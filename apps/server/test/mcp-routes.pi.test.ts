import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  mockMcpServerLaunch,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * MCP config routes (the visible half's backend), end-to-end against real pi:
 * POST /mcp adds a stdio server (writing mcp.json), an explicit check (POST
 * /mcp/:id/refresh) or an edit probes it and GET /mcp reports it connected with
 * its tools, a session calls the tool through Pi native, and DELETE /mcp/:id
 * removes it.
 */

const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
process.env.AGENT_DECK_TEST = "1";
// Hermetic resource home: mcp.json writes go under this tmp home, not ~/.pi.
process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: tmpHome });

let mock: MockProviderServer;
let server: AgentDeckServer;
const cwd = mkdtempSync(path.join(tmpdir(), "pi-mcp-routes-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
let projectId: string;

async function api(method: string, url: string, body?: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (_lastUser, body) => {
      const hasToolResult = body.messages.some((m) => m.role === "tool");
      return hasToolResult
        ? null
        : { name: "mcp__mock__echo", arguments: { message: "via routes" } };
    },
    reply: () => "answered.",
  });
  server = await startServer({ dataDir });
  const added = await api("POST", "/projects", { path: cwd, name: "MCP routes" });
  projectId = ((await added.json()) as { project: { id: string } }).project.id;
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("mcp config routes", () => {
  it("adds a server via POST /mcp and lists it connected with its tools once checked", async () => {
    const launch = mockMcpServerLaunch("mock");
    const res = await api("POST", "/mcp", {
      name: "mock",
      command: launch.command,
      args: launch.args,
    });
    expect(res.status).toBe(201);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      server: { id: "mock", connected: false, toolNames: [] },
    });
    expect(
      (await api("PATCH", `/projects/${projectId}`, { assignedMcpServers: ["mock"] })).status,
    ).toBe(200);

    type Row = { id: string; connected: boolean; toolNames: string[]; error?: string };
    const scoped = async () =>
      (
        (await (await api("GET", `/mcp?projectId=${encodeURIComponent(projectId)}`)).json()) as {
          servers: Row[];
        }
      ).servers.find((s) => s.id === "mock");
    // No connection is kept: nothing runs until a check.
    expect((await scoped())?.connected).toBe(false);
    const checked = await api(
      "POST",
      `/mcp/mock/refresh?projectId=${encodeURIComponent(projectId)}`,
    );
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({ server: { id: "mock", connected: true } });
    expect(await scoped()).toMatchObject({
      connected: true,
      toolNames: expect.arrayContaining(["mock/echo"]),
    });
    // An edit drops the old probe at once and checks the server again where it
    // is assigned, after answering.
    expect(
      (await api("PATCH", "/mcp/mock", { command: "definitely-not-a-command-xyz" })).status,
    ).toBe(200);
    expect(await scoped()).toMatchObject({ connected: false, toolNames: [] });
    await expect.poll(async () => (await scoped())?.error, { timeout: 20_000 }).toBeTruthy();
    expect(
      (await api("PATCH", "/mcp/mock", { command: launch.command, args: launch.args })).status,
    ).toBe(200);
    await expect.poll(async () => (await scoped())?.connected, { timeout: 20_000 }).toBe(true);
    // The All Projects view shows no status, so a check needs a project.
    expect((await api("POST", "/mcp/mock/refresh")).status).toBe(400);

    const globalList = (await (await api("GET", "/mcp")).json()) as {
      servers: Array<{ id: string; connected: boolean; toolNames: string[] }>;
    };
    expect(globalList.servers.find((item) => item.id === "mock")).toMatchObject({
      connected: false,
      toolNames: [],
    });
  });

  it("lets a real pi session call the added MCP tool", async () => {
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
    const { session } = (await response.json()) as { session: { id: string } };
    await server.sessions.get(session.id)!.prompt("use the mcp tool");
    await server.receipts.waitFor("idle", session.id);

    const followUp = mock.requests[mock.requests.length - 1]!;
    const toolText = JSON.stringify(followUp.messages.filter((m) => m.role === "tool"));
    expect(toolText).toContain("mcp stdio echo: via routes");
  });

  it("removes the server via DELETE", async () => {
    expect((await api("DELETE", "/mcp/mock")).status).toBe(200);
    const list = (await (
      await api("GET", `/mcp?projectId=${encodeURIComponent(projectId)}`)
    ).json()) as { servers: Array<{ id: string }> };
    expect(list.servers.some((s) => s.id === "mock")).toBe(false);
    expect(server.bridge.specs().some((s) => s.name === "mcp")).toBe(false);
    // Deleting an unknown server 404s.
    expect((await api("DELETE", "/mcp/mock")).status).toBe(404);
  });
});
