import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { gitFetchTransfer, gitRestoreSnapshotInPlace, SnapshotResetError } from "../src/git.ts";
import { startServer, type AgentDeckServer } from "../src/index.ts";
import { createTransferWorktree } from "../src/sessionTransfer.ts";

/**
 * SRV-12c3 without Pi: the return trip (a shared server sends a session back to
 * its device) and the shared server's merge as a push plus a pull request as the
 * session owner. A local bare repository stands in for GitHub; gh is a stub.
 */
const scratch = mkdtempSync(path.join(tmpdir(), "deck session return "));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const bare = path.join(scratch, "origin.git");
const localClone = path.join(scratch, "local app");
const serverClone = path.join(scratch, "server app");
const fakeHome = path.join(scratch, "home");
const pushLog = path.join(scratch, "push-token.log");
const ghLog = path.join(scratch, "gh.log");
const savedEnv = { ...process.env };

const PROJECT_A = randomUUID();
const PROJECT_B = randomUUID();
const S_MOVE = randomUUID();
const S_PR1 = randomUUID();
const S_PR2 = randomUUID();
const S_PR3 = randomUUID();
const B_OTHER = randomUUID();
const B_PLAIN = randomUUID();
const B_LOOP = randomUUID();
const B_LEGACY = randomUUID();
const B_FOLDER = randomUUID();
const PROJECT_FOLDER = randomUUID();
const ORIGIN = "https://deck.example.test";
const EMAIL = "andrea@example.com";
const OTHER = "bea@example.com";
const TOKEN = "gho_test-not-a-secret";
const OFFERED = { kind: "parent", provider: "openai", model: "gpt-4o-mini" };

const TEAM = "team.cloudflareaccess.test";
const AUD = "aud-return";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
function assertionFor(email: string): string {
  const now = Math.floor(Date.now() / 1000);
  const signed = `${b64({ alg: "RS256", kid: "k1" })}.${b64({
    iss: `https://${TEAM}`,
    aud: [AUD],
    iat: now,
    exp: now + 600,
    email,
  })}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}
const andrea = () => ({ "cf-access-jwt-assertion": assertionFor(EMAIL) });
const bea = () => ({ "cf-access-jwt-assertion": assertionFor(OTHER) });

let jwks: Server;
let a: AgentDeckServer;
let b: AgentDeckServer;
const urlA = (p: string) => `http://127.0.0.1:${a.port}${p}`;
const urlB = (p: string) => `http://127.0.0.1:${b.port}${p}`;
const post = (url: string, body: unknown, headers: Record<string, string> = {}, method = "POST") =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const serverMeta = async (id: string): Promise<SessionMeta> =>
  (
    (await (await fetch(urlB(`/sessions/${id}`), { headers: andrea() })).json()) as {
      session: SessionMeta;
    }
  ).session;
const readJson = async (response: Response) => (await response.json()) as Record<string, unknown>;

