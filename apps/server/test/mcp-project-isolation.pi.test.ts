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

const home = mkdtempSync(path.join(tmpdir(), "pi-mcp-scope-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "pi-mcp-scope-data-"));
const projectA = mkdtempSync(path.join(tmpdir(), "pi-mcp-project-a-"));
const projectB = mkdtempSync(path.join(tmpdir(), "pi-mcp-project-b-"));
const launch = mockMcpServerLaunch("shared");
const piEnv = { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" };

process.env.AGENT_DECK_TEST = "1";
process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: home });
delete process.env.AGENT_DECK_MCP_SERVERS;

let server: AgentDeckServer;
let provider: MockProviderServer;
let providerExtension: string;
let projectAId: string;
let projectBId: string;

async function api(method: string, route: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function writeProjectConfig(root: string, label: string): void {
  const dir = path.join(root, ".pi");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "mcp.json"),
    `${JSON.stringify(
      {
        mcpServers: {
          shared: {
            command: launch.command,
            args: launch.args,
            env: { AGENT_DECK_MOCK_MCP_LABEL: label },
          },
        },
      },
      null,
      2,
    )}\n`,
  );
}

async function addAssignedProject(root: string, name: string): Promise<string> {
  const added = await api("POST", "/projects", { path: root, name });
  expect(added.status).toBe(201);
  const id = ((await added.json()) as { project: { id: string } }).project.id;
  expect((await api("PATCH", `/projects/${id}`, { assignedMcpServers: ["shared"] })).status).toBe(
    200,
  );
  return id;
}

async function createSession(projectId: string): Promise<string> {
  const response = await api("POST", "/sessions", {
    projectId,
    provider: MOCK_PROVIDER_ID,
    model: MOCK_MODEL_ID,
    extensions: [providerExtension],
    env: piEnv,
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { session: { id: string } }).session.id;
}

function requestsForMarker(
  requests: ChatCompletionRequest[],
  marker: string,
): ChatCompletionRequest[] {
  return requests.filter((request) => JSON.stringify(request.messages).includes(marker));
}

beforeAll(async () => {
  writeProjectConfig(projectA, "project-a-result");
  writeProjectConfig(projectB, "project-b-result");
  provider = await startMockProvider({
    toolCall: (_lastUser, body) =>
      body.messages.some((message) => message.role === "tool")
        ? null
        : { name: "mcp__shared__echo", arguments: { message: "isolated" } },
    reply: () => "streamed parent answer has several deltas",
  });
  providerExtension = writeMockProviderExtension(provider.baseUrl);
  server = await startServer({ dataDir });
  projectAId = await addAssignedProject(projectA, "Project A");
  projectBId = await addAssignedProject(projectB, "Project B");
});

afterAll(async () => {
  await server.close();
  await provider.close();
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("real Pi project-scoped MCP isolation", () => {
  it("keeps concurrent same-id project clients isolated and parent streaming incremental", async () => {
    const [sessionAId, sessionBId] = await Promise.all([
      createSession(projectAId),
      createSession(projectBId),
    ]);
    const sessionA = server.sessions.get(sessionAId)!;
    const sessionB = server.sessions.get(sessionBId)!;
    let deltasA = 0;
    let deltasB = 0;
    const unsubscribeA = sessionA.bus.subscribe((item) => {
      if (item.event.type === "cell_delta") deltasA += 1;
    });
    const unsubscribeB = sessionB.bus.subscribe((item) => {
      if (item.event.type === "cell_delta") deltasB += 1;
    });

    await Promise.all([
      sessionA.prompt("marker-project-a use the MCP tool"),
      sessionB.prompt("marker-project-b use the MCP tool"),
    ]);
    await Promise.all([
      server.receipts.waitFor("idle", sessionAId),
      server.receipts.waitFor("idle", sessionBId),
    ]);
    unsubscribeA();
    unsubscribeB();

    const aRequests = requestsForMarker(provider.requests, "marker-project-a");
    const bRequests = requestsForMarker(provider.requests, "marker-project-b");
    expect(JSON.stringify(aRequests)).toContain("project-a-result: isolated");
    expect(JSON.stringify(aRequests)).not.toContain("project-b-result");
    expect(JSON.stringify(bRequests)).toContain("project-b-result: isolated");
    expect(JSON.stringify(bRequests)).not.toContain("project-a-result");
    expect(deltasA).toBeGreaterThan(1);
    expect(deltasB).toBeGreaterThan(1);
  });
});
