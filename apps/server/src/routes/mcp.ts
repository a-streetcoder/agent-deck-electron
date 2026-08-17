import {
  deleteMcpServer,
  hasMcpServer,
  isValidHttpMcpUrl,
  McpConfigError,
  readMcpServerCatalog,
  writeMcpServer,
  type McpServerEntry,
} from "@agent-deck/resources";
import { z } from "zod";
import type { ServerContext } from "../context.ts";

/** MCP catalog, global-only CRUD, project assignments, and scoped OAuth. */
export function registerMcpRoutes(ctx: ServerContext): void {
  const {
    fastify,
    mcp,
    mcpOAuth,
    reloadMcpConfig,
    reconcileProjectMcp,
    effectiveMcpConfigs,
    globalMcpConfigs,
    isMcpEnvOverride,
    oauthKey,
    broadcast,
    rootsFor,
    projects,
  } = ctx;

  const mcpAddBody = z.union([
    z.object({
      name: z.string().min(1),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: z.record(z.string()).optional(),
    }),
    z.object({
      name: z.string().min(1),
      url: z.string().refine(isValidHttpMcpUrl, "url must be a valid http(s) URL"),
    }),
  ]);

  const mcpEditBody = z.union([
    z.object({
      name: z.string().min(1).optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
    }),
    z.object({
      name: z.string().min(1).optional(),
      url: z.string().refine(isValidHttpMcpUrl, "url must be a valid http(s) URL"),
    }),
  ]);

  const definitionFields = (entry: McpServerEntry | undefined) => {
    if (!entry) return {};
    if (entry.transport === "stdio") {
      return entry.args !== undefined
        ? { command: entry.command, args: entry.args }
        : { command: entry.command };
    }
    return { url: entry.url };
  };

  const projectScope = (raw: unknown): string | undefined => {
    if (typeof raw !== "string") return undefined;
    return projects.find((project) => project.id === raw) ? raw : undefined;
  };

  fastify.get("/mcp", async (request, reply) => {
    const requested = (request.query as { projectId?: unknown }).projectId;
    const scope = projectScope(requested);
    if (requested !== undefined && !scope)
      return reply.status(404).send({ error: "unknown project" });

    if (!scope) {
      const catalog = readMcpServerCatalog(rootsFor());
      const globalById = new Map(catalog.servers.map((entry) => [entry.id, entry]));
      const globalSnapshot = globalMcpConfigs();
      const configs = new Map<string, { id: string; transport: "stdio" | "http" }>();
      for (const config of globalSnapshot.configs)
        configs.set(config.id, { id: config.id, transport: "url" in config ? "http" : "stdio" });
      return {
        valid: catalog.valid && globalSnapshot.valid,
        projectId: null,
        assignedServerIds: [] as string[],
        missingAssignedServerIds: [] as string[],
        servers: [...configs.values()].map((config) => {
          const source = isMcpEnvOverride(config.id)
            ? "environment"
            : globalById.has(config.id)
              ? "global"
              : "environment";
          const editable = source === "global";
          return {
            ...config,
            source,
            // No-project catalog browsing must not disclose another project's
            // live connectivity or tool inventory.
            connected: false,
            toolNames: [] as string[],
            editable,
            auth: { status: "none" as const },
            ...(editable ? definitionFields(globalById.get(config.id)) : {}),
          };
        }),
      };
    }

    const project = projects.find((item) => item.id === scope)!;
    const snapshot = effectiveMcpConfigs(scope);
    const statuses = new Map(mcp.status(scope).map((status) => [status.id, status]));
    const catalog = readMcpServerCatalog(rootsFor(scope));
    const sourceById = new Map(catalog.servers.map((entry) => [entry.id, entry.scope]));
    const assigned = [...new Set(project.assignedMcpServers ?? [])];
    const configured = new Set(snapshot.configs.map((config) => config.id));
    return {
      valid: snapshot.valid,
      projectId: scope,
      assignedServerIds: assigned,
      missingAssignedServerIds: assigned.filter((id) => !configured.has(id)),
      servers: snapshot.configs.map((config) => {
        const status = statuses.get(config.id);
        const transport = "url" in config ? "http" : "stdio";
        const authId = oauthKey(scope, config.id);
        const source = isMcpEnvOverride(config.id)
          ? "environment"
          : (sourceById.get(config.id) ?? "environment");
        const editable = source === "global";
        return {
          id: config.id,
          transport,
          source,
          connected: status?.connected ?? false,
          toolNames: status?.toolNames ?? [],
          error: status?.error,
          editable,
          auth: transport === "http" ? mcpOAuth.state(authId) : { status: "none" as const },
          ...(editable
            ? definitionFields(catalog.servers.find((entry) => entry.id === config.id))
            : {}),
        };
      }),
    };
  });

  fastify.post("/mcp/reload", async (request, reply) => {
    const requested = (request.query as { projectId?: unknown }).projectId;
    const scope = projectScope(requested);
    if (requested !== undefined && !scope)
      return reply.status(404).send({ error: "unknown project" });
    const result = await reloadMcpConfig(scope);
    if (!result.ok) return reply.code(422).send({ error: result.error });
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  const requireScopedHttp = (request: { query: unknown; params: unknown }) => {
    const scope = projectScope((request.query as { projectId?: unknown }).projectId);
    const id = (request.params as { id: string }).id;
    return scope ? { scope, id, authId: oauthKey(scope, id) } : undefined;
  };

  fastify.post("/mcp/:id/login", async (request, reply) => {
    const target = requireScopedHttp(request);
    if (!target) return reply.code(400).send({ error: "projectId is required" });
    const serverUrl = mcp.httpUrlFor(target.id, target.scope);
    if (!serverUrl) return reply.code(404).send({ error: "unknown assigned http MCP server" });
    const state = await mcpOAuth.beginAuth(
      target.authId,
      serverUrl,
      async (completed) => {
        if (completed.status === "authorized") await mcp.refresh(target.id, target.scope);
        broadcast({ type: "resources_changed" });
      },
      { projectId: target.scope, serverId: target.id },
    );
    if (state.status === "error") return reply.code(502).send({ error: state.error, auth: state });
    return { auth: state };
  });

  const mcpCallbackBody = z.object({ code: z.string().min(1), state: z.string().optional() });
  fastify.post("/mcp/:id/login/callback", async (request, reply) => {
    const target = requireScopedHttp(request);
    if (!target) return reply.code(400).send({ error: "projectId is required" });
    const serverUrl = mcp.httpUrlFor(target.id, target.scope);
    if (!serverUrl) return reply.code(404).send({ error: "unknown assigned http MCP server" });
    const parsed = mcpCallbackBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const state = await mcpOAuth.submitCode(
      target.authId,
      serverUrl,
      parsed.data.code,
      parsed.data.state,
    );
    if (state.status !== "authorized") {
      const status = state.error?.includes("state mismatch") ? 400 : 502;
      return reply.code(status).send({ error: state.error, auth: state });
    }
    return { auth: state, server: mcp.status(target.scope).find((item) => item.id === target.id) };
  });

  fastify.delete("/mcp/:id/login", async (request, reply) => {
    const target = requireScopedHttp(request);
    if (!target) return reply.code(400).send({ error: "projectId is required" });
    await mcpOAuth.cancel(target.authId);
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  fastify.post("/mcp/:id/logout", async (request, reply) => {
    const target = requireScopedHttp(request);
    if (!target) return reply.code(400).send({ error: "projectId is required" });
    if (!mcp.has(target.id, target.scope))
      return reply.code(404).send({ error: "unknown assigned MCP server" });
    await mcpOAuth.clear(target.authId);
    await mcp.refresh(target.id, target.scope);
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  fastify.post("/mcp", async (request, reply) => {
    const parsed = mcpAddBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const data = parsed.data;
    const input =
      "url" in data ? { url: data.url } : { command: data.command, args: data.args, env: data.env };
    try {
      writeMcpServer(rootsFor(), "global", data.name, input);
    } catch (error) {
      const message = error instanceof McpConfigError ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
    for (const project of projects.list()) await reconcileProjectMcp(project.id);
    broadcast({ type: "resources_changed" });
    return reply.code(201).send({
      ok: true,
      // Preserve the legacy response envelope without implying execution:
      // definitions remain disconnected until a project assignment grants trust.
      server: {
        id: data.name,
        transport: "url" in data ? "http" : "stdio",
        connected: false,
        toolNames: [] as string[],
      },
    });
  });

  fastify.patch("/mcp/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = mcpEditBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    if (parsed.data.name !== undefined && parsed.data.name !== id) {
      return reply.code(400).send({
        error: "MCP server identity is the path id; rename is not supported",
      });
    }
    const roots = rootsFor();
    if (isMcpEnvOverride(id)) {
      return reply.code(403).send({
        error: "Environment MCP definitions are not editable in-app.",
      });
    }
    try {
      // hasMcpServer throws on a malformed file (400). Usability matches GET:
      // only catalog-listed global entries are editable; leftover keys 404.
      const exists = hasMcpServer(roots, "global", id);
      const usable = readMcpServerCatalog(roots).servers.some(
        (entry) => entry.id === id && entry.scope === "global",
      );
      if (!exists || !usable) {
        return reply.code(404).send({ error: "unknown global MCP server" });
      }
    } catch (error) {
      const message = error instanceof McpConfigError ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
    const input =
      "url" in parsed.data
        ? { url: parsed.data.url }
        : { command: parsed.data.command, args: parsed.data.args };
    try {
      writeMcpServer(roots, "global", id, input);
    } catch (error) {
      const message = error instanceof McpConfigError ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
    await Promise.all(projects.list().map((project) => mcpOAuth.clear(oauthKey(project.id, id))));
    for (const project of projects.list()) await reconcileProjectMcp(project.id);
    broadcast({ type: "resources_changed" });
    return {
      ok: true,
      server: {
        id,
        transport: "url" in parsed.data ? "http" : "stdio",
        connected: false,
        toolNames: [] as string[],
      },
    };
  });

  fastify.delete("/mcp/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    let deletedConfig = false;
    try {
      deletedConfig = deleteMcpServer(rootsFor(), "global", id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return reply.code(400).send({ error: message });
    }
    if (!deletedConfig) return reply.code(404).send({ error: "unknown global MCP server" });
    await Promise.all(projects.list().map((project) => mcpOAuth.clear(oauthKey(project.id, id))));
    for (const project of projects.list()) await reconcileProjectMcp(project.id);
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  fastify.post("/mcp/:id/refresh", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const requested = (request.query as { projectId?: unknown }).projectId;
    const scope = projectScope(requested);
    if (requested !== undefined && !scope)
      return reply.code(404).send({ error: "unknown project" });
    if (scope) {
      const status = await mcp.refresh(id, scope);
      if (!status) return reply.code(404).send({ error: "unknown assigned MCP server" });
      broadcast({ type: "resources_changed" });
      return { server: status };
    }
    const scopes = mcp.scopesFor(id);
    if (scopes.length === 0)
      return reply.code(409).send({
        error: "MCP server is not assigned to any project; assign it before reconnecting.",
      });
    const servers = await Promise.all(scopes.map((owner) => mcp.refresh(id, owner)));
    broadcast({ type: "resources_changed" });
    return { servers: servers.filter((server) => server !== null) };
  });
}
