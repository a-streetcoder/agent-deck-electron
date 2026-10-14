import { configToolAllowed, toolApprovalBlock, type McpServerConfig } from "./mcpTools.ts";

/** The per-session server list handed to Pi native MCP through the generated
 * bridge extension (PI-03b). `idMap` maps each Pi server name back to its
 * Agent Deck id. */
export interface NativeMcpList {
  servers: Array<{ name: string; config: Record<string, unknown> }>;
  blockedTools: string[];
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

// Pi's tool name rule (extensions/mcp/tools.js createMcpToolName).
const piToolName = (server: string, tool: string): string =>
  `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");

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
 * allowed ones. Named refused tools also go into blockedTools. Names containing
 * `*` are dropped: Pi would read them as patterns and widen the grant.
 */
export function nativeMcpList(configs: McpServerConfig[], toolAllowlist?: string[]): NativeMcpList {
  const servers: NativeMcpList["servers"] = [];
  const blockedTools: string[] = [];
  const idMap = new Map<string, string>();
  // Pi rejects names outside [A-Za-z0-9_-] and treats `-` and `_` as the same.
  const taken = new Set<string>();
  for (const config of configs) {
    if (config.blocked) continue;
    const base = nativeMcpBaseName(config.id);
    let name = base;
    for (let n = 2; taken.has(name.replace(/-/g, "_")); n++)
      name = `${base.slice(0, MAX_NAME - `_${n}`.length)}_${n}`;
    taken.add(name.replace(/-/g, "_"));
    idMap.set(name, config.id);

    let named: string[];
    let exposure: string;
    if (toolAllowlist) {
      // ponytail: legacy names are sanitised, so an allowlisted tool whose real
      // name has `-` or `.` stays hidden (fails closed).
      const prefix = `mcp__${config.id.replace(/[^A-Za-z0-9_]/g, "_")}__`;
      named = toolAllowlist.filter((t) => t.startsWith(prefix)).map((t) => t.slice(prefix.length));
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
      const allowed = configToolAllowed(config, tool);
      toolExposure[tool] = allowed ? "direct" : "hidden";
      if (!allowed) blockedTools.push(piToolName(name, tool));
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
  return { servers, blockedTools, idMap };
}

const sanitise = (s: string): string => s.replace(/[^A-Za-z0-9_]/g, "_");

/**
 * PI-03c: why a native MCP call may not run, from live state; undefined allows
 * it. The generated extension asks before each call and again on its result
 * (the result is withheld on refusal: the side effect already happened, as with
 * the proxy). `configs` is the list the Pi names are mapped back over (a child's
 * grant as at spawn, a main session's live assignment), `assigned` the live
 * assignment check, `server` the Pi server name and `tool` the Pi-sanitised
 * identifier after `mcp__<server>__`.
 */
export function nativeMcpRefusal(input: {
  enabled: boolean;
  projectVisible: boolean;
  configs: McpServerConfig[];
  assigned: (id: string) => boolean;
  toolAllowlist?: string[];
  server: string;
  tool: string;
}): string | undefined {
  const piName = piToolName(input.server, input.tool);
  if (!input.enabled) return `MCP is turned off in Agent Deck, so "${piName}" cannot run.`;
  if (!input.projectVisible)
    return `This session's project is gone or hidden, so "${piName}" cannot run.`;
  const id = nativeMcpList(input.configs, input.toolAllowlist).idMap.get(input.server);
  const config = input.configs.find((candidate) => candidate.id === id);
  if (!config || !input.assigned(config.id))
    return `MCP server "${input.server}" is no longer assigned to this session.`;
  if (input.toolAllowlist) {
    // Legacy grants name `mcp__<sanitised id>__<tool>`; compare sanitised, and
    // refuse when two granted ids share that alias (the grant is ambiguous).
    const alias = sanitise(config.id);
    const granted =
      input.configs.filter((candidate) => sanitise(candidate.id) === alias).length === 1 &&
      input.toolAllowlist.some((t) => sanitise(t) === `mcp__${alias}__${input.tool}`);
    if (!granted) return `"${piName}" is not in this agent's tool list.`;
  }
  // Settings name raw tools; Pi only shows the sanitised one, so every raw name
  // that sanitises to it must be allowed (fails closed on a collision).
  const raws = [
    ...(config.enabledTools ?? []),
    ...(config.disabledTools ?? []),
    ...Object.keys(config.toolApproval ?? {}),
  ].filter((t) => sanitise(t) === input.tool);
  for (const raw of raws.length ? raws : [input.tool]) {
    if (configToolAllowed(config, raw)) continue;
    const block = toolApprovalBlock(config, raw);
    return block
      ? `"${piName}": ${block}`
      : `"${piName}" is turned off for "${config.id}" in Agent Deck.`;
  }
  return undefined;
}
