import { configToolAllowed, toolApprovalBlock, type McpServerConfig } from "./mcpTools.ts";

/** The per-session server list handed to Pi native MCP through the generated
 * bridge extension (PI-03b). `idMap` maps each Pi server name back to its
 * Agent Deck id. */
export interface NativeMcpList {
  servers: Array<{ name: string; config: Record<string, unknown> }>;
  blockedTools: string[];
  idMap: Map<string, string>;
}

// Pi's tool name rule (extensions/mcp/tools.js createMcpToolName).
const piToolName = (server: string, tool: string): string =>
  `mcp__${server}__${tool}`.replace(/[^A-Za-z0-9_]/g, "_");

// Pi resolves `$VAR`, `${VAR}` and a leading `!` (a shell command) in env and
// header values. Ours are already resolved, so escape them back to literals.
const literal = (value: string): string => value.replace(/\$/g, "$$$$").replace(/^!/, "$$!");
const literals = (record: Record<string, string> | undefined) =>
  record && Object.fromEntries(Object.entries(record).map(([k, v]) => [k, literal(v)]));

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
 * allowed ones. Named refused tools also go into blockedTools.
 */
export function nativeMcpList(configs: McpServerConfig[], toolAllowlist?: string[]): NativeMcpList {
  const servers: NativeMcpList["servers"] = [];
  const blockedTools: string[] = [];
  const idMap = new Map<string, string>();
  // Pi rejects names outside [A-Za-z0-9_-] and treats `-` and `_` as the same.
  const taken = new Set<string>();
  for (const config of configs) {
    if (config.blocked) continue;
    const base = config.id.replace(/[^A-Za-z0-9_-]/g, "_");
    let name = base;
    for (let n = 2; taken.has(name.replace(/-/g, "_")); n++) name = `${base}_${n}`;
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
    for (const tool of named) {
      const allowed = configToolAllowed(config, tool);
      toolExposure[tool] = allowed ? "direct" : "hidden";
      if (!allowed) blockedTools.push(piToolName(name, tool));
    }
    const common = {
      exposure,
      ...(named.length ? { toolExposure } : {}),
      ...(config.toolTimeoutMs ? { timeout: Math.ceil(config.toolTimeoutMs / 1000) } : {}),
    };
    servers.push({
      name,
      config:
        "url" in config
          ? { type: "http", url: config.url, headers: literals(config.headers), ...common }
          : {
              type: "stdio",
              command: config.command,
              args: config.args,
              env: literals(config.env),
              cwd: config.cwd,
              ...common,
            },
    });
  }
  return { servers, blockedTools, idMap };
}
