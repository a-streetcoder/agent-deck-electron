import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { FileMcpOAuthStore } from "@agent-deck/mcp";
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

function globalMcpPath(): string {
  return path.join(home, ".pi", "agent", "mcp.json");
}

function writeGlobalMcp(config: unknown): void {
  const file = globalMcpPath();
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

function readGlobalMcp(): Record<string, unknown> {
  return JSON.parse(readFileSync(globalMcpPath(), "utf8")) as Record<string, unknown>;
}

async function start(): Promise<void> {
  server = await startServer({ dataDir });
}

beforeEach(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "deck-mcp-edit-data-"));
  home = mkdtempSync(path.join(tmpdir(), "deck-mcp-edit-home-"));
  projectPath = mkdtempSync(path.join(tmpdir(), "deck-mcp-edit-project-"));
  process.env.AGENT_DECK_TEST = "1";
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: home });
  delete process.env.AGENT_DECK_MCP_SERVERS;
  await start();
  const added = await api("POST", "/projects", { path: projectPath, name: "Edit MCP" });
  projectId = ((await added.json()) as { project: { id: string } }).project.id;
});

afterEach(async () => {
  await server.close();
  if (originalPiEnv === undefined) delete process.env.AGENT_DECK_PI_ENV;
  else process.env.AGENT_DECK_PI_ENV = originalPiEnv;
  if (originalMcpEnv === undefined) delete process.env.AGENT_DECK_MCP_SERVERS;
  else process.env.AGENT_DECK_MCP_SERVERS = originalMcpEnv;
});

describe("MCP config mutation credential lifecycle", () => {
  it("clears only removed server credentials on disk reload", async () => {
    writeGlobalMcp({
      mcpServers: {
        removed: { url: "http://127.0.0.1:1/mcp" },
        retained: { url: "http://127.0.0.1:2/mcp" },
      },
    });
    expect(
      (
        await api("PATCH", `/projects/${projectId}`, {
          assignedMcpServers: ["removed", "retained"],
        })
      ).status,
    ).toBe(200);
    const store = new FileMcpOAuthStore(path.join(dataDir, "mcp-oauth"));
    const removedKey = `v2:${JSON.stringify([projectId, "removed"])}`;
    const retainedKey = `v2:${JSON.stringify([projectId, "retained"])}`;
    store.save(removedKey, {
      serverUrl: "http://127.0.0.1:1/mcp",
      tokens: { access_token: "removed-token", token_type: "Bearer" },
    });
    store.save(retainedKey, {
      serverUrl: "http://127.0.0.1:2/mcp",
      tokens: { access_token: "retained-token", token_type: "Bearer" },
    });
    writeGlobalMcp({
      mcpServers: { retained: { url: "http://127.0.0.1:2/mcp" } },
    });
    expect((await api("POST", `/mcp/reload?projectId=${projectId}`)).status).toBe(200);
    expect(store.load(removedKey)).toBeUndefined();
    expect(store.load(retainedKey)?.tokens?.access_token).toBe("retained-token");
  });
});

describe("DELETE /mcp/:id assignment cleanup", () => {
  it("clears the durable All Projects reference when an app-owned definition is removed", async () => {
    writeGlobalMcp({ mcpServers: { files: { url: "http://127.0.0.1:1/mcp" } } });
    expect((await api("PATCH", "/mcp/files/default-assignment", { enabled: true })).status).toBe(
      200,
    );
    expect(
      (await api("PATCH", `/projects/${projectId}`, { assignedMcpServers: ["files"] })).status,
    ).toBe(200);
    expect((await api("DELETE", "/mcp/files")).status).toBe(200);
    const settings = (await (await api("GET", "/settings")).json()) as {
      settings: { defaultMcpServers: string[] };
    };
    expect(settings.settings.defaultMcpServers).toEqual([]);
    const projects = (await (await api("GET", "/projects")).json()) as {
      projects: Array<{ id: string; assignedMcpServers?: string[] }>;
    };
    expect(
      projects.projects.find((project) => project.id === projectId)?.assignedMcpServers,
    ).toEqual([]);
  });
});

