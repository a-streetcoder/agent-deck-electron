import { McpClient, type HttpServerConfig, type StdioServerConfig } from "@agent-deck/mcp";
import {
  interpolateClaudeMcpValue,
  interpolateMcpValue,
  isValidHttpMcpUrl,
  type McpServerEntry,
  type McpToolApproval,
} from "@agent-deck/resources";

/**
 * Launchable MCP server configs from the catalog and AGENT_DECK_MCP_SERVERS,
 * the tool policy they carry, and the settings screen's probe. Sessions host
 * MCP through Pi native (mcpNative.ts, the generated bridge extension).
 */

/** A configured MCP server: stdio (spawned) or http (remote Streamable HTTP),
 * discriminated by whether it carries a `url`. */
export type McpServerConfig = {
  id: string;
  enabledTools?: string[];
  disabledTools?: string[];
  startupTimeoutMs?: number;
  toolTimeoutMs?: number;
  toolApproval?: Record<string, McpToolApproval>;
  defaultToolApproval?: McpToolApproval;
  /** A launch precondition failed (an unset environment reference, an
   * interpolated URL that is not http(s)). Names only, never values: the
   * server is listed with this as its error instead of silently vanishing. */
  blocked?: string;
} & (StdioServerConfig | HttpServerConfig);

/** Why a tool cannot run under its imported approval mode, or undefined when it can.
 * Codex prompts a human for `prompt`/`writes`; this app has no such prompt, so
 * honouring the policy means refusing rather than quietly auto-approving. */
export function toolApprovalBlock(config: McpServerConfig, tool: string): string | undefined {
  const mode = config.toolApproval?.[tool] ?? config.defaultToolApproval ?? "auto";
  if (mode === "auto" || mode === "approve") return undefined;
  return `Tool "${tool}" on "${config.id}" is set to approval mode "${mode}", which needs an approval prompt Agent Deck does not have. Set its approval to "approve" or "auto" in the server settings to allow it.`;
}

export function configToolAllowed(config: McpServerConfig, tool: string): boolean {
  return (
    (config.enabledTools === undefined || config.enabledTools.includes(tool)) &&
    !config.disabledTools?.includes(tool) &&
    toolApprovalBlock(config, tool) === undefined
  );
}