function transcriptFor(cwd: string): string {
  return [
    { type: "session", version: 3, id: randomUUID(), timestamp: new Date().toISOString(), cwd },
    {
      type: "message",
      id: "e1",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "fix it" },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join("\n")
    .concat("\n");
}

/** Move a device session to the server (conversation or snapshot) and link the pointer. */
async function moveToServer(
  id: string,
  body: Record<string, unknown>,
): Promise<{ serverId: string; envelope: Record<string, unknown> }> {
  const shared = await post(urlA(`/sessions/${id}/share`), body);
  expect(shared.status, await shared.clone().text()).toBe(200);
  const out = (await shared.json()) as { envelope: Record<string, unknown>; handoff: string };
  const imported = await post(
    urlB(`/projects/${PROJECT_B}/sessions/import`),
    out.envelope,
    andrea(),
  );
  expect(imported.status, await imported.clone().text()).toBe(201);
  const { sessionId } = (await imported.json()) as { sessionId: string };
  const mode = (out.envelope.transfer as { mode: string }).mode;
  const linked = await post(
    urlA(`/sessions/${id}/shared-to`),
    { serverOrigin: ORIGIN, serverSessionId: sessionId, mode, handoff: out.handoff },
    {},
    "PATCH",
  );
  expect(linked.status).toBe(200);
  return { serverId: sessionId, envelope: out.envelope };
}

beforeAll(async () => {
  const work = path.join(scratch, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "t@example.test");
  git(work, "config", "user.name", "t");
  writeFileSync(path.join(work, "README.md"), "one\n");
  writeFileSync(path.join(work, ".gitignore"), "*.log\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "one");
  git(scratch, "clone", "-q", "--bare", work, bare);
  // Every push into "GitHub" records the token it came with (the pusher's env).
  writeFileSync(
    path.join(bare, "hooks", "pre-receive"),
    `#!/bin/sh\nprintf '%s\\n' "\${GH_TOKEN:-none}" >> "${pushLog.replace(/\\/g, "/")}"\ncat >/dev/null\nexit 0\n`,
    { mode: 0o755 },
  );
  for (const clone of [localClone, serverClone]) {
    git(scratch, "clone", "-q", bare, clone);
    git(clone, "config", "user.email", "t@example.test");
    git(clone, "config", "user.name", "t");
  }
  mkdirSync(path.join(fakeHome, ".pi", "agent"), { recursive: true });
  writeFileSync(
    path.join(fakeHome, ".pi", "agent", "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "sk-test-not-a-secret" } }),
  );
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: fakeHome, USERPROFILE: fakeHome });

  const now = new Date().toISOString();
  const dataA = mkdtempSync(path.join(scratch, "data-a-"));
  const piFile = (dir: string, name: string, cwd: string) => {
    const file = path.join(dir, `${name}.jsonl`);
    writeFileSync(file, transcriptFor(cwd));
    return file;
  };
  writeFileSync(
    path.join(dataA, "projects.json"),
    JSON.stringify([
      {
        id: PROJECT_A,
        path: localClone,
        name: "app",
        createdAt: now,
        sharedTo: { serverOrigin: ORIGIN, projectId: PROJECT_B, sharedAt: now },
      },
    ]),
  );
  const base = { cwd: localClone, createdAt: now, updatedAt: now, projectId: PROJECT_A };
  writeFileSync(
    path.join(dataA, "sessions.json"),
    JSON.stringify(
      [
        [S_MOVE, "Fix it"],
        [S_PR1, "Add the docs"],
        [S_PR2, "Second change"],
        [S_PR3, "Third change"],
      ].map(([id, title]) => ({
        id,
        ...base,
        lifecycle: "started",
        title,
        piSessionFile: piFile(dataA, id!, localClone),
        launchPlan: OFFERED,
      })),
    ),
  );
  a = await startServer({ dataDir: dataA });

  jwks = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }],
      }),
    );
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  process.env.AGENT_DECK_TRUSTED_PROXY = "cloudflare";
  process.env.AGENT_DECK_CF_ACCESS_TEAM_DOMAIN = TEAM;
  process.env.AGENT_DECK_CF_ACCESS_AUD = AUD;
  process.env.AGENT_DECK_CF_ACCESS_JWKS_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs`;
  process.env.AGENT_DECK_OPERATOR_EMAIL = EMAIL;
  const dataB = mkdtempSync(path.join(scratch, "data-b-"));
  writeFileSync(
    path.join(dataB, "projects.json"),
    JSON.stringify([
      {
        id: PROJECT_B,
        path: serverClone,
        name: "app",
        createdAt: now,
        origin: "https://github.com/acme/app.git",
        repoId: 1,
        defaultBranch: "main",
      },
      // A server folder, not a repository: no GitHub origin.
      { id: PROJECT_FOLDER, path: fakeHome, name: "folder", createdAt: now },
    ]),
  );
  const sharedFrom = (localSessionId: string) => ({
    device: "laptop",
    localSessionId,
    sharedAt: now,
    mode: "conversation",
  });
  const baseB = { cwd: serverClone, createdAt: now, updatedAt: now, projectId: PROJECT_B };
  writeFileSync(
    path.join(dataB, "sessions.json"),
    JSON.stringify([
      {
        id: B_OTHER,
        ...baseB,
        lifecycle: "started",
        createdBy: { id: OTHER },
        sharedFrom: sharedFrom(randomUUID()),
        piSessionFile: piFile(dataB, "other", serverClone),
      },
      {
        id: B_PLAIN,
        ...baseB,
        lifecycle: "started",
        createdBy: { id: EMAIL },
        piSessionFile: piFile(dataB, "plain", serverClone),
      },
      {
        id: B_LOOP,
        ...baseB,
        lifecycle: "started",
        createdBy: { id: EMAIL },
        loopReviewRunId: "run-1",
        sharedFrom: sharedFrom(randomUUID()),
        piSessionFile: piFile(dataB, "loop", serverClone),
      },
      // No owner (written before the trusted proxy): its pull request is refused.
      {
        id: B_LEGACY,
        ...baseB,
        lifecycle: "started",
        piSessionFile: piFile(dataB, "legacy", serverClone),
      },
      {
        id: B_FOLDER,
        ...baseB,
        projectId: PROJECT_FOLDER,
        lifecycle: "started",
        createdBy: { id: OTHER },
        piSessionFile: piFile(dataB, "folder", serverClone),
      },
    ]),
  );
  // The operator's GitHub connection (in the data dir); Bea has none.
  writeFileSync(path.join(dataB, "github.json"), JSON.stringify({ token: TOKEN, login: "andrea" }));
  b = await startServer({ dataDir: dataB });
});

afterAll(async () => {
  await a?.close();
  await b?.close();
  await new Promise<void>((resolve) => (jwks ? jwks.close(() => resolve()) : resolve()));
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});

/** The tree of a working directory as git would commit it (a throwaway index): no
 * line-ending or untracked-file blind spot. */
const workingTree = (dir: string): string => {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, `index-${randomUUID()}`) };
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  return execFileSync("git", ["write-tree"], { cwd: dir, env, encoding: "utf8" }).trim();
};
const refsOnOrigin = () => git(bare, "for-each-ref", "--format=%(refname)", "refs/agent-deck");

describe("session return: the server side", () => {
  it("refuses sessions that cannot go back, and anyone but the owner", async () => {
    for (const id of [B_PLAIN, B_LOOP]) {
      const res = await post(urlB(`/sessions/${id}/return`), {}, andrea());
      expect(res.status, id).toBe(409);
      expect((await readJson(res)).code).toBe("return_refused");
    }
    // Only the owner returns a session (the envelope and its completion are
    // theirs); Bea owns hers but has no GitHub connection, and only the owner's
    // connection pushes.
    const noGithub = await post(urlB(`/sessions/${B_OTHER}/return`), {}, bea());
    expect(noGithub.status).toBe(409);
    expect(await readJson(noGithub)).toMatchObject({ code: "github_not_connected" });
    // The operator may not return someone else's session, but may cancel its return.
    expect((await post(urlB(`/sessions/${B_OTHER}/return`), {}, andrea())).status).toBe(403);
    expect(
      (
        await post(
          urlB(`/sessions/${B_OTHER}/returned`),
          { deviceSessionId: randomUUID(), handoff: randomUUID() },
          andrea(),
          "PATCH",
        )
      ).status,
    ).toBe(403);
    expect((await post(urlB(`/sessions/${B_OTHER}/return/abort`), {}, andrea())).status).toBe(200);
    const forbidden = await post(urlB(`/sessions/${B_PLAIN}/return`), {}, bea());
    expect(forbidden.status).toBe(403);
    for (const route of ["return/abort"]) {
      expect((await post(urlB(`/sessions/${B_PLAIN}/${route}`), {}, bea())).status).toBe(403);
    }
    const returned = await post(
      urlB(`/sessions/${B_PLAIN}/returned`),
      { deviceSessionId: randomUUID(), handoff: randomUUID() },
      bea(),
      "PATCH",
    );
    expect(returned.status).toBe(403);
    // The device routes are not the server's.
    expect((await post(urlB(`/sessions/${B_PLAIN}/import-return`), {}, andrea())).status).toBe(409);
  });

  it("goes back to a dirty device checkout through a fresh worktree, touching nothing there", async () => {
    // Out with the device's edits; the device checkout keeps them (a share copies).
    writeFileSync(path.join(localClone, "README.md"), "edited on the device\n");
    writeFileSync(path.join(localClone, "notes.md"), "device notes\n");
    const base = git(localClone, "rev-parse", "HEAD");
    const { serverId } = await moveToServer(S_MOVE, { mode: "snapshot", untracked: ["notes.md"] });
    const wt = (await serverMeta(serverId)).cwd;
    writeFileSync(path.join(wt, "server.md"), "from the server\n");
    // A hook planted in the shared .git/hooks never sees the owner's token.
    const leaked = path.join(scratch, "pre-push saw");
    writeFileSync(
      path.join(serverClone, ".git", "hooks", "pre-push"),
      `#!/bin/sh\nprintf '%s' "$GH_TOKEN" > "${leaked.replace(/\\/g, "/")}"\n`,
      { mode: 0o755 },
    );

    const preflight = await post(urlB(`/sessions/${serverId}/return`), {}, andrea());
    expect(preflight.status).toBe(200);
    const { plan } = (await preflight.json()) as {
      plan: { files: { untracked: string[] }; device: string };
    };
    expect(plan.files.untracked.sort()).toEqual(["notes.md", "server.md"]);
    // Consent covers what travels: another list asks again.
    const changed = await post(
      urlB(`/sessions/${serverId}/return`),
      { confirmedUntracked: ["notes.md"] },
      andrea(),
    );
    expect(changed.status).toBe(409);
    expect(await readJson(changed)).toMatchObject({ code: "share_plan_changed" });
    expect(refsOnOrigin()).toBe("");

    const ret = await post(
      urlB(`/sessions/${serverId}/return`),
      { confirmedUntracked: plan.files.untracked },
      andrea(),
    );
    expect(ret.status, await ret.clone().text()).toBe(200);
    const back = (await ret.json()) as {
      envelope: Record<string, unknown> & {
        transfer: { ref: string; baseHead: string; commit: string };
        sharedFrom: { localSessionId: string };
      };
      handoff: string;
    };
    expect(back.envelope).toMatchObject({
      direction: "return",
      localSessionId: serverId,
      sharedFrom: { localSessionId: S_MOVE },
    });
    expect(refsOnOrigin()).toBe(back.envelope.transfer.ref);
    expect(existsSync(leaked)).toBe(false);
    // One return at a time: a second one is refused until this one ends.
    const twice = await post(
      urlB(`/sessions/${serverId}/return`),
      { confirmedUntracked: plan.files.untracked },
      andrea(),
    );
    expect(await readJson(twice)).toMatchObject({ code: "return_in_progress" });
    // Pushed with the owner's connection.
    expect(readFileSync(pushLog, "utf8").trim().split("\n").at(-1)).toBe(TOKEN);
    // Frozen while the device takes it: a forwarded prompt is refused.
    expect(
      (await post(urlB(`/sessions/${serverId}/prompt`), { text: "hi" }, andrea())).status,
    ).toBe(409);

    // A returned session is never imported into a server project.
    const intoServer = await post(
      urlB(`/projects/${PROJECT_B}/sessions/import`),
      back.envelope,
      andrea(),
    );
    expect(intoServer.status).toBe(400);
    // The device checks the envelope as strictly as the server checks a share.
    for (const tampered of [
      { ...back.envelope, sharedFrom: { device: "laptop", localSessionId: randomUUID() } },
      { ...back.envelope, localSessionId: randomUUID() },
      { ...back.envelope, direction: undefined },
      { ...back.envelope, transfer: { mode: "conversation" } },
      { ...back.envelope, extra: true },
    ]) {
      const res = await post(urlA(`/sessions/${S_MOVE}/import-return`), {
        envelope: tampered,
        handoff: back.handoff,
      });
      expect(res.status, JSON.stringify(Object.keys(tampered))).toBe(400);
    }
    expect(refsOnOrigin()).toBe(back.envelope.transfer.ref);
    // A model this device does not offer is refused before anything changes.
    const unoffered = await post(urlA(`/sessions/${S_MOVE}/import-return`), {
      envelope: {
        ...back.envelope,
        meta: { ...(back.envelope.meta as object), provider: "google", model: "gemini-2.5-flash" },
      },
      handoff: back.handoff,
    });
    expect(unoffered.status).toBe(409);
    expect(await readJson(unoffered)).toMatchObject({ code: "model_unavailable" });
    expect(refsOnOrigin()).toBe(back.envelope.transfer.ref);
    expect(git(localClone, "worktree", "list").split("\n")).toHaveLength(1);

    // The server ran at a thinking level and opened a PR; this device keeps both.
    const pointerFile = (await (await fetch(urlA("/sessions"))).json()) as {
      sessions: SessionMeta[];
    };
    const piFile = pointerFile.sessions.find((s) => s.id === S_MOVE)!.piSessionFile!;
    const before = readFileSync(piFile, "utf8");
    const [head0, ...rest] = before.split("\n");
    writeFileSync(
      piFile,
      [
        JSON.stringify({ ...JSON.parse(head0!), parentSession: "C:/pi/parent.jsonl" }),
        ...rest,
      ].join("\n"),
    );
    const thinking = {
      type: "thinking_level_change",
      id: "t1",
      parentId: "e1",
      timestamp: new Date().toISOString(),
      thinkingLevel: "high",
    };
    const envelope = {
      ...back.envelope,
      transcript: `${String(back.envelope.transcript)}${JSON.stringify(thinking)}\n`,
      meta: {
        ...(back.envelope.meta as object),
        mergePr: { url: "https://github.com/acme/app/pull/5", number: 5 },
      },
    };
    const restored = await post(urlA(`/sessions/${S_MOVE}/import-return`), {
      envelope,
      handoff: back.handoff,
    });

    expect(restored.status, await restored.clone().text()).toBe(200);
    const result = (await restored.json()) as {
      session: SessionMeta;
      restored: string;
      notice: string;
      transferRefDeleted: boolean;
    };
    expect(result.restored).toBe("worktree");
    expect(result.notice).toMatch(/new worktree/);
    expect(result.transferRefDeleted).toBe(true);
    expect(refsOnOrigin()).toBe("");
    // The device's own checkout is exactly as it was.
    expect(readFileSync(path.join(localClone, "README.md"), "utf8")).toBe("edited on the device\n");
    expect(readFileSync(path.join(localClone, "notes.md"), "utf8")).toBe("device notes\n");
    expect(existsSync(path.join(localClone, "server.md"))).toBe(false);
    // The fresh worktree holds the server's work, uncommitted on the base.
    const fresh = result.session.cwd;
    expect(fresh).not.toBe(localClone);
    expect(result.session.workspace?.path).toBe(fresh);
    expect(git(fresh, "rev-parse", "HEAD")).toBe(base);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: fresh, encoding: "utf8" });
    expect(status.split("\n").filter(Boolean).sort()).toEqual([
      " M README.md",
      "?? notes.md",
      "?? server.md",
    ]);
    // The same local session, live again, its transcript pointing at the new cwd.
    expect(result.session.id).toBe(S_MOVE);
    expect(result.session.location?.live).toBeUndefined();
    // Provenance is written once: the return is the hand-off's, not a new origin.
    expect(result.session.provenance?.kind).not.toBe("returned");
    expect(result.session.location?.transfer).toMatchObject({
      direction: "return",
      serverOrigin: ORIGIN,
      sessionId: serverId,
    });
    expect(result.session.transcriptSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.session.launch?.resourceConfig?.thinkingOverride).toBe("high");
    expect(result.session.location?.mergePr).toEqual({
      url: "https://github.com/acme/app/pull/5",
      number: 5,
    });
    // The pointer's own transcript is kept one generation back.
    expect(readFileSync(`${piFile}.pre-return`, "utf8")).toContain("C:/pi/parent.jsonl");
    const header = JSON.parse(
      readFileSync(result.session.piSessionFile!, "utf8").split("\n")[0]!,
    ) as { cwd: string; parentSession?: string };
    expect(header.cwd).toBe(fresh);
    expect(header.parentSession).toBe("C:/pi/parent.jsonl");

    // The server copy becomes the pointer only for this hand-off and this device session.
    const wrongToken = await post(
      urlB(`/sessions/${serverId}/returned`),
      { deviceSessionId: S_MOVE, handoff: randomUUID() },
      andrea(),
      "PATCH",
    );
    expect(wrongToken.status).toBe(409);
    expect(await readJson(wrongToken)).toMatchObject({ code: "return_stale" });
    const wrongDevice = await post(
      urlB(`/sessions/${serverId}/returned`),
      { deviceSessionId: randomUUID(), handoff: back.handoff },
      andrea(),
      "PATCH",
    );
    expect(wrongDevice.status).toBe(409);
    const closed = await post(
      urlB(`/sessions/${serverId}/returned`),
      { deviceSessionId: S_MOVE, handoff: back.handoff },
      andrea(),
      "PATCH",
    );
    expect(closed.status).toBe(200);
    const closedBody = (await closed.json()) as {
      session: SessionMeta;
      transferRefDeleted: boolean;
    };
    expect(closedBody.transferRefDeleted).toBe(true);
    expect(closedBody.session.location?.live).toMatchObject({
      device: expect.any(String),
      sessionId: S_MOVE,
    });
    // The server copy records the transcript its hand-off carried (this test
    // changed it on the way, so the device records another).
    expect(closedBody.session.transcriptSha256).toBe(
      createHash("sha256").update(String(back.envelope.transcript)).digest("hex"),
    );
    expect(result.session.transcriptSha256).toBe(
      createHash("sha256").update(envelope.transcript).digest("hex"),
    );
    // A lost answer is retried: the same device session gets the pointer again,
    // any other device session is refused.
    const again = await post(
      urlB(`/sessions/${serverId}/returned`),
      { deviceSessionId: S_MOVE, handoff: back.handoff },
      andrea(),
      "PATCH",
    );
    expect(again.status).toBe(200);
    const otherDevice = await post(
      urlB(`/sessions/${serverId}/returned`),
      { deviceSessionId: randomUUID(), handoff: back.handoff },
      andrea(),
      "PATCH",
    );
    expect(otherDevice.status).toBe(409);
    // The device records the finished return.
    expect(result.session.location?.transfer).toMatchObject({
      token: back.handoff,
      serverOrigin: ORIGIN,
      sessionId: serverId,
      ref: back.envelope.transfer.ref,
    });
    const done = await post(
      urlA(`/sessions/${S_MOVE}/return-pending`),
      { returnPending: null },
      {},
      "PATCH",
    );
    expect(
      ((await done.json()) as { session: SessionMeta }).session.location?.transfer,
    ).toBeUndefined();

    // A pointer refuses prompts and a second return.
    const prompt = await post(urlB(`/sessions/${serverId}/prompt`), { text: "hi" }, andrea());
    expect(await readJson(prompt)).toMatchObject({ code: "session_shared" });
    expect((await post(urlB(`/sessions/${serverId}/return`), {}, andrea())).status).toBe(409);

    // Moving it out again makes a new server copy (the pointer is not the session any more).
    const second = await moveToServer(S_MOVE, { mode: "conversation" });
    expect(second.serverId).not.toBe(serverId);
  });

  it("refuses a return while a turn runs, and aborting unfreezes and removes the ref", async () => {
    const { serverId } = await moveToServer(S_PR2, { mode: "conversation" });
    const serverCopy = await serverMeta(serverId);
    const live = (streaming: boolean) =>
      ({
        meta: serverCopy,
        isRunning: true,
        snapshot: () => ({ state: { agentStatus: streaming ? "running" : "idle", cells: [] } }),
        getState: async () => ({ isStreaming: streaming }),
      }) as never;
    const spy = vi
      .spyOn(b.sessions, "get")
      .mockImplementation((id) => (id === serverId ? live(true) : undefined));
    try {
      const busy = await post(urlB(`/sessions/${serverId}/return`), {}, andrea());
      expect(busy.status).toBe(409);
      expect((await readJson(busy)).error).toMatch(/finished responding/);
    } finally {
      spy.mockRestore();
    }
    const ret = await post(
      urlB(`/sessions/${serverId}/return`),
      { confirmedUntracked: [] },
      andrea(),
    );
    expect(ret.status, await ret.clone().text()).toBe(200);
    const { handoff, envelope } = (await ret.json()) as {
      handoff: string;
      envelope: { transfer: { ref: string } };
    };
    expect(refsOnOrigin()).toBe(envelope.transfer.ref);
    // A turn that started anyway (it cannot, but the device's confirmation re-checks).
    const spy2 = vi
      .spyOn(b.sessions, "get")
      .mockImplementation((id) => (id === serverId ? live(true) : undefined));
    try {
      const refused = await post(
        urlB(`/sessions/${serverId}/returned`),
        { deviceSessionId: S_PR2, handoff },
        andrea(),
        "PATCH",
      );
      expect(refused.status).toBe(409);
      expect((await readJson(refused)).error).toMatch(/turn is running/);
    } finally {
      spy2.mockRestore();
    }
    // "GitHub" cannot be reached: the abort unfreezes, says the ref is still
    // there and keeps it for the next call, which deletes it.
    const away = `${bare}.away`;
    renameSync(bare, away);
    let aborted: Response;
    try {
      aborted = await post(urlB(`/sessions/${serverId}/return/abort`), { handoff }, andrea());
    } finally {
      renameSync(away, bare);
    }
    expect(aborted.status).toBe(200);
    expect(await readJson(aborted)).toMatchObject({ ok: true, transferRefDeleted: false });
    expect(refsOnOrigin()).toBe(envelope.transfer.ref);
    const retried = await post(urlB(`/sessions/${serverId}/return/abort`), {}, andrea());
    expect(await readJson(retried)).toMatchObject({ ok: true, transferRefDeleted: true });
    expect(refsOnOrigin()).toBe("");
    // Unfrozen: the hand-off is gone, so its confirmation is stale.
    const stale = await post(
      urlB(`/sessions/${serverId}/returned`),
      { deviceSessionId: S_PR2, handoff },
      andrea(),
      "PATCH",
    );
    expect(await readJson(stale)).toMatchObject({ code: "return_stale" });
  });
});

