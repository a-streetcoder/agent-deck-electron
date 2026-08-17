import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileMcpOAuthStore } from "@agent-deck/mcp";
import { mockMcpServerLaunch } from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

const dataDir = mkdtempSync(path.join(tmpdir(), "mcp-policy-preserve-data-"));
const home = mkdtempSync(path.join(tmpdir(), "mcp-policy-preserve-home-"));
const projectPath = mkdtempSync(path.join(tmpdir(), "mcp-policy-preserve-project-"));
const originalPiEnv = process.env.AGENT_DECK_PI_ENV;
let server: AgentDeckServer;
let projectId: string;

const api = (method: string, route: string, body?: unknown) =>
  fetch(`http://127.0.0.1:${server.port}${route}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

beforeAll(async () => {
  process.env.AGENT_DECK_TEST = "1";
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: home });
  const configDir = path.join(home, ".pi", "agent");
  mkdirSync(path.join(configDir, "agents"), { recursive: true });
  const launch = mockMcpServerLaunch("remote");
  writeFileSync(
    path.join(configDir, "mcp.json"),
    JSON.stringify({
      mcpServers: { remote: { command: launch.command, args: launch.args } },
    }),
  );
  writeFileSync(
    path.join(configDir, "agents", "named.md"),
    "---\nname: named\nmcpServers: remote\nmcpDirectTools: search\n---\n\nNamed policy.\n",
  );
  server = await startServer({ dataDir });
  const project = await api("POST", "/projects", { path: projectPath, name: "Preserved" });
  projectId = ((await project.json()) as { project: { id: string } }).project.id;
  expect((await api("PATCH", "/mcp/remote/default-assignment", { enabled: true })).ok).toBe(true);
  expect(
    (
      await api("PATCH", `/projects/${projectId}`, {
        assignedMcpServers: ["remote"],
      })
    ).ok,
  ).toBe(true);
  new FileMcpOAuthStore(path.join(dataDir, "mcp-oauth")).save(
    `v2:${JSON.stringify([projectId, "remote"])}`,
    {
      serverUrl: "https://mcp.example/mcp",
      tokens: { access_token: "secret", token_type: "Bearer" },
    },
  );
});

afterAll(async () => {
  await server.close();
  if (originalPiEnv === undefined) delete process.env.AGENT_DECK_PI_ENV;
  else process.env.AGENT_DECK_PI_ENV = originalPiEnv;
});

describe("MCP policy preservation", () => {
  it("changes only policy truth while preserving definitions, assignments, agent policy, and OAuth bytes", async () => {
    const configPath = path.join(home, ".pi", "agent", "mcp.json");
    const agentPath = path.join(home, ".pi", "agent", "agents", "named.md");
    const projectsPath = path.join(dataDir, "projects.json");
    const oauthDir = path.join(dataDir, "mcp-oauth");
    const oauthFile = path.join(oauthDir, readdirSync(oauthDir)[0]!);
    const before = {
      config: readFileSync(configPath),
      agent: readFileSync(agentPath),
      projects: readFileSync(projectsPath),
      oauth: readFileSync(oauthFile),
    };

    const paused = await api("PATCH", "/mcp/policy", { enabled: false });
    expect(paused.status).toBe(200);
    expect(await paused.json()).toMatchObject({ mcpEnabled: false });
    const settings = JSON.parse(readFileSync(path.join(dataDir, "app-settings.json"), "utf8")) as {
      defaultMcpServers?: string[];
      mcpEnabled?: boolean;
    };
    expect(settings).toMatchObject({ defaultMcpServers: ["remote"], mcpEnabled: false });
    expect(readFileSync(configPath)).toEqual(before.config);
    expect(readFileSync(agentPath)).toEqual(before.agent);
    expect(readFileSync(projectsPath)).toEqual(before.projects);
    expect(readFileSync(oauthFile)).toEqual(before.oauth);

    const catalog = (await (await api("GET", `/mcp?projectId=${projectId}`)).json()) as {
      mcpEnabled: boolean;
      defaultAssignedServerIds: string[];
      assignedServerIds: string[];
    };
    expect(catalog).toMatchObject({
      mcpEnabled: false,
      defaultAssignedServerIds: ["remote"],
      assignedServerIds: ["remote"],
    });
  });
});