/** True for an http (Streamable HTTP) server config. */
function isHttpConfig(config: McpServerConfig): config is { id: string } & HttpServerConfig {
  return "url" in config && typeof config.url === "string";
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
  environment: Record<string, string | undefined> | { expand: (value: string) => string },
): T | null {
  // A non-string slipped past validation (AGENT_DECK_MCP_SERVERS validates only
  // `id` and the transport) must not THROW here: that would abort backend
  // startup instead of failing one server's connection (Codex).
  const expand = (value: unknown): string =>
    typeof value !== "string"
      ? ""
      : "expand" in environment && typeof environment.expand === "function"
        ? environment.expand(value)
        : interpolateMcpValue(value, environment as Record<string, string | undefined>, homeDir);
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
  const policy = {
    enabledTools: entry.enabledTools,
    disabledTools: entry.disabledTools,
    ...(entry.startupTimeoutMs !== undefined ? { startupTimeoutMs: entry.startupTimeoutMs } : {}),
    ...(entry.toolTimeoutMs !== undefined ? { toolTimeoutMs: entry.toolTimeoutMs } : {}),
    ...(entry.toolApproval !== undefined ? { toolApproval: entry.toolApproval } : {}),
    ...(entry.defaultToolApproval !== undefined
      ? { defaultToolApproval: entry.defaultToolApproval }
      : {}),
  };
  const reference = (name: string): string | undefined =>
    /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && Object.hasOwn(environment, name)
      ? environment[name]
      : undefined;
  // A failed precondition is reported by NAME on a listed-but-unlaunchable
  // config: the user sees which variable to set instead of a vanished server.
  const missing = (names: string[]): string =>
    `Environment variable${names.length > 1 ? "s" : ""} ${names.map((n) => `"${n}"`).join(", ")} ${names.length > 1 ? "are" : "is"} not set for "${entry.id}". Set ${names.length > 1 ? "them" : "it"} in Environment and reconnect.`;
  // Claude-imported definitions expand `${VAR}` / `${VAR:-default}` in every
  // field at launch (Claude Code's rule), never persisting the resolved values.
  const claude = entry.envInterpolation === "claude";
  const unresolved = new Set<string>();
  const expandClaude = (value: string): string => {
    const result = interpolateClaudeMcpValue(value, environment);
    for (const name of result.missing) unresolved.add(name);
    return result.value;
  };
  if (entry.transport === "http" && entry.url) {
    const url = claude ? expandClaude(entry.url) : entry.url;
    const headers = Object.fromEntries(
      Object.entries(entry.headers ?? {}).map(([k, v]) => [k, claude ? expandClaude(v) : v]),
    );
    for (const [key, name] of Object.entries(entry.envHttpHeaders ?? {})) {
      const value = reference(name);
      if (value === undefined) return [{ id: entry.id, ...policy, url, blocked: missing([name]) }];
      if (/[\r\n\0]/.test(value)) return [];
      headers[key] = value;
    }
    if (entry.bearerTokenEnvVar) {
      const value = reference(entry.bearerTokenEnvVar);
      if (!value)
        return [{ id: entry.id, ...policy, url, blocked: missing([entry.bearerTokenEnvVar]) }];
      if (/[\r\n\0]/.test(value)) return [];
      headers.Authorization = `Bearer ${value}`;
    }
    if (unresolved.size)
      return [{ id: entry.id, ...policy, url, blocked: missing([...unresolved]) }];
    if (
      claude &&
      (!isValidHttpMcpUrl(url) || Object.values(headers).some((v) => /[\r\n\0]/.test(v)))
    )
      return [
        {
          id: entry.id,
          ...policy,
          url: entry.url,
          blocked: `The interpolated URL or headers of "${entry.id}" are not valid. Check the referenced environment variables.`,
        },
      ];
    // Native interpolates ONLY the four stdio fields below — never `url` or
    // `headers` — so without the Claude flag these pass through untouched.
    return [
      {
        id: entry.id,
        ...policy,
        url,
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
      claude ? { expand: expandClaude } : environment,
    );
    if (!launch) return [];
    for (const name of entry.envVars ?? []) {
      // Codex explicit env overrides inherited env_vars, including empty values.
      if (Object.hasOwn(entry.env ?? {}, name)) continue;
      const value = reference(name);
      if (value === undefined) return [{ ...launch, ...policy, blocked: missing([name]) }];
      if (value.includes("\0")) return [];
      launch.env = { ...launch.env, [name]: value };
    }
    if (unresolved.size) return [{ ...launch, ...policy, blocked: missing([...unresolved]) }];
    return [{ ...launch, ...policy }];
  }
  return [];
}

/** Merge config sources by id; entries in later sources are authoritative. */
export function mergeMcpServerConfigs(...sources: McpServerConfig[][]): McpServerConfig[] {
  return [...new Map(sources.flat().map((config) => [config.id, config] as const)).values()];
}

/** What the last probe of one server found (for GET /mcp). */
export interface McpServerStatus {
  connected: boolean;
  /** The server answered 401: Pi signs in per user (`/mcp login`), the probe has no token. */
  needsSignIn?: boolean;
  /** Qualified names (`<server>/<tool>`) the probe listed. */
  toolNames: string[];
  /** Tool metadata exactly as reported by the server. */
  tools: { name: string; description?: string }[];
  error?: string;
}

/** A check is a status read, so it never waits longer than this (a server's own
 * startupTimeoutMs can be an hour). */
const MCP_PROBE_TIMEOUT_MS = 15_000;

/**
 * Connect, list tools, disconnect: the settings screen's status and tool list.
 * Sessions reach MCP through Pi; this keeps no connection open. Only call it
 * for a server assigned to a visible project (a definition is inert until then).
 */
export async function probeMcpServer(config: McpServerConfig): Promise<McpServerStatus> {
  const failed = (error: string, needsSignIn = false): McpServerStatus => ({
    connected: false,
    ...(needsSignIn ? { needsSignIn } : {}),
    toolNames: [],
    tools: [],
    error,
  });
  if (config.blocked) return failed(config.blocked);
  const timeoutMs = Math.min(config.startupTimeoutMs ?? MCP_PROBE_TIMEOUT_MS, MCP_PROBE_TIMEOUT_MS);
  const options = { signal: AbortSignal.timeout(timeoutMs), timeoutMs };
  let client: McpClient | undefined;
  try {
    client = await (isHttpConfig(config)
      ? McpClient.connectHttp(config, options)
      : McpClient.connectStdio(config, options));
    const tools = (await client.listTools(options)).filter((tool) =>
      configToolAllowed(config, tool.name),
    );
    return {
      connected: true,
      toolNames: tools.map((tool) => `${config.id}/${tool.name}`),
      tools: tools.map(({ name, description }) => ({ name, description })),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return failed(message, isHttpConfig(config) && /HTTP 401|unauthori[sz]ed/i.test(message));
  } finally {
    await client?.close().catch(() => {});
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