describe("shared server merge: push and pull request as the owner", () => {
  const stub = path.join(scratch, "gh-stub.cjs");
  const ghCalls = () =>
    existsSync(ghLog)
      ? readFileSync(ghLog, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as { argv: string[]; token: string | null })
      : [];
  const withGh = async <T>(
    stubEnv: { mode?: string; state?: string; number?: string },
    run: () => Promise<T>,
  ): Promise<T> => {
    const keys = {
      AGENT_DECK_GH_BIN: process.execPath,
      NODE_OPTIONS: `--require "${stub.replace(/\\/g, "/")}"`,
      GH_STUB_MODE: stubEnv.mode ?? "ok",
      GH_STUB_STATE: stubEnv.state ?? "OPEN",
      GH_STUB_NUMBER: stubEnv.number ?? "7",
    };
    const saved = Object.fromEntries(Object.keys(keys).map((key) => [key, process.env[key]]));
    Object.assign(process.env, keys);
    try {
      return await run();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  beforeAll(() => {
    writeFileSync(
      stub,
      `const fs = require("fs");
fs.appendFileSync(${JSON.stringify(ghLog)}, JSON.stringify({ argv: process.argv.slice(2), token: process.env.GH_TOKEN ?? null }) + "\\n");
const mode = process.env.GH_STUB_MODE;
if (process.argv[2] === "view") { process.stdout.write(JSON.stringify({ state: process.env.GH_STUB_STATE }) + "\\n"); process.exit(0); }
if (mode === "fail") { process.stderr.write("HTTP 422: Validation Failed\\n"); process.exit(1); }
if (mode === "exists") { process.stderr.write('a pull request for branch "x" into branch "main" already exists:\\nhttps://github.com/acme/app/pull/12\\n'); process.exit(1); }
process.stdout.write("https://github.com/acme/app/pull/" + process.env.GH_STUB_NUMBER + "\\n");
process.exit(0);
`,
    );
  });

  const merge = (id: string, headers: Record<string, string>) =>
    fetch(urlB(`/sessions/${id}/merge`), { method: "POST", headers });

  it("refuses anyone but the owner or the operator, and an owner without GitHub", async () => {
    const other = await merge(B_PLAIN, bea());
    expect(other.status).toBe(403);
    expect(await readJson(other)).toMatchObject({ code: "merge_forbidden" });
    const noGithub = await merge(B_OTHER, andrea());
    expect(noGithub.status).toBe(409);
    expect(await readJson(noGithub)).toMatchObject({ code: "merge_github_missing" });
  });

  it("keeps the local merge for folder projects", async () => {
    // Not asked for GitHub or an owner: the ordinary merge checks answer (this
    // session has no isolated worktree).
    const res = await merge(B_FOLDER, bea());
    expect(res.status).toBe(409);
    expect(await readJson(res)).toMatchObject({ code: "merge_stale_ownership" });
  });

  it("refuses, never merges into the server checkout, a GitHub session without an owner", async () => {
    // The operator too: without an owner there is no connection to push with.
    for (const headers of [bea(), andrea()]) {
      const res = await merge(B_LEGACY, headers);
      expect(res.status).toBe(403);
      expect(await readJson(res)).toMatchObject({ code: "merge_forbidden" });
    }
  });

  it("pushes the branch with the owner's connection and opens the PR as the owner", async () => {
    const { serverId } = await moveToServer(S_PR1, { mode: "conversation" });
    const meta = await serverMeta(serverId);
    const head = git(serverClone, "rev-parse", "main");
    writeFileSync(path.join(meta.cwd, "docs.md"), "docs\n");
    const res = await withGh({}, () => merge(serverId, andrea()));
    expect(res.status, await res.clone().text()).toBe(200);
    expect(await readJson(res)).toMatchObject({
      ok: true,
      code: "merge_pr_opened",
      pr: { url: "https://github.com/acme/app/pull/7", number: 7 },
      branch: meta.workspace?.branch,
      base: "main",
      commits: 1,
    });
    // The branch is on origin, pushed with the owner's token; the server checkout is untouched.
    expect(git(bare, "rev-parse", `refs/heads/${meta.workspace?.branch}`)).toBe(
      git(meta.cwd, "rev-parse", "HEAD"),
    );
    expect(readFileSync(pushLog, "utf8").trim().split("\n").at(-1)).toBe(TOKEN);
    expect(git(serverClone, "rev-parse", "main")).toBe(head);
    const call = ghCalls().at(-1)!;
    expect(call.token).toBe(TOKEN);
    expect(call.argv).toEqual([
      "create",
      "--repo=acme/app",
      `--head=${meta.workspace?.branch}`,
      "--base=main",
      "--title=Add the docs",
      `--body=- Agent Deck: Add the docs changes\n\nOpened from Agent Deck session ${serverId}`,
    ]);
    // Recorded, and the worktree stays for the PR.
    const after = await serverMeta(serverId);
    expect(after.location?.mergePr).toMatchObject({
      url: "https://github.com/acme/app/pull/7",
      number: 7,
    });
    expect(existsSync(after.cwd)).toBe(true);
    expect(after.workspace?.path).toBe(meta.workspace?.path);

    // A re-click while the PR is open commits and pushes again: the same PR, updated.
    writeFileSync(path.join(meta.cwd, "more.md"), "more\n");
    const again = await withGh({}, () => merge(serverId, andrea()));
    expect(again.status).toBe(200);
    expect(await readJson(again)).toMatchObject({
      code: "merge_pr_updated",
      pr: { url: "https://github.com/acme/app/pull/7", number: 7 },
    });
    expect(ghCalls().at(-1)!.argv).toEqual(["view", "7", "--repo=acme/app", "--json=state"]);
    expect(git(bare, "rev-parse", `refs/heads/${meta.workspace?.branch}`)).toBe(
      git(meta.cwd, "rev-parse", "HEAD"),
    );
    // Merged on GitHub: the next merge opens a new PR.
    const reopened = await withGh({ state: "MERGED", number: "9" }, () =>
      merge(serverId, andrea()),
    );
    expect(await readJson(reopened)).toMatchObject({ code: "merge_pr_opened", pr: { number: 9 } });
    expect((await serverMeta(serverId)).location?.mergePr).toMatchObject({ number: 9 });

    // The PR goes back with the session: the return envelope names it.
    const ret = await post(
      urlB(`/sessions/${serverId}/return`),
      { confirmedUntracked: [] },
      andrea(),
    );
    expect(ret.status, await ret.clone().text()).toBe(200);
    const { envelope, handoff } = (await ret.json()) as {
      envelope: { meta: { mergePr?: unknown } };
      handoff: string;
    };
    expect(envelope.meta.mergePr).toEqual({ url: "https://github.com/acme/app/pull/9", number: 9 });
    // Neither the PR pushes nor the transfer push ran the planted pre-push hook.
    expect(existsSync(path.join(scratch, "pre-push saw"))).toBe(false);

    expect(
      await readJson(await post(urlB(`/sessions/${serverId}/return/abort`), { handoff }, andrea())),
    ).toMatchObject({ ok: true, transferRefDeleted: true });
  });

  it("names the pushed branch when gh fails, and answers an existing PR", async () => {
    const { serverId } = await moveToServer(S_PR3, { mode: "conversation" });
    const meta = await serverMeta(serverId);
    writeFileSync(path.join(meta.cwd, "second.md"), "second\n");
    const failed = await withGh({ mode: "fail" }, () => merge(serverId, andrea()));
    expect(failed.status).toBe(502);
    const body = await readJson(failed);
    expect(body).toMatchObject({
      code: "merge_pr_failed",
      branch: meta.workspace?.branch,
      pushed: true,
    });
    expect(String(body.error)).toContain(`Pushed ${meta.workspace?.branch} to origin`);
    expect((await serverMeta(serverId)).location?.mergePr).toBeUndefined();
    const existing = await withGh({ mode: "exists" }, () => merge(serverId, andrea()));
    expect(existing.status, await existing.clone().text()).toBe(200);
    expect(await readJson(existing)).toMatchObject({
      pr: { url: "https://github.com/acme/app/pull/12", number: 12 },
    });
  });

  it("Git screen: a tokenless push runs no hook, and a hook's secret never reaches the page", async () => {
    const hooks = path.join(scratch, "git screen hooks");
    const marker = path.join(scratch, "git-screen-hook-ran");
    // A recognizable (fake) GitHub token pattern, printed by a failing pre-commit.
    const secret = `ghp_${"Q0pz".repeat(9)}`;
    mkdirSync(hooks);
    writeFileSync(
      path.join(hooks, "pre-push"),
      `#!/bin/sh\necho ran > "${marker.replace(/\\/g, "/")}"\nexit 1\n`,
      { mode: 0o755 },
    );
    writeFileSync(path.join(hooks, "pre-commit"), `#!/bin/sh\necho "${secret}" >&2\nexit 1\n`, {
      mode: 0o755,
    });
    git(serverClone, "config", "core.hooksPath", hooks);
    const extra = path.join(serverClone, "git-screen.txt");
    try {
      // Bea has no GitHub connection: the push would use the service's credentials.
      const pushed = await post(urlB(`/projects/${PROJECT_B}/git/push`), {}, bea());
      expect(pushed.status, await pushed.clone().text()).toBe(200);
      expect(existsSync(marker)).toBe(false);

      // A release on the shared server: fetch, tag and atomic push, no hook either.
      const released = await post(urlB(`/projects/${PROJECT_B}/release`), { tag: "v9.9.9" }, bea());
      expect(released.status, await released.clone().text()).toBe(200);
      expect(git(bare, "tag", "-l", "v9.9.9")).toBe("v9.9.9");
      expect(existsSync(marker)).toBe(false);

      writeFileSync(extra, "x\n");
      const committed = await post(
        urlB(`/projects/${PROJECT_B}/git/commit`),
        { message: "x" },
        bea(),
      );
      expect(committed.status).toBe(500);
      const text = await committed.text();
      expect(text).not.toContain(secret);
      expect(text).toContain("<secret>");
    } finally {
      git(serverClone, "config", "--unset", "core.hooksPath");
      git(serverClone, "reset", "-q");
      rmSync(extra, { force: true });
    }
  });
});

describe("restoring a returned snapshot into the original checkout", () => {
  /** A repository with `files` at its base, and a snapshot commit `change` makes on top. */
  function fixture(
    name: string,
    files: Record<string, string>,
    change: (server: string) => void,
  ): { repo: string; base: string; snapshot: string } {
    const repo = path.join(scratch, `in place ${name}`);
    mkdirSync(repo);
    git(repo, "init", "-q", "-b", "main");
    git(repo, "config", "user.email", "t@example.test");
    git(repo, "config", "user.name", "t");
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
      writeFileSync(path.join(repo, file), content);
    }
    git(repo, "add", ".");
    git(repo, "commit", "-qm", "base");
    const base = git(repo, "rev-parse", "HEAD");
    const server = `${repo} server`;
    git(scratch, "clone", "-q", repo, server);
    git(server, "config", "user.email", "t@example.test");
    git(server, "config", "user.name", "t");
    change(server);
    git(server, "add", "-A", "-f");
    git(server, "commit", "-qm", "snapshot");
    const snapshot = git(server, "rev-parse", "HEAD");
    git(repo, "fetch", "-q", server, "HEAD");
    return { repo, base, snapshot };
  }
  const blob = (repo: string, rev: string, file: string) => git(repo, "show", `${rev}:${file}`);
  const edit = (server: string) => {
    writeFileSync(path.join(server, "README.md"), "server\n");
    writeFileSync(path.join(server, "new.md"), "new\n");
  };
  const baseFiles = { "README.md": "one\n", ".gitignore": "*.log\n" };

  it("the fallback fresh worktree and every cleanup run no hook", async () => {
    const marker = path.join(scratch, "snapshot-hook-ran");
    const hook = `#!/bin/sh\necho ran >> "${marker.replace(/\\/g, "/")}"\n`;
    const { repo, base, snapshot } = fixture("hooked", baseFiles, (server) => {
      edit(server);
      mkdirSync(path.join(server, ".githooks"));
      for (const name of ["post-checkout", "post-index-change", "reference-transaction"])
        writeFileSync(path.join(server, ".githooks", name), hook, { mode: 0o755 });
    });
    // A repository-relative hooks path: the snapshot's own .githooks once checked out.
    git(repo, "config", "core.hooksPath", ".githooks");
    const root = path.join(scratch, "transfer worktrees");
    const ctx = {
      worktreesRoot: root,
      sessionWorktreeStore: {
        reserveWorktree: () => "reservation",
        deleteWorktree: async (target: string) => rmSync(target, { recursive: true, force: true }),
      },
    } as unknown as Parameters<typeof createTransferWorktree>[0];
    const made = await createTransferWorktree(ctx, repo, { commit: snapshot, baseHead: base });
    expect(git(made.worktree.path, "rev-parse", "HEAD")).toBe(base);
    expect(existsSync(path.join(made.worktree.path, "new.md"))).toBe(true);
    expect(existsSync(marker)).toBe(false);

    // The cleanups run in the project checkout: hooks there (any configured path) stay off too.
    const hooksDir = path.join(scratch, "project hooks");
    mkdirSync(hooksDir);
    for (const name of ["reference-transaction", "post-checkout", "post-index-change"])
      writeFileSync(path.join(hooksDir, name), hook, { mode: 0o755 });
    git(repo, "config", "core.hooksPath", hooksDir);
    const branches = () => git(repo, "branch", "--list", "agent-deck/*");
    // Discard after an abort.
    await made.discard();
    expect(branches()).toBe("");
    expect(existsSync(marker), "discard").toBe(false);
    // A failed import (the reset fails) discards what it made.
    await expect(
      createTransferWorktree(ctx, repo, { commit: snapshot, baseHead: "0".repeat(40) }),
    ).rejects.toThrow();
    expect(branches()).toBe("");
    expect(existsSync(marker), "failed import").toBe(false);
    // The fetch's private ref is deleted after the fetch.
    const ref = `refs/agent-deck/transfer/${randomUUID()}`;
    git(`${repo} server`, "update-ref", ref, snapshot);
    git(repo, "remote", "add", "origin", `${repo} server`);
    expect(await gitFetchTransfer(repo, ref, {})).toBe(snapshot);
    expect(git(repo, "for-each-ref", "refs/agent-deck/import")).toBe("");
    expect(existsSync(marker), "fetch cleanup").toBe(false);
  });

  it("restores only a clean checkout at the base, the work uncommitted again", async () => {
    const { repo, base, snapshot } = fixture("clean", baseFiles, edit);
    // Dirty: untouched.
    writeFileSync(path.join(repo, "mine.txt"), "local work\n");
    expect(await gitRestoreSnapshotInPlace(repo, snapshot, base)).toBe(false);
    expect(readFileSync(path.join(repo, "mine.txt"), "utf8")).toBe("local work\n");
    rmSync(path.join(repo, "mine.txt"));
    // An ignored file elsewhere does not stand in the way.
    writeFileSync(path.join(repo, "other.log"), "x\n");
    expect(await gitRestoreSnapshotInPlace(repo, snapshot, base)).toBe(true);
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
    // The working tree is exactly the snapshot's tree; the new file is untracked again.
    expect(workingTree(repo)).toBe(git(repo, "rev-parse", `${snapshot}^{tree}`));
    expect(git(repo, "ls-files", "--others", "--exclude-standard")).toBe("new.md");
    expect(blob(repo, snapshot, "README.md")).toBe("server");
  });

  it("never moves HEAD: a checkout behind the base goes to a fresh worktree", async () => {
    const { repo, base, snapshot } = fixture("behind", baseFiles, edit);
    // The base is one commit ahead of this checkout's HEAD.
    git(repo, "reset", "-q", "--hard", base);
    writeFileSync(path.join(repo, "older.md"), "older\n");
    git(repo, "add", "older.md");
    git(repo, "commit", "-qm", "older");
    const ahead = git(repo, "rev-parse", "HEAD");
    git(repo, "reset", "-q", "--hard", "HEAD~1");
    expect(await gitRestoreSnapshotInPlace(repo, snapshot, ahead)).toBe(false);
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
    expect(git(repo, "status", "--porcelain")).toBe("");
  });

  it("refuses an ignored file at, inside or around a path the snapshot writes", async () => {
    // The snapshot replaces the directory assets/ with a file: an ignored log
    // inside the directory would be deleted by the merge.
    const { repo, base, snapshot } = fixture(
      "ignored",
      { ...baseFiles, "assets/a.txt": "a\n" },
      (server) => {
        rmSync(path.join(server, "assets"), { recursive: true });
        writeFileSync(path.join(server, "assets"), "now a file\n");
        writeFileSync(path.join(server, "keep.log"), "server log\n");
      },
    );
    writeFileSync(path.join(repo, "assets", "local.log"), "my local log\n");
    expect(await gitRestoreSnapshotInPlace(repo, snapshot, base)).toBe(false);
    expect(readFileSync(path.join(repo, "assets", "local.log"), "utf8")).toBe("my local log\n");
    rmSync(path.join(repo, "assets", "local.log"));
    // The same path, ignored here (keep.log is forced into the snapshot).
    writeFileSync(path.join(repo, "keep.log"), "mine\n");
    expect(await gitRestoreSnapshotInPlace(repo, snapshot, base)).toBe(false);
    expect(readFileSync(path.join(repo, "keep.log"), "utf8")).toBe("mine\n");
    expect(git(repo, "rev-parse", "HEAD")).toBe(base);
  });

  it("runs no hook of the checkout (the snapshot is someone else's code)", async () => {
    const { repo, base, snapshot } = fixture("hooks", baseFiles, edit);
    const marker = path.join(scratch, "hook ran");
    const hook = `#!/bin/sh\necho ran > "${marker.replace(/\\/g, "/")}"\n`;
    writeFileSync(path.join(repo, ".git", "hooks", "post-merge"), hook, { mode: 0o755 });
    // husky-style: core.hooksPath in the repository's own config.
    const husky = path.join(scratch, "husky hooks");
    mkdirSync(husky);
    writeFileSync(path.join(husky, "post-merge"), hook, { mode: 0o755 });
    writeFileSync(path.join(husky, "post-index-change"), hook, { mode: 0o755 });
    git(repo, "config", "core.hooksPath", husky);
    // A new mtime with the same content: the clean check's status refreshes the index.
    const later = new Date(Date.now() + 60_000);
    utimesSync(path.join(repo, "README.md"), later, later);
    expect(await gitRestoreSnapshotInPlace(repo, snapshot, base)).toBe(true);
    expect(existsSync(marker)).toBe(false);
  });

  it("says when the merge happened but the commit could not be undone", async () => {
    const { repo, base, snapshot } = fixture("reset", baseFiles, edit);
    const lock = path.join(repo, ".git", "index.lock");
    const failure = await gitRestoreSnapshotInPlace(repo, snapshot, base, {
      afterMerge: async () => writeFileSync(lock, ""),
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SnapshotResetError);
    expect(String((failure as Error).message)).toContain(`git reset --mixed ${base}`);
    rmSync(lock);
    expect(git(repo, "rev-parse", "HEAD")).toBe(snapshot);
  });
});
