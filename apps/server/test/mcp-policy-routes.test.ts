import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { FileMcpDefinitionStore } from "../src/mcpDefinitions.ts";
import type { McpPolicyStore } from "../src/mcpPolicy.ts";
import { registerMcpRoutes } from "../src/routes/mcp.ts";

interface Harness {
  fastify: FastifyInstance;
  home: string;
  policy: McpPolicyStore;
  forget: ReturnType<typeof vi.fn>;
  probe: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  writes: boolean[];
}

function makeHarness(
  options: {
    enabled?: boolean;
    failWrite?: boolean;
    authoritativeWrite?: boolean;
    hiddenProject?: boolean;
    onRootsFor?: (home: string) => void;
    catalogServers?: Record<string, unknown>[];
    status?: Record<string, unknown>[];
  } = {},
): Harness {
  const fastify = Fastify();
  let enabled = options.enabled ?? true;
  const writes: boolean[] = [];
  const policy: McpPolicyStore = {
    enabled: () => enabled,
    setEnabled: (next) => {
      writes.push(next);
      if (options.failWrite) throw new Error("disk full");
      enabled = options.authoritativeWrite ?? next;
      return enabled;
    },
  };
  const forget = vi.fn();
  // Probing runs only for the assigned `remote` (projectHasEffectiveMcpGrant below).
  const probe = vi.fn(async (_projectId: string, serverId: string) => serverId === "remote");
  const broadcast = vi.fn();
  const home = mkdtempSync(path.join(tmpdir(), "mcp-policy-route-home-"));
  registerMcpRoutes({
    fastify,
    mcpPolicy: policy,
    mcpDefinitions: new FileMcpDefinitionStore(),
    forgetMcpProbes: forget,
    probeMcp: probe,
    mcpProbe: (_projectId: string, serverId: string) =>
      options.status?.find((status) => status.id === serverId),
    effectiveMcpConfigs: () => ({
      configs: (options.catalogServers ?? [{ id: "remote", url: "https://mcp.example/mcp" }]).map(
        (server) => ({ id: server.id, url: server.url, command: server.command }),
      ),
      valid: true,
      catalog: {
        valid: true,
        servers: options.catalogServers?.map((server) => ({
          sourcePath: path.join(home, ".pi", "agent", "mcp.json"),
          ...server,
        })) ?? [
          {
            id: "remote",
            transport: "http",
            url: "https://mcp.example/mcp",
            scope: "global",
            sourcePath: path.join(home, ".pi", "agent", "mcp.json"),
            // The catalog now carries whether a definition came from a file the
            // app writes; this fixture's file is exactly that one.
            writable: true,
          },
        ],
      },
    }),
    globalMcpConfigs: () => ({
      configs: [],
      valid: true,
      catalog: { servers: [], valid: true },
    }),
    isMcpEnvOverride: () => false,
    broadcast,
    rootsFor: () => {
      options.onRootsFor?.(home);
      return { home, projectPath: home };
    },
    projects: {
      list: () => [
        {
          id: "project",
          name: "Project",
          path: home,
          createdAt: "now",
          hidden: options.hiddenProject,
        },
      ],
      find: (predicate: (value: { id: string }) => boolean) => {
        const project = {
          id: "project",
          name: "Project",
          path: home,
          createdAt: "now",
          hidden: options.hiddenProject,
        };
        return predicate(project) ? project : undefined;
      },
    },
    mcpAssignments: {
      defaultServerNames: () => [],
      projectServerNames: () => [],
    },
    projectHasEffectiveMcpGrant: (_projectId: string, serverId: string) => serverId === "remote",
  } as unknown as ServerContext);
  return {
    fastify,
    home,
    policy,
    forget,
    probe,
    broadcast,
    writes,
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(async () => {
  await harness.fastify.close();
});

describe("GET /mcp coherent provenance", () => {
  it("keeps config and winning source from one snapshot when the file changes afterward", async () => {
    await harness.fastify.close();
    let laterRootReads = 0;
    harness = makeHarness({
      onRootsFor: (home) => {
        laterRootReads += 1;
        const file = path.join(home, ".pi", "mcp.json");
        mkdirSync(path.dirname(file), { recursive: true });
        writeFileSync(
          file,
          JSON.stringify({ mcpServers: { remote: { command: "changed-project-command" } } }),
        );
      },
    });

    const response = await harness.fastify.inject({
      method: "GET",
      url: "/mcp?projectId=project",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().servers).toEqual([
      expect.objectContaining({
        id: "remote",
        transport: "http",
        source: "global",
        editable: true,
        url: "https://mcp.example/mcp",
        provenance: {
          source: "global",
          path: expect.stringMatching(/[\\/].pi[\\/]agent[\\/]mcp.json$/),
        },
      }),
    ]);
    // A second roots/catalog read would run the deterministic concurrent-write
    // hook above and incorrectly pair the URL config with project provenance.
    expect(laterRootReads).toBe(0);
  });
});

describe("GET /mcp live tools (MCP-19)", () => {
  it("passes each tool's own name and description through to the renderer", async () => {
    // The UI reads raw metadata rather than trying to derive descriptions from
    // the model-facing proxy name.
    await harness.fastify.close();
    harness = makeHarness({
      status: [
        {
          id: "remote",
          transport: "http",
          connected: true,
          toolNames: ["remote/echo"],
          tools: [{ name: "echo", description: "Echo the input." }],
        },
      ],
    });

    const servers = (
      await harness.fastify.inject({ method: "GET", url: "/mcp?projectId=project" })
    ).json().servers as { id: string; tools?: unknown }[];

    expect(servers.find((server) => server.id === "remote")!.tools).toEqual([
      { name: "echo", description: "Echo the input." },
    ]);
  });

  it("bounds what an untrusted server can make the UI render", async () => {
    // Tool metadata comes from a remote server. A huge inventory or a
    // multi-megabyte description must not reach the renderer at all.
    await harness.fastify.close();
    harness = makeHarness({
      status: [
        {
          id: "remote",
          transport: "http",
          connected: true,
          toolNames: [],
          tools: Array.from({ length: 500 }, (_, index) => ({
            name: `tool_${index}`,
            description: "d".repeat(5000),
          })),
        },
      ],
    });

    const server = (
      await harness.fastify.inject({ method: "GET", url: "/mcp?projectId=project" })
    ).json().servers[0] as { tools: { name: string; description?: string }[] };

    expect(server.tools.length).toBeLessThanOrEqual(200);
    expect(server.tools[0]!.description!.length).toBeLessThanOrEqual(500);
  });
});

describe("POST /mcp", () => {
  it("persists headers supplied with a remote server (MCP-12)", async () => {
    // A pasted `claude mcp add … -H "Authorization: Bearer …"` carries the only
    // thing that makes an authenticated remote server usable. The add body used
    // to accept url alone, so the header was dropped between parse and disk.
    const response = await harness.fastify.inject({
      method: "POST",
      url: "/mcp",
      payload: {
        name: "docs",
        url: "https://mcp.example/mcp",
        headers: { Authorization: "Bearer t" },
      },
    });

    expect(response.statusCode).toBe(201);
    const doc = JSON.parse(
      readFileSync(path.join(harness.home, ".pi", "agent", "mcp.json"), "utf8"),
    ) as { mcpServers: Record<string, Record<string, unknown>> };
    expect(doc.mcpServers.docs).toMatchObject({
      url: "https://mcp.example/mcp",
      headers: { Authorization: "Bearer t" },
    });
  });

  it("rejects a header a real request could never send (MCP-12)", async () => {
    // Written to disk, an unusable header only surfaces much later as a
    // disconnected server; undici throws while building the request. Fail here.
    for (const headers of [
      { "Bad Header": "x" },
      { "Bad:Header": "x" },
      { Authorization: "Bearer\r\nX-Injected: 1" },
    ]) {
      const response = await harness.fastify.inject({
        method: "POST",
        url: "/mcp",
        payload: { name: "docs", url: "https://mcp.example/mcp", headers },
      });
      expect(response.statusCode).toBe(400);
    }
    expect(existsSync(path.join(harness.home, ".pi", "agent", "mcp.json"))).toBe(false);
  });
});

describe("PATCH /mcp/:id (MCP-18)", () => {
  it("accepts env for a stdio server and headers for a remote one", async () => {
    // The edit form gains the Environment and Headers boxes native has, so the
    // edit body must carry them; before, PATCH took command/args or url only and
    // every keystroke in those boxes was discarded on save.
    const file = path.join(harness.home, ".pi", "agent", "mcp.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example/mcp" } } }),
    );

    const patched = await harness.fastify.inject({
      method: "PATCH",
      url: "/mcp/remote",
      payload: { url: "https://mcp.example/mcp", headers: { Authorization: "Bearer t" } },
    });
    expect(patched.statusCode).toBe(200);
    const doc = JSON.parse(readFileSync(file, "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    expect(doc.mcpServers.remote!.headers).toEqual({ Authorization: "Bearer t" });
  });

  it("rejects an unusable header on edit exactly as add does", async () => {
    const file = path.join(harness.home, ".pi", "agent", "mcp.json");
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({ mcpServers: { remote: { url: "https://mcp.example/mcp" } } }),
    );

    const response = await harness.fastify.inject({
      method: "PATCH",
      url: "/mcp/remote",
      payload: { url: "https://mcp.example/mcp", headers: { "Bad Header": "x" } },
    });

    expect(response.statusCode).toBe(400);
  });
});

