/** One pickable kind in the composer's `/` browser. */
export type SlashItemKind = "command" | "prompt" | "skill" | "loop";

/**
 * Path-free slash-universe item. Identifiers are:
 * `command:${InjectedCommandId}` | `prompt:${scope}:${name}` |
 * `skill:${scope}:${name}` | `loop:create-new` | `loop:${loop.id}`.
 */
export interface SlashUniverseItem {
  kind: SlashItemKind;
  id: string;
  displayName: string;
  description?: string;
  scopeLabel?: string;
  isActive: boolean;
  /** Commands: the `/name` they send. */
  slashName?: string;
  /** Skills: name used in `/skill:name`. */
  skillName?: string;
  /** Prompt/skill body for seed/inline. Not searched. */
  body?: string;
  /** Extra searchable text that is not shown as the description (loop goal). */
  searchText?: string;
  /** Saved loops; omit for create-new. */
  loopId?: string;
}

/** Snapshot of Skills / Prompts / Commands / Loops the composer can browse. */
export interface SlashUniverse {
  commands: SlashUniverseItem[];
  prompts: SlashUniverseItem[];
  skills: SlashUniverseItem[];
  loops: SlashUniverseItem[];
}
