import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

const originalPiEnv = process.env.AGENT_DECK_PI_ENV;
const originalMcpEnv = process.env.AGENT_DECK_MCP_SERVERS;

let server: AgentDeckServer;
let dataDir: string;
let home: string;
let projectPath: string;
let projectId: string;

async function api(method: string, route: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function start(): Promise<void> {
  server = await startServer({ dataDir });
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "deck-mcp-assign-data-"));
  home = mkdtempSync(path.join(tmpdir(), "deck-mcp-assign-home-"));
  projectPath = mkdtempSync(path.join(tmpdir(), "deck-mcp-assign-project-"));
  process.env.AGENT_DECK_TEST = "1";
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: home });
  delete process.env.AGENT_DECK_MCP_SERVERS;
  await start();
  const added = await api("POST", "/projects", { path: projectPath, name: "Assigned MCP" });
  projectId = ((await added.json()) as { project: { id: string } }).project.id;
});

afterEach(async () => {
  await server.close();
  if (originalPiEnv === undefined) delete process.env.AGENT_DECK_PI_ENV;
  else process.env.AGENT_DECK_PI_ENV = originalPiEnv;
  if (originalMcpEnv === undefined) delete process.env.AGENT_DECK_MCP_SERVERS;
  else process.env.AGENT_DECK_MCP_SERVERS = originalMcpEnv;
});

describe("project MCP assignment persistence", () => {
  it("adds, removes, and restart-round-trips explicit assignments", async () => {
    const assigned = await api("PATCH", `/projects/${projectId}`, {
      assignedMcpServers: ["not-configured"],
    });
    expect(assigned.status).toBe(200);

    const catalog = (await (
      await api("GET", `/mcp?projectId=${encodeURIComponent(projectId)}`)
    ).json()) as { missingAssignedServerIds: string[] };
    expect(catalog.missingAssignedServerIds).toEqual(["not-configured"]);

    await server.close();
    await start();
    const projects = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{ id: string; assignedMcpServers?: string[] }>;
    };
    expect(
      projects.projects.find((project) => project.id === projectId)?.assignedMcpServers,
    ).toEqual(["not-configured"]);

    expect(
      (
        await api("PATCH", `/projects/${projectId}`, {
          assignedMcpServers: [],
        })
      ).status,
    ).toBe(200);
    const persisted = JSON.parse(
      readFileSync(path.join(dataDir, "projects.json"), "utf8"),
    ) as Array<{
      id: string;
      assignedMcpServers?: string[];
    }>;
    expect(persisted.find((project) => project.id === projectId)?.assignedMcpServers).toEqual([]);
  });

  it("fails closed on malformed project config while preserving the assignment", async () => {
    const configDir = path.join(projectPath, ".pi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "mcp.json"), "{ malformed", "utf8");

    const response = await api("PATCH", `/projects/${projectId}`, {
      assignedMcpServers: ["repository-server"],
    });
    expect(response.status).toBe(422);
    expect(await response.text()).toContain("not valid JSON");

    const projects = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{ id: string; assignedMcpServers?: string[] }>;
    };
    expect(
      projects.projects.find((project) => project.id === projectId)?.assignedMcpServers,
    ).toEqual(["repository-server"]);
    expect(server.bridge.specs().some((spec) => spec.name.startsWith("mcp__"))).toBe(false);
  });
});
