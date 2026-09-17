import {
  McpClient,
  type HttpServerConfig,
  type McpToolInfo,
  type McpOAuthProvider,
  type StdioServerConfig,
} from "@agent-deck/mcp";
import { interpolateMcpValue, isValidHttpMcpUrl, type McpServerEntry } from "@agent-deck/resources";
import type { BridgeRegistry, BridgeToolContext } from "./bridge.ts";

/**
 * Proxies configured MCP servers' tools onto the bridge and owns their live
 * connection lifecycle. pi has no native MCP, so the app runs an MCP client per
 * configured server and registers one `mcp` proxy on the bridge. The proxy does
 * scoped list/search/describe/call operations against the live assigned server
 * catalog, avoiding one model-facing schema per discovered MCP tool.
 */

/** A configured MCP server: stdio (spawned) or http (remote Streamable HTTP),
 * discriminated by whether it carries a `url`. */
export type McpServerConfig = { id: string; enabledTools?: string[]; disabledTools?: string[] } & (
  | StdioServerConfig
  | HttpServerConfig
);

function configToolAllowed(config: McpServerConfig, tool: string): boolean {
  return (
    (config.enabledTools === undefined || config.enabledTools.includes(tool)) &&
    !config.disabledTools?.includes(tool)
  );
}

/** True for an http (Streamable HTTP) server config. */
function isHttpConfig(config: McpServerConfig): config is { id: string } & HttpServerConfig {
  return "url" in config && typeof config.url === "string";
}

