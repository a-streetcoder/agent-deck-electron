import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { transcriptThinkingLevel } from "../src/sessionTransfer.ts";

/**
 * SRV-12c1 with a real Pi: a session runs on one server instance (the device's
 * local backend), moves with a snapshot of its working tree to a second one (the
 * shared server, behind the trusted proxy; a local bare repository is "GitHub"),
 * resumes there from the imported transcript and answers a prompt. Continue
 * locally on the device is a plain fork without the link.
 */
process.env.AGENT_DECK_TEST = "1";

const scratch = mkdtempSync(path.join(tmpdir(), "deck move pi "));
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
const AUD = "aud-move-pi";
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

describe("session move with a real Pi", () => {
  it("moves a session with its edits; the server copy resumes and answers", async () => {
    const urlA = (p: string) => `http://127.0.0.1:${a.port}${p}`;
    const urlB = (p: string) => `http://127.0.0.1:${b.port}${p}`;
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

    // Work the agent left uncommitted on the device.
    writeFileSync(path.join(localClone, "README.md"), "edited on the device\n");
    writeFileSync(path.join(localClone, "notes.md"), "new file\n");
    const shared = await post(urlA(`/sessions/${session.id}/share`), {
      mode: "snapshot",
      untracked: ["notes.md"],
    });
    expect(shared.status).toBe(200);
    const { envelope, handoff } = (await shared.json()) as {
      envelope: { transfer: { baseHead: string } };
      handoff: string;
    };
    const headers = { "cf-access-jwt-assertion": assertion() };
    const imported = await post(urlB(`/projects/${PROJECT_B}/sessions/import`), envelope, headers);
    expect(imported.status, await imported.clone().text()).toBe(201);
    const { sessionId } = (await imported.json()) as { sessionId: string };
    const frozen = await fetch(urlA(`/sessions/${session.id}/shared-to`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverOrigin: ORIGIN,
        serverSessionId: sessionId,
        mode: "snapshot",
        handoff,
      }),
    });
    expect(frozen.status).toBe(200);
    expect(a.sessions.get(session.id)).toBeUndefined(); // the pointer's Pi has ended

    // The level the device session ran at (Pi records it) beats the server default.
    const ranAt = transcriptThinkingLevel(readFileSync(local.piSessionFile!, "utf8"));
    expect(ranAt).toBeDefined();
    const otherLevel = ranAt === "low" ? "high" : "low";
    expect(
      (await post(urlB("/settings"), { defaultThinking: otherLevel }, headers, "PATCH")).status,
    ).toBe(200);
    // The shared server resumes Pi from the imported transcript, in the worktree.
    const resumed = await post(urlB(`/sessions/${sessionId}/resume`), {}, headers);
    expect(resumed.status).toBe(200);
    const remote = b.sessions.get(sessionId)!;
    expect(remote.isRunning).toBe(true);
    expect((remote.meta.launch?.plan as { thinking?: string }).thinking).toBe(ranAt);
    const wt = remote.meta.cwd;
    expect(remote.meta.workspace?.path).toBe(wt);
    await waitFor(() => remote.snapshot().state.cells.some((cell) => cell.kind === "user"));
    await remote.prompt("second turn on the server");
    await waitFor(() => {
      const state = remote.snapshot().state;
      return (
        state.agentStatus === "idle" &&
        state.cells.filter((cell) => cell.kind === "user").length === 2
      );
    });
    const cells = remote.snapshot().state.cells;
    expect(cells.filter((cell) => cell.kind === "user").map((cell) => cell.text)).toEqual([
      "first turn on the device",
      "second turn on the server",
    ]);
    expect(cells.filter((cell) => cell.kind === "assistant").length).toBeGreaterThanOrEqual(2);
    // The worktree is the snapshot with the snapshot commit undone.
    expect(git(wt, "log", "-1", "--format=%H")).toBe(envelope.transfer.baseHead);
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: wt, encoding: "utf8" });
    expect(status.split("\n").filter(Boolean).sort()).toEqual([" M README.md", "?? notes.md"]);
    expect(git(bare, "for-each-ref", "refs/agent-deck")).toBe("");

    // Continue locally: a plain fork of the pointer, without the link.
    const forked = await post(urlA(`/sessions/${session.id}/fork`), {});
    expect(forked.status).toBe(201);
    const { session: fork } = (await forked.json()) as { session: SessionMeta };
    expect(fork.location?.live).toBeUndefined();
    const { sessions } = (await (await fetch(urlA("/sessions"))).json()) as {
      sessions: SessionMeta[];
    };
    expect(sessions.find((s) => s.id === session.id)?.location?.live?.sessionId).toBe(sessionId);

    // Conversation only: the server copy's next prompt tells the model the edits stayed behind.
    const live = a.sessions.get(fork.id)!;
    await waitFor(() => live.snapshot().state.agentStatus === "idle");
    const talk = await post(urlA(`/sessions/${fork.id}/share`), { mode: "conversation" });
    expect(talk.status).toBe(200);
    const moved = await post(
      urlB(`/projects/${PROJECT_B}/sessions/import`),
      ((await talk.json()) as { envelope: unknown }).envelope,
      { "cf-access-jwt-assertion": assertion() },
    );
    expect(moved.status).toBe(201);
    const { sessionId: talkId } = (await moved.json()) as { sessionId: string };
    expect(
      (
        await post(
          urlB(`/sessions/${talkId}/resume`),
          {},
          { "cf-access-jwt-assertion": assertion() },
        )
      ).status,
    ).toBe(200);
    const copy = b.sessions.get(talkId)!;
    const before = mock.requests.length;
    await copy.prompt("third turn, conversation only");
    await waitFor(() => {
      const state = copy.snapshot().state;
      return state.agentStatus === "idle" && mock.requests.length > before;
    });
    expect(JSON.stringify(mock.requests.at(-1))).toMatch(
      /Earlier edits from .+ are not in this workspace/,
    );
    expect(git(copy.meta.cwd, "status", "--porcelain")).toBe("");

    // Continue locally from an isolated session's pointer: the fork shares its checkout.
    expect((await post(urlA("/settings"), { worktreeIsolation: true }, {}, "PATCH")).status).toBe(
      200,
    );
    const isolated = (
      (await (
        await post(urlA("/sessions"), {
          startImmediately: true,
          projectId: PROJECT_A,
          provider: MOCK_PROVIDER_ID,
          model: MOCK_MODEL_ID,
        })
      ).json()) as { session: SessionMeta }
    ).session;
    expect(isolated.workspace?.path).toBeTruthy();
    const iso = a.sessions.get(isolated.id)!;
    await iso.prompt("isolated turn");
    await waitFor(() => iso.snapshot().state.agentStatus === "idle" && Boolean(iso.piSessionFile));
    const isoShare = (await (
      await post(urlA(`/sessions/${isolated.id}/share`), { mode: "conversation" })
    ).json()) as { envelope: unknown; handoff: string };
    const isoImport = await post(
      urlB(`/projects/${PROJECT_B}/sessions/import`),
      isoShare.envelope,
      {
        "cf-access-jwt-assertion": assertion(),
      },
    );
    expect(isoImport.status).toBe(201);
    const isoServerId = ((await isoImport.json()) as { sessionId: string }).sessionId;
    expect(
      (
        await post(
          urlA(`/sessions/${isolated.id}/shared-to`),
          {
            serverOrigin: ORIGIN,
            serverSessionId: isoServerId,
            mode: "conversation",
            handoff: isoShare.handoff,
          },
          {},
          "PATCH",
        )
      ).status,
    ).toBe(200);
    const isoFork = await post(urlA(`/sessions/${isolated.id}/fork`), {});
    expect(isoFork.status).toBe(201);
    const continued = ((await isoFork.json()) as { session: SessionMeta }).session;
    expect(continued.location?.live).toBeUndefined();
    expect(continued.workspace?.ownerSessionId).toBe(isolated.id);
    expect(continued.cwd).toBe(isolated.workspace?.path);
    expect(a.sessions.get(continued.id)?.isRunning).toBe(true);
  });
});
