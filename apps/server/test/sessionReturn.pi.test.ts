import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * SRV-12c3 with a real Pi: the round trip. A session runs on the device (one
 * server instance), moves with its edits to the shared server (a second one,
 * behind the trusted proxy; a local bare repository is "GitHub"), works there,
 * and comes back: the server pushes the snapshot with the owner's GitHub
 * connection, the device restores the working tree into its original checkout
 * and resumes the same local session, which answers a prompt; the server copy
 * becomes a pointer to the device.
 */
process.env.AGENT_DECK_TEST = "1";

const scratch = mkdtempSync(path.join(tmpdir(), "deck return pi "));
const home = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const bare = path.join(scratch, "origin.git");
const localClone = path.join(scratch, "local app");
const serverClone = path.join(scratch, "server app");
const PROJECT_A = randomUUID();
const PROJECT_B = randomUUID();
const ORIGIN = "https://deck.example.test";
const savedEnv = { ...process.env };

const TEAM = "team.cloudflareaccess.test";
const AUD = "aud-return-pi";
const EMAIL = "andrea@example.com";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
function assertion(): string {
  const now = Math.floor(Date.now() / 1000);
  const signed = `${b64({ alg: "RS256", kid: "k1" })}.${b64({
    iss: `https://${TEAM}`,
    aud: [AUD],
    iat: now,
    exp: now + 600,
    email: EMAIL,
  })}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}

/** The tree of a working directory as git would commit it (a throwaway index). */
const workingTree = (dir: string): string => {
  const env = { ...process.env, GIT_INDEX_FILE: path.join(scratch, `index-${randomUUID()}`) };
  execFileSync("git", ["add", "-A"], { cwd: dir, env });
  return execFileSync("git", ["write-tree"], { cwd: dir, env, encoding: "utf8" }).trim();
};

let mock: MockProviderServer;

let jwks: Server;
let a: AgentDeckServer;
let b: AgentDeckServer;
const post = (url: string, body: unknown, headers: Record<string, string> = {}, method = "POST") =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

async function waitFor(check: () => boolean, timeoutMs = 60_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error("timed out");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

beforeAll(async () => {
  const work = path.join(scratch, "work");
  mkdirSync(work);
  git(work, "init", "-q", "-b", "main");
  git(work, "config", "user.email", "t@example.test");
  git(work, "config", "user.name", "t");
  writeFileSync(path.join(work, "README.md"), "one\n");
  git(work, "add", ".");
  git(work, "commit", "-qm", "one");
  git(scratch, "clone", "-q", "--bare", work, bare);
  for (const clone of [localClone, serverClone]) git(scratch, "clone", "-q", bare, clone);

  mock = await startMockProvider({ reply: () => "ok from pi" });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  process.env.AGENT_DECK_DEFAULT_PROVIDER = MOCK_PROVIDER_ID;
  process.env.AGENT_DECK_DEFAULT_MODEL = MOCK_MODEL_ID;
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({
    HOME: home,
    USERPROFILE: home,
    PI_SKIP_VERSION_CHECK: "1",
  });

  const now = new Date().toISOString();
  const dataA = mkdtempSync(path.join(scratch, "data-a-"));
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
  // The operator keeps the shared agent dir (HOME above), so Pi finds the mock model.
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
    ]),
  );
  // The owner's (operator's) GitHub connection; the bare repository needs no login.
  writeFileSync(path.join(dataB, "github.json"), JSON.stringify({ token: "test-not-a-secret" }));
  b = await startServer({ dataDir: dataB });
  // The requester's providers must offer the session's model (as for a fork): a key for
  // the mock provider in the shared agent dir, and the catalog discovered once.
  mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(
    path.join(home, ".pi", "agent", "auth.json"),
    JSON.stringify({ [MOCK_PROVIDER_ID]: { type: "api_key", key: "test-not-a-secret" } }),
  );
  const discovered = await post(
    `http://127.0.0.1:${b.port}/runtime/models/discover`,
    {},
    { "cf-access-jwt-assertion": assertion() },
  );
  expect(discovered.status).toBe(200);
});

