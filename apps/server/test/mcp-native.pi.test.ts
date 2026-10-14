import { mkdtempSync } from "node:fs";
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
 * PI-03b against real Pi: with AGENT_DECK_NATIVE_MCP=1 a project session gets
 * exactly its assigned servers as Pi native MCP tools (no `mcp` proxy), with
 * the Agent Deck id mapped to a Pi-valid name (`alpha.one` -> `alpha_one`).
 */

process.env.AGENT_DECK_TEST = "1";
process.env.AGENT_DECK_NATIVE_MCP = "1";
process.env.AGENT_DECK_MCP_SERVERS = JSON.stringify([
  mockMcpServerLaunch("alpha.one"),
  mockMcpServerLaunch("beta"),
]);

let mock: MockProviderServer;
let server: AgentDeckServer;
let projectId: string;

const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-native-mcp-it-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

const toolNames = (body: ChatCompletionRequest): string[] =>
  ((body.tools ?? []) as Array<{ function?: { name?: string } }>).map(
    (t) => t.function?.name ?? "",
  );

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (_lastUser, body) =>
      body.messages.some((m) => m.role === "tool")
        ? null
        : { name: "mcp__alpha_one__echo", arguments: { message: "native" } },
    reply: () => "The MCP tool answered.",
  });
  server = await startServer({ dataDir });
  const added = await fetch(`http://127.0.0.1:${server.port}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: cwd, name: "Native MCP" }),
  });
  projectId = ((await added.json()) as { project: { id: string } }).project.id;
  const assigned = await fetch(`http://127.0.0.1:${server.port}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignedMcpServers: ["alpha.one"] }),
  });
  expect(assigned.status).toBe(200);
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_MCP_SERVERS;
  delete process.env.AGENT_DECK_NATIVE_MCP;
});

describe("native MCP: a session sees exactly its assigned servers", () => {
  it("declares only the assigned server's tools and completes a call", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startImmediately: true,
        projectId,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [writeMockProviderExtension(mock.baseUrl)],
        env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };

    await server.sessions.get(session.id)!.prompt("use the mcp echo tool");
    await server.receipts.waitFor("idle", session.id);

    const names = toolNames(mock.requests[0]!);
    expect(names).toContain("mcp__alpha_one__echo");
    expect(names.some((n) => n.startsWith("mcp__beta"))).toBe(false);
    expect(names).not.toContain("mcp");
    const followUp = mock.requests[mock.requests.length - 1]!;
    expect(JSON.stringify(followUp.messages.filter((m) => m.role === "tool"))).toContain(
      "mcp stdio echo: native",
    );
  });
});
