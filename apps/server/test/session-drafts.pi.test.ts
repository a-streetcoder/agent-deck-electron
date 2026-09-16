import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta, ServerMessage } from "@agent-deck/domain";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";
const dataDir = mkdtempSync(path.join(tmpdir(), "durable-drafts-"));
const repo = mkdtempSync(path.join(tmpdir(), "draft-repo-"));
const home = mkdtempSync(path.join(tmpdir(), "draft-home-"));
let server: AgentDeckServer;
let mock: MockProviderServer;
let projectId: string;

async function request(route: string, method = "GET", body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}
async function createDraft(): Promise<SessionMeta> {
  const response = await request("/sessions", "POST", { projectId });
  expect(response.status).toBe(201);
  return ((await response.json()) as { session: SessionMeta }).session;
}
async function listed(id: string): Promise<SessionMeta | undefined> {
  const response = await request("/sessions");
  return ((await response.json()) as { sessions: SessionMeta[] }).sessions.find((s) => s.id === id);
}
function worktrees(): string[] {
  const root = path.join(dataDir, "session-worktrees");
  return existsSync(root) ? readdirSync(root).sort() : [];
}
async function prompt(id: string): Promise<{ ok: boolean; messages: ServerMessage[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
  const messages: ServerMessage[] = [];
  await new Promise<void>((resolve) => socket.once("open", resolve));
  try {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("draft prompt timed out")), 60_000);
      let accepted = false;
      socket.on("message", (raw: Buffer) => {
        const frame = JSON.parse(raw.toString()) as {
          kind: string;
          id?: number;
          ok?: boolean;
          message?: ServerMessage;
        };
        if (frame.message) messages.push(frame.message);
        if (frame.kind === "reply" && frame.id === 2) {
          accepted = frame.ok === true;
          if (!accepted) {
            clearTimeout(timeout);
            resolve({ ok: false, messages });
          }
        }
        if (
          accepted &&
          messages.some(
            (m) =>
              m.type === "event" &&
              m.event.type === "cell_final" &&
              m.event.cell.kind === "assistant",
          )
        ) {
          clearTimeout(timeout);
          resolve({ ok: true, messages });
        }
      });
      socket.send(JSON.stringify({ id: 1, request: { type: "subscribe_session", sessionId: id } }));
      socket.send(
        JSON.stringify({
          id: 2,
          request: { type: "prompt", sessionId: id, message: "first draft message" },
        }),
      );
    });
  } finally {
    socket.close();
  }
}

