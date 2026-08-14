import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeMemory, type MemoryStore } from "@agent-deck/memory";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Launch-time memory injection (memory.md §Memory Policy Injection): a parent
 * session's system prompt carries the project memory index + policy, injected
 * via --append-system-prompt. And because any explicit append suppresses pi's
 * automatic APPEND_SYSTEM.md discovery, the resolved project APPEND_SYSTEM.md is
 * re-added ahead of it — so it is still honored (agent-deck-system-prompt-logic.md).
 */

process.env.AGENT_DECK_TEST = "1";

const APPEND_SENTINEL = "PROJECT_APPEND_SENTINEL_XYZ: obey the house style.";

let mock: MockProviderServer;
let server: AgentDeckServer;

const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
// No global APPEND_SYSTEM: while paused, Pi's native discovery should retain
// the project APPEND_SYSTEM without Agent Deck passing any explicit append.
const pausedHome = mkdtempSync(path.join(tmpdir(), "pi-paused-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-mem-inject-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

function promptRequestSince(start: number, prompt: string): ChatCompletionRequest {
  const request = mock.requests
    .slice(start)
    .find((candidate) => JSON.stringify(candidate.messages).includes(prompt));
  if (!request) throw new Error(`no provider request found for prompt: ${prompt}`);
  return request;
}

function systemText(request: ChatCompletionRequest): string {
  // pi's OpenAI-completions provider carries the system prompt as the
  // "developer" role (newer OpenAI convention); accept "system" too.
  return request.messages
    .filter((m) => m.role === "developer" || m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

const GLOBAL_SENTINEL = "GLOBAL_APPEND_SENTINEL_QWE: global house rules.";
const cwdNoProjectAppend = mkdtempSync(path.join(tmpdir(), "pi-mem-inject-global-"));

beforeAll(async () => {
  // A project APPEND_SYSTEM.md pi would auto-discover.
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi", "APPEND_SYSTEM.md"), APPEND_SENTINEL);
  // A GLOBAL APPEND_SYSTEM.md under the session's HOME override — must be found
  // via the launch HOME (not the server process home) when a project has none.
  mkdirSync(path.join(tmpHome, ".pi", "agent"), { recursive: true });
  writeFileSync(path.join(tmpHome, ".pi", "agent", "APPEND_SYSTEM.md"), GLOBAL_SENTINEL);
  // Pi's native project APPEND discovery is trust-gated. The paused launch must
  // use that native path rather than Agent Deck's explicit append override.
  const pausedAgentDir = path.join(pausedHome, ".pi", "agent");
  mkdirSync(pausedAgentDir, { recursive: true });
  writeFileSync(
    path.join(pausedAgentDir, "trust.json"),
    JSON.stringify({ [realpathSync(cwd)]: true }),
  );

  // Pre-seed a memory so the injected index has a line at launch.
  const store: MemoryStore = { baseDir: path.join(dataDir, "memory"), projectPath: cwd };
  const seeded = writeMemory(store, {
    type: "decision",
    title: "Package manager choice",
    summary: "The monorepo uses pnpm workspaces",
    body: "We use pnpm, not npm.",
  });
  if (!seeded.ok) throw new Error("failed to seed memory");

  mock = await startMockProvider({ reply: () => "ok" });
  server = await startServer({ dataDir });
});

afterEach(async () => {
  await fetch(`http://127.0.0.1:${server.port}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ agentMemoryEnabled: true }),
  });
});

afterAll(async () => {
  await server.close();
  await mock.close();
});

describe("memory: launch-time index injection + APPEND_SYSTEM.md preservation", () => {
  it("replaces one idle parent in place on pause/resume and updates policy, hook, and tools", async () => {
    const settingsUrl = `http://127.0.0.1:${server.port}/settings`;
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [writeMockProviderExtension(mock.baseUrl)],
        env: { HOME: pausedHome, USERPROFILE: pausedHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };
    await server.sessions.get(session.id)!.prompt("before pause");
    await server.receipts.waitFor("idle", session.id);
    await vi.waitFor(() =>
      expect(server.sessions.get(session.id)!.meta.piSessionFile).toBeTruthy(),
    );
    const original = server.sessions.get(session.id)!.meta;
    const canonicalPiSession = original.piSessionFile;
    const activeFingerprint = original.launchResourceFingerprint;

    const pause = await fetch(settingsUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentMemoryEnabled: false }),
    });
    expect(pause.status).toBe(200);
    await vi.waitFor(() =>
      expect(server.sessions.get(session.id)!.meta.launchResourceFingerprint).not.toBe(
        activeFingerprint,
      ),
    );

    const pausedStart = mock.requests.length;
    await server.sessions.get(session.id)!.prompt("package manager choice");
    await vi.waitFor(() =>
      expect(
        mock.requests
          .slice(pausedStart)
          .some((request) => JSON.stringify(request.messages).includes("package manager choice")),
      ).toBe(true),
    );
    await server.receipts.waitFor("idle", session.id);
    const pausedRequest = promptRequestSince(pausedStart, "package manager choice");
    const pausedSystem = systemText(pausedRequest);
    expect(pausedSystem).not.toContain("Agent Deck project memory");
    expect(pausedSystem).not.toContain("Package manager choice");
    expect(JSON.stringify(pausedRequest.tools ?? [])).not.toContain("agent_deck_memory_");
    expect(JSON.stringify(pausedRequest.messages)).toContain("before pause");
    expect(server.sessions.get(session.id)!.meta.piSessionFile).toBe(canonicalPiSession);
    const pausedFingerprint = server.sessions.get(session.id)!.meta.launchResourceFingerprint;

    // A new paused launch passes no explicit append flags, so pinned Pi's own
    // discovery must still honor the project APPEND_SYSTEM file.
    const freshPausedStart = mock.requests.length;
    const freshPausedResponse = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [writeMockProviderExtension(mock.baseUrl)],
        env: { HOME: pausedHome, USERPROFILE: pausedHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(freshPausedResponse.status).toBe(201);
    const freshPausedSession = (await freshPausedResponse.json()) as { session: { id: string } };
    await server.sessions.get(freshPausedSession.session.id)!.prompt("fresh paused append");
    await vi.waitFor(() =>
      expect(
        mock.requests
          .slice(freshPausedStart)
          .some((request) => JSON.stringify(request.messages).includes("fresh paused append")),
      ).toBe(true),
    );
    await server.receipts.waitFor("idle", freshPausedSession.session.id);
    expect(systemText(promptRequestSince(freshPausedStart, "fresh paused append"))).toContain(
      APPEND_SENTINEL,
    );

    const resume = await fetch(settingsUrl, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentMemoryEnabled: true }),
    });
    expect(resume.status).toBe(200);
    await vi.waitFor(() =>
      expect(server.sessions.get(session.id)!.meta.launchResourceFingerprint).not.toBe(
        pausedFingerprint,
      ),
    );

    const resumedStart = mock.requests.length;
    await server.sessions.get(session.id)!.prompt("after resume");
    await vi.waitFor(() =>
      expect(
        mock.requests
          .slice(resumedStart)
          .some((request) => JSON.stringify(request.messages).includes("after resume")),
      ).toBe(true),
    );
    await server.receipts.waitFor("idle", session.id);
    const resumedRequest = promptRequestSince(resumedStart, "after resume");
    expect(systemText(resumedRequest)).toContain("Agent Deck project memory");
    expect(JSON.stringify(resumedRequest.tools ?? [])).toContain("agent_deck_memory_search");
    expect(JSON.stringify(resumedRequest.messages)).toContain("package manager choice");
    expect(server.sessions.get(session.id)!.meta.piSessionFile).toBe(canonicalPiSession);
  });
  it("injects the memory index and still honors the project APPEND_SYSTEM.md", async () => {
    const requestStart = mock.requests.length;
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [writeMockProviderExtension(mock.baseUrl)],
        env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };

    await server.sessions.get(session.id)!.prompt("hello");
    await server.receipts.waitFor("idle", session.id);

    const system = systemText(promptRequestSince(requestStart, "hello"));
    // The memory policy + the seeded memory's index line are present.
    expect(system).toContain("Agent Deck project memory");
    expect(system).toContain("Package manager choice");
    // The project APPEND_SYSTEM.md content survived (not suppressed by our append).
    expect(system).toContain(APPEND_SENTINEL);
  });

  it("preserves the GLOBAL APPEND_SYSTEM.md resolved against the session's HOME", async () => {
    const requestStart = mock.requests.length;
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: cwdNoProjectAppend, // no project .pi/APPEND_SYSTEM.md → global applies
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [writeMockProviderExtension(mock.baseUrl)],
        env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };

    await server.sessions.get(session.id)!.prompt("hi");
    await server.receipts.waitFor("idle", session.id);

    const system = systemText(promptRequestSince(requestStart, "hi"));
    expect(system).toContain("Agent Deck project memory");
    // The global APPEND_SYSTEM.md (under the launch HOME) is honored.
    expect(system).toContain(GLOBAL_SENTINEL);
  });
});
