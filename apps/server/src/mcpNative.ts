import { configToolAllowed, toolApprovalBlock, type McpServerConfig } from "./mcpTools.ts";

/** The per-session server list handed to Pi native MCP through the generated
 * bridge extension (PI-03b). `idMap` maps each Pi server name back to its
 * Agent Deck id (persisted on the session meta as `mcpServerNames`). */
export interface NativeMcpList {
  servers: Array<{ name: string; config: Record<string, unknown> }>;
  idMap: Map<string, string>;
}

/** Experimental until the proxy is removed (PI-03f). */
export const nativeMcpEnabled = (): boolean => process.env.AGENT_DECK_NATIVE_MCP === "1";

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

// Mirrors the proxy (mcpTools.ts legacy alias check): when two granted ids share
// a legacy prefix (`a.b`, `a_b`), an old exact grant cannot say which server it
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
    if (tool === "mcp") {
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
