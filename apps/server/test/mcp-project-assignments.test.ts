import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  startServer,
  type AgentDeckServer,
  type McpAssignmentStore,
  type StartServerOptions,
} from "../src/index.ts";

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

async function start(options: Omit<StartServerOptions, "dataDir"> = {}): Promise<void> {
  server = await startServer({ dataDir, ...options });
}

async function resourceEvents(): Promise<{ socket: WebSocket; messages: string[] }> {
  const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
  const messages: string[] = [];
  socket.on("message", (raw) => {
    const frame = JSON.parse(String(raw)) as { kind?: string; message?: { type?: string } };
    if (frame.kind === "push" && frame.message?.type) messages.push(frame.message.type);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { socket, messages };
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

  it("persists a deduped All Projects default across restart and keeps it distinct from project assignment", async () => {
    const first = await api("PATCH", "/mcp/default-only/default-assignment", { enabled: true });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ defaultAssignedServerIds: ["default-only"] });

    const scoped = (await (
      await api("GET", `/mcp?projectId=${encodeURIComponent(projectId)}`)
    ).json()) as {
      defaultAssignedServerIds: string[];
      assignedServerIds: string[];
      missingDefaultAssignedServerIds: string[];
    };
    expect(scoped).toMatchObject({
      defaultAssignedServerIds: ["default-only"],
      assignedServerIds: [],
      missingDefaultAssignedServerIds: ["default-only"],
    });

    await server.close();
    await start();
    const settings = (await (await api("GET", "/settings")).json()) as {
      settings: { defaultMcpServers: string[] };
    };
    expect(settings.settings.defaultMcpServers).toEqual(["default-only"]);
  });

  it("uses an injected store as the authoritative assignment reader and writer", async () => {
    await server.close();
    let defaults: string[] = ["injected-default"];
    const byProject = new Map<string, string[]>();
    const injected: McpAssignmentStore = {
      defaultServerNames: () => defaults,
      projectServerNames: (id) => byProject.get(id) ?? [],
      setDefaultServer: (name, enabled) => {
        defaults = enabled
          ? [...new Set([...defaults, name])]
          : defaults.filter((id) => id !== name);
        return defaults;
      },
      setProjectServers: (id, names) => {
        const assignedMcpServers = [...new Set(names)];
        byProject.set(id, assignedMcpServers);
        return assignedMcpServers;
      },
    };
    await start({ mcpAssignmentStore: injected });
    const added = await api("POST", "/projects", { path: projectPath, name: "Injected" });
    const injectedProjectId = ((await added.json()) as { project: { id: string } }).project.id;
    expect(
      (await api("PATCH", `/projects/${injectedProjectId}`, { assignedMcpServers: ["explicit"] }))
        .status,
    ).toBe(200);
    expect(
      (await api("PATCH", "/mcp/second-default/default-assignment", { enabled: true })).status,
    ).toBe(200);

    const catalog = (await (
      await api("GET", `/mcp?projectId=${encodeURIComponent(injectedProjectId)}`)
    ).json()) as { defaultAssignedServerIds: string[]; assignedServerIds: string[] };
    expect(catalog.defaultAssignedServerIds).toEqual(["injected-default", "second-default"]);
    expect(catalog.assignedServerIds).toEqual(["explicit"]);
    const listed = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{ id: string; assignedMcpServers?: string[] }>;
    };
    expect(
      listed.projects.find((project) => project.id === injectedProjectId)?.assignedMcpServers,
    ).toEqual(["explicit"]);

    const combined = await api("PATCH", `/projects/${injectedProjectId}`, {
      assignedMcpServers: ["combined"],
      assignedSkills: ["kept-skill"],
      enabled: false,
    });
    expect(combined.status).toBe(200);
    expect(await combined.json()).toMatchObject({
      project: {
        assignedMcpServers: ["combined"],
        assignedSkills: ["kept-skill"],
        enabled: false,
      },
    });
    const combinedList = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{
        id: string;
        assignedMcpServers?: string[];
        assignedSkills?: string[];
        enabled?: boolean;
      }>;
    };
    expect(combinedList.projects.find((project) => project.id === injectedProjectId)).toMatchObject(
      {
        assignedMcpServers: ["combined"],
        assignedSkills: ["kept-skill"],
        enabled: false,
      },
    );
    expect((await (await api("GET", "/settings")).json()) as object).toMatchObject({
      settings: { defaultMcpServers: ["injected-default", "second-default"] },
    });
  });

  it("returns a typed failure without reconciling when the injected assignment store cannot write", async () => {
    await server.close();
    const failing: McpAssignmentStore = {
      defaultServerNames: () => [],
      projectServerNames: () => [],
      setDefaultServer: () => {
        throw new Error("simulated assignment write failure");
      },
      setProjectServers: () => {
        throw new Error("unused");
      },
    };
    await start({ mcpAssignmentStore: failing });
    const response = await api("PATCH", "/mcp/fails/default-assignment", { enabled: true });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      code: "RESOURCE_WRITE_FAILED",
      error: "simulated assignment write failure",
    });
    const settings = (await (await api("GET", "/settings")).json()) as {
      settings: { defaultMcpServers: string[] };
    };
    expect(settings.settings.defaultMcpServers).toEqual([]);

    const configPath = path.join(home, ".pi", "agent", "mcp.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ mcpServers: { keep: { command: "keep" } } }));
    const deletion = await api("DELETE", "/mcp/keep");
    expect(deletion.status).toBe(500);
    expect(readFileSync(configPath, "utf8")).toContain('"keep"');
  });

  it("broadcasts successful deletion clears when a later assignment write fails", async () => {
    await server.close();
    let defaults = ["partial-delete"];
    const byProject = new Map([[projectId, ["partial-delete"]]]);
    const partiallyFailing: McpAssignmentStore = {
      defaultServerNames: () => defaults,
      projectServerNames: (id) => byProject.get(id) ?? [],
      setDefaultServer: (name, enabled) => {
        defaults = enabled
          ? [...new Set([...defaults, name])]
          : defaults.filter((id) => id !== name);
        return defaults;
      },
      setProjectServers: () => {
        throw new Error("simulated later assignment failure");
      },
    };
    const configPath = path.join(home, ".pi", "agent", "mcp.json");
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { "partial-delete": { command: "missing-command" } } }),
    );
    await start({ mcpAssignmentStore: partiallyFailing });
    const events = await resourceEvents();

    const deletion = await api("DELETE", "/mcp/partial-delete");
    expect(deletion.status).toBe(500);
    expect(await deletion.json()).toMatchObject({
      code: "RESOURCE_WRITE_FAILED",
      assignmentsPartiallyCleared: true,
      error: expect.stringContaining("Retry deletion"),
    });
    expect(defaults).toEqual([]);
    expect(byProject.get(projectId)).toEqual(["partial-delete"]);
    expect(readFileSync(configPath, "utf8")).toContain("partial-delete");
    await expect
      .poll(() => events.messages.filter((type) => type === "resources_changed"))
      .toHaveLength(1);
    events.socket.close();
  });

  it("saves the assignment over a malformed project config and starts nothing", async () => {
    const configDir = path.join(projectPath, ".pi");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "mcp.json"), "{ malformed", "utf8");

    const response = await api("PATCH", `/projects/${projectId}`, {
      assignedMcpServers: ["repository-server"],
    });
    expect(response.status).toBe(200);

    const projects = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{ id: string; assignedMcpServers?: string[] }>;
    };
    expect(
      projects.projects.find((project) => project.id === projectId)?.assignedMcpServers,
    ).toEqual(["repository-server"]);
    expect(server.bridge.specs().some((spec) => spec.name === "mcp")).toBe(false);
  });
});