describe("PATCH /mcp/:id", () => {
  it("updates a global mcp.json entry and survives process restart", async () => {
    writeGlobalMcp({
      leftover: true,
      mcpServers: {
        files: {
          command: "npxx",
          args: ["-y", "server-fs"],
          env: { TOKEN: "secret" },
          cwd: "/tmp/work",
        },
        keep: { command: "keep" },
      },
    });

    const patched = await api("PATCH", "/mcp/files", {
      command: "npx",
      args: ["-y", "server-fs"],
    });
    expect(patched.status).toBe(200);
    await expect(patched.json()).resolves.toMatchObject({
      ok: true,
      server: { id: "files", transport: "stdio", connected: false, toolNames: [] },
    });

    expect(readGlobalMcp()).toEqual({
      leftover: true,
      mcpServers: {
        files: {
          command: "npx",
          args: ["-y", "server-fs"],
          env: { TOKEN: "secret" },
          cwd: "/tmp/work",
        },
        keep: { command: "keep" },
      },
    });

    await server.close();
    await start();
    const list = (await (await api("GET", "/mcp")).json()) as {
      servers: Array<{ id: string; command?: string; args?: string[] }>;
    };
    expect(list.servers.find((server) => server.id === "files")).toMatchObject({
      command: "npx",
      args: ["-y", "server-fs"],
    });
    expect(readGlobalMcp()).toMatchObject({
      leftover: true,
      mcpServers: {
        files: { command: "npx", args: ["-y", "server-fs"] },
        keep: { command: "keep" },
      },
    });
  });

  it("refuses to edit an environment-overridden global id", async () => {
    writeGlobalMcp({ mcpServers: { envsrv: { command: "global-cmd" } } });
    process.env.AGENT_DECK_MCP_SERVERS = JSON.stringify([{ id: "envsrv", command: "env-cmd" }]);
    await server.close();
    await start();
    expect((await api("PATCH", "/mcp/envsrv", { command: "uvx" })).status).toBe(403);
    expect(readGlobalMcp()).toEqual({ mcpServers: { envsrv: { command: "global-cmd" } } });
  });

  it("404s an unknown global id", async () => {
    writeGlobalMcp({ mcpServers: { keep: { command: "keep" } } });
    expect((await api("PATCH", "/mcp/missing", { command: "npx" })).status).toBe(404);
    expect(readGlobalMcp()).toEqual({ mcpServers: { keep: { command: "keep" } } });
  });

  it("404s an unusable global key and leaves the file untouched", async () => {
    writeGlobalMcp({
      mcpServers: { broken: { neither: true }, keep: { command: "keep" } },
    });
    expect((await api("PATCH", "/mcp/broken", { command: "npx" })).status).toBe(404);
    expect(readGlobalMcp()).toEqual({
      mcpServers: { broken: { neither: true }, keep: { command: "keep" } },
    });
  });

  it("400s an invalid body and leaves a malformed file untouched", async () => {
    writeGlobalMcp({
      mcpServers: { files: { command: "npx", env: { TOKEN: "secret" } } },
    });
    expect((await api("PATCH", "/mcp/files", { neither: true })).status).toBe(400);
    expect(readGlobalMcp()).toEqual({
      mcpServers: { files: { command: "npx", env: { TOKEN: "secret" } } },
    });

    writeFileSync(globalMcpPath(), "{ this is broken json");
    expect((await api("PATCH", "/mcp/files", { command: "uvx" })).status).toBe(400);
    expect(readFileSync(globalMcpPath(), "utf8")).toBe("{ this is broken json");
  });

  it("rejects a body name that differs from the path id", async () => {
    writeGlobalMcp({ mcpServers: { files: { command: "npx" } } });
    expect((await api("PATCH", "/mcp/files", { name: "other", command: "uvx" })).status).toBe(400);
    expect(readGlobalMcp()).toEqual({ mcpServers: { files: { command: "npx" } } });
  });

  it("keeps same-transport extras and drops the opposite transport", async () => {
    writeGlobalMcp({
      leftover: 7,
      mcpServers: {
        svc: {
          command: "npx",
          args: ["old"],
          env: { TOKEN: "secret" },
          cwd: "/tmp/work",
        },
        keep: { command: "keep" },
      },
    });

    expect((await api("PATCH", "/mcp/svc", { url: "https://example.com/mcp" })).status).toBe(200);
    expect(readGlobalMcp()).toEqual({
      leftover: 7,
      mcpServers: {
        svc: { url: "https://example.com/mcp" },
        keep: { command: "keep" },
      },
    });

    writeGlobalMcp({
      leftover: 7,
      mcpServers: {
        svc: {
          url: "https://exampel.com/mcp",
          headers: { Authorization: "Bearer secret" },
        },
        keep: { command: "keep" },
      },
    });
    expect((await api("PATCH", "/mcp/svc", { url: "https://example.com/mcp" })).status).toBe(200);
    expect(readGlobalMcp()).toEqual({
      leftover: 7,
      mcpServers: {
        svc: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer secret" },
        },
        keep: { command: "keep" },
      },
    });
  });
});

