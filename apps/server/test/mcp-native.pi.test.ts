import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  mockMcpServerLaunch,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * PI-03b against real Pi with AGENT_DECK_NATIVE_MCP=1: a project session gets
 * exactly its assigned servers as Pi native MCP tools (no `mcp` proxy), ids are
 * mapped to Pi-valid names (`alpha.one` -> `alpha_one`), stdio servers do not
 * inherit Pi's env, and a named child sees only its granted subset.
 */

const PLANTED = "PLANTED-SECRET";
const root = mkdtempSync(path.join(tmpdir(), "pi-native-mcp-it-"));
const home = path.join(root, "home");
const cwd = path.join(root, "project");
mkdirSync(path.join(home, ".pi", "agent", "agents"), { recursive: true });
mkdirSync(cwd);
// A child granted alpha.one only, with an authored tool list naming the proxy.
writeFileSync(
  path.join(home, ".pi", "agent", "agents", "worker.md"),
  "---\nname: worker\nmcpServers: alpha.one\ntools: read, mcp\n---\nCall the tools.\n",
);
// The mock server echoes AGENT_DECK_MOCK_MCP_LABEL; beta has no label of its
// own, so a leak of Pi's env would show the planted value in its replies.
const piEnv = {
  HOME: home,
  USERPROFILE: home,
  PI_SKIP_VERSION_CHECK: "1",
  AGENT_DECK_MOCK_MCP_LABEL: PLANTED,
};
const server = (id: string, label?: string) => ({
  ...mockMcpServerLaunch(id),
  ...(label ? { env: { AGENT_DECK_MOCK_MCP_LABEL: label } } : {}),
});

process.env.AGENT_DECK_TEST = "1";
process.env.AGENT_DECK_NATIVE_MCP = "1";
process.env.AGENT_DECK_PI_ENV = JSON.stringify(piEnv);
process.env.AGENT_DECK_MCP_SERVERS = JSON.stringify([
  server("alpha.one", "ALPHA"),
  server("beta"),
  server("gamma", "GAMMA"),
]);

let mock: MockProviderServer;
let deck: AgentDeckServer;
let projectId: string;
let parentId: string;

const toolNames = (body: ChatCompletionRequest | undefined): string[] =>
  ((body?.tools ?? []) as Array<{ function?: { name?: string } }>).map(
    (t) => t.function?.name ?? "",
  );
const toolText = (requests: ChatCompletionRequest[]): string =>
  JSON.stringify(requests.at(-1)?.messages.filter((m) => m.role === "tool"));

// Calls each planned tool in turn after the latest user message, then replies.
let plan: Array<{ name: string; arguments: Record<string, unknown> }> = [];

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (_lastUser, body) => {
      const lastUser = body.messages.findLastIndex((m) => m.role === "user");
      const done = body.messages.slice(lastUser + 1).filter((m) => m.role === "tool").length;
      return plan[done] ?? null;
    },
    reply: () => "Done.",
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  deck = await startServer({ dataDir: path.join(root, "data") });
  const added = await fetch(`http://127.0.0.1:${deck.port}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: cwd, name: "Native MCP" }),
  });
  projectId = ((await added.json()) as { project: { id: string } }).project.id;
  const assigned = await fetch(`http://127.0.0.1:${deck.port}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignedMcpServers: ["alpha.one", "beta"] }),
  });
  expect(assigned.status).toBe(200);
});

afterAll(async () => {
  await deck?.close();
  await mock?.close();
  for (const key of [
    "AGENT_DECK_MCP_SERVERS",
    "AGENT_DECK_NATIVE_MCP",
    "AGENT_DECK_PI_ENV",
    "AGENT_DECK_PROVIDER_EXTENSIONS",
  ])
    delete process.env[key];
});

describe("native MCP", () => {
  it("gives a session exactly its assigned servers, without Pi's env", async () => {
    plan = [
      { name: "mcp__alpha_one__echo", arguments: { message: "one" } },
      { name: "mcp__beta__echo", arguments: { message: "two" } },
    ];
    const response = await fetch(`http://127.0.0.1:${deck.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startImmediately: true,
        projectId,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        env: piEnv,
      }),
    });
    expect(response.status).toBe(201);
    parentId = ((await response.json()) as { session: { id: string } }).session.id;
    const start = mock.requests.length;
    await deck.sessions.get(parentId)!.prompt("use the mcp echo tools");
    await deck.receipts.waitFor("idle", parentId);
    // Only the session's turns: a session-title request has no tools.
    const requests = mock.requests.slice(start).filter((r) => toolNames(r).length > 0);

    const names = toolNames(requests[0]);
    expect(names).toEqual(expect.arrayContaining(["mcp__alpha_one__echo", "mcp__beta__echo"]));
    expect(names.some((n) => n.startsWith("mcp__gamma"))).toBe(false);
    expect(names).not.toContain("mcp");
    const results = toolText(requests);
    expect(results).toContain("ALPHA: one");
    expect(results).toContain("mcp stdio echo: two");
    expect(JSON.stringify(mock.requests)).not.toContain(PLANTED);
    // The transcript's name map is on the persisted session meta.
    expect(deck.sessions.get(parentId)!.meta.mcpServerNames).toEqual({
      alpha_one: "alpha.one",
      beta: "beta",
    });
  });

  it("gives a named child only its granted subset under an authored tool list", async () => {
    plan = [
      { name: "mcp__alpha_one__echo", arguments: { message: "child-one" } },
      { name: "mcp__beta__echo", arguments: { message: "child-two" } },
    ];
    const start = mock.requests.length;
    await deck.sessions.runManagedSubagent(parentId, "Echo for this turn", "worker");
    // Only the child's turns: a session-title request can interleave.
    const requests = mock.requests
      .slice(start)
      .filter((r) => toolNames(r).includes("contact_supervisor"));

    const names = toolNames(requests[0]);
    expect(names).toContain("mcp__alpha_one__echo");
    expect(names.some((n) => n.startsWith("mcp__beta"))).toBe(false);
    const results = toolText(requests);
    expect(results).toContain("ALPHA: child-one");
    expect(results).not.toContain("echo: child-two");
    expect(results).toContain("mcp__beta__echo");
  });
});
