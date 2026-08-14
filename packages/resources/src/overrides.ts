import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  normalizeAgentDefaultReads,
  normalizeAgentOutput,
  validateAgentDefaultReadsForAuthoring,
  type AgentInfo,
  type SubagentExpectedOutcome,
} from "@agent-deck/domain";
import { piAgentHome, type ResourceRoots } from "./paths.ts";

/**
 * Builtin agent overrides, mirroring the native app's AgentPersistence.swift:
 * builtin files are NEVER mutated — edits become a diff-shaped record at
 * `settings.json → subagents.agentOverrides.<name>`. A field value of `false`
 * means "explicitly cleared"; `systemPrompt` overrides the markdown body.
 * Unknown settings.json keys are preserved verbatim (raw read-modify-write).
 */

export type AgentOverride = Record<string, unknown>;

/** Editable fields the M1 editor supports (native supports a superset). */
export interface AgentEdit {
  description?: string;
  whenToUse?: string;
  model?: string;
  fallbackModels?: string[];
  thinking?: string;
  systemPromptMode?: "replace" | "append";
  /** Native-compatible combined tools list; direct adapter names use `mcp:<name>`. */
  tools?: string[];
  skills?: string[];
  mcpServers?: string[];
  defaultReads?: string[];
  defaultExpectedOutcome?: SubagentExpectedOutcome | "";
  /** `false` clears the custom-agent frontmatter value, matching native writes. */
  defaultProgress?: boolean;
  /** `false` clears the custom-agent frontmatter value, matching native writes. */
  interactive?: boolean;
  /** Single-line native output guidance; an empty string clears it. */
  output?: string;
  body?: string;
}

function settingsPath(roots: ResourceRoots): string {
  return path.join(piAgentHome(roots), "settings.json");
}

function loadSettings(roots: ResourceRoots): Record<string, unknown> {
  let raw: string;
  try {
    raw = readFileSync(settingsPath(roots), "utf8");
  } catch {
    return {}; // No settings file yet — safe to start empty.
  }
  // An EXISTING but malformed settings.json must never be silently replaced:
  // that would destroy the user's whole pi configuration on the next write.
  const parsed: unknown = JSON.parse(raw);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("settings.json exists but is not a JSON object — refusing to overwrite");
  }
  return parsed as Record<string, unknown>;
}

export function readAgentOverrides(roots: ResourceRoots): Record<string, AgentOverride> {
  let settings: Record<string, unknown>;
  try {
    settings = loadSettings(roots);
  } catch {
    // External/manual settings edits must not take the Agents catalog down.
    // Reads fail closed like native's scanner; writes still use loadSettings
    // directly and refuse to overwrite malformed user configuration.
    return {};
  }
  const subagents = settings.subagents;
  if (typeof subagents !== "object" || subagents === null) return {};
  const overrides = (subagents as Record<string, unknown>).agentOverrides;
  if (typeof overrides !== "object" || overrides === null) return {};
  return overrides as Record<string, AgentOverride>;
}