function stringRecordEqual(
  left: Record<string, string> | undefined,
  right: Record<string, string> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

/**
 * The ONE projection from a parsed catalog entry to a launchable config
 * (MCP-15, MCP-16). This lived inline in server.ts, twice, and BOTH copies
 * silently dropped `cwd` and `headers`: a working directory set in mcp.json
 * never reached the spawn, so a relative command launched wherever the app
 * happened to be, and a header-authenticated remote server could not
 * authenticate at all. One exported function so a field the catalog gains
 * cannot reach one caller and miss the other.
 */
/**
 * MCP-17 — resolve `${VAR}`, `$VAR` and a leading `~` in the four fields native
 * interpolates (command, args, env VALUES, cwd) and apply the home-directory
 * cwd default. EVERY launchable stdio config goes through here, whichever
 * source produced it: an mcp.json entry or an AGENT_DECK_MCP_SERVERS override.
 * The override path skipped interpolation entirely, so the same config text
 * behaved differently depending on where it was written (Codex) — one function
 * is what stops that recurring.
 *
 * Returns null when the command expands to nothing: the parser already skips an
 * entry with no command, and an entry whose command VANISHED because a variable
 * was unset is the same thing. Passing "" to the spawn only fails later and
 * more opaquely.
 */
function normalizeStdioLaunch<T extends { id: string } & StdioServerConfig>(
  config: T,
  homeDir: string,
  environment: Record<string, string | undefined>,
): T | null {
  // A non-string slipped past validation (AGENT_DECK_MCP_SERVERS validates only
  // `id` and the transport) must not THROW here: that would abort backend
  // startup instead of failing one server's connection (Codex).
  const expand = (value: unknown): string =>
    typeof value === "string" ? interpolateMcpValue(value, environment, homeDir) : "";
  const command = expand(config.command);
  if (command.length === 0) return null;
  return {
    ...config,
    command,
    args: Array.isArray(config.args) ? config.args.map(expand) : undefined,
    // Values only: an env NAME is a key, not a template (native maps over
    // values with `mapValues`).
    env:
      typeof config.env === "object" && config.env !== null
        ? Object.fromEntries(Object.entries(config.env).map(([k, v]) => [k, expand(v)]))
        : undefined,
    // Native defaults a missing cwd to the user's home rather than letting the
    // child inherit the app's working directory.
    cwd: typeof config.cwd === "string" && config.cwd ? expand(config.cwd) : homeDir,
  };
}

export function mcpEntryToConfig(
  entry: McpServerEntry,
  homeDir: string,
  environment: Record<string, string | undefined> = process.env,
): McpServerConfig[] {
  const policy = { enabledTools: entry.enabledTools, disabledTools: entry.disabledTools };
  const reference = (name: string): string | undefined =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && Object.hasOwn(environment, name)
      ? environment[name]
      : undefined;
  if (entry.transport === "http" && entry.url) {
    const headers = { ...entry.headers };
    for (const [key, name] of Object.entries(entry.envHttpHeaders ?? {})) {
      const value = reference(name);
      if (value === undefined || /[\r\n\0]/.test(value)) return [];
      headers[key] = value;
    }
    if (entry.bearerTokenEnvVar) {
      const value = reference(entry.bearerTokenEnvVar);
      if (!value || /[\r\n\0]/.test(value)) return [];
      headers.Authorization = `Bearer ${value}`;
    }
    // Native interpolates ONLY the four stdio fields below — never `url` or
    // `headers` — so these pass through untouched.
    return [
      {
        id: entry.id,
        ...policy,
        url: entry.url,
        ...(Object.keys(headers).length ? { headers } : {}),
      },
    ];
  }
  if (entry.command) {
    const launch = normalizeStdioLaunch(
      {
        id: entry.id,
        command: entry.command,
        ...(entry.args ? { args: entry.args } : {}),
        ...(entry.env ? { env: entry.env } : {}),
        ...(entry.cwd ? { cwd: entry.cwd } : {}),
      },
      homeDir,
      environment,
    );
    if (!launch) return [];
    for (const name of entry.envVars ?? []) {
      // Codex explicit env overrides inherited env_vars, including empty values.
      if (Object.hasOwn(entry.env ?? {}, name)) continue;
      const value = reference(name);
      if (value === undefined || value.includes("\0")) return [];
      launch.env = { ...launch.env, [name]: value };
    }
    return [{ ...launch, ...policy }];
  }
  return [];
}

export function mcpServerConfigsEqual(left: McpServerConfig, right: McpServerConfig): boolean {
  if (
    JSON.stringify([left.enabledTools, left.disabledTools]) !==
    JSON.stringify([right.enabledTools, right.disabledTools])
  )
    return false;
  if (left.id !== right.id || isHttpConfig(left) !== isHttpConfig(right)) return false;
  if (isHttpConfig(left) && isHttpConfig(right)) {
    return left.url === right.url && stringRecordEqual(left.headers, right.headers);
  }
  if (isHttpConfig(left) || isHttpConfig(right)) return false;
  return (
    left.command === right.command &&
    JSON.stringify(left.args ?? []) === JSON.stringify(right.args ?? []) &&
    left.cwd === right.cwd &&
    stringRecordEqual(left.env, right.env)
  );
}

/** Merge config sources by id; entries in later sources are authoritative. */
export function mergeMcpServerConfigs(...sources: McpServerConfig[][]): McpServerConfig[] {
  return [...new Map(sources.flat().map((config) => [config.id, config] as const)).values()];
}

/** Live state of one configured MCP server (for GET /mcp). */
export interface McpServerStatus {
  id: string;
  transport: "stdio" | "http";
  connected: boolean;
  /** Qualified discovery names (`<server>/<tool>`) currently known for this server. */
  toolNames: string[];
  /** Tool metadata exactly as reported by the server. */
  tools: { name: string; description?: string }[];
  /** Present when the last connect/list attempt failed. */
  error?: string;
}

export interface McpSessionToolPolicy {
  restricted: boolean;
  allows(serverId: string, toolName: string): boolean;
}

/** How long to wait for a single MCP server to connect + list its tools. */
const MCP_CONNECT_TIMEOUT_MS = 15_000;

export const MCP_PROXY_TOOL_NAME = "mcp";

/** True only for an authored legacy exact-tool allowlist, not an explicit proxy grant. */
export function isLegacyMcpToolPolicy(tools: readonly string[] | undefined): boolean {
  return tools !== undefined && !tools.includes(MCP_PROXY_TOOL_NAME);
}

const MCP_REQUEST_TIMEOUT_MS = 60_000;
const MCP_DISCOVERY_RESULT_LIMIT = 200;

const MCP_PROXY_SPEC = {
  name: MCP_PROXY_TOOL_NAME,
  label: "MCP",
  description:
    'Access tools from assigned MCP servers. List with mcp({}); search with mcp({ search: "text" }); inspect with mcp({ describe: "server/tool" }); call with mcp({ tool: "server/tool", args: { ... } }).',
  promptSnippet: "Call assigned MCP server tools through one list/search/describe/call proxy",
  parameters: {
    type: "object",
    additionalProperties: false,
    properties: {
      tool: { type: "string", description: 'Tool to call as "server/tool".' },
      server: { type: "string", description: "Server name when tool is unqualified." },
      args: { type: ["object", "string"], description: "Arguments passed to the tool." },
      search: { type: "string", description: "Search assigned tools by keyword." },
      describe: { type: "string", description: 'Describe one tool as "server/tool".' },
    },
  },
};

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const settle = (callback: () => void) => {
      cleanup();
      callback();
    };
    const onAbort = () =>
      settle(() =>
        reject(
          signal?.reason instanceof Error
            ? signal.reason
            : new Error(signal?.reason ? String(signal.reason) : `${label} aborted`),
        ),
      );
    const timer = setTimeout(
      () => settle(() => reject(new Error(`${label} timed out after ${ms}ms`))),
      ms,
    );
    timer.unref();
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => settle(() => resolve(value)),
      (error: unknown) => {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      },
    );
  });
}

