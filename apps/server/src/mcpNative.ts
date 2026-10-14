import { createHash } from "node:crypto";
import { configToolAllowed, toolApprovalBlock, type McpServerConfig } from "./mcpTools.ts";

/** The per-session server list handed to Pi native MCP through the generated
 * bridge extension. `idMap` maps each Pi server name back to its
 * Agent Deck id (persisted on the session meta as `mcpServerNames`). */
export interface NativeMcpList {
  /** `id` is the Agent Deck id, sent back by the policy hook (PI-03c). */
  servers: Array<{ name: string; id: string; config: Record<string, unknown> }>;
  idMap: Map<string, string>;
}

/** The proxy-era tool grant: in an authored `tools:` list it still means
 * "every assigned MCP server" (migrated to one pattern per server). */
export const LEGACY_MCP_GRANT = "mcp";

// Pi hashes tool names over 64 characters and keeps only the first 55, so the
// server part is capped at 24 (suffix included): `mcp__<24>__` is 31 characters,
// which leaves 33 for the tool before hashing and keeps the prefix whole after.
const MAX_NAME = 24;

/** Pi-valid server name for an id, before any collision suffix. */
export const nativeMcpBaseName = (id: string): string =>
  id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, MAX_NAME);

/** `--tools` pattern that keeps one server's native tools under an authored
 * allowlist (Pi turns `-` into `_` in tool names). */
export const nativeMcpToolPattern = (name: string): string => `mcp__${name.replace(/-/g, "_")}__*`;

