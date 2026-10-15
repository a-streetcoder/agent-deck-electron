import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * SRV-12c1 session move, without Pi: a local backend (A) prepares the export and
 * pushes the snapshot to a transfer ref on the origin (a local bare repository
 * stands in for GitHub); a shared server (B, behind the trusted proxy) imports
 * it; A then freezes its session into a pointer.
 */
const scratch = mkdtempSync(path.join(tmpdir(), "deck session move "));
const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const bare = path.join(scratch, "origin.git");
const localClone = path.join(scratch, "local app");
const serverClone = path.join(scratch, "server app");
const otherDir = path.join(scratch, "other");
const fakeHome = path.join(scratch, "home");
const savedEnv = { ...process.env };

const PROJECT_A = randomUUID();
const PROJECT_UNSHARED = randomUUID();
const PROJECT_B = randomUUID();
const S_OK = randomUUID();
const S_GOOGLE = randomUUID();
const S_DRAFT = randomUUID();
const S_LOOP = randomUUID();
const S_UNSHARED = randomUUID();
const ORIGIN = "https://deck.example.test";
const EMAIL = "andrea@example.com";
// A model the requester's providers offer (an OpenAI key below), and one they do not.
const OFFERED = { kind: "parent", provider: "openai", model: "gpt-4o-mini" };
const UNOFFERED = { kind: "parent", provider: "google", model: "gemini-2.5-flash" };

// Trusted proxy for B: a local JWKS and signed Access assertions.
const TEAM = "team.cloudflareaccess.test";
const AUD = "aud-move";
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
const andrea = { "cf-access-jwt-assertion": assertionFor(EMAIL) };

let jwks: Server;
let a: AgentDeckServer;
let b: AgentDeckServer;
let dataB = "";
const urlA = (p: string) => `http://127.0.0.1:${a.port}${p}`;
const urlB = (p: string) => `http://127.0.0.1:${b.port}${p}`;
const post = (url: string, body: unknown, headers: Record<string, string> = {}, method = "POST") =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
const importOn = (body: unknown) =>
  post(urlB(`/projects/${PROJECT_B}/sessions/import`), body, andrea);

interface Shared {
  envelope: {
    localSessionId: string;
    transcript: string;
    transfer: { mode: string; ref?: string; baseHead?: string };
  };
  projectId: string;
  handoff: string;
}
async function share(id: string, body: Record<string, unknown>): Promise<Shared> {
  const res = await post(urlA(`/sessions/${id}/share`), body);
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(200);
  return (await res.json()) as Shared;
}