describe("MCP policy route", () => {
  it("uses the injected store as authoritative read/write truth", async () => {
    const initial = await harness.fastify.inject({ method: "GET", url: "/mcp" });
    expect(initial.json()).toMatchObject({ mcpEnabled: true });

    const toggled = await harness.fastify.inject({
      method: "PATCH",
      url: "/mcp/policy",
      payload: { enabled: false },
    });
    expect(toggled.statusCode).toBe(200);
    expect(toggled.json()).toEqual({ mcpEnabled: false });
    expect(harness.writes).toEqual([false]);
    // Pausing drops every cached probe; sessions are refused by the policy hook.
    expect(harness.forget).toHaveBeenCalledOnce();
    expect(harness.broadcast).toHaveBeenCalledWith({ type: "resources_changed" });
    expect((await harness.fastify.inject({ method: "GET", url: "/mcp" })).json()).toMatchObject({
      mcpEnabled: false,
    });
  });

  it("converges from the authoritative returned boolean rather than the request", async () => {
    await harness.fastify.close();
    harness = makeHarness({ enabled: true, authoritativeWrite: false });
    const response = await harness.fastify.inject({
      method: "PATCH",
      url: "/mcp/policy",
      payload: { enabled: true },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ mcpEnabled: false });
    expect(harness.writes).toEqual([true]);
    expect(harness.forget).toHaveBeenCalledOnce();
  });

  it("changes neither runtime nor UI broadcast when persistence fails", async () => {
    await harness.fastify.close();
    harness = makeHarness({ failWrite: true });
    const response = await harness.fastify.inject({
      method: "PATCH",
      url: "/mcp/policy",
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({ code: "RESOURCE_WRITE_FAILED", error: "disk full" });
    expect(harness.policy.enabled()).toBe(true);
    expect(harness.forget).not.toHaveBeenCalled();
    expect(harness.broadcast).not.toHaveBeenCalled();
  });

  it("refuses a check while paused", async () => {
    await harness.fastify.inject({
      method: "PATCH",
      url: "/mcp/policy",
      payload: { enabled: false },
    });
    const check = await harness.fastify.inject({
      method: "POST",
      url: "/mcp/remote/refresh?projectId=project",
    });
    expect(check.statusCode).toBe(409);
    expect(check.json()).toMatchObject({ error: expect.stringContaining("paused") });
    expect(harness.probe).not.toHaveBeenCalled();
  });
});

describe("POST /mcp/:id/refresh (probe)", () => {
  it("probes an assigned server and returns what it found", async () => {
    await harness.fastify.close();
    harness = makeHarness({
      status: [{ id: "remote", connected: true, toolNames: ["remote/echo"], tools: [] }],
    });
    const check = await harness.fastify.inject({
      method: "POST",
      url: "/mcp/remote/refresh?projectId=project",
    });
    expect(check.statusCode).toBe(200);
    expect(check.json()).toMatchObject({ server: { id: "remote", connected: true } });
    expect(harness.probe).toHaveBeenCalledWith("project", "remote");
    expect(harness.broadcast).toHaveBeenCalledWith({ type: "resources_changed" });
  });

  it("answers 404 for a server not assigned to the project", async () => {
    const check = await harness.fastify.inject({
      method: "POST",
      url: "/mcp/other/refresh?projectId=project",
    });
    expect(check.statusCode).toBe(404);
  });

  it("hides a cached probe once the server is no longer assigned", async () => {
    await harness.fastify.close();
    harness = makeHarness({
      catalogServers: [
        {
          id: "other",
          transport: "http",
          url: "https://o.example/mcp",
          scope: "global",
          writable: true,
        },
      ],
      status: [{ id: "other", connected: true, toolNames: ["other/x"], tools: [] }],
    });
    const servers = (
      await harness.fastify.inject({ method: "GET", url: "/mcp?projectId=project" })
    ).json().servers as { id: string; connected: boolean }[];
    expect(servers).toEqual([expect.objectContaining({ id: "other", connected: false })]);
  });
});