/**
 * A timed-out connect promise cannot be cancelled by the MCP SDK. Retain a
 * completion handler so a client that resolves after our timeout is closed
 * immediately instead of becoming an unowned stdio process.
 */
async function connectWithTimeout(
  connect: (signal: AbortSignal) => Promise<McpClient>,
  label: string,
  controller: AbortController,
): Promise<McpClient> {
  const promise = connect(controller.signal);
  let accepted = false;
  try {
    const client = await withTimeout(promise, MCP_CONNECT_TIMEOUT_MS, label, controller.signal);
    accepted = true;
    return client;
  } finally {
    if (!accepted) {
      if (!controller.signal.aborted) {
        controller.abort(new Error(`${label} timed out after ${MCP_CONNECT_TIMEOUT_MS}ms`));
      }
      void promise.then((client) => client.close()).catch(() => {});
    }
  }
}

interface ServerState {
  scope: string;
  config: McpServerConfig;
  client?: McpClient;
  /** Cancels an in-progress connect or tool-discovery operation during shutdown. */
  operationController?: AbortController;
  /** Qualified names currently shown by the UI and compact proxy discovery. */
  toolNames: string[];
  tools: McpToolInfo[];
  error?: string;
}

export class McpManager {
  private readonly servers = new Map<string, ServerState>();
  /** Per-id operation chain so connect/refresh/remove for one id never interleave. */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** Whole-catalog reloads are authoritative snapshots and must apply in request order. */
  private reconcileTail: Promise<void> = Promise.resolve();
  /** Once shutdown starts, no route or queued reload may create another client. */
  private closing = false;
  /** Supplies the OAuth provider for an authed http server (undefined → none). */
  private readonly httpAuthProvider?: (
    scope: string,
    id: string,
    serverUrl: string,
  ) => McpOAuthProvider | undefined;
  /** Prevents the SDK from starting another OAuth flow on an interactive provider. */
  private readonly isHttpAuthorizationActive?: (scope: string, id: string) => boolean;
  private readonly scopeForSession?: (sessionId: string) => string | undefined;
  private readonly allowServerForSession?: (sessionId: string, serverId: string) => boolean;
  /** Optional child policy that can retain an authored exact-tool restriction. */
  private readonly allowToolForSession?: (
    sessionId: string,
    serverId: string,
    toolName: string,
  ) => boolean;
  private readonly isToolPolicyRestrictedForSession?: (sessionId: string) => boolean;
  /** Resolves one live policy snapshot per authorization boundary. */
  private readonly toolPolicyForSession?: (sessionId: string) => McpSessionToolPolicy;
  /** Live master policy; checked at admission, publication, and dispatch. */
  private readonly isEnabled: () => boolean;