/** One RPC request on A; answers its reply and the snapshot pushed before it. */
function rpc(request: Record<string, unknown>) {
  return new Promise<{ ok: boolean; error?: string; snapshot?: { cells: unknown[] } }>(
    (resolve, reject) => {
      let snapshot: { cells: unknown[] } | undefined;
      const socket = new WebSocket(`ws://127.0.0.1:${a.port}/rpc`);
      socket.on("open", () => socket.send(JSON.stringify({ id: 3, request })));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as {
          kind: string;
          id?: number;
          ok: boolean;
          error?: string;
          message?: { type: string; state?: { cells: unknown[] } };
        };
        if (frame.kind === "push" && frame.message?.type === "snapshot")
          snapshot = frame.message.state;
        if (frame.kind !== "reply" || frame.id !== 3) return;
        socket.close();
        resolve({ ...frame, snapshot });
      });
      socket.on("error", reject);
    },
  );
}

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
  for (const clone of [localClone, serverClone]) {
    git(scratch, "clone", "-q", bare, clone);
    git(clone, "config", "user.email", "t@example.test");
    git(clone, "config", "user.name", "t");
  }
  mkdirSync(otherDir);
  // The requester's (operator's) provider: an OpenAI key, never used for a call.
  mkdirSync(path.join(fakeHome, ".pi", "agent"), { recursive: true });
  writeFileSync(
    path.join(fakeHome, ".pi", "agent", "auth.json"),
    JSON.stringify({ openai: { type: "api_key", key: "sk-test-not-a-secret" } }),
  );
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: fakeHome, USERPROFILE: fakeHome });

  const now = new Date().toISOString();
  const dataA = mkdtempSync(path.join(scratch, "data-a-"));
  const piFile = (name: string) => {
    const file = path.join(dataA, `${name}.jsonl`);
    writeFileSync(file, transcriptFor(localClone));
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
      { id: PROJECT_UNSHARED, path: otherDir, name: "other", createdAt: now },
    ]),
  );
  const base = { cwd: localClone, createdAt: now, updatedAt: now, projectId: PROJECT_A };
  writeFileSync(
    path.join(dataA, "sessions.json"),
    JSON.stringify([
      {
        id: S_OK,
        ...base,
        lifecycle: "started",
        title: "Fix it",
        piSessionFile: piFile("ok"),
        launchPlan: OFFERED,
        // A pointer is idle: these go when it freezes.
        status: "failed",
        lastError: "boom",
        needsAttention: true,
      },
      { id: S_GOOGLE, ...base, piSessionFile: piFile("google"), launchPlan: UNOFFERED },
      { id: S_DRAFT, ...base, lifecycle: "draft" },
      { id: S_LOOP, ...base, loopReviewRunId: "run-1", piSessionFile: piFile("loop") },
      {
        id: S_UNSHARED,
        ...base,
        cwd: otherDir,
        projectId: PROJECT_UNSHARED,
        piSessionFile: piFile("unshared"),
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
  process.env.AGENT_DECK_OPERATOR_EMAIL = EMAIL;
  dataB = mkdtempSync(path.join(scratch, "data-b-"));
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

const refsOnOrigin = () => git(bare, "for-each-ref", "--format=%(refname)", "refs/agent-deck");
const serverBranches = () =>
  git(serverClone, "branch", "--list", "agent-deck/*", "--format=%(refname:short)");

describe("session move: local export", () => {
  it("refuses drafts, Loop sessions and sessions of an unshared project", async () => {
    for (const id of [S_DRAFT, S_LOOP, S_UNSHARED]) {
      const res = await post(urlA(`/sessions/${id}/share/preflight`), {});
      expect(res.status, id).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("share_refused");
    }
  });

  it("lists untracked files by name, never ignored ones, and the local commits", async () => {
    writeFileSync(path.join(localClone, "README.md"), "two\n");
    git(localClone, "add", "README.md");
    writeFileSync(path.join(localClone, "secret.txt"), "token\n");
    writeFileSync(path.join(localClone, "debug.log"), "noise\n");
    const res = await post(urlA(`/sessions/${S_OK}/share/preflight`), {});
    expect(res.status).toBe(200);
    const { plan } = (await res.json()) as {
      plan: {
        branch: string;
        files: { tracked: number; untracked: string[] };
        localCommits: number | null;
        dirtySubmodules: string[];
      };
    };
    expect(plan).toMatchObject({
      branch: "main",
      files: { tracked: 1, untracked: ["secret.txt"] },
      localCommits: 0,
      dirtySubmodules: [],
    });
  });

  it("answers a push failure with the conversation fallback and touches nothing", async () => {
    const before = git(localClone, "status", "--porcelain");
    git(localClone, "remote", "set-url", "origin", path.join(scratch, "missing.git"));
    try {
      const res = await post(urlA(`/sessions/${S_OK}/share`), {
        mode: "snapshot",
        untracked: ["secret.txt"],
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        code: "share_push_failed",
        fallback: "conversation",
      });
    } finally {
      git(localClone, "remote", "set-url", "origin", bare);
    }
    expect(git(localClone, "status", "--porcelain")).toBe(before);
    expect(refsOnOrigin()).toBe("");
    expect(a.sessions.mutationClaims.owner(S_OK)).toBeUndefined();
  });

  it("refuses a snapshot when the untracked files differ from what the user agreed to", async () => {
    const res = await post(urlA(`/sessions/${S_OK}/share`), { mode: "snapshot", untracked: [] });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "share_plan_changed",
      untracked: ["secret.txt"],
    });
    expect(refsOnOrigin()).toBe("");
  });

  it("refuses a transcript whose ancestry would loop, before any git step", async () => {
    const file =
      a.sessions.get(S_OK)?.meta.piSessionFile ??
      (
        (await (await fetch(urlA("/sessions"))).json()) as { sessions: SessionMeta[] }
      ).sessions.find((s) => s.id === S_OK)!.piSessionFile!;
    const good = readFileSync(file, "utf8");
    writeFileSync(file, `${good}${JSON.stringify({ type: "custom", id: "a", parentId: "a" })}\n`);
    try {
      const res = await post(urlA(`/sessions/${S_OK}/share`), {
        mode: "snapshot",
        untracked: ["secret.txt"],
      });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/parent/);
      expect(refsOnOrigin()).toBe("");
    } finally {
      writeFileSync(file, good);
    }
  });

  it("freezes the session through the hand-off and releases it on abort", async () => {
    const { envelope, handoff } = await share(S_OK, {
      mode: "snapshot",
      untracked: ["secret.txt"],
    });
    expect(refsOnOrigin()).toBe(`refs/agent-deck/transfer/${S_OK}`);
    // The real index still holds only what the user staged.
    expect(git(localClone, "diff", "--cached", "--name-only")).toBe("README.md");
    expect(git(localClone, "rev-list", "--count", "HEAD")).toBe("1");
    // Nothing changes the session while it is handed over.
    expect(a.sessions.mutationClaims.owner(S_OK)).toBe("share");
    const prompt = await rpc({ type: "prompt", sessionId: S_OK, message: "hi" });
    expect(prompt.error).toMatch(/^session_moving:/);
    for (const blocked of [
      post(urlA(`/sessions/${S_OK}`), { title: "Other" }, {}, "PATCH"),
      post(urlA(`/sessions/${S_OK}/composer-draft`), { draft: null }, {}, "PUT"),
    ]) {
      const res = await blocked;
      expect(res.status, res.url).toBe(409);
      expect(((await res.json()) as { code: string }).code).toBe("session_moving");
    }
    const aborted = await post(urlA(`/sessions/${S_OK}/share/abort`), {
      ref: envelope.transfer.ref,
      handoff,
    });
    expect(aborted.status).toBe(200);
    expect(refsOnOrigin()).toBe("");
    expect(a.sessions.mutationClaims.owner(S_OK)).toBeUndefined();
  });

  it("a new share removes the ref an unfinished one pushed", async () => {
    await share(S_OK, { mode: "snapshot", untracked: ["secret.txt"] });
    expect(refsOnOrigin()).toBe(`refs/agent-deck/transfer/${S_OK}`);
    const { handoff } = await share(S_OK, { mode: "conversation" });
    expect(refsOnOrigin()).toBe("");
    await post(urlA(`/sessions/${S_OK}/share/abort`), { handoff });
  });

  it("captures the snapshot without running a hook of the checkout", async () => {
    const hooks = path.join(scratch, "device hooks");
    const marker = path.join(scratch, "device-hook-ran");
    mkdirSync(hooks, { recursive: true });
    for (const name of ["post-index-change", "reference-transaction"])
      writeFileSync(
        path.join(hooks, name),
        `#!/bin/sh\necho ${name} >> "${marker.replace(/\\/g, "/")}"\n`,
        {
          mode: 0o755,
        },
      );
    git(localClone, "config", "core.hooksPath", hooks);
    // A new mtime with the same content: the plan's status refreshes the real index.
    const touch = () => {
      const later = new Date(Date.now() + 60_000 + Math.random() * 60_000);
      utimesSync(path.join(localClone, "README.md"), later, later);
    };
    try {
      touch();
      expect((await post(urlA(`/sessions/${S_OK}/share/preflight`), {})).status).toBe(200);
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : "", "preflight").toBe("");
      touch();
      const { envelope, handoff } = await share(S_OK, {
        mode: "snapshot",
        untracked: ["secret.txt"],
      });
      await post(urlA(`/sessions/${S_OK}/share/abort`), { ref: envelope.transfer.ref, handoff });
      expect(existsSync(marker) ? readFileSync(marker, "utf8") : "").toBe("");
    } finally {
      git(localClone, "config", "--unset", "core.hooksPath");
    }
  });

  it("moves only the conversation of a checkout that tracks LFS files", async () => {
    // A tracked file under the LFS filter, without git-lfs: a local attributes file.
    const attributes = path.join(localClone, ".git", "info", "attributes");
    mkdirSync(path.dirname(attributes), { recursive: true });
    writeFileSync(attributes, "README.md filter=lfs\n");
    try {
      const res = await post(urlA(`/sessions/${S_OK}/share/preflight`), {});
      expect(res.status).toBe(200);
      expect(((await res.json()) as { plan: { lfs?: boolean } }).plan.lfs).toBe(true);
      const snapshot = await post(urlA(`/sessions/${S_OK}/share`), {
        mode: "snapshot",
        untracked: ["secret.txt"],
      });
      expect(snapshot.status).toBe(409);
      expect(await snapshot.json()).toMatchObject({
        code: "share_refused",
        error: "LFS repositories cannot be moved yet.",
      });
      expect(refsOnOrigin()).toBe("");
      const { envelope, handoff } = await share(S_OK, { mode: "conversation" });
      expect(envelope.transfer.mode).toBe("conversation");
      await post(urlA(`/sessions/${S_OK}/share/abort`), { handoff });
    } finally {
      rmSync(attributes, { force: true });
    }
  });

  const snapshotShare = () =>
    post(urlA(`/sessions/${S_OK}/share`), { mode: "snapshot", untracked: ["secret.txt"] });

  it("refuses a snapshot whose consented untracked file falls under the LFS filter", async () => {
    const attributes = path.join(localClone, ".git", "info", "attributes");
    mkdirSync(path.dirname(attributes), { recursive: true });
    writeFileSync(attributes, "secret.txt filter=lfs\n");
    try {
      const preflight = await post(urlA(`/sessions/${S_OK}/share/preflight`), {});
      expect(((await preflight.json()) as { plan: { lfs?: boolean } }).plan.lfs).toBe(true);
      const res = await snapshotShare();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "LFS repositories cannot be moved yet." });
      expect(refsOnOrigin()).toBe("");
    } finally {
      rmSync(attributes, { force: true });
    }
  });

  it("refuses a snapshot when LFS detection fails, rather than pushing it", async () => {
    // A config only git grep reads, and rejects: the attributes scan cannot run.
    git(localClone, "config", "grep.patternType", "bogus");
    try {
      const preflight = await post(urlA(`/sessions/${S_OK}/share/preflight`), {});
      expect(((await preflight.json()) as { plan: { lfs?: boolean } }).plan.lfs).toBe(true);
      const res = await snapshotShare();
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({
        error: "LFS detection failed, so the work cannot be moved with its files.",
      });
      expect(refsOnOrigin()).toBe("");
    } finally {
      git(localClone, "config", "--unset", "grep.patternType");
    }
  });
});

