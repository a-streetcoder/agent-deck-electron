/**
 * Resource model shared by server and UI: agents and skills with the scope /
 * shadowing / filter semantics ported from the native app (SidebarModels.swift).
 *
 * Scope priority for same-name shadowing: project > global > builtin > library.
 * Library agents remain catalog entries but never replace active agents.
 */

export type ResourceScope = "builtin" | "global" | "library" | "project" | "package";

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
  // Package skills follow native: visible with provenance, injected only when assigned —
  // never part of effective-name resolution (SKL-08).
  package: 0,
};

export type AgentWarningCategory = "skill" | "environment" | "tools";
export type AgentWarningId =
  | "skill-missing"
  | "skill-disabled"
  | "skill-ambiguous"
  | "exa-key-missing"
  | "web-fetch-with-exa"
  | "extensions-without-tools";

/** Generated, current-runtime diagnostics. These are returned with the catalog
 * and are never authored back into agent markdown or settings. */
export interface AgentWarning {
  id: AgentWarningId;
  category: AgentWarningCategory;
  message: string;
}

export const AGENT_WARNING_MAX_ITEMS = 16;
export const AGENT_WARNING_MESSAGE_MAX_LENGTH = 500;

export interface AgentWarningContext {
  /** Number of current-project catalog candidates for each bare skill name. */
  skillCandidateCounts: ReadonlyMap<string, number>;
  disabledSkills: ReadonlySet<string>;
  exaConfigured: boolean;
  projectSelected: boolean;
}

const EXA_WEB_TOOLS = new Set(["web_search", "fetch_content", "get_search_content"]);

function boundedSkillNames(names: readonly string[]): string {
  const shown = names.slice(0, 5).map((name) => `“${name.slice(0, 100)}”`);
  return `${shown.join(", ")}${names.length > shown.length ? `, and ${names.length - shown.length} more` : ""}`;
}

/** Native-compatible warning set plus Electron's separate disabled-skill state.
 * Messages and count remain bounded even for malformed hand-authored lists. */
export function agentConfigurationWarnings(
  agent: Pick<AgentInfo, "skills" | "tools" | "mcpDirectTools" | "extensions">,
  context: AgentWarningContext,
): AgentWarning[] {
  const warnings: AgentWarning[] = [];
  const names = [...new Set((agent.skills ?? []).slice(0, 64))];
  const missing = names.filter((name) => (context.skillCandidateCounts.get(name) ?? 0) === 0);
  const ambiguous = names.filter((name) => (context.skillCandidateCounts.get(name) ?? 0) > 1);
  const disabled = names.filter(
    (name) =>
      (context.skillCandidateCounts.get(name) ?? 0) === 1 && context.disabledSkills.has(name),
  );
  const visibility = context.projectSelected
    ? "Bare skill names resolve only against global skills and this selected project's skills; project skills from other projects are not visible."
    : "Bare skill names resolve against the global skill catalog until a project is selected.";
  if (missing.length) {
    warnings.push({
      id: "skill-missing",
      category: "skill",
      message: `References missing skill${missing.length === 1 ? "" : "s"} ${boundedSkillNames(missing)}. ${visibility}`,
    });
  }
  if (disabled.length) {
    warnings.push({
      id: "skill-disabled",
      category: "skill",
      message: `References disabled skill${disabled.length === 1 ? "" : "s"} ${boundedSkillNames(disabled)}. Named-agent launch refuses disabled assignments; ambient default/project assignments skip them. Enable ${disabled.length === 1 ? "it" : "them"} in Skills or remove the assignment.`,
    });
  }
  if (ambiguous.length) {
    warnings.push({
      id: "skill-ambiguous",
      category: "skill",
      message: `Skill name${ambiguous.length === 1 ? " is" : "s are"} ambiguous: ${boundedSkillNames(ambiguous)}. Rename or remove duplicate current-project catalog entries before launch. ${visibility}`,
    });
  }
  const tools = agent.tools ?? [];
  if (tools.some((tool) => EXA_WEB_TOOLS.has(tool)) && !context.exaConfigured) {
    warnings.push({
      id: "exa-key-missing",
      category: "environment",
      message:
        "Uses bundled Exa web tools but EXA_API_KEY was not found. Add the key in Environment or remove those tools.",
    });
  }
  if (tools.some((tool) => tool === "web_fetch") && context.exaConfigured) {
    warnings.push({
      id: "web-fetch-with-exa",
      category: "environment",
      message:
        "Uses web_fetch while Exa is configured. Agent Deck exposes Exa tools instead; replace web_fetch with web_search, fetch_content, or get_search_content.",
    });
  }
  if (
    (agent.extensions?.length ?? 0) > 0 &&
    tools.length === 0 &&
    (agent.mcpDirectTools?.length ?? 0) === 0
  ) {
    warnings.push({
      id: "extensions-without-tools",
      category: "tools",
      message:
        "Declares extensions but no explicit ordinary or direct tools, so capabilities may not match expectations. Add the intended tools or remove the extensions.",
    });
  }
  return warnings.slice(0, AGENT_WARNING_MAX_ITEMS).map((warning) => ({
    ...warning,
    message: warning.message.slice(0, AGENT_WARNING_MESSAGE_MAX_LENGTH),
  }));
}

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
  /** The authored frontmatter contained a tools field, including `tools: []`.
   * Needed to distinguish Pi defaults from an explicit empty allowlist. */
  toolsExplicit?: boolean;
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
  /** Current-project/runtime diagnostics generated by the server catalog. */
  warnings?: AgentWarning[];
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
  /**
   * An EXTERNAL REFERENCE (PRM-05, native discoveryKind externalReference): the
   * file stays where the user keeps it — never copied into a catalog. Removing
   * it removes the reference, not the file.
   */
  external?: boolean;
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