  constructor(
    private readonly bridge: BridgeRegistry,
    options: {
      httpAuthProvider?: (
        scope: string,
        id: string,
        serverUrl: string,
      ) => McpOAuthProvider | undefined;
      isHttpAuthorizationActive?: (scope: string, id: string) => boolean;
      scopeForSession?: (sessionId: string) => string | undefined;
      allowServerForSession?: (sessionId: string, serverId: string) => boolean;
      allowToolForSession?: (sessionId: string, serverId: string, toolName: string) => boolean;
      isToolPolicyRestrictedForSession?: (sessionId: string) => boolean;
      toolPolicyForSession?: (sessionId: string) => McpSessionToolPolicy;
      isEnabled?: () => boolean;
    } = {},
  ) {
    this.httpAuthProvider = options.httpAuthProvider;
    this.isHttpAuthorizationActive = options.isHttpAuthorizationActive;
    this.scopeForSession = options.scopeForSession;
    this.allowServerForSession = options.allowServerForSession;
    this.allowToolForSession = options.allowToolForSession;
    this.isToolPolicyRestrictedForSession = options.isToolPolicyRestrictedForSession;
    this.toolPolicyForSession = options.toolPolicyForSession;
    this.isEnabled = options.isEnabled ?? (() => true);
  }

  private key(scope: string, id: string): string {
    return `${scope}\u0000${id}`;
  }

  /** The Streamable-HTTP url a configured server connects to (for OAuth), if any. */
  httpUrlFor(id: string, scope = "global"): string | undefined {
    const config = this.servers.get(this.key(scope, id))?.config;
    return config && isHttpConfig(config) ? config.url : undefined;
  }

