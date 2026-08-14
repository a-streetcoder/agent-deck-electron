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

export const AGENT_OUTPUT_MAX_LENGTH = 1000;
/** Agent extension entries are catalog file paths. Keep authored metadata bounded
 * without conflating an absent default policy with an explicit empty allowlist. */
export const AGENT_EXTENSION_MAX_ITEMS = 64;
export const AGENT_EXTENSION_MAX_LENGTH = 4096;
export const AGENT_DEFAULT_READ_MAX_BYTES = 512;
export const AGENT_DEFAULT_READ_MAX_ITEMS = 32;
export const AGENT_DEFAULT_READ_TOTAL_MAX_BYTES = 1102;

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Cross-platform safety check shared by authored defaults and the strict bridge boundary. */
export function projectRelativeReadError(raw: string): string | undefined {
  for (const character of raw) {
    const point = character.codePointAt(0)!;
    if (point <= 0x1f || (point >= 0x7f && point <= 0x9f) || point === 0x2028 || point === 0x2029) {
      return "cannot contain multiline or control content";
    }
  }
  const value = raw.trim();
  if (!value) return "cannot be empty";
  if (utf8Bytes(value) > AGENT_DEFAULT_READ_MAX_BYTES) {
    return `cannot exceed ${AGENT_DEFAULT_READ_MAX_BYTES} UTF-8 bytes`;
  }
  if (
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value) ||
    value.split(/[\\/]/u).includes("..")
  ) {
    return "must be a single-line project-relative path without traversal";
  }
  return undefined;
}

/** Manually authored defaults fail soft: keep each safe entry in authored order. */
export function normalizeAgentDefaultReads(
  value: readonly string[] | undefined,
): string[] | undefined {
  if (!value) return undefined;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    if (projectRelativeReadError(raw)) continue;
    const path = raw.trim();
    if (seen.has(path)) continue;
    seen.add(path);
    normalized.push(path);
  }
  return normalized.length > 0 ? normalized : undefined;
}

/** Authoring is fail-soft for unsafe individual entries but rejects a sanitized
 * definition that can never fit the managed-subagent launch/artifact budget. */
export function validateAgentDefaultReadsForAuthoring(
  value: readonly string[] | undefined,
): string[] | undefined {
  const normalized = normalizeAgentDefaultReads(value);
  if (!normalized) return undefined;
  if (normalized.length > AGENT_DEFAULT_READ_MAX_ITEMS) {
    throw new Error(
      `Default reads cannot exceed ${AGENT_DEFAULT_READ_MAX_ITEMS} safe, unique paths after sanitization. Remove ${normalized.length - AGENT_DEFAULT_READ_MAX_ITEMS} path(s).`,
    );
  }
  const totalBytes = normalized.reduce((total, path) => total + utf8Bytes(path), 0);
  if (totalBytes > AGENT_DEFAULT_READ_TOTAL_MAX_BYTES) {
    throw new Error(
      `Default reads cannot exceed ${AGENT_DEFAULT_READ_TOTAL_MAX_BYTES.toLocaleString("en-US")} UTF-8 bytes in total after sanitization (received ${totalBytes.toLocaleString("en-US")}). Shorten or remove paths.`,
    );
  }
  return normalized;
}

/** Preserve absence vs explicit empty while trimming, bounding, and stably
 * de-duplicating hand-authored extension entries. Invalid entries fail soft. */
export function normalizeAgentExtensions(
  value: readonly string[] | undefined,
): string[] | undefined {
  if (value === undefined) return undefined;
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const entry = raw.trim();
    if (!entry || entry.length > AGENT_EXTENSION_MAX_LENGTH || seen.has(entry)) continue;
    seen.add(entry);
    normalized.push(entry);
    if (normalized.length === AGENT_EXTENSION_MAX_ITEMS) break;
  }
  return normalized;
}

/** Strict authoring counterpart. Unlike scanning, API writes reject overflow so
 * the renderer cannot silently lose a selection. */
export function validateAgentExtensionsForAuthoring(value: readonly string[]): string[] {
  if (value.length > AGENT_EXTENSION_MAX_ITEMS) {
    throw new Error(`Extensions cannot exceed ${AGENT_EXTENSION_MAX_ITEMS} entries.`);
  }
  if (value.some((entry) => entry.length > AGENT_EXTENSION_MAX_LENGTH)) {
    throw new Error(`Each extension entry cannot exceed ${AGENT_EXTENSION_MAX_LENGTH} characters.`);
  }
  return normalizeAgentExtensions(value) ?? [];
}

/** Native output metadata enters a child prompt as exactly one advisory value. */
export function normalizeAgentOutput(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const output = value.trim();
  if (!output || output.length > AGENT_OUTPUT_MAX_LENGTH) return undefined;
  for (const character of output) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 31 ||
      codePoint === 127 ||
      codePoint === 133 ||
      codePoint === 8232 ||
      codePoint === 8233
    ) {
      return undefined;
    }
  }
  return output;
}

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
  /** Ordered, project-relative read-first hints for named delegation. Unsafe
   * manually authored entries are omitted independently during scanning. */
  defaultReads?: string[];
  /** Requested default for managed named delegation. Mutation still requires
   * the runtime's per-run worktree/approval/path policy. */
  defaultExpectedOutcome?: SubagentExpectedOutcome;
  /** Native-compatible authored progress preference. Portable metadata only:
   * Agent Deck currently preserves and displays it without changing runtime. */
  defaultProgress?: boolean;
  /** Native compatibility metadata for expected interaction. Parsed, persisted,
   * and displayed without changing Agent Deck runtime behavior. */
  interactive?: boolean;
  /** Native compatibility metadata for delegation depth. Agent Deck still
   * prohibits recursive child delegation regardless of this value. */
  maxSubagentDepth?: number;
  /** Native authored output guidance. For named delegation this is advisory
   * prompt metadata only; it never grants tools or filesystem authority. */
  output?: string;
  scope: ResourceScope;
  filePath: string;
  /** Opaque same-origin URL for an app-managed avatar. Never a filesystem path. */
  avatarUrl?: string;
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
