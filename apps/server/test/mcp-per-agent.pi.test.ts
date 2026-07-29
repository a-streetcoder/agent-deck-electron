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
 * Per-session MCP scoping (native explicit-assignment model): an agent that
 * DECLARES mcpServers exposes only those servers' MCP tools to its sessions; an
 * agent that declares none (opt-in default) gets no MCP tools; a PLAIN session
 * (no agent) is unrestricted. End-to-end against real pi with a configured stdio
 * MCP server "mock" (tool mcp__mock__echo).
 */

const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-per-agent-mcp-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

process.env.AGENT_DECK_TEST = "1";
process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: tmpHome });
process.env.AGENT_DECK_MCP_SERVERS = JSON.stringify([mockMcpServerLaunch("mock")]);

let mock: MockProviderServer;
let server: AgentDeckServer;
let mockExt: string;
let projectId: string;
let unassignedProjectId: string;
const unassignedCwd = mkdtempSync(path.join(tmpdir(), "pi-unassigned-agent-mcp-"));
const env = { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" };

function writeGlobalAgent(name: string, frontmatter: string, body: string): void {
  const dir = path.join(tmpHome, ".pi", "agent", "agents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, `${name}.md`),
    `---\nname: ${name}\n${frontmatter}\n---\n\n${body}\n`,
  );
}

function toolResults(reqs: ChatCompletionRequest[]): string {
  return JSON.stringify(reqs.flatMap((r) => r.messages.filter((m) => m.role === "tool")));
}

async function runSession(
  agentName?: string,
  options: { projectId?: string; prompt?: string } = {},
): Promise<ChatCompletionRequest[]> {
  const start = mock.requests.length;
  const res = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      projectId: options.projectId ?? projectId,
      agentName,
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
      extensions: [mockExt],
      env,
    }),
  });
  expect(res.status).toBe(201);
  const { session } = (await res.json()) as { session: { id: string } };
  await server.sessions.get(session.id)!.prompt(options.prompt ?? "use the mcp echo tool");
  await server.receipts.waitFor("idle", session.id);
  return mock.requests.slice(start);
}

beforeAll(async () => {
  writeGlobalAgent("mcp-yes", "mcpServers: mock", "You use the MCP echo tool.");
  // Declares no mcpServers at all → opt-in default is no MCP tools.
  writeGlobalAgent("mcp-none", "description: plain", "You do not use MCP.");
  writeGlobalAgent(
    "global-project-only",
    "mcpServers: projectonly",
    "You request the project-only MCP tool.",
  );
  const projectMcpDir = path.join(unassignedCwd, ".pi");
  mkdirSync(path.join(projectMcpDir, "agents"), { recursive: true });
  const projectOnly = mockMcpServerLaunch("projectonly");
  writeFileSync(
    path.join(projectMcpDir, "mcp.json"),
    `${JSON.stringify({ mcpServers: { projectonly: { command: projectOnly.command, args: projectOnly.args } } })}\n`,
  );
  writeFileSync(
    path.join(projectMcpDir, "agents", "project-local-mcp.md"),
    "---\nname: project-local-mcp\nmcpServers: projectonly\n---\n\nUse project-only MCP.\n",
  );
  mock = await startMockProvider({
    toolCall: (lastUser, body) =>
      body.messages.some((m) => m.role === "tool")
        ? null
        : {
            name: lastUser.includes("project-only") ? "mcp__projectonly__echo" : "mcp__mock__echo",
            arguments: { message: "scoped" },
          },
    reply: () => "done",
  });
  mockExt = writeMockProviderExtension(mock.baseUrl);
  server = await startServer({ dataDir });
  const added = await fetch(`http://127.0.0.1:${server.port}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: cwd, name: "MCP project" }),
  });
  projectId = ((await added.json()) as { project: { id: string } }).project.id;
  const assigned = await fetch(`http://127.0.0.1:${server.port}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assignedMcpServers: ["mock"] }),
  });
  expect(assigned.status).toBe(200);
  const unassigned = await fetch(`http://127.0.0.1:${server.port}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: unassignedCwd, name: "Unassigned MCP project" }),
  });
  unassignedProjectId = ((await unassigned.json()) as { project: { id: string } }).project.id;
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PI_ENV;
  delete process.env.AGENT_DECK_MCP_SERVERS;
});

describe("per-session MCP scoping by an agent's declared mcpServers", () => {
  it("exposes the declared server's MCP tool to its agent session", async () => {
    // The server has the MCP tool registered globally.
    expect(server.bridge.specs().some((s) => s.name === "mcp__mock__echo")).toBe(true);
    const reqs = await runSession("mcp-yes");
    // The agent declared mock, so mcp__mock__echo ran and its result came back.
    expect(toolResults(reqs)).toContain("mcp stdio echo: scoped");
  });

  it("hides all MCP tools from an agent that declares none (opt-in)", async () => {
    const reqs = await runSession("mcp-none");
    // mcp__mock__echo was NOT exposed to this session, so it never produced output.
    expect(toolResults(reqs)).not.toContain("mcp stdio echo");
  });

  it("exposes only the project's explicit assignment to a plain session", async () => {
    const reqs = await runSession();
    // No agent → the project's explicit assignment is available.
    expect(toolResults(reqs)).toContain("mcp stdio echo: scoped");
  });

  it.each(["project-local-mcp", "global-project-only"])(
    "does not let agent %s grant execution trust for an unassigned project override",
    async (agentName) => {
      const catalog = (await (
        await fetch(`http://127.0.0.1:${server.port}/mcp?projectId=${unassignedProjectId}`)
      ).json()) as {
        servers: Array<{ id: string; connected: boolean; toolNames: string[] }>;
      };
      expect(catalog.servers.find((entry) => entry.id === "projectonly")).toMatchObject({
        connected: false,
        toolNames: [],
      });
      const reqs = await runSession(agentName, {
        projectId: unassignedProjectId,
        prompt: "use the project-only MCP echo tool",
      });
      expect(toolResults(reqs)).not.toContain("mcp stdio echo");
      const after = (await (
        await fetch(`http://127.0.0.1:${server.port}/mcp?projectId=${unassignedProjectId}`)
      ).json()) as {
        servers: Array<{ id: string; connected: boolean; toolNames: string[] }>;
      };
      expect(after.servers.find((entry) => entry.id === "projectonly")).toMatchObject({
        connected: false,
        toolNames: [],
      });
    },
  );
});
