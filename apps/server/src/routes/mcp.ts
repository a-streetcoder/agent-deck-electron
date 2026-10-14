import {
  hasMcpServer,
  isValidHttpMcpUrl,
  isValidHttpMcpUrlTemplate,
  MCP_MAX_TIMEOUT_MS,
  MCP_SETTINGS_KEYS,
  MCP_TOOL_APPROVALS,
  McpConfigError,
  readMcpServerCatalog,
  type McpServerEntry,
  type McpToolApproval,
} from "@agent-deck/resources";
import { z } from "zod";
import { claudePluginMcpSources, McpImportDiscovery, mcpImportSources } from "../mcpImport.ts";
import type { ServerContext } from "../context.ts";
import { requestUser } from "../trustedProxy.ts";

const MCP_ENV_SOURCE = "AGENT_DECK_MCP_SERVERS" as const;

type McpDefinitionProvenance =
  | { source: "global" | "project"; path: string }
  | { source: "environment"; variable: typeof MCP_ENV_SOURCE };

type McpUiTool = { name: string; description?: string };

// MCP metadata is untrusted remote input; bound it once at the renderer DTO
// boundary so a huge inventory or description cannot freeze the UI.
function uiToolInventory(status?: { toolNames: string[]; tools?: McpUiTool[] }): {
  toolNames: string[];
  tools: McpUiTool[];
} {
  return {
    toolNames: status?.toolNames.slice(0, 200) ?? [],
    tools:
      status?.tools?.slice(0, 200).map((tool) => ({
        ...tool,
        ...(tool.description !== undefined && tool.description.length > 500
          ? { description: `${tool.description.slice(0, 499)}…` }
          : {}),
      })) ?? [],
  };
}