// Pi's tool name rule (extensions/mcp/tools.js createMcpToolName), before its
// hash suffix for names over 64 characters or colliding after sanitising.
const piToolName = (server: string, tool: string): string =>
  `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");

/** Prefix of the old proxy-era exact tool grants (`mcp__<id>__<tool>`). */
export const legacyMcpToolPrefix = (id: string): string =>
  `mcp__${id.replace(/[^A-Za-z0-9_]/g, "_")}__`;

// When two granted ids share a legacy prefix (`a.b`, `a_b`), an old exact grant cannot say which server it
// meant, so it grants neither.
const uniqueLegacyPrefix = (id: string, ids: readonly string[]): boolean =>
  ids.filter((other) => legacyMcpToolPrefix(other) === legacyMcpToolPrefix(id)).length === 1;

/**
 * Fold a spawn's Pi name -> id map into the stored one. A name that comes back
 * with a different id becomes "" (unknown) for good, so cells from either launch
 * fall back to the Pi name instead of being relabelled.
 */
export function mergeMcpServerNames(
  stored: Readonly<Record<string, string>> | undefined,
  idMap: ReadonlyMap<string, string>,
): Record<string, string> {
  const merged = { ...stored };
  for (const [name, id] of idMap)
    merged[name] = merged[name] === undefined || merged[name] === id ? id : "";
  return merged;
}

/** The Pi name a session's stored map gives an id: the latest launch's name
 * (merged names are appended); "" entries (reused names) never match. */
export const storedMcpServerName = (
  stored: Readonly<Record<string, string>>,
  id: string,
): string | undefined =>
  id ? Object.entries(stored).findLast(([, value]) => value === id)?.[0] : undefined;

/**
 * Pi server name per Agent Deck id. Ids are sorted first so the launch plan's
 * `--tools` patterns and the bridge's server list agree for the same set,
 * whatever order each caller holds it in.
 */
export function nativeMcpNames(ids: readonly string[]): Map<string, string> {
  const names = new Map<string, string>();
  // Pi rejects names outside [A-Za-z0-9_-] and treats `-` and `_` as the same.
  const taken = new Set<string>();
  for (const id of [...new Set(ids)].sort()) {
    const base = nativeMcpBaseName(id);
    let name = base;
    for (let n = 2; taken.has(name.replace(/-/g, "_")); n++)
      name = `${base.slice(0, MAX_NAME - `_${n}`.length)}_${n}`;
    taken.add(name.replace(/-/g, "_"));
    names.set(id, name);
  }
  return names;
}

/**
 * Migrate an authored `tools:` list from the proxy shape to native names: `mcp`
 * keeps the entry and adds one pattern per server; a legacy exact name
 * `mcp__<sanitised id>__<tool>` becomes Pi's `mcp__<pi name>__<tool>`, and is
 * dropped when its prefix is ambiguous.
 */
export function migrateMcpToolGrants(
  tools: readonly string[],
  serverIds: readonly string[],
): string[] {
  const names = nativeMcpNames(serverIds);
  const out = new Set<string>();
  for (const tool of tools) {
    if (tool === LEGACY_MCP_GRANT) {
      out.add(tool);
      for (const name of names.values()) out.add(nativeMcpToolPattern(name));
      continue;
    }
    const match = [...names].find(([id]) => tool.startsWith(legacyMcpToolPrefix(id)));
    if (!match) out.add(tool);
    else if (uniqueLegacyPrefix(match[0], [...names.keys()]))
      out.add(piToolName(match[1], tool.slice(legacyMcpToolPrefix(match[0]).length)));
  }
  return [...out];
}

/**
 * Translate the configs a session may use (already filtered for global enable,
 * assignment and child grant) into Pi's MCP config. Blocked configs (a missing
 * env reference) are dropped. `toolAllowlist` is a child's legacy exact-tool
 * allowlist (`mcp__<id>__<tool>`); undefined grants every tool.
 *
 * Refused tools (enabledTools/disabledTools, approval modes prompt/writes) use
 * Pi's per-tool `toolExposure: "hidden"`. A tool Agent Deck cannot name (any tool
 * when the server's default mode is refused or an enabledTools list exists)
 * falls to the server-level `exposure: "hidden"`; named overrides re-expose the
 * allowed ones. Names containing `*` are dropped: Pi would read them as
 * patterns and widen the grant.
 *
 * No tool_call block list (PI-03e): Pi refuses a hidden tool at execution by its
 * RAW name (extensions/mcp/index.js getClient), which is exact, while a list of
 * normalised names could refuse a different tool (`a-b` hidden, `a_b` allowed
 * and the only one present both map to `mcp__s__a_b`). Live policy is the
 * bridge hook's job (PI-03c).
 */
export function nativeMcpList(configs: McpServerConfig[], toolAllowlist?: string[]): NativeMcpList {
  const servers: NativeMcpList["servers"] = [];
  const idMap = new Map<string, string>();
  // Blocked configs still take a name: the launch plan cannot see them.
  const names = nativeMcpNames(configs.map((config) => config.id));
  for (const config of configs) {
    if (config.blocked) continue;
    const name = names.get(config.id)!;
    idMap.set(name, config.id);

    let named: string[];
    let exposure: string;
    if (toolAllowlist) {
      // ponytail: legacy names are sanitised, so an allowlisted tool whose real
      // name has `-` or `.` stays hidden (fails closed).
      const prefix = legacyMcpToolPrefix(config.id);
      named = uniqueLegacyPrefix(
        config.id,
        configs.map((c) => c.id),
      )
        ? toolAllowlist.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length))
        : [];
      exposure = "hidden";
    } else {
      named = [
        ...new Set([
          ...(config.enabledTools ?? []),
          ...(config.disabledTools ?? []),
          ...Object.keys(config.toolApproval ?? {}),
        ]),
      ];
      const defaultRefused =
        toolApprovalBlock({ ...config, toolApproval: undefined }, "") !== undefined;
      exposure = config.enabledTools !== undefined || defaultRefused ? "hidden" : "direct";
    }
    const toolExposure: Record<string, string> = {};
    for (const tool of named.filter((t) => !t.includes("*"))) {
      toolExposure[tool] = configToolAllowed(config, tool) ? "direct" : "hidden";
    }
    const common = {
      exposure,
      ...(Object.keys(toolExposure).length ? { toolExposure } : {}),
      // Pi's `timeout` bounds each request, connect included; startupTimeoutMs
      // has no Pi equivalent and is dropped.
      ...(config.toolTimeoutMs ? { timeout: Math.ceil(config.toolTimeoutMs / 1000) } : {}),
    };
    servers.push({
      name,
      id: config.id,
      config:
        "url" in config
          ? { type: "http", url: config.url, headers: config.headers, ...common }
          : {
              type: "stdio",
              command: config.command,
              args: config.args,
              env: config.env,
              // Always absolute here (mcpEntryToConfig defaults it to home); the
              // bridge transport would resolve a relative one against the session cwd.
              cwd: config.cwd,
              ...common,
            },
    });
  }
  return { servers, idMap };
}

const sanitise = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, "_");

/** Pi's resource tools (core/mcp-servers.js); they carry the server as `input.server`. */
export const NATIVE_MCP_RESOURCE_TOOLS = new Set([
  "list_mcp_resources",
  "list_mcp_resource_templates",
  "read_mcp_resource",
]);

// The names Pi can give a raw tool (extensions/mcp/tools.js createMcpToolName):
// plain, or hashed when over 64 characters or when two raw names sanitise alike.
const piToolNames = (server: string, raw: string): string[] => {
  const plain = piToolName(server, raw);
  const hash = createHash("sha256").update(`${server}\0${raw}`).digest("hex").slice(0, 8);
  return [plain, `${plain.slice(0, 55)}_${hash}`];
};

/**
 * PI-03c: why a native MCP call may not run, from live state; undefined allows
 * it. The generated extension asks before each call and again on its result
 * (the result is withheld on refusal: the side effect already happened, as with
 * the proxy). `config` is the live config of the server id embedded at spawn
 * (undefined once it left the catalog), `assigned` whether that id is still
 * assigned, `server` its Pi name and `toolName` the full Pi tool name.
 * `legacyGrant` is a child's exact-tool allowlist with its granted server ids.
 */
export function nativeMcpRefusal(input: {
  enabled: boolean;
  projectVisible: boolean;
  config: McpServerConfig | undefined;
  assigned: boolean;
  legacyGrant?: { tools: string[]; serverIds: string[] };
  server: string;
  toolName: string;
}): string | undefined {
  const { config, server, toolName } = input;
  if (!input.enabled) return `MCP is turned off in Agent Deck, so "${toolName}" cannot run.`;
  if (!input.projectVisible)
    return `This session's project is gone or hidden, so "${toolName}" cannot run.`;
  if (!config || !input.assigned)
    return `MCP server "${server}" is no longer assigned to this session.`;
  const resource = NATIVE_MCP_RESOURCE_TOOLS.has(toolName);
  if (input.legacyGrant) {
    // Legacy grants name `mcp__<sanitised id>__<tool>` and never resources;
    // refuse when two granted ids share that alias (the grant is ambiguous).
    const prefix = `mcp__${sanitise(config.id)}__`;
    const granted =
      !resource &&
      input.legacyGrant.serverIds.filter((id) => `mcp__${sanitise(id)}__` === prefix).length ===
        1 &&
      input.legacyGrant.tools.some(
        (t) =>
          t.startsWith(prefix) && piToolNames(server, t.slice(prefix.length)).includes(toolName),
      );
    if (!granted) return `"${toolName}" is not in this agent's tool list.`;
  }
  if (resource) return undefined;
  // Settings name raw tools; match each against the names Pi would give it.
  // A tool no setting names gets the server's defaults.
  const raws = [
    ...(config.enabledTools ?? []),
    ...(config.disabledTools ?? []),
    ...Object.keys(config.toolApproval ?? {}),
  ].filter((t) => piToolNames(server, t).includes(toolName));
  for (const raw of raws.length ? raws : [toolName]) {
    if (configToolAllowed(config, raw)) continue;
    const block = toolApprovalBlock(config, raw);
    return block
      ? `"${toolName}": ${block}`
      : `"${toolName}" is turned off for "${config.id}" in Agent Deck.`;
  }
  return undefined;
}
