/**
 * Resource model shared by server and UI: agents and skills with the scope /
 * shadowing / filter semantics ported from the native app (SidebarModels.swift).
 *
 * Scope priority for same-name shadowing: project > global > builtin > library.
 * Library agents remain catalog entries but never replace active agents.
 */

export type ResourceScope = "builtin" | "global" | "library" | "project";

/** Native-compatible authored default for a managed named delegation. */
export type SubagentExpectedOutcome =
  | "reportOnly"
  | "editFilesInWorktree"
  | "writeProjectFile"
  | "directProjectWrites";

export const SUBAGENT_EXPECTED_OUTCOMES: readonly SubagentExpectedOutcome[] = [
  "reportOnly",
  "editFilesInWorktree",
  "writeProjectFile",
  "directProjectWrites",
];

export const SUBAGENT_EXPECTED_OUTCOME_LABELS: Record<SubagentExpectedOutcome, string> = {
  reportOnly: "Report only",
  editFilesInWorktree: "Edit files in worktree",
  writeProjectFile: "Write/update project file",
  directProjectWrites: "Direct project writes",
};

const SCOPE_PRIORITY: Record<ResourceScope, number> = {
  project: 3,
  global: 2,
  builtin: 1,
  // Native keeps the library outside effective-agent resolution. Electron still
  // exposes unique library entries, but an active builtin/global always wins.
  library: 0,
};

export interface AgentInfo {
  name: string;
  description?: string;
  whenToUse?: string;
  model?: string;
  /** Ordered fallback model identifiers (native fallbackModels) — Agent Deck
   *  metadata, not passed to pi; persisted so an edit never silently drops it. */
  fallbackModels?: string[];
  thinking?: string;
  systemPromptMode: "replace" | "append";
  /** Ordinary Pi tool names passed through `--tools`. */
  tools?: string[];
  /** Ordered external pi-mcp-adapter tool names declared as `mcp:<tool>` in
   * `tools:` frontmatter. These names do not grant or connect MCP servers. */
  mcpDirectTools?: string[];
  skills?: string[];
  extensions?: string[];
  /** MCP server names (from mcp.json) this agent declares for its sessions. */
  mcpServers?: string[];
  /** Requested default for managed named delegation. Mutation still requires
   * the runtime's per-run worktree/approval/path policy. */
  defaultExpectedOutcome?: SubagentExpectedOutcome;
  /** Native-compatible authored progress preference. Portable metadata only:
   * Agent Deck currently preserves and displays it without changing runtime. */
  defaultProgress?: boolean;
  scope: ResourceScope;
  filePath: string;
  /** Markdown body = the agent system prompt. */
  body: string;
  /** A higher-priority scope defines the same name. */
  shadowed: boolean;
  /** Effective agent that hides a builtin of the same name. */
  replacesBuiltin: boolean;
  /** Builtin whose values come partly from settings.json agentOverrides. */
  overridden?: boolean;
  /** Disabled agents are excluded from the picker and won't launch. */
  disabled?: boolean;
}

export interface SkillInfo {
  name: string;
  description: string;
  scope: ResourceScope;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  /** SKILL.md markdown body (frontmatter stripped) — the editor's initial state. */
  body: string;
  /** App-level disable: dimmed, unassignable, excluded from --skill injection. */
  disabled?: boolean;
}

export interface PromptInfo {
  name: string;
  description?: string;
  scope: ResourceScope;
  filePath: string;
  /** Markdown body (frontmatter stripped) — the editor's initial state. */
  body: string;
  /**
   * The slash command that runs this template (native prompt.invocation).
   * pi matches `/<filename>` (expandPromptTemplate compares against the file's
   * basename, NOT any frontmatter `name`), so this is `/` + the basename.
   */
  invocation: string;
  /** pi's `argument-hint` frontmatter — a usage hint shown next to the command. */
  argumentHint?: string;
}

export type AgentFilter =
  | "all"
  | "builtin"
  | "global"
  | "library"
  | "project"
  | "overridden"
  | "replaced"
  | "custom"
  | "disabled";

export const AGENT_FILTERS: AgentFilter[] = [
  "all",
  "builtin",
  "global",
  "library",
  "project",
  "overridden",
  "replaced",
  "custom",
  "disabled",
];

export function agentMatchesFilter(agent: AgentInfo, filter: AgentFilter): boolean {
  switch (filter) {
    case "all":
      return true;
    case "builtin":
    case "global":
    case "library":
    case "project":
      return agent.scope === filter;
    case "overridden":
      // A builtin whose values are partly redefined by a settings.json override.
      return agent.overridden === true;
    case "replaced":
      return agent.replacesBuiltin || (agent.scope === "builtin" && agent.shadowed);
    case "custom":
      return agent.scope !== "builtin";
    case "disabled":
      return agent.disabled === true;
  }
}

/** Compute shadowing flags across all scanned agents (pure; stable order).
 * Within one scope, the first catalog entry wins; this preserves native's
 * legacy-before-modern global agent precedence. */
export function applyShadowing(
  agents: Omit<AgentInfo, "shadowed" | "replacesBuiltin">[],
): AgentInfo[] {
  const best = new Map<string, { priority: number; index: number }>();
  const hasBuiltin = new Set<string>();
  agents.forEach((agent, index) => {
    const priority = SCOPE_PRIORITY[agent.scope];
    if (agent.scope === "builtin") hasBuiltin.add(agent.name);
    const current = best.get(agent.name);
    if (current === undefined || priority > current.priority) {
      best.set(agent.name, { priority, index });
    }
  });
  return agents.map((agent, index) => {
    const winner = best.get(agent.name)!;
    const shadowed = winner.priority > SCOPE_PRIORITY[agent.scope] || winner.index !== index;
    return {
      ...agent,
      shadowed,
      replacesBuiltin: !shadowed && agent.scope !== "builtin" && hasBuiltin.has(agent.name),
    };
  });
}
