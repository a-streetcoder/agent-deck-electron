import {
  McpClient,
  type HttpServerConfig,
  type McpOAuthProvider,
  type StdioServerConfig,
} from "@agent-deck/mcp";
import { isValidHttpMcpUrl } from "@agent-deck/resources";
import type { BridgeRegistry } from "./bridge.ts";

/**
 * Proxies configured MCP servers' tools onto the bridge and owns their live
 * connection lifecycle. pi has no native MCP, so the app runs an MCP client per
 * configured server, lists its tools, and registers each on the bridge as
 * `mcp__<server>__<tool>`, forwarding calls to the client. The manager tracks
 * per-server state so the UI can show what connected and add/remove/refresh
 * servers at runtime.
 */

/** A configured MCP server: stdio (spawned) or http (remote Streamable HTTP),
 * discriminated by whether it carries a `url`. */
export type McpServerConfig = { id: string } & (StdioServerConfig | HttpServerConfig);

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

export function mcpServerConfigsEqual(left: McpServerConfig, right: McpServerConfig): boolean {
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
  /** Bridge tool names (mcp__<id>__<tool>) currently registered for this server. */
  toolNames: string[];
  /** Present when the last connect/list attempt failed. */
  error?: string;
}

/** How long to wait for a single MCP server to connect + list its tools. */
const MCP_CONNECT_TIMEOUT_MS = 15_000;

/** Keep bridge tool names to pi-safe identifier characters. */
function sanitize(part: string): string {
  return part.replace(/[^A-Za-z0-9_]/g, "_");
}

const MCP_TOOL_PREFIX = "mcp__";

function bridgeToolName(serverId: string, toolName: string): string {
  return `${MCP_TOOL_PREFIX}${sanitize(serverId)}__${sanitize(toolName)}`;
}

/**
 * Per-session MCP scoping: keep every non-MCP bridge tool, but keep an MCP tool
 * (mcp__<server>__<tool>) only if its server is in `allowedServerIds`. Used to
 * expose ONLY the MCP servers an agent declared (agent.mcpServers) to its
 * sessions; an empty allowlist drops all MCP tools. Pure + name-based so it needs
 * no live manager state.
 */
export function scopeMcpBridgeSpecs<T extends { name: string }>(
  specs: T[],
  allowedServerIds: string[],
): T[] {
  const allowedPrefixes = allowedServerIds.map((id) => `${MCP_TOOL_PREFIX}${sanitize(id)}__`);
  return specs.filter(
    (spec) =>
      !spec.name.startsWith(MCP_TOOL_PREFIX) ||
      allowedPrefixes.some((prefix) => spec.name.startsWith(prefix)),
  );
}

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

/** Ensure the advertised parameters are a valid object JSON-Schema for pi. */
function normalizeParameters(inputSchema: Record<string, unknown>): Record<string, unknown> {
  if (inputSchema && typeof inputSchema === "object" && inputSchema.type === "object") {
    return inputSchema;
  }
  return { type: "object", properties: (inputSchema?.properties as unknown) ?? {} };
}

interface ServerState {
  scope: string;
  config: McpServerConfig;
  client?: McpClient;
  /** Cancels an in-progress connect or tool-discovery operation during shutdown. */
  operationController?: AbortController;
  /** Bridge names/specs registered for this server (for scoped advertisement and teardown). */
  toolNames: string[];
  toolSpecs: ReturnType<BridgeRegistry["specs"]>;
  error?: string;
}

