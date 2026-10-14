import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockHttpMcpServer,
  startMockProvider,
  writeMockProviderExtension,
  type MockHttpMcpServer,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * HTTP (Streamable HTTP) MCP through Pi native, end-to-end against real pi: an
 * assigned http MCP server's `echo` tool is declared as `mcp__mockhttp__echo`
 * by the generated bridge extension and called by a real pi session; the
 * settings screen's probe reports it connected with its tools, and an OAuth
 * server as needing sign-in. Mirrors mcp-native.pi.test.ts with http.
 */

process.env.AGENT_DECK_TEST = "1";

let mock: MockProviderServer;
let server: AgentDeckServer;
let mcpHttp: MockHttpMcpServer;
let oauthMcp: MockHttpMcpServer;
let projectId: string;

const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-mcp-http-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (_lastUser, body) => {
      const hasToolResult = body.messages.some((m) => m.role === "tool");
      return hasToolResult
        ? null
        : { name: "mcp__mockhttp__echo", arguments: { message: "over http" } };
    },
    reply: () => "The MCP tool answered.",
  });
  // The http MCP servers must be listening BEFORE startServer reads the env config.
  mcpHttp = await startMockHttpMcpServer();
  oauthMcp = await startMockHttpMcpServer({ oauth: true });
  process.env.AGENT_DECK_MCP_SERVERS = JSON.stringify([
    { id: "mockhttp", url: mcpHttp.url },
    { id: "secure", url: oauthMcp.url },
  ]);
  server = await startServer({ dataDir });
  const added = await fetch(`http://127.0.0.1:${server.port}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: cwd, name: "HTTP MCP integration" }),
  });
  projectId = ((await added.json()) as { project: { id: string } }).project.id;
  const assigned = await fetch(`http://127.0.0.1:${server.port}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignedMcpServers: ["mockhttp", "secure"] }),
  });
  expect(assigned.status).toBe(200);
});

afterAll(async () => {
  await server.close();
  await mock.close();
  await mcpHttp.close();
  await oauthMcp.close();
  delete process.env.AGENT_DECK_MCP_SERVERS;
});

describe("mcp http: an assigned Streamable HTTP server through Pi native", () => {
  it("probes on request: connected with its tools, or needing sign-in", async () => {
    const base = `http://127.0.0.1:${server.port}`;
    type Row = { id: string; transport: string; connected: boolean; toolNames: string[] };
    const list = async () =>
      ((await (await fetch(`${base}/mcp?projectId=${projectId}`)).json()) as { servers: Row[] })
        .servers;
    // Nothing connects until asked.
    expect((await list()).find((s) => s.id === "mockhttp")?.connected).toBe(false);
    for (const id of ["mockhttp", "secure"]) {
      const probed = await fetch(`${base}/mcp/${id}/refresh?projectId=${projectId}`, {
        method: "POST",
      });
      expect(probed.status).toBe(200);
    }
    const rows = await list();
    expect(rows.find((s) => s.id === "mockhttp")).toMatchObject({
      transport: "http",
      connected: true,
      toolNames: expect.arrayContaining(["mockhttp/echo"]),
    });
    expect(rows.find((s) => s.id === "secure")).toMatchObject({
      connected: false,
      needsSignIn: true,
      oauth: true,
    });
  });

  it("declares the server's tool natively and forwards a real pi call to it", async () => {
    expect(server.bridge.specs().some((s) => s.name === "mcp")).toBe(false);

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

    expect(JSON.stringify(mock.requests.map((r) => r.tools ?? []))).toContain(
      '"mcp__mockhttp__echo"',
    );
    const followUp = mock.requests[mock.requests.length - 1]!;
    const toolText = JSON.stringify(followUp.messages.filter((m) => m.role === "tool"));
    expect(toolText).toContain("mcp http echo: over http");
  });
});