  /** Serialize an operation for one server id behind any in-flight op for it. */
  private serialize<T>(id: string, op: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(id) ?? Promise.resolve();
    const next = prev.then(op, op);
    // Store a non-rejecting tail so the next op always runs after this settles.
    this.locks.set(
      id,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  /** Live state of every server the manager has attempted to connect. */
  status(scope = "global"): McpServerStatus[] {
    return [...this.servers.values()]
      .filter((state) => state.scope === scope)
      .map((state) => ({
        id: state.config.id,
        transport: isHttpConfig(state.config) ? "http" : "stdio",
        connected: state.client !== undefined,
        toolNames: [...state.toolNames],
        tools: state.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description === undefined ? {} : { description: tool.description }),
        })),
        error: state.error,
      }));
  }

  /** One proxy spec, only when this launch has at least one assigned server. */
  specs(scope: string, allowedServerIds: readonly string[]): ReturnType<BridgeRegistry["specs"]> {
    if (!this.isEnabled()) return [];
    const allowed = new Set(allowedServerIds);
    return [...this.servers.values()].some(
      (state) => state.scope === scope && allowed.has(state.config.id),
    )
      ? [MCP_PROXY_SPEC]
      : [];
  }

  has(id: string, scope = "global"): boolean {
    return this.servers.has(this.key(scope, id));
  }

  scopesFor(id: string): string[] {
    return [...this.servers.values()]
      .filter((state) => state.config.id === id)
      .map((state) => state.scope);
  }

  /** Unregister a server's tools, close its client, and drop it. */
  private async teardown(id: string, scope = "global", surfaceCloseError = false): Promise<void> {
    const key = this.key(scope, id);
    const state = this.servers.get(key);
    if (!state) return;
    // Fail closed before potentially fallible process cleanup.
    this.servers.delete(key);
    if (this.servers.size === 0) this.bridge.unregister(MCP_PROXY_TOOL_NAME);
    try {
      await state.client?.close();
    } catch (error) {
      if (surfaceCloseError) throw error;
    }
  }

  /**
   * Connect (or reconnect) one server: any prior registration for the id is torn
   * down first. A connect/list failure is recorded on the state (not thrown), so
   * one bad server never breaks the others or startup.
   */
  connect(config: McpServerConfig, scope = "global"): Promise<McpServerStatus> {
    if (this.closing) return Promise.reject(new Error("MCP manager is closing"));
    if (!this.isEnabled()) return Promise.reject(new Error("MCP is paused"));
    return this.serialize(this.key(scope, config.id), () => this.connectInner(config, scope));
  }

  private async connectInner(config: McpServerConfig, scope: string): Promise<McpServerStatus> {
    if (this.closing) throw new Error("MCP manager is closing");
    if (!this.isEnabled()) throw new Error("MCP is paused");
    if (isHttpConfig(config) && this.isHttpAuthorizationActive?.(scope, config.id)) {
      // Reusing the interactive provider here lets the SDK call redirectToAuthorization
      // again, replacing the PKCE verifier/state that the browser is currently using.
      // Preserve both the attempt and any existing client until it completes/cancels.
      const current = this.status(scope).find((state) => state.id === config.id);
      if (current) return current;
      return {
        id: config.id,
        transport: "http",
        connected: false,
        toolNames: [],
        tools: [],
        error: "OAuth authorization is already in progress",
      };
    }
    await this.teardown(config.id, scope);
    if (this.closing) throw new Error("MCP manager is closing");
    const operationController = new AbortController();
    const key = this.key(scope, config.id);
    const state: ServerState = {
      scope,
      config,
      operationController,
      toolNames: [],
      tools: [],
    };
    this.servers.set(key, state);
    this.bridge.register(MCP_PROXY_SPEC, (params, ctx) => this.dispatchProxy(params, ctx));
    let client: McpClient | undefined;
    try {
      client = await connectWithTimeout(
        (signal) => {
          const connectOptions = { signal, timeoutMs: MCP_CONNECT_TIMEOUT_MS };
          return isHttpConfig(config)
            ? McpClient.connectHttp(config, {
                ...connectOptions,
                // Bind persisted credentials to the exact effective URL before
                // the SDK can read tokens or attach a bearer header.
                authProvider: this.httpAuthProvider?.(scope, config.id, config.url),
              })
            : McpClient.connectStdio(config, connectOptions);
        },
        `MCP connect "${config.id}"`,
        operationController,
      );
      const connectedClient = client;
      // Own the client as soon as it connects. Tool discovery can still fail or
      // time out, and shutdown must be able to find and close it in that window.
      state.client = connectedClient;
      const tools = await withTimeout(
        connectedClient.listTools({
          signal: operationController.signal,
          timeoutMs: MCP_CONNECT_TIMEOUT_MS,
        }),
        MCP_CONNECT_TIMEOUT_MS,
        `MCP listTools "${config.id}"`,
        operationController.signal,
      );
      if (!this.isEnabled()) throw new Error("MCP was paused while connecting");
      state.tools = tools.filter((tool) => configToolAllowed(config, tool.name));
      state.toolNames = state.tools.map((tool) => `${config.id}/${tool.name}`);
    } catch (error) {
      state.toolNames = [];
      state.tools = [];
      await client?.close().catch(() => {});
      state.client = undefined;
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.operationController = undefined;
    }
    return this.status(scope).find((s) => s.id === config.id)!;
  }

  private authorizedStates(sessionId: string): ServerState[] {
    if (!this.isEnabled()) return [];
    const scope = this.scopeForSession?.(sessionId);
    if (!scope) return [];
    return [...this.servers.values()].filter(
      (state) =>
        state.scope === scope && this.allowServerForSession?.(sessionId, state.config.id) === true,
    );
  }

  private async discoverState(state: ServerState, ctx: BridgeToolContext): Promise<McpToolInfo[]> {
    if (!state.client) return [];
    const tools = await state.client.listTools({
      signal: ctx.signal,
      timeoutMs: MCP_REQUEST_TIMEOUT_MS,
    });
    // Authorization and ownership may change while remote discovery is in flight.
    const current = this.servers.get(this.key(state.scope, state.config.id));
    if (
      current !== state ||
      !this.isEnabled() ||
      this.allowServerForSession?.(ctx.sessionId, state.config.id) !== true
    ) {
      throw new Error(`MCP server "${state.config.id}" is no longer assigned to this session`);
    }
    state.tools = tools.filter((tool) => configToolAllowed(state.config, tool.name));
    state.toolNames = state.tools.map((tool) => `${state.config.id}/${tool.name}`);
    return state.tools;
  }

  private resolveAddress(
    rawTool: unknown,
    rawServer: unknown,
  ): { server: string; tool: string } | undefined {
    const tool = typeof rawTool === "string" ? rawTool.trim() : "";
    const serverHint = typeof rawServer === "string" ? rawServer.trim() : "";
    const slash = tool.indexOf("/");
    if (slash > 0 && slash < tool.length - 1) {
      return { server: tool.slice(0, slash), tool: tool.slice(slash + 1) };
    }
    return serverHint && tool ? { server: serverHint, tool } : undefined;
  }

  private resolveToolPolicy(sessionId: string): McpSessionToolPolicy {
    return (
      this.toolPolicyForSession?.(sessionId) ?? {
        restricted: this.isToolPolicyRestrictedForSession?.(sessionId) === true,
        allows: (serverId, toolName) =>
          this.allowToolForSession?.(sessionId, serverId, toolName) !== false,
      }
    );
  }

  private toolAllowed(
    policy: McpSessionToolPolicy,
    server: string,
    tool: string,
    availableTools: readonly McpToolInfo[],
    authorizedStates: readonly ServerState[],
  ): boolean {
    if (!policy.allows(server, tool)) return false;
    const state = authorizedStates.find((candidate) => candidate.config.id === server);
    if (!state || !configToolAllowed(state.config, tool)) return false;
    if (!policy.restricted) return true;
    // Legacy names sanitize server IDs. If two assigned IDs collapse to one
    // alias, an old exact-tool grant cannot identify which server it meant.
    const serverAlias = server.replace(/[^A-Za-z0-9_]/g, "_");
    if (
      authorizedStates.filter(
        (state) => state.config.id.replace(/[^A-Za-z0-9_]/g, "_") === serverAlias,
      ).length !== 1
    ) {
      return false;
    }
    const alias = tool.replace(/[^A-Za-z0-9_]/g, "_");
    return (
      availableTools.filter((candidate) => candidate.name.replace(/[^A-Za-z0-9_]/g, "_") === alias)
        .length === 1
    );
  }

  private async dispatchProxy(
    params: Record<string, unknown>,
    ctx: BridgeToolContext,
  ): Promise<{ content: string; isError?: boolean; details?: unknown }> {
    const states = this.authorizedStates(ctx.sessionId);
    if (states.length === 0) {
      return { content: "No MCP servers are assigned to this session.", isError: true };
    }
    const action =
      typeof params.search === "string" && params.search.trim()
        ? "search"
        : typeof params.describe === "string" && params.describe.trim()
          ? "describe"
          : typeof params.tool === "string" && params.tool.trim()
            ? "call"
            : "list";
    const address = this.resolveAddress(
      action === "describe" ? params.describe : params.tool,
      params.server,
    );

    if (action === "call") {
      if (!address) return { content: 'Specify a tool as "server/tool".', isError: true };
      const state = states.find((candidate) => candidate.config.id === address.server);
      if (!state?.client) {
        return {
          content: `MCP server "${address.server}" or tool "${address.tool}" is not assigned to this session.`,
          isError: true,
        };
      }
      const liveTools = await this.discoverState(state, ctx);
      const liveStates = this.authorizedStates(ctx.sessionId);
      const livePolicy = this.resolveToolPolicy(ctx.sessionId);
      if (
        ctx.signal?.aborted ||
        !liveStates.includes(state) ||
        !liveTools.some((tool) => tool.name === address.tool) ||
        !this.toolAllowed(livePolicy, address.server, address.tool, liveTools, liveStates)
      ) {
        return {
          content: `MCP server "${address.server}" or tool "${address.tool}" is not assigned to this session.`,
          isError: true,
        };
      }
      let args: Record<string, unknown>;
      if (typeof params.args === "string") {
        try {
          const parsed = JSON.parse(params.args) as unknown;
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          args = parsed as Record<string, unknown>;
        } catch {
          return { content: "MCP tool args must be a JSON object.", isError: true };
        }
      } else if (params.args === undefined) {
        args = {};
      } else if (params.args && typeof params.args === "object" && !Array.isArray(params.args)) {
        args = params.args as Record<string, unknown>;
      } else {
        return { content: "MCP tool args must be an object.", isError: true };
      }
      const result = await state.client.callTool(address.tool, args, {
        signal: ctx.signal,
        timeoutMs: MCP_REQUEST_TIMEOUT_MS,
      });
      if (
        ctx.signal?.aborted ||
        this.servers.get(this.key(state.scope, state.config.id)) !== state ||
        !this.isEnabled() ||
        this.allowServerForSession?.(ctx.sessionId, address.server) !== true ||
        !this.toolAllowed(
          this.resolveToolPolicy(ctx.sessionId),
          address.server,
          address.tool,
          state.tools,
          this.authorizedStates(ctx.sessionId),
        )
      ) {
        return { content: "MCP assignment changed during the tool call.", isError: true };
      }
      return {
        content: result.content,
        isError: result.isError,
        details: { version: 1, server: address.server, tool: address.tool },
      };
    }

    if (action === "describe" && !address) {
      return { content: 'Specify a tool as "server/tool".', isError: true };
    }
    const relevantStates = address
      ? states.filter((state) => state.config.id === address.server)
      : states;
    const discovered = await Promise.all(
      relevantStates.map(async (state) => {
        if (!state.client)
          return { state, tools: [] as McpToolInfo[], error: state.error ?? "unavailable" };
        try {
          return { state, tools: await this.discoverState(state, ctx) };
        } catch (error) {
          if (
            ctx.signal?.aborted ||
            !this.isEnabled() ||
            this.allowServerForSession?.(ctx.sessionId, state.config.id) !== true
          ) {
            throw error;
          }
          return {
            state,
            tools: [] as McpToolInfo[],
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );
    const authorizedNow = new Set(this.authorizedStates(ctx.sessionId));
    const authorizedStateList = [...authorizedNow];
    const toolPolicy = this.resolveToolPolicy(ctx.sessionId);
    if (ctx.signal?.aborted || relevantStates.some((state) => !authorizedNow.has(state))) {
      throw new Error("MCP assignment changed during discovery");
    }
    const entries = discovered.flatMap(({ state, tools }) =>
      tools
        .filter((tool) =>
          this.toolAllowed(toolPolicy, state.config.id, tool.name, tools, authorizedStateList),
        )
        .map((tool) => ({ state, tool, qualifiedName: `${state.config.id}/${tool.name}` })),
    );

    if (action === "describe") {
      const match = entries.find(
        (entry) => entry.qualifiedName === `${address!.server}/${address!.tool}`,
      );
      if (!match) return { content: `Tool ${address!.server}/${address!.tool} was not found.` };
      return {
        content: `${match.qualifiedName}: ${match.tool.description || "(no description)"}\nInput schema:\n${JSON.stringify(match.tool.inputSchema, null, 2)}`,
      };
    }
    if (action === "search") {
      const query = String(params.search).trim().toLocaleLowerCase();
      const hits = entries
        .filter(
          (entry) =>
            entry.qualifiedName.toLocaleLowerCase().includes(query) ||
            entry.tool.description?.toLocaleLowerCase().includes(query),
        )
        .slice(0, MCP_DISCOVERY_RESULT_LIMIT);
      return {
        content:
          hits.length === 0
            ? `No MCP tools matched "${String(params.search).trim()}".`
            : hits
                .map(
                  (entry) =>
                    `- ${entry.qualifiedName}: ${entry.tool.description || "(no description)"}`,
                )
                .join("\n"),
      };
    }
    const lines: string[] = [];
    for (const { state, error } of discovered) {
      if (lines.length >= MCP_DISCOVERY_RESULT_LIMIT) break;
      if (error) {
        lines.push(`- ${state.config.id}: unavailable (${error})`);
        continue;
      }
      const serverEntries = entries.filter((entry) => entry.state === state);
      if (serverEntries.length === 0) lines.push(`- ${state.config.id}: 0 tools`);
      for (const entry of serverEntries) {
        if (lines.length >= MCP_DISCOVERY_RESULT_LIMIT) break;
        lines.push(`- ${entry.qualifiedName}: ${entry.tool.description || "(no description)"}`);
      }
    }
    return {
      content: lines.join("\n"),
    };
  }

  /** Connect many servers in parallel (startup). Best-effort per server. */
  async connectAll(configs: McpServerConfig[], scope = "global"): Promise<void> {
    const seen = new Set<string>();
    const unique = configs.filter((config) => {
      if (seen.has(config.id)) return false;
      seen.add(config.id);
      return true;
    });
    await Promise.allSettled(unique.map((config) => this.connect(config, scope)));
  }

  /** Apply an authoritative config snapshot without disturbing unchanged live clients. */
  reconcile(configs: McpServerConfig[], scope = "global"): Promise<void> {
    if (this.closing) return Promise.reject(new Error("MCP manager is closing"));
    const snapshot = (this.isEnabled() ? configs : []).map((config) => ({ ...config }));
    const next = this.reconcileTail.then(
      () => this.reconcileSnapshot(snapshot, scope),
      () => this.reconcileSnapshot(snapshot, scope),
    );
    this.reconcileTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async reconcileSnapshot(configs: McpServerConfig[], scope: string): Promise<void> {
    const desired = new Map(configs.map((config) => [config.id, config]));
    const removals = [...this.servers.values()]
      .filter((state) => state.scope === scope && !desired.has(state.config.id))
      .map((state) => this.remove(state.config.id, scope));
    const connections = [...desired.values()]
      .filter((config) => {
        const current = this.servers.get(this.key(scope, config.id))?.config;
        return current === undefined || !mcpServerConfigsEqual(current, config);
      })
      .map((config) => this.connect(config, scope));
    await Promise.allSettled([...removals, ...connections]);
  }

  /** Remove clients in a scope that are no longer authorized without needing to parse config. */
  async retain(scope: string, serverIds: ReadonlySet<string>): Promise<void> {
    await Promise.allSettled(
      [...this.servers.values()]
        .filter((state) => state.scope === scope && !serverIds.has(state.config.id))
        .map((state) => this.remove(state.config.id, scope)),
    );
  }

  /** Reconnect a known server using its stored config. */
  refresh(id: string, scope = "global"): Promise<McpServerStatus | null> {
    if (this.closing || !this.isEnabled()) return Promise.resolve(null);
    return this.serialize(this.key(scope, id), async () => {
      const config = this.servers.get(this.key(scope, id))?.config;
      // connectInner (not connect) — we already hold this id's lock.
      return config ? await this.connectInner(config, scope) : null;
    });
  }

  /** Remove a server: unregister its tools and close its client. */
  remove(id: string, scope = "global"): Promise<boolean> {
    if (this.closing) return Promise.resolve(false);
    return this.serialize(this.key(scope, id), async () => {
      if (!this.servers.has(this.key(scope, id))) return false;
      await this.teardown(id, scope);
      return true;
    });
  }

  /** Pause execution without making the manager unusable for a later enable. */
  async pause(): Promise<void> {
    for (const state of this.servers.values()) {
      state.operationController?.abort(new Error("MCP is paused"));
    }
    await this.reconcileTail;
    await Promise.allSettled([...this.locks.values()]);
    const cleanup = await Promise.allSettled(
      [...this.servers.values()].map((state) => this.teardown(state.config.id, state.scope, true)),
    );
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length > 0) {
      throw new AggregateError(
        failures,
        "one or more MCP clients could not be closed while pausing",
      );
    }
  }

  async close(): Promise<void> {
    this.closing = true;
    // Reject in-progress connect/tool-discovery waits immediately. Their
    // connectInner catch paths own closing any connected or late clients.
    for (const state of this.servers.values()) {
      state.operationController?.abort(new Error("MCP manager is closing"));
    }
    // A queued catalog snapshot can enqueue per-id work, so drain it first;
    // then drain every per-id tail before tearing down the final owned clients.
    await this.reconcileTail;
    await Promise.allSettled([...this.locks.values()]);
    await Promise.all(
      [...this.servers.values()].map((state) => this.teardown(state.config.id, state.scope)),
    );
    this.locks.clear();
  }
}

/** Parse AGENT_DECK_MCP_SERVERS (a JSON array of server configs, stdio or http). */
export function mcpServerConfigsFromEnv(
  raw: string | undefined,
  homeDir: string,
  environment: Record<string, string | undefined> = process.env,
): McpServerConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((entry): entry is McpServerConfig => {
      if (typeof entry !== "object" || entry === null) return false;
      const e = entry as { id?: unknown; command?: unknown; url?: unknown };
      if (typeof e.id !== "string") return false;
      const hasCommand = typeof e.command === "string";
      const hasUrl = e.url !== undefined;
      // Exactly one transport (never both/neither — a dual entry would silently
      // drop `command` since url wins), and any http url must be well-formed http(s).
      if (hasCommand === hasUrl) return false;
      if (hasUrl) return isValidHttpMcpUrl(e.url);
      return true;
    })
    .map((config) => {
      // Same launch normalization as a file entry. Without it the identical
      // config text expanded in mcp.json and stayed literal here (Codex).
      // `homeDir` is REQUIRED: making it optional meant a caller that omitted
      // it silently launched literal `$VAR` text (Codex).
      if ("url" in config) return config;
      return normalizeStdioLaunch(config, homeDir, environment);
    })
    .filter((config): config is McpServerConfig => config !== null);
}