describe("session move: server import and the frozen pointer", () => {
  let serverSessionId = "";
  let snapshotShare: Shared;

  it("imports a snapshot into its own worktree with the snapshot commit undone", async () => {
    snapshotShare = await share(S_OK, { mode: "snapshot", untracked: ["secret.txt"] });
    const { envelope, projectId } = snapshotShare;
    expect(projectId).toBe(PROJECT_B);
    expect((envelope as unknown as { dropped: string[] }).dropped).toEqual(
      expect.arrayContaining(["checkpoints", "subagent runs", "plan history"]),
    );
    expect((await post(urlB(`/projects/${PROJECT_B}/sessions/import`), envelope)).status).toBe(401);
    // Author records that name someone else: the import makes them the requester's.
    (envelope as unknown as { authors: unknown[] }).authors = [
      {
        signature: "a".repeat(64),
        author: { id: "mallory@example.com", name: "Mallory" },
        entryId: "e1",
        claimed: true,
      },
    ];
    // The server cannot delete the ref (no push rights here): the device does it.
    git(serverClone, "remote", "set-url", "--push", "origin", path.join(scratch, "missing.git"));
    let body: { sessionId: string; mode: string; transferRefDeleted: boolean };
    try {
      const res = await importOn(envelope);
      expect(res.status).toBe(201);
      body = (await res.json()) as typeof body;
    } finally {
      git(serverClone, "remote", "set-url", "--push", "origin", bare);
    }
    expect(body).toMatchObject({ mode: "snapshot", worktree: true, transferRefDeleted: false });
    serverSessionId = body.sessionId;
    expect(refsOnOrigin()).toBe(`refs/agent-deck/transfer/${S_OK}`);

    const { sessions } = (await (await fetch(urlB("/sessions"), { headers: andrea })).json()) as {
      sessions: SessionMeta[];
    };
    const imported = sessions.find((s) => s.id === serverSessionId)!;
    expect(imported).toMatchObject({
      title: "Fix it",
      projectId: PROJECT_B,
      createdBy: { id: EMAIL },
      sharedFrom: { localSessionId: S_OK, mode: "snapshot" },
      activity: "idle",
      launchPlan: { provider: "openai", model: "gpt-4o-mini" },
    });
    expect((imported.launchPlan as { thinking?: string }).thinking).toBeUndefined();
    expect(imported.forkedFrom).toBeUndefined();
    const wt = imported.worktreePath!;
    expect(imported.cwd).toBe(wt);
    expect(git(wt, "log", "-1", "--format=%H")).toBe(envelope.transfer.baseHead);
    // Unstaged edits (" M", not "M "): the reset is --mixed.
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" });
    expect(status.split("\n").filter(Boolean).sort()).toEqual([" M README.md", "?? secret.txt"]);
    const header = JSON.parse(readFileSync(imported.piSessionFile!, "utf8").split("\n")[0]!);
    expect(header.cwd).toBe(wt);
    // The main checkout of the shared project is untouched.
    expect(git(serverClone, "status", "--porcelain")).toBe("");
    expect(git(serverClone, "for-each-ref", "refs/agent-deck")).toBe("");
    // Attribution is the requester's, not what the device sent.
    const authors = JSON.parse(
      readFileSync(path.join(dataB, "session-authors.json"), "utf8"),
    ) as Array<{
      id: string;
      turns: Array<{ author: { id: string; name?: string } }>;
    }>;
    expect(authors.find((row) => row.id === serverSessionId)?.turns.map((t) => t.author)).toEqual([
      { id: EMAIL },
    ]);

    const events = (await (
      await fetch(urlB(`/events?sessionId=${serverSessionId}`), { headers: andrea })
    ).json()) as { events: Array<{ kind: string; payload: Record<string, unknown> }> };
    const sharedEvent = events.events.find((e) => e.kind === "session.shared");
    expect(sharedEvent?.payload).toMatchObject({ direction: "in", mode: "snapshot" });
    expect(JSON.stringify(sharedEvent)).not.toContain(scratch.replace(/\\/g, "\\\\"));
  });

  it("refuses share/abort on the shared server, as preflight and share", async () => {
    const res = await post(urlB(`/sessions/${serverSessionId}/share/abort`), {}, andrea);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "share_refused" });
  });

  it("refuses a model the requester is not offered, leaving nothing behind", async () => {
    const before = serverBranches();
    const { envelope, handoff } = await share(S_GOOGLE, { mode: "conversation" });
    const res = await importOn(envelope);
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "model_unavailable" });
    expect(serverBranches()).toBe(before);
    await post(urlA(`/sessions/${S_GOOGLE}/share/abort`), { handoff });
  });

  it("rejects bad exports, unknown projects and a looping transcript", async () => {
    expect((await importOn({ version: 2 })).status).toBe(400);
    expect(
      (await post(urlB(`/projects/${randomUUID()}/sessions/import`), { version: 1 }, andrea))
        .status,
    ).toBe(404);
    const looping = {
      ...snapshotShare.envelope,
      localSessionId: randomUUID(),
      transfer: { mode: "conversation" },
      transcript: `${transcriptFor("C:/x")}${JSON.stringify({ type: "custom", id: "a", parentId: "a" })}\n`,
    };
    const res = await importOn(looping);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/parent/);
  });

  it("imports a conversation once, even when two posts race, with the notice", async () => {
    const { envelope } = await share(S_OK, { mode: "conversation" });
    // The same device session again is refused and names the earlier copy.
    const again = await importOn(envelope);
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({
      code: "session_already_imported",
      sessionId: serverSessionId,
    });
    const fresh = { ...envelope, localSessionId: randomUUID() };
    const raced = await Promise.all([importOn(fresh), importOn(fresh)]);
    expect(raced.map((res) => res.status).sort()).toEqual([201, 409]);
    const loser = raced.find((res) => res.status === 409)!;
    // Still running: pending, and no session to link yet.
    const pending = (await loser.json()) as { code: string; pending?: boolean; sessionId?: string };
    expect(pending).toMatchObject({ code: "session_already_imported", pending: true });
    expect(pending.sessionId).toBeUndefined();
    // A retry whose export differs from the earlier copy is not the same move.
    const changed = await importOn({
      ...envelope,
      transcript:
        `${envelope.transcript}${JSON.stringify({ type: "custom", id: "zz", parentId: "e1" })}`.concat(
          String.fromCharCode(10),
        ),
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toMatchObject({
      code: "export_changed",
      sessionId: serverSessionId,
    });
    const { sessionId } = (await raced.find((res) => res.status === 201)!.json()) as {
      sessionId: string;
    };
    expect(b.sessions.list().find((s) => s.id === sessionId)).toBeUndefined(); // not live
    const { sessions } = (await (await fetch(urlB("/sessions"), { headers: andrea })).json()) as {
      sessions: SessionMeta[];
    };
    const imported = sessions.find((s) => s.id === sessionId)!;
    expect(git(imported.cwd, "status", "--porcelain")).toBe("");
    const last = JSON.parse(
      readFileSync(imported.piSessionFile!, "utf8").trim().split("\n").at(-1)!,
    );
    expect(last).toMatchObject({ type: "custom_message" });
    expect(last.content).toMatch(/^Earlier edits from .+ are not in this workspace\.$/);
  });

  it("freezes the local session into a read-only pointer and removes the ref from the device", async () => {
    // The conversation share above replaced the snapshot's hand-off: it is stale now.
    const stale = await post(
      urlA(`/sessions/${S_OK}/shared-to`),
      { serverOrigin: ORIGIN, serverSessionId, mode: "snapshot", handoff: snapshotShare.handoff },
      {},
      "PATCH",
    );
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "share_stale" });
    const { handoff } = await share(S_OK, { mode: "snapshot", untracked: ["secret.txt"] });
    const wrong = await post(
      urlA(`/sessions/${S_OK}/shared-to`),
      { serverOrigin: "https://elsewhere.example", serverSessionId, mode: "snapshot", handoff },
      {},
      "PATCH",
    );
    expect(wrong.status).toBe(409);
    const res = await post(
      urlA(`/sessions/${S_OK}/shared-to`),
      { serverOrigin: ORIGIN, serverSessionId, mode: "snapshot", handoff },
      {},
      "PATCH",
    );
    expect(res.status).toBe(200);
    const { session } = (await res.json()) as { session: SessionMeta };
    expect(session.sharedTo).toMatchObject({ serverOrigin: ORIGIN, serverSessionId });
    expect(session).toMatchObject({ title: "Fix it", activity: "idle" });
    expect(session.status).toBeUndefined();
    expect(session.needsAttention).toBeUndefined();
    expect(a.sessions.mutationClaims.owner(S_OK)).toBeUndefined();
    // The device removes the ref the server could not.
    const removed = await post(urlA(`/sessions/${S_OK}/share/abort`), {
      ref: `refs/agent-deck/transfer/${S_OK}`,
    });
    expect(removed.status).toBe(200);
    expect(refsOnOrigin()).toBe("");
    const outEvents = (await (await fetch(urlA(`/events?sessionId=${S_OK}`))).json()) as {
      events: Array<{ kind: string; payload: Record<string, unknown> }>;
    };
    expect(outEvents.events.find((e) => e.kind === "session.shared")?.payload).toMatchObject({
      direction: "out",
      serverSessionId,
      serverOrigin: ORIGIN,
    });

    // Opening it runs no Pi and shows the last local transcript.
    expect((await post(urlA(`/sessions/${S_OK}/resume`), {})).status).toBe(200);
    expect(a.sessions.get(S_OK)).toBeUndefined();
    const opened = await rpc({ type: "subscribe_session", sessionId: S_OK });
    expect(opened.ok).toBe(true);
    expect(JSON.stringify(opened.snapshot?.cells)).toContain("fix it");
    // Every mutation but fork, delete, pin and attention refuses it.
    const refusals = [
      post(urlA(`/sessions/${S_OK}/history/rerun`), { entryId: "e1" }),
      post(urlA(`/sessions/${S_OK}/history/fork`), { entryId: "e1" }),
      post(urlA(`/sessions/${S_OK}`), { title: "Other" }, {}, "PATCH"),
      post(urlA(`/sessions/${S_OK}/merge`), {}),
      post(urlA(`/sessions/${S_OK}/plan/items/i1/retry`), {}),
      post(urlA(`/sessions/${S_OK}/composer-draft`), { draft: null }, {}, "PUT"),
    ];
    for (const refused of await Promise.all(refusals)) {
      expect(refused.status, refused.url).toBe(409);
      expect(((await refused.json()) as { code: string }).code).toBe("session_shared");
    }
    expect((await post(urlA(`/sessions/${S_OK}/share/preflight`), {})).status).toBe(409);
    const prompt = await rpc({ type: "prompt", sessionId: S_OK, message: "hi" });
    expect(prompt.ok).toBe(false);
    expect(prompt.error).toMatch(/^session_shared:/);
  });

  it("keeps the thinking level the session ran at over the server default", async () => {
    expect(
      (await post(urlB("/settings"), { defaultThinking: "low" }, andrea, "PATCH")).status,
    ).toBe(200);
    const { envelope, handoff } = await share(S_GOOGLE, { mode: "conversation" });
    const entry = {
      type: "thinking_level_change",
      id: "t1",
      parentId: "e1",
      thinkingLevel: "high",
    };
    const res = await importOn({
      ...envelope,
      localSessionId: randomUUID(),
      meta: {
        ...(envelope as unknown as { meta: object }).meta,
        provider: "openai",
        model: "gpt-4o-mini",
      },
      transcript: `${envelope.transcript}${JSON.stringify(entry)}\n`,
    });
    expect(res.status).toBe(201);
    const { sessionId } = (await res.json()) as { sessionId: string };
    const { sessions } = (await (await fetch(urlB("/sessions"), { headers: andrea })).json()) as {
      sessions: SessionMeta[];
    };
    const imported = sessions.find((s) => s.id === sessionId)!;
    // Durable: the configuration every later resolution (resume, refresh) reads.
    expect(imported.launchResourceConfig).toMatchObject({ thinkingOverride: "high" });
    expect((imported.launchPlan as { thinking?: string }).thinking).toBe("high");
    await post(urlA(`/sessions/${S_GOOGLE}/share/abort`), { handoff });
  });

  it("links exclusively: a replacing share and the link never both win", async () => {
    const { handoff } = await share(S_GOOGLE, { mode: "conversation" });
    const [linked, replaced] = await Promise.all([
      post(
        urlA(`/sessions/${S_GOOGLE}/shared-to`),
        { serverOrigin: ORIGIN, serverSessionId: randomUUID(), mode: "conversation", handoff },
        {},
        "PATCH",
      ),
      post(urlA(`/sessions/${S_GOOGLE}/share`), { mode: "conversation" }),
    ]);
    expect([linked.status, replaced.status].filter((status) => status === 200)).toHaveLength(1);
    const meta = (
      (await (await fetch(urlA("/sessions"))).json()) as { sessions: SessionMeta[] }
    ).sessions.find((s) => s.id === S_GOOGLE)!;
    // A pointer exactly when the link won.
    expect(Boolean(meta.sharedTo)).toBe(linked.status === 200);
    if (replaced.status === 200) {
      const { handoff: next } = (await replaced.json()) as { handoff: string };
      await post(urlA(`/sessions/${S_GOOGLE}/share/abort`), { handoff: next });
    }
  });
});