describe("GET /mcp definition fields", () => {
  it("includes command/args or url only on editable global rows", async () => {
    writeGlobalMcp({
      mcpServers: {
        files: {
          command: "npx",
          args: ["-y", "server-fs"],
          env: { TOKEN: "secret" },
          cwd: "/tmp/work",
        },
        remote: {
          url: "https://example.com/mcp",
          headers: { Authorization: "Bearer secret" },
        },
        envsrv: { command: "global-shadowed" },
      },
    });
    mkdirSync(path.join(projectPath, ".pi"), { recursive: true });
    writeFileSync(
      path.join(projectPath, ".pi", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          projectdb: {
            command: "project-db",
            env: { PROJECT: "secret" },
          },
        },
      }),
    );
    process.env.AGENT_DECK_MCP_SERVERS = JSON.stringify([
      { id: "envsrv", command: "env-cmd", env: { ENV: "secret" } },
    ]);

    await server.close();
    await start();

    const globalResponse = await api("GET", "/mcp");
    const globalBody = await globalResponse.text();
    const globalList = JSON.parse(globalBody) as {
      servers: Array<Record<string, unknown>>;
    };
    const files = globalList.servers.find((server) => server.id === "files");
    const remote = globalList.servers.find((server) => server.id === "remote");
    const env = globalList.servers.find((server) => server.id === "envsrv");
    expect(files).toMatchObject({
      transport: "stdio",
      source: "global",
      editable: true,
      command: "npx",
      args: ["-y", "server-fs"],
      provenance: { source: "global", path: globalMcpPath() },
    });
    expect(files).not.toHaveProperty("env");
    expect(files).not.toHaveProperty("cwd");
    expect(remote).toMatchObject({
      transport: "http",
      source: "global",
      editable: true,
      url: "https://example.com/mcp",
    });
    expect(remote).not.toHaveProperty("headers");
    expect(env).toMatchObject({
      source: "environment",
      editable: false,
      provenance: { source: "environment", variable: "AGENT_DECK_MCP_SERVERS" },
    });
    expect(env).not.toHaveProperty("command");
    expect(env).not.toHaveProperty("env");
    expect(globalBody).not.toContain("env-cmd");
    expect(globalBody).not.toContain('ENV":"secret');
    expect(globalBody).not.toContain("global-shadowed");

    const projectList = (await (
      await api("GET", `/mcp?projectId=${encodeURIComponent(projectId)}`)
    ).json()) as { servers: Array<Record<string, unknown>> };
    const projectdb = projectList.servers.find((server) => server.id === "projectdb");
    const projectFiles = projectList.servers.find((server) => server.id === "files");
    const projectEnv = projectList.servers.find((server) => server.id === "envsrv");
    expect(projectdb).toMatchObject({
      source: "project",
      editable: false,
      provenance: {
        source: "project",
        path: path.join(projectPath, ".pi", "mcp.json"),
      },
    });
    expect(projectdb).not.toHaveProperty("command");
    expect(projectdb).not.toHaveProperty("env");
    expect(projectFiles).toMatchObject({
      source: "global",
      editable: true,
      command: "npx",
      args: ["-y", "server-fs"],
      provenance: { source: "global", path: globalMcpPath() },
    });
    expect(projectFiles).not.toHaveProperty("env");
    expect(projectEnv).toMatchObject({
      source: "environment",
      editable: false,
      provenance: { source: "environment", variable: "AGENT_DECK_MCP_SERVERS" },
    });
    expect(projectEnv).not.toHaveProperty("command");
    expect(projectEnv).not.toHaveProperty("env");
  });
});