beforeAll(async () => {
  for (const args of [
    ["init", "-b", "main"],
    ["config", "user.email", "test@example.com"],
    ["config", "user.name", "Test"],
  ])
    execFileSync("git", args, { cwd: repo });
  writeFileSync(path.join(repo, "README.md"), "draft fixture\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: repo });
  mock = await startMockProvider({ reply: () => "The draft now streams a real response" });
  process.env.AGENT_DECK_DEFAULT_PROVIDER = MOCK_PROVIDER_ID;
  process.env.AGENT_DECK_DEFAULT_MODEL = MOCK_MODEL_ID;
  process.env.AGENT_DECK_DEFAULT_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = process.env.AGENT_DECK_DEFAULT_EXTENSIONS;
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({
    HOME: home,
    USERPROFILE: home,
    PI_SKIP_VERSION_CHECK: "1",
  });
  server = await startServer({ dataDir });
  const response = await request("/projects", "POST", { path: repo });
  projectId = ((await response.json()) as { project: { id: string } }).project.id;
  expect(
    (await request("/settings", "PATCH", { worktreeIsolation: true, autoTitle: false })).ok,
  ).toBe(true);
});
afterAll(async () => {
  await server.close();
  await mock.close();
  for (const key of [
    "AGENT_DECK_DEFAULT_PROVIDER",
    "AGENT_DECK_DEFAULT_MODEL",
    "AGENT_DECK_DEFAULT_EXTENSIONS",
    "AGENT_DECK_PROVIDER_EXTENSIONS",
    "AGENT_DECK_PI_ENV",
  ])
    delete process.env[key];
});

describe("durable lazy drafts against real Pi", () => {
  it("persists and resumes without Pi or a worktree, then starts the same id on first send", async () => {
    const before = worktrees();
    const draft = await createDraft();
    expect(draft.lifecycle).toBe("draft");
    expect(server.sessions.get(draft.id)).toBeUndefined();
    expect(worktrees()).toEqual(before);
    await server.close();
    server = await startServer({ dataDir });
    expect((await listed(draft.id))?.lifecycle).toBe("draft");
    expect((await request(`/sessions/${draft.id}/resume`, "POST")).status).toBe(200);
    expect(server.sessions.get(draft.id)).toBeUndefined();
    expect(worktrees()).toEqual(before);
    const firstTurn = await prompt(draft.id);
    expect(firstTurn.ok).toBe(true);
    const events = firstTurn.messages.filter((m) => m.type === "event");
    const final = events.findIndex(
      (m) => m.event.type === "cell_final" && m.event.cell.kind === "assistant",
    );
    expect(
      events.slice(0, final).filter((m) => m.event.type === "cell_delta").length,
    ).toBeGreaterThanOrEqual(2);
    expect(events.map((m) => m.seq)).toEqual(events.map((m) => m.seq).sort((a, b) => a - b));
    await server.receipts.waitFor("idle", draft.id);
    const active = await listed(draft.id);
    expect(active?.id).toBe(draft.id);
    expect(active?.lifecycle).not.toBe("draft");
    expect(active?.cwd).not.toBe(repo);
    expect(active?.worktreeBranch).toBeTruthy();
    expect(server.sessions.get(draft.id)?.isRunning).toBe(true);
    expect((await request(`/sessions/${draft.id}`, "DELETE")).ok).toBe(true);
    expect(worktrees()).toEqual(before);
  });

  it("retains a draft after launch failure, cleans allocated worktree, and supports retry", async () => {
    const draft = await createDraft();
    const before = worktrees();
    const previous = process.env.AGENT_DECK_PI_PATH;
    process.env.AGENT_DECK_PI_PATH = path.join(dataDir, "missing-pi");
    try {
      expect((await prompt(draft.id)).ok).toBe(false);
      expect((await listed(draft.id))?.lifecycle).toBe("draft");
      expect(server.sessions.get(draft.id)).toBeUndefined();
      expect(worktrees()).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env.AGENT_DECK_PI_PATH;
      else process.env.AGENT_DECK_PI_PATH = previous;
    }
    expect((await prompt(draft.id)).ok).toBe(true);
    await server.receipts.waitFor("idle", draft.id);
    expect((await request(`/sessions/${draft.id}`, "DELETE")).ok).toBe(true);
  });

  it("returns empty usage and preserves a custom cwd when editing draft isolation", async () => {
    const response = await request("/sessions", "POST", { cwd: repo });
    const draft = ((await response.json()) as { session: SessionMeta }).session;
    const stats = await request(`/sessions/${draft.id}/stats`);
    expect(stats.status).toBe(200);
    expect(await stats.json()).toEqual(
      expect.objectContaining({
        stats: expect.objectContaining({ sessionId: draft.id, totalMessages: 0, cost: 0 }),
      }),
    );
    const updated = await request(`/sessions/${draft.id}/draft`, "PATCH", {
      worktreeIsolation: false,
    });
    expect(updated.status).toBe(200);
    expect(((await updated.json()) as { session: SessionMeta }).session.cwd).toBe(repo);
    expect(server.sessions.get(draft.id)).toBeUndefined();
    expect((await request(`/sessions/${draft.id}`, "DELETE")).ok).toBe(true);
  });

  it("explicitly deletes an unopened draft without allocating runtime resources", async () => {
    const before = worktrees();
    const draft = await createDraft();
    expect((await request(`/sessions/${draft.id}`, "DELETE")).status).toBe(200);
    expect(await listed(draft.id)).toBeUndefined();
    expect(server.sessions.get(draft.id)).toBeUndefined();
    expect(worktrees()).toEqual(before);
    await server.close();
    server = await startServer({ dataDir });
    expect(await listed(draft.id)).toBeUndefined();
  });
});