export class McpManager {
  private readonly servers = new Map<string, ServerState>();
  /** Tool registrations are shared by name, but dispatch resolves the authenticated session scope. */
  private readonly toolOwners = new Map<string, Set<string>>();
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
    } = {},
  ) {
    this.httpAuthProvider = options.httpAuthProvider;
    this.isHttpAuthorizationActive = options.isHttpAuthorizationActive;
    this.scopeForSession = options.scopeForSession;
    this.allowServerForSession = options.allowServerForSession;
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
        error: state.error,
      }));
  }

  /** MCP specs available to one authenticated project scope. */
  specs(scope: string): ReturnType<BridgeRegistry["specs"]> {
    return [...this.servers.values()]
      .filter((state) => state.scope === scope)
      .flatMap((state) => state.toolSpecs);
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
  private async teardown(id: string, scope = "global"): Promise<void> {
    const key = this.key(scope, id);
    const state = this.servers.get(key);
    if (!state) return;
    for (const name of state.toolNames) {
      const owners = this.toolOwners.get(name);
      owners?.delete(key);
      if (!owners || owners.size === 0) {
        this.toolOwners.delete(name);
        this.bridge.unregister(name);
      }
    }
    await state.client?.close().catch(() => {});
    this.servers.delete(key);
  }

  /**
   * Connect (or reconnect) one server: any prior registration for the id is torn
   * down first. A connect/list failure is recorded on the state (not thrown), so
   * one bad server never breaks the others or startup.
   */
  connect(config: McpServerConfig, scope = "global"): Promise<McpServerStatus> {
    if (this.closing) return Promise.reject(new Error("MCP manager is closing"));
    return this.serialize(this.key(scope, config.id), () => this.connectInner(config, scope));
  }

  private async connectInner(config: McpServerConfig, scope: string): Promise<McpServerStatus> {
    if (this.closing) throw new Error("MCP manager is closing");
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
        error: "OAuth authorization is already in progress",
      };
    }
    await this.teardown(config.id, scope);
    if (this.closing) throw new Error("MCP manager is closing");
    const operationController = new AbortController();
    const key = this.key(scope, config.id);
    const state: ServerState = { scope, config, operationController, toolNames: [], toolSpecs: [] };
    this.servers.set(key, state);
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
        connectedClient.listTools(),
        MCP_CONNECT_TIMEOUT_MS,
        `MCP listTools "${config.id}"`,
        operationController.signal,
      );
      const safeId = sanitize(config.id);
      for (const tool of tools) {
        const name = bridgeToolName(config.id, tool.name);
        // Skip empty-segment or already-claimed names (memory tools, other
        // servers) rather than silently clobber the bridge registry.
        const existingOwners = this.toolOwners.get(name);
        const collidesInScope = [...(existingOwners ?? [])].some(
          (ownerKey) => ownerKey.startsWith(`${scope}\u0000`) && ownerKey !== key,
        );
        if (
          !safeId ||
          !sanitize(tool.name) ||
          collidesInScope ||
          (this.bridge.specs().some((s) => s.name === name) && !existingOwners)
        ) {
          continue;
        }
        const spec = {
          name,
          label: `${config.id}: ${tool.name}`,
          description: tool.description,
          parameters: normalizeParameters(tool.inputSchema),
        };
        state.toolNames.push(name);
        state.toolSpecs.push(spec);
        const owners = this.toolOwners.get(name) ?? new Set<string>();
        owners.add(key);
        this.toolOwners.set(name, owners);
        this.bridge.register(spec, async (params, ctx) => {
          const callScope = this.scopeForSession?.(ctx.sessionId) ?? "global";
          const owner = this.servers.get(this.key(callScope, config.id));
          if (
            !this.allowServerForSession?.(ctx.sessionId, config.id) ||
            !owner?.client ||
            !owner.toolNames.includes(name)
          ) {
            return {
              content: `MCP server "${config.id}" is not assigned to this session`,
              isError: true,
            };
          }
          const result = await owner.client.callTool(tool.name, params);
          return { content: result.content, isError: result.isError };
        });
      }
    } catch (error) {
      for (const name of state.toolNames) {
        const owners = this.toolOwners.get(name);
        owners?.delete(key);
        if (!owners || owners.size === 0) {
          this.toolOwners.delete(name);
          this.bridge.unregister(name);
        }
      }
      state.toolNames = [];
      state.toolSpecs = [];
      await client?.close().catch(() => {});
      state.client = undefined;
      state.error = error instanceof Error ? error.message : String(error);
    } finally {
      state.operationController = undefined;
    }
    return this.status(scope).find((s) => s.id === config.id)!;
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
    const snapshot = configs.map((config) => ({ ...config }));
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
    if (this.closing) return Promise.resolve(null);
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
export function mcpServerConfigsFromEnv(raw: string | undefined): McpServerConfig[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((entry): entry is McpServerConfig => {
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
  });
}