/** Write (or with null: remove) one agent's override. Preserves unknown keys. */
export function writeBuiltinAgentOverride(
  roots: ResourceRoots,
  name: string,
  override: AgentOverride | null,
): void {
  const settings = loadSettings(roots);
  const subagents =
    typeof settings.subagents === "object" && settings.subagents !== null
      ? (settings.subagents as Record<string, unknown>)
      : {};
  const overrides =
    typeof subagents.agentOverrides === "object" && subagents.agentOverrides !== null
      ? (subagents.agentOverrides as Record<string, unknown>)
      : {};

  if (override && Object.keys(override).length > 0) overrides[name] = override;
  else delete overrides[name];

  if (Object.keys(overrides).length > 0) subagents.agentOverrides = overrides;
  else delete subagents.agentOverrides;
  if (Object.keys(subagents).length > 0) settings.subagents = subagents;
  else delete settings.subagents;

  const file = settingsPath(roots);
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`);
  renameSync(tmp, file);
}

function listsEqual(a: string[] | undefined, b: string[] | undefined): boolean {
  return (a ?? []).join("\0") === (b ?? []).join("\0");
}

/** Override keys the M1 editor manages; anything else must be preserved on write. */
export const EDITABLE_OVERRIDE_KEYS = new Set([
  "description",
  "whenToUse",
  "model",
  "fallbackModels",
  "thinking",
  "systemPromptMode",
  "tools",
  "skills",
  "mcpServers",
  "defaultReads",
  // The builtin editor intentionally omits this field, so it remains unmanaged
  // unless an explicit API edit computes a replacement value below.
  "systemPrompt",
]);

/** Merge a freshly computed override with fields the editor doesn't manage. */
export function mergeWithUnmanagedOverrideFields(
  existing: AgentOverride | undefined,
  computed: AgentOverride | null,
): AgentOverride | null {
  const unmanaged: AgentOverride = {};
  for (const [key, value] of Object.entries(existing ?? {})) {
    if (!EDITABLE_OVERRIDE_KEYS.has(key)) unmanaged[key] = value;
  }
  const merged = { ...unmanaged, ...(computed ?? {}) };
  return Object.keys(merged).length > 0 ? merged : null;
}

/** Diff an edit against the pristine builtin base — native buildBuiltinOverride semantics. */
export function computeBuiltinOverride(
  base: Pick<
    AgentInfo,
    | "description"
    | "whenToUse"
    | "model"
    | "fallbackModels"
    | "thinking"
    | "systemPromptMode"
    | "tools"
    | "mcpDirectTools"
    | "skills"
    | "mcpServers"
    | "defaultReads"
    | "defaultExpectedOutcome"
    | "output"
    | "body"
  >,
  edit: AgentEdit,
): AgentOverride | null {
  const values: AgentOverride = {};
  const diffString = (key: string, edited: string | undefined, baseValue: string | undefined) => {
    if (edited !== undefined && edited !== (baseValue ?? "")) {
      values[key] = edited === "" ? false : edited;
    }
  };
  diffString("description", edit.description, base.description);
  diffString("whenToUse", edit.whenToUse, base.whenToUse);
  diffString("model", edit.model, base.model);
  diffString("thinking", edit.thinking, base.thinking);
  diffString("output", edit.output, base.output);
  if (edit.systemPromptMode !== undefined && edit.systemPromptMode !== base.systemPromptMode) {
    values.systemPromptMode = edit.systemPromptMode;
  }
  if (edit.fallbackModels !== undefined && !listsEqual(edit.fallbackModels, base.fallbackModels)) {
    values.fallbackModels = edit.fallbackModels.length > 0 ? edit.fallbackModels : false;
  }
  const baseTools = [
    ...(base.tools ?? []),
    ...(base.mcpDirectTools ?? []).map((name) => `mcp:${name}`),
  ];
  if (edit.tools !== undefined && !listsEqual(edit.tools, baseTools)) {
    values.tools = edit.tools.length > 0 ? edit.tools : false;
  }
  if (edit.skills !== undefined && !listsEqual(edit.skills, base.skills)) {
    values.skills = edit.skills.length > 0 ? edit.skills : false;
  }
  if (edit.mcpServers !== undefined && !listsEqual(edit.mcpServers, base.mcpServers)) {
    values.mcpServers = edit.mcpServers.length > 0 ? edit.mcpServers : false;
  }
  if (edit.defaultReads !== undefined) {
    const defaultReads = validateAgentDefaultReadsForAuthoring(edit.defaultReads) ?? [];
    if (!listsEqual(defaultReads, base.defaultReads)) {
      values.defaultReads = defaultReads.length > 0 ? defaultReads : false;
    }
  }
  if (
    edit.defaultExpectedOutcome !== undefined &&
    edit.defaultExpectedOutcome !== (base.defaultExpectedOutcome ?? "")
  ) {
    values.defaultExpectedOutcome = edit.defaultExpectedOutcome || false;
  }
  if (edit.body !== undefined && edit.body.trim() !== base.body) {
    values.systemPrompt = edit.body;
  }
  return Object.keys(values).length > 0 ? values : null;
}

function overrideString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function overrideList(value: unknown): string[] | undefined {
  if (value === false) return undefined;
  // Trim + drop empties on BOTH array and comma-string forms, so a raw override
  // value normalizes the same way frontmatter's asList does.
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return undefined;
}

/** Apply a diff-shaped override to a scanned builtin agent. */
export function applyAgentOverride(
  agent: Omit<AgentInfo, "shadowed" | "replacesBuiltin">,
  override: AgentOverride,
): Omit<AgentInfo, "shadowed" | "replacesBuiltin"> & { overridden: true } {
  const next = { ...agent, overridden: true as const };
  for (const [key, value] of Object.entries(override)) {
    switch (key) {
      case "description":
        next.description = value === false ? undefined : overrideString(value);
        break;
      case "whenToUse":
        next.whenToUse = value === false ? undefined : overrideString(value);
        break;
      case "model":
        next.model = value === false ? undefined : overrideString(value);
        break;
      case "fallbackModels":
        next.fallbackModels = overrideList(value);
        break;
      case "thinking":
        next.thinking = value === false ? undefined : overrideString(value);
        break;
      case "systemPromptMode":
        next.systemPromptMode = value === "append" ? "append" : "replace";
        break;
      case "tools": {
        const combined = overrideList(value) ?? [];
        next.tools = combined.filter((item) => !item.startsWith("mcp:"));
        next.mcpDirectTools = combined.flatMap((item) => {
          if (!item.startsWith("mcp:")) return [];
          const name = item.slice(4).trim();
          return name ? [name] : [];
        });
        if (next.tools.length === 0) next.tools = undefined;
        if (next.mcpDirectTools.length === 0) next.mcpDirectTools = undefined;
        break;
      }
      case "skills":
        next.skills = overrideList(value);
        break;
      case "mcpServers":
        next.mcpServers = overrideList(value);
        break;
      case "defaultReads":
        next.defaultReads = normalizeAgentDefaultReads(overrideList(value));
        break;
      case "defaultExpectedOutcome":
        next.defaultExpectedOutcome =
          value === "reportOnly" ||
          value === "editFilesInWorktree" ||
          value === "writeProjectFile" ||
          value === "directProjectWrites"
            ? value
            : undefined;
        break;
      case "defaultProgress":
        // Unlike ordinary false-as-clear override fields, this is boolean
        // metadata: false is an effective value and must shadow builtin true.
        if (typeof value === "boolean") next.defaultProgress = value;
        break;
      case "interactive":
        // Boolean compatibility metadata: false is an effective override value.
        if (typeof value === "boolean") next.interactive = value;
        break;
      case "output":
        next.output = value === false ? undefined : normalizeAgentOutput(value);
        break;
      case "systemPrompt": {
        const body = overrideString(value);
        if (body !== undefined) next.body = body;
        break;
      }
      case "disabled":
        next.disabled = value === true;
        break;
      default:
        // Unknown override fields are preserved on disk but not interpreted here.
        break;
    }
  }
  return next;
}