afterAll(async () => {
  await a?.close();
  await b?.close();
  await mock?.close();
  await new Promise<void>((resolve) => (jwks ? jwks.close(() => resolve()) : resolve()));
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(scratch, { recursive: true, force: true, maxRetries: 3 });
});

describe("session return with a real Pi", () => {
  it("goes to the server and back, keeping the conversation and the working tree", async () => {
    const urlA = (p: string) => `http://127.0.0.1:${a.port}${p}`;
    const urlB = (p: string) => `http://127.0.0.1:${b.port}${p}`;
    const as = () => ({ "cf-access-jwt-assertion": assertion() });
    const created = await post(urlA("/sessions"), {
      startImmediately: true,
      projectId: PROJECT_A,
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: SessionMeta };
    const local = a.sessions.get(session.id)!;
    await local.prompt("first turn on the device");
    await waitFor(
      () => local.snapshot().state.agentStatus === "idle" && Boolean(local.piSessionFile),
    );
    const base = git(localClone, "rev-parse", "HEAD");

    // Out: the device's edits travel with the session.
    writeFileSync(path.join(localClone, "README.md"), "edited on the device\n");
    writeFileSync(path.join(localClone, "notes.md"), "new file\n");
    const shared = await post(urlA(`/sessions/${session.id}/share`), {
      mode: "snapshot",
      untracked: ["notes.md"],
    });
    expect(shared.status).toBe(200);
    const out = (await shared.json()) as { envelope: unknown; handoff: string };
    const imported = await post(urlB(`/projects/${PROJECT_B}/sessions/import`), out.envelope, as());
    expect(imported.status, await imported.clone().text()).toBe(201);
    const { sessionId } = (await imported.json()) as { sessionId: string };
    const linked = await post(
      urlA(`/sessions/${session.id}/shared-to`),
      { serverOrigin: ORIGIN, serverSessionId: sessionId, mode: "snapshot", handoff: out.handoff },
      {},
      "PATCH",
    );
    expect(linked.status).toBe(200);
    expect(git(bare, "for-each-ref", "refs/agent-deck")).toBe("");
    // The device checkout still holds the edits it sent (a share copies): the
    // default return, into a fresh worktree, leaves it alone.
    const deviceTree = workingTree(localClone);

    // On the server: a turn, and more work in the session worktree.
    expect((await post(urlB(`/sessions/${sessionId}/resume`), {}, as())).status).toBe(200);
    const remote = b.sessions.get(sessionId)!;
    await waitFor(() => remote.snapshot().state.cells.some((cell) => cell.kind === "user"));
    await remote.prompt("second turn on the server");
    await waitFor(() => {
      const state = remote.snapshot().state;
      return (
        state.agentStatus === "idle" &&
        state.cells.filter((cell) => cell.kind === "user").length === 2
      );
    });
    const wt = remote.meta.cwd;
    writeFileSync(path.join(wt, "README.md"), "edited on the server\n");
    writeFileSync(path.join(wt, "server.md"), "from the server\n");

    // Back: preflight, then the snapshot with the consented untracked files.
    const preflight = await post(urlB(`/sessions/${sessionId}/return`), {}, as());
    expect(preflight.status, await preflight.clone().text()).toBe(200);
    const { plan } = (await preflight.json()) as { plan: { files: { untracked: string[] } } };
    expect(plan.files.untracked.sort()).toEqual(["notes.md", "server.md"]);
    const ret = await post(
      urlB(`/sessions/${sessionId}/return`),
      { confirmedUntracked: plan.files.untracked },
      as(),
    );
    expect(ret.status, await ret.clone().text()).toBe(200);
    const back = (await ret.json()) as {
      envelope: { transfer: { ref: string; baseHead: string; commit: string } };
      handoff: string;
    };
    expect(git(bare, "for-each-ref", "--format=%(refname)", "refs/agent-deck")).toBe(
      back.envelope.transfer.ref,
    );
    // Frozen during the hand-off: the live mirror's forwarded prompt is refused.
    expect((await post(urlB(`/sessions/${sessionId}/prompt`), { text: "hi" }, as())).status).toBe(
      409,
    );

    const restored = await post(urlA(`/sessions/${session.id}/import-return`), {
      envelope: back.envelope,
      handoff: back.handoff,
    });
    expect(restored.status, await restored.clone().text()).toBe(200);
    const result = (await restored.json()) as {
      session: SessionMeta;
      restored: string;
      transferRefDeleted: boolean;
    };
    expect(result.restored).toBe("worktree");
    expect(result.transferRefDeleted).toBe(true);
    expect(result.session.sharedTo).toBeUndefined();
    expect(result.session.returnedFrom?.serverSessionId).toBe(sessionId);
    expect(git(bare, "for-each-ref", "refs/agent-deck")).toBe("");
    const closed = await post(
      urlB(`/sessions/${sessionId}/returned`),
      { deviceSessionId: session.id, handoff: back.handoff },
      as(),
      "PATCH",
    );
    expect(closed.status, await closed.clone().text()).toBe(200);
    const pointer = ((await closed.json()) as { session: SessionMeta }).session;
    expect(pointer.sharedTo).toMatchObject({ serverOrigin: null, deviceSessionId: session.id });
    expect(pointer.activity).toBe("idle");
    expect(b.sessions.get(sessionId)).toBeUndefined();
    const refused = await post(urlB(`/sessions/${sessionId}/prompt`), { text: "hi" }, as());
    expect(refused.status).toBe(409);
    expect(((await refused.json()) as { code?: string }).code).toBe("session_shared");

    // The fresh worktree is exactly the snapshot, its commit undone (HEAD is the
    // base); the device checkout is untouched.
    const restoredCwd = result.session.cwd;
    expect(restoredCwd).not.toBe(localClone);
    const { commit } = back.envelope.transfer;
    expect(git(restoredCwd, "rev-parse", "HEAD")).toBe(base);
    expect(back.envelope.transfer.baseHead).toBe(base);
    expect(workingTree(restoredCwd)).toBe(git(restoredCwd, "rev-parse", `${commit}^{tree}`));
    execFileSync("git", ["diff", "--exit-code", commit, "--", "README.md"], { cwd: restoredCwd });
    expect(git(restoredCwd, "show", `${commit}:README.md`)).toBe("edited on the server");
    expect(git(restoredCwd, "show", `${commit}:server.md`)).toBe("from the server");
    expect(workingTree(localClone)).toBe(deviceTree);
    const status = execFileSync("git", ["status", "--porcelain"], {
      cwd: restoredCwd,
      encoding: "utf8",
    });
    expect(status.split("\n").filter(Boolean).sort()).toEqual([
      " M README.md",
      "?? notes.md",
      "?? server.md",
    ]);

    // The same local session resumes with the whole conversation and answers.
    expect((await post(urlA(`/sessions/${session.id}/resume`), {})).status).toBe(200);
    const again = a.sessions.get(session.id)!;
    expect(again.isRunning).toBe(true);
    await waitFor(
      () => again.snapshot().state.cells.filter((cell) => cell.kind === "user").length === 2,
    );
    await again.prompt("third turn back on the device");
    await waitFor(() => {
      const state = again.snapshot().state;
      return (
        state.agentStatus === "idle" &&
        state.cells.filter((cell) => cell.kind === "user").length === 3
      );
    });
    const cells = again.snapshot().state.cells;
    expect(cells.filter((cell) => cell.kind === "user").map((cell) => cell.text)).toEqual([
      "first turn on the device",
      "second turn on the server",
      "third turn back on the device",
    ]);
    expect(cells.filter((cell) => cell.kind === "assistant").length).toBeGreaterThanOrEqual(3);
  });
});