/** MCP catalog, global-only CRUD, project assignments, probes and native sign-in. */
export function registerMcpRoutes(ctx: ServerContext): void {
  const {
    fastify,
    effectiveMcpConfigs,
    globalMcpConfigs,
    isMcpEnvOverride,
    broadcast,
    rootsFor,
    resourceHome,
    projects,
    mcpAssignments,
    mcpPolicy,
    mcpDefinitions,
  } = ctx;

  const mcpHeaders = z.record(z.string()).superRefine((headers, refinement) => {
    const fieldName = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
    for (const [name, value] of Object.entries(headers)) {
      if (!fieldName.test(name)) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `invalid HTTP header name: ${name}`,
        });
      }
      if (/[\r\n]/.test(value)) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `invalid HTTP header value for ${name}: must not contain CR or LF`,
        });
      }
    }
  });

  const mcpEnv = z.record(z.string()).superRefine((env, refinement) => {
    for (const [name, value] of Object.entries(env)) {
      if (!name || name.includes("=") || name.includes("\0")) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `invalid environment variable name: ${name}`,
        });
      }
      if (value.includes("\0")) {
        refinement.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `invalid environment variable value for ${name}: must not contain NUL`,
        });
      }
    }
  });

  const protectedRecordPatch = (record: z.ZodType<Record<string, string>>, foldCase = false) =>
    z
      .object({ set: record.optional(), remove: z.array(z.string().min(1)).optional() })
      .strict()
      .superRefine((patch, refinement) => {
        const normalize = (key: string) => (foldCase ? key.toLowerCase() : key);
        const setKeys = new Set(Object.keys(patch.set ?? {}).map(normalize));
        const removeKeys = new Set((patch.remove ?? []).map(normalize));
        if (
          setKeys.size !== Object.keys(patch.set ?? {}).length ||
          removeKeys.size !== (patch.remove ?? []).length
        ) {
          refinement.addIssue({
            code: z.ZodIssueCode.custom,
            message: "duplicate protected field key",
          });
        }
        for (const key of setKeys) {
          if (removeKeys.has(key)) {
            refinement.addIssue({
              code: z.ZodIssueCode.custom,
              message: "a protected field cannot be replaced and removed together",
            });
          }
        }
      });

  const stdioProtectedPatch = z.object({ env: protectedRecordPatch(mcpEnv) }).strict();
  const httpProtectedPatch = z.object({ headers: protectedRecordPatch(mcpHeaders, true) }).strict();

  const settingsFields = {
    enabledTools: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).optional(),
    disabledTools: z.array(z.string().regex(/^[A-Za-z0-9_.-]+$/)).optional(),
    envVars: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
    envHttpHeaders: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/)).optional(),
    bearerTokenEnvVar: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
      .optional(),
    startupTimeoutMs: z.number().int().min(1).max(MCP_MAX_TIMEOUT_MS).optional(),
    toolTimeoutMs: z.number().int().min(1).max(MCP_MAX_TIMEOUT_MS).optional(),
    toolApproval: z
      .record(
        z.string().regex(/^[A-Za-z0-9_.-]+$/),
        z.enum(MCP_TOOL_APPROVALS as [McpToolApproval, ...McpToolApproval[]]),
      )
      .optional(),
    defaultToolApproval: z
      .enum(MCP_TOOL_APPROVALS as [McpToolApproval, ...McpToolApproval[]])
      .optional(),
    envInterpolation: z.literal("claude").optional(),
  };
  const mcpAddBody = z.union([
    z.object({
      ...settingsFields,
      name: z.string().min(1),
      cwd: z
        .string()
        .min(1)
        .refine((v) => !v.includes("\0"))
        .optional(),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      env: mcpEnv.optional(),
    }),
    z.object({
      ...settingsFields,
      name: z.string().min(1),
      // A Claude-interpolated template is accepted here; the writer re-checks it
      // against `envInterpolation`, and the launcher against the expanded URL.
      url: z
        .string()
        .refine(
          (v) => isValidHttpMcpUrl(v) || isValidHttpMcpUrlTemplate(v),
          "url must be a valid http(s) URL",
        ),
      // A pasted remote server usually carries its auth header; dropping it
      // saves a definition that can only 401 (MCP-12).
      headers: mcpHeaders.optional(),
    }),
  ]);

  const mcpEditBody = z.union([
    z
      .object({
        ...settingsFields,
        name: z.string().min(1).optional(),
        expectedTransport: z.enum(["stdio", "http"]).optional(),
        allowTransportChange: z.boolean().optional(),
        cwd: z
          .string()
          .min(1)
          .refine((v) => !v.includes("\0"))
          .optional(),
        command: z.string().min(1),
        args: z.array(z.string()).optional(),
        env: mcpEnv.optional(),
        protected: stdioProtectedPatch.optional(),
      })
      .superRefine((value, refinement) => {
        if (value.env !== undefined && value.protected?.env !== undefined) {
          refinement.addIssue({
            code: z.ZodIssueCode.custom,
            message: "env and protected env operations cannot be submitted together",
          });
        }
      }),
    z
      .object({
        ...settingsFields,
        name: z.string().min(1).optional(),
        expectedTransport: z.enum(["stdio", "http"]).optional(),
        allowTransportChange: z.boolean().optional(),
        // A Claude-interpolated template is accepted here; the writer re-checks it
        // against `envInterpolation`, and the launcher against the expanded URL.
        url: z
          .string()
          .refine(
            (v) => isValidHttpMcpUrl(v) || isValidHttpMcpUrlTemplate(v),
            "url must be a valid http(s) URL",
          ),
        headers: mcpHeaders.optional(),
        protected: httpProtectedPatch.optional(),
      })
      .superRefine((value, refinement) => {
        if (value.headers !== undefined && value.protected?.headers !== undefined) {
          refinement.addIssue({
            code: z.ZodIssueCode.custom,
            message: "headers and protected header operations cannot be submitted together",
          });
        }
      }),
  ]);

  // A changed definition: drop its old probes and probe it again wherever it is
  // assigned (probeMcp runs nothing elsewhere, and one probe per distinct
  // config), after the response: a save never waits for a server to answer.
  const reprobe = (id: string): void => {
    ctx.forgetMcpProbes((_projectId, serverId) => serverId === id);
    void Promise.all(projects.list().map((project) => ctx.probeMcp(project.id, id)))
      .then((probed) => {
        if (probed.some(Boolean)) broadcast({ type: "resources_changed" });
      })
      .catch(() => {});
  };

  // Settings (policy, timeouts, references) are not secrets: they round-trip so
  // an import can be reviewed and adjusted in the editor.
  const settingsOf = (entry: McpServerEntry) =>
    Object.fromEntries(
      MCP_SETTINGS_KEYS.filter((key) => entry[key] !== undefined).map((key) => [key, entry[key]]),
    );
  const definitionFields = (entry: McpServerEntry | undefined) => {
    if (!entry) return {};
    if (entry.transport === "stdio") {
      return {
        command: entry.command,
        ...(entry.args !== undefined ? { args: entry.args } : {}),
        envKeys: Object.keys(entry.env ?? {}).sort(),
        ...settingsOf(entry),
      };
    }
    return {
      url: entry.url,
      headerKeys: Object.keys(entry.headers ?? {}).sort(),
      ...settingsOf(entry),
    };
  };

  const definitionProvenance = (
    source: "global" | "project" | "environment",
    entry?: McpServerEntry,
  ): McpDefinitionProvenance => {
    if (source === "environment") return { source, variable: MCP_ENV_SOURCE };
    if (!entry || entry.scope !== source) {
      // File-backed source labels are derived from this same winning catalog,
      // so this branch denotes an internal inconsistency rather than a fallback
      // path that could accidentally identify the wrong definition.
      throw new Error(`missing ${source} MCP provenance`);
    }
    return { source, path: entry.sourcePath };
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
      const globalSnapshot = globalMcpConfigs();
      const catalog = globalSnapshot.catalog;
      const globalById = new Map(catalog.servers.map((entry) => [entry.id, entry]));
      const configs = new Map<string, { id: string; transport: "stdio" | "http" }>();
      for (const config of globalSnapshot.configs)
        configs.set(config.id, { id: config.id, transport: "url" in config ? "http" : "stdio" });
      const defaults = [...new Set(mcpAssignments.defaultServerNames())];
      const configured = new Set(configs.keys());
      return {
        valid: catalog.valid && globalSnapshot.valid,
        mcpEnabled: mcpPolicy.enabled(),
        projectId: null,
        defaultAssignedServerIds: defaults,
        missingDefaultAssignedServerIds: defaults.filter((id) => !configured.has(id)),
        assignedServerIds: [] as string[],
        missingAssignedServerIds: [] as string[],
        servers: [...configs.values()].map((config) => {
          const source = isMcpEnvOverride(config.id)
            ? "environment"
            : globalById.has(config.id)
              ? "global"
              : "environment";
          // Editable means WRITABLE, not merely global-scoped. A server defined
          // only in `~/.config/mcp/mcp.json` is a read-only ecosystem source:
          // offering Edit/Delete produced a 404 from the writer, which targets
          // `~/.pi/agent/mcp.json` alone (Codex).
          const editable = source === "global" && globalById.get(config.id)?.writable === true;
          const entry = globalById.get(config.id);
          return {
            ...config,
            source,
            provenance: definitionProvenance(source, entry),
            // No-project catalog browsing must not disclose another project's
            // live connectivity or tool inventory.
            connected: false,
            ...uiToolInventory(),
            editable,
            ...(editable ? definitionFields(entry) : {}),
          };
        }),
      };
    }

    const snapshot = effectiveMcpConfigs(scope);
    const catalog = snapshot.catalog;
    const sourceById = new Map(catalog.servers.map((entry) => [entry.id, entry.scope]));
    const assigned = [...new Set(mcpAssignments.projectServerNames(scope))];
    const configured = new Set(snapshot.configs.map((config) => config.id));
    const defaults = [...new Set(mcpAssignments.defaultServerNames())];
    return {
      valid: snapshot.valid,
      mcpEnabled: mcpPolicy.enabled(),
      projectId: scope,
      defaultAssignedServerIds: defaults,
      missingDefaultAssignedServerIds: defaults.filter((id) => !configured.has(id)),
      assignedServerIds: assigned,
      missingAssignedServerIds: assigned.filter((id) => !configured.has(id)),
      servers: snapshot.configs.map((config) => {
        // A probe stops counting once its server is no longer assigned here.
        const status =
          mcpPolicy.enabled() && ctx.projectHasEffectiveMcpGrant(scope, config.id)
            ? ctx.mcpProbe(scope, config.id)
            : undefined;
        const transport = "url" in config ? "http" : "stdio";
        const source = isMcpEnvOverride(config.id)
          ? "environment"
          : (sourceById.get(config.id) ?? "environment");
        const entry = catalog.servers.find((candidate) => candidate.id === config.id);
        const editable = source === "global" && entry?.writable === true;
        return {
          id: config.id,
          transport,
          source,
          provenance: definitionProvenance(source, entry),
          connected: status?.connected ?? false,
          ...(status?.needsSignIn ? { needsSignIn: true } : {}),
          ...uiToolInventory(status),
          error: status?.error,
          editable,
          // Pi offers OAuth only to an HTTP server without an Authorization header
          // (bearerTokenEnvVar is already one here).
          oauth:
            "url" in config &&
            !Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === "authorization"),
          ...(editable ? definitionFields(entry) : {}),
        };
      }),
    };
  });

  // One global mutation chain prevents two clients from persisting/reconciling out of order.
  let policyToggleTail: Promise<void> = Promise.resolve();
  fastify.patch("/mcp/policy", async (request, reply) => {
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid MCP policy" });
    const run = async (): Promise<{ status: number; body: Record<string, unknown> }> => {
      let authoritativeEnabled: boolean;
      try {
        authoritativeEnabled = mcpPolicy.setEnabled(parsed.data.enabled);
      } catch (error) {
        return {
          status: 500,
          body: {
            code: "RESOURCE_WRITE_FAILED",
            error:
              error instanceof Error
                ? error.message
                : "The MCP availability preference could not be saved.",
          },
        };
      }
      if (!authoritativeEnabled) ctx.forgetMcpProbes(() => true);
      broadcast({ type: "resources_changed" });
      return { status: 200, body: { mcpEnabled: mcpPolicy.enabled() } };
    };
    const resultPromise = policyToggleTail.then(run, run);
    policyToggleTail = resultPromise.then(
      () => undefined,
      () => undefined,
    );
    const result = await resultPromise;
    return reply.code(result.status).send(result.body);
  });

  fastify.patch("/mcp/:id/default-assignment", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = z.object({ enabled: z.boolean() }).strict().safeParse(request.body);
    if (!parsed.success || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(id)) {
      return reply.code(400).send({ error: "invalid MCP default assignment" });
    }
    let defaultAssignedServerIds: string[];
    try {
      // Durable assignment is authoritative and must land before runtime changes.
      defaultAssignedServerIds = mcpAssignments.setDefaultServer(id, parsed.data.enabled);
      // An unassigned server's old check result must not come back on reassignment.
      if (!parsed.data.enabled)
        ctx.forgetMcpProbes(
          (projectId, serverId) =>
            serverId === id && !ctx.projectHasEffectiveMcpGrant(projectId, serverId),
        );
    } catch (error) {
      return reply.code(500).send({
        code: "RESOURCE_WRITE_FAILED",
        error:
          error instanceof Error
            ? error.message
            : "The All Projects MCP assignment could not be saved.",
      });
    }
    broadcast({ type: "resources_changed" });
    return { defaultAssignedServerIds };
  });

  fastify.post("/mcp/reload", async (request, reply) => {
    const requested = (request.query as { projectId?: unknown }).projectId;
    const scope = projectScope(requested);
    if (requested !== undefined && !scope)
      return reply.status(404).send({ error: "unknown project" });
    // Sessions read the catalog at spawn; a reload only drops stale probes.
    const valid = scope
      ? effectiveMcpConfigs(scope).valid
      : globalMcpConfigs().valid &&
        projects.list().every((project) => effectiveMcpConfigs(project.id).valid);
    if (!valid)
      return reply.code(422).send({
        error: "Global or project .pi/mcp.json is not valid JSON; no server was started.",
      });
    ctx.forgetMcpProbes((projectId) => !scope || projectId === scope);
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Native MCP sign-in runs inside a live Pi.  // Native MCP sign-in runs inside a live Pi. `/mcp login <name>` makes
  // Pi send the authorization URL (notify card) and ask for the redirect URL
  // (input card) in that session; tokens land in the session owner's
  // <agentDir>/mcp-auth.json.
  fastify.post("/mcp/:id/native-login", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ sessionId: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const session = ctx.sessions.get(parsed.data.sessionId);
    if (!session) return reply.code(404).send({ error: "unknown session" });
    // The session's Pi writes to its OWNER's agent dir: signing in from someone
    // else's session would put your account in their mcp-auth.json.
    if (ctx.sharedServer && session.meta.createdBy?.id !== requestUser(request.raw)?.id)
      return reply.code(403).send({ error: "sign in from one of your own sessions" });
    // Resume a parked session first (getState spawns Pi if needed), so a session
    // that cannot start answers here instead of after the detached prompt, and
    // the name comes from the spawn that will run the command (a parked session
    // may wake with a newly assigned server).
    try {
      await session.getState();
    } catch (error) {
      return reply.code(502).send({ error: `The session could not start: ${String(error)}` });
    }
    const meta = ctx.sessions.get(parsed.data.sessionId)?.meta ?? session.meta;
    const name = ctx.nativeMcpNameFor(meta, id);
    if (!name) return reply.code(404).send({ error: "this session does not use that MCP server" });
    // Not awaited: Pi answers an extension-command prompt only once the command
    // ends, i.e. after the user pasted the redirect URL, far past the RPC
    // timeout. A timeout is not recorded as a session failure.
    session.prompt(`/mcp login ${name}`).catch((error: unknown) => {
      request.log.warn({ err: error, serverId: id }, "MCP sign-in prompt did not complete");
    });
    return reply.code(202).send({ ok: true });
  });

  const importDiscovery = new McpImportDiscovery();
  // Project-private configuration is read only for ONE explicitly named
  // project; user-level sources and user-scoped plugins are always included.
  fastify.post("/mcp/import/discover", async (request, reply) => {
    reply.header("Cache-Control", "no-store");
    const parsed = z
      .object({ projectId: z.string().nullable().optional() })
      .strict()
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid discovery request" });
    const projectId = parsed.data.projectId ?? undefined;
    if (projectId !== undefined && !projectScope(projectId))
      return reply.status(404).send({ error: "unknown project" });
    const projectPath = projectId ? projects.find((p) => p.id === projectId)?.path : undefined;
    const home = resourceHome();
    const scope = { home, projectPath };
    return importDiscovery.discover(
      [...mcpImportSources(scope), ...(await claudePluginMcpSources(scope))],
      { projectId: projectId ?? null, projectPath, home },
    );
  });

  fastify.post("/mcp", async (request, reply) => {
    const importRequest = z
      .object({ importToken: z.string(), overwrite: z.boolean().optional() })
      .strict()
      .safeParse(request.body);
    let body = request.body;
    if (importRequest.success) {
      const candidate = importDiscovery.resolve(importRequest.data.importToken);
      if (!candidate)
        return reply.code(400).send({ error: "Import preview expired. Discover again." });
      if (!importRequest.data.overwrite && hasMcpServer(rootsFor(), "global", candidate.name)) {
        return reply.code(409).send({
          error: "A global definition already exists. Confirm replacement before importing.",
        });
      }
      // Import replaces the source definition in full, including absent secrets.
      body = {
        name: candidate.name,
        ...candidate.definition,
      };
    }
    const parsed = mcpAddBody.safeParse(body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const data = parsed.data;
    const input = "url" in data ? { ...data, url: data.url } : { ...data, command: data.command };
    try {
      mcpDefinitions.write(
        rootsFor(),
        "global",
        data.name,
        input,
        undefined,
        importRequest.success ? "replace" : "merge",
      );
    } catch (error) {
      const message =
        error instanceof McpConfigError
          ? error.message
          : "The MCP server definition could not be saved.";
      return reply.code(400).send({ error: message });
    }
    reprobe(data.name);
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
      // Authorize on the SAME fact GET reports as `editable`: the EFFECTIVE
      // definition must come from the writable file. Checking only key presence
      // let a PATCH rewrite a hidden app-owned entry while the visible winner
      // was a read-only ecosystem definition — GET said read-only, the mutation
      // routes disagreed (Codex).
      const usableEntry = readMcpServerCatalog(roots).servers.find(
        (entry) => entry.id === id && entry.scope === "global" && entry.writable,
      );
      if (!exists || !usableEntry) {
        return reply.code(404).send({ error: "unknown global MCP server" });
      }
      if (
        parsed.data.expectedTransport &&
        parsed.data.expectedTransport !== usableEntry.transport
      ) {
        return reply
          .code(409)
          .send({ error: "The MCP server type changed. Reopen the editor and try again." });
      }
      const requestedTransport = "url" in parsed.data ? "http" : "stdio";
      if (
        parsed.data.expectedTransport &&
        requestedTransport !== parsed.data.expectedTransport &&
        !parsed.data.allowTransportChange
      ) {
        return reply
          .code(400)
          .send({ error: "Changing the MCP server type requires explicit confirmation." });
      }
    } catch (error) {
      const message =
        error instanceof McpConfigError
          ? error.message
          : "The MCP server definition could not be saved.";
      return reply.code(400).send({ error: message });
    }
    const input =
      "url" in parsed.data
        ? { ...parsed.data, url: parsed.data.url }
        : { ...parsed.data, command: parsed.data.command };
    try {
      mcpDefinitions.write(roots, "global", id, input, parsed.data.protected);
    } catch (error) {
      const message =
        error instanceof McpConfigError
          ? error.message
          : "The MCP server definition could not be saved.";
      return reply.code(400).send({ error: message });
    }
    reprobe(id);
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
    let exists: boolean;
    const deleteRoots = rootsFor();
    try {
      // Same effective-definition rule as PATCH and GET: a read-only winner is
      // not deletable, even if a shadowed key exists in the writable file.
      exists =
        hasMcpServer(deleteRoots, "global", id) &&
        readMcpServerCatalog(deleteRoots).servers.some(
          (entry) => entry.id === id && entry.scope === "global" && entry.writable,
        );
    } catch (error) {
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
    if (!exists) return reply.code(404).send({ error: "unknown global MCP server" });
    let assignmentsChanged = false;
    try {
      // Clear durable assignment references before deleting the definition. A
      // partial cleanup is fail-closed; the definition remains if any write fails.
      const hadDefaultAssignment = mcpAssignments.defaultServerNames().includes(id);
      mcpAssignments.setDefaultServer(id, false);
      assignmentsChanged = hadDefaultAssignment;
      for (const project of projects.list()) {
        const assigned = mcpAssignments.projectServerNames(project.id);
        const retained = assigned.filter((name) => name !== id);
        if (retained.length !== assigned.length) {
          mcpAssignments.setProjectServers(project.id, retained);
          assignmentsChanged = true;
        }
      }
    } catch (error) {
      // Earlier clears remain authoritative even if a later assignment write fails.
      if (assignmentsChanged) broadcast({ type: "resources_changed" });
      return reply.code(500).send({
        code: "RESOURCE_WRITE_FAILED",
        error: assignmentsChanged
          ? "Some MCP assignments were cleared, but another assignment could not be saved. Retry deletion to finish cleanup."
          : error instanceof Error
            ? error.message
            : "The MCP assignments could not be cleared.",
        assignmentsPartiallyCleared: assignmentsChanged,
      });
    }
    let deletedConfig = false;
    try {
      deletedConfig = mcpDefinitions.delete(rootsFor(), "global", id);
    } catch (error) {
      // The durable clear already won, even though the definition remains.
      broadcast({ type: "resources_changed" });
      return reply
        .code(400)
        .send({ error: error instanceof Error ? error.message : String(error) });
    }
    if (!deletedConfig) {
      broadcast({ type: "resources_changed" });
      return reply.code(404).send({ error: "unknown global MCP server" });
    }
    ctx.forgetMcpProbes((_projectId, serverId) => serverId === id);
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Explicit check: connect, list tools, disconnect (no connection stays open).
  fastify.post("/mcp/:id/refresh", async (request, reply) => {
    if (!mcpPolicy.enabled()) {
      return reply.code(409).send({ error: "MCP is paused. Turn MCP on before checking." });
    }
    const id = (request.params as { id: string }).id;
    const requested = (request.query as { projectId?: unknown }).projectId;
    // One project per check: the All Projects view shows no status anyway, and
    // a check there would start one probe per project.
    if (requested === undefined)
      return reply.code(400).send({ error: "Pick a project to check this server." });
    const scope = projectScope(requested);
    if (!scope) return reply.code(404).send({ error: "unknown project" });
    if (!(await ctx.probeMcp(scope, id)))
      return reply.code(404).send({ error: "unknown assigned MCP server" });
    broadcast({ type: "resources_changed" });
    return { server: { id, ...ctx.mcpProbe(scope, id) } };
  });
}
