import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import type { McpPolicyStore } from "../src/mcpPolicy.ts";
import { registerMcpRoutes } from "../src/routes/mcp.ts";

interface Harness {
  fastify: FastifyInstance;
  policy: McpPolicyStore;
  pause: ReturnType<typeof vi.fn>;
  reconcile: ReturnType<typeof vi.fn>;
  broadcast: ReturnType<typeof vi.fn>;
  writes: boolean[];
  beginAuth: ReturnType<typeof vi.fn>;
  clearAuth: ReturnType<typeof vi.fn>;
  submitCode: ReturnType<typeof vi.fn>;
}

function makeHarness(
  options: {
    enabled?: boolean;
    failWrite?: boolean;
    authoritativeWrite?: boolean;
    hiddenProject?: boolean;
    callbackError?: string;
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
  const pause = vi.fn().mockResolvedValue(undefined);
  const reconcile = vi.fn().mockResolvedValue({ ok: true, missing: [] });
  const broadcast = vi.fn();
  const beginAuth = vi.fn().mockResolvedValue({
    status: "authorizing",
    authUrl: "https://auth.example/authorize",
  });
  const clearAuth = vi.fn().mockResolvedValue(undefined);
  const submitCode = vi
    .fn()
    .mockResolvedValue(
      options.callbackError
        ? { status: "error", error: options.callbackError }
        : { status: "authorized" },
    );
  const home = mkdtempSync(path.join(tmpdir(), "mcp-policy-route-home-"));
  registerMcpRoutes({
    fastify,
    mcpPolicy: policy,
    mcp: {
      pause,
      status: () => [],
      refresh: vi.fn().mockResolvedValue(null),
      scopesFor: () => [],
      has: () => false,
    },
    mcpOAuth: {
      state: () => ({ status: "unauthenticated" }),
      beginAuth,
      clear: clearAuth,
      submitCode,
    },
    reloadMcpConfig: vi.fn().mockResolvedValue({ ok: true }),
    reconcileProjectMcp: reconcile,
    effectiveMcpConfigs: () => ({
      configs: [{ id: "remote", url: "https://mcp.example/mcp" }],
      valid: true,
    }),
    globalMcpConfigs: () => ({ configs: [], valid: true }),
    isMcpEnvOverride: () => false,
    oauthKey: (scope: string, id: string) => `${scope}:${id}`,
    broadcast,
    rootsFor: () => ({ home }),
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
    policy,
    pause,
    reconcile,
    broadcast,
    writes,
    beginAuth,
    clearAuth,
    submitCode,
  };
}

let harness: Harness;
beforeEach(() => {
  harness = makeHarness();
});
afterEach(async () => {
  await harness.fastify.close();
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
    expect(harness.pause).toHaveBeenCalledOnce();
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
    expect(harness.pause).toHaveBeenCalledOnce();
    expect(harness.reconcile).not.toHaveBeenCalled();
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
    expect(harness.pause).not.toHaveBeenCalled();
    expect(harness.reconcile).not.toHaveBeenCalled();
    expect(harness.broadcast).not.toHaveBeenCalled();
  });

  it("serializes concurrent off/on through cleanup before reconnect", async () => {
    let releasePause!: () => void;
    harness.pause.mockReturnValueOnce(new Promise<void>((resolve) => (releasePause = resolve)));
    const off = harness.fastify.inject({
      method: "PATCH",
      url: "/mcp/policy",
      payload: { enabled: false },
    });
    await vi.waitFor(() => expect(harness.pause).toHaveBeenCalledOnce());
    const on = harness.fastify.inject({
      method: "PATCH",
      url: "/mcp/policy",
      payload: { enabled: true },
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(harness.writes).toEqual([false]);
    expect(harness.reconcile).not.toHaveBeenCalled();
    releasePause();
    expect((await off).json()).toEqual({ mcpEnabled: false });
    expect((await on).json()).toEqual({ mcpEnabled: true });
    expect(harness.writes).toEqual([false, true]);
    expect(harness.reconcile).toHaveBeenCalledWith("project");
    expect(harness.policy.enabled()).toBe(true);
  });

  it.each([true, false])(
    "rejects hidden-project OAuth login/callback when policy enabled=%s",
    async (enabled) => {
      await harness.fastify.close();
      harness = makeHarness({ enabled, hiddenProject: true });
      const login = await harness.fastify.inject({
        method: "POST",
        url: "/mcp/remote/login?projectId=project",
      });
      expect(login.statusCode).toBe(404);
      const callback = await harness.fastify.inject({
        method: "POST",
        url: "/mcp/remote/login/callback?projectId=project",
        payload: { code: "code", state: "state" },
      });
      expect(callback.statusCode).toBe(404);
      expect(harness.beginAuth).not.toHaveBeenCalled();
    },
  );

  it.each([
    "state mismatch (possible CSRF) — restart sign-in",
    "sign-in attempt is no longer active — restart sign-in",
    "sign-in attempt was already completed or superseded",
  ])("maps inactive or mismatched OAuth callback admission to 400: %s", async (error) => {
    await harness.fastify.close();
    harness = makeHarness({ callbackError: error });
    const callback = await harness.fastify.inject({
      method: "POST",
      url: "/mcp/remote/login/callback?projectId=project",
      payload: { code: "code", state: "state" },
    });
    expect(callback.statusCode).toBe(400);
    expect(callback.json()).toMatchObject({ error });
  });

  it("keeps OAuth management usable while paused and refuses reconnect", async () => {
    await harness.fastify.inject({
      method: "PATCH",
      url: "/mcp/policy",
      payload: { enabled: false },
    });
    const login = await harness.fastify.inject({
      method: "POST",
      url: "/mcp/remote/login?projectId=project",
    });
    expect(login.statusCode).toBe(200);
    expect(login.json()).toMatchObject({ auth: { status: "authorizing" } });
    expect(harness.beginAuth).toHaveBeenCalledWith(
      "project:remote",
      "https://mcp.example/mcp",
      expect.any(Function),
      { projectId: "project", serverId: "remote" },
    );

    const logout = await harness.fastify.inject({
      method: "POST",
      url: "/mcp/remote/logout?projectId=project",
    });
    expect(logout.statusCode).toBe(200);
    expect(harness.clearAuth).toHaveBeenCalledWith("project:remote");
    const reconnect = await harness.fastify.inject({
      method: "POST",
      url: "/mcp/remote/refresh?projectId=project",
    });
    expect(reconnect.statusCode).toBe(409);
    expect(reconnect.json()).toMatchObject({ error: expect.stringContaining("paused") });
  });

  it("returns a cleanup warning while retaining persisted paused truth", async () => {
    harness.pause.mockRejectedValueOnce(new Error("close failed"));
    const response = await harness.fastify.inject({
      method: "PATCH",
      url: "/mcp/policy",
      payload: { enabled: false },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      mcpEnabled: false,
      warning: "Some live MCP connections could not be closed cleanly.",
    });
    expect(harness.policy.enabled()).toBe(false);
    expect(harness.broadcast).toHaveBeenCalledOnce();
  });
});
