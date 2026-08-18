import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import envPaths from "env-paths";
import type {
  KeybindingBinding,
  ProjectMeta,
  SessionMeta,
  TranscriptVisibilitySettings,
} from "@agent-deck/contracts";
import {
  coerceTranscriptVisibility,
  DEFAULT_TRANSCRIPT_VISIBILITY,
  isKeybindingCommand,
  isValidChord,
} from "@agent-deck/contracts";
import { PI_THINKING_LEVELS, type ThinkingLevel } from "@agent-deck/domain";
import type { CodexPluginSkillRef } from "@agent-deck/resources";
import { Context, Effect, Layer, Option } from "effect";

/**
 * App-data persistence as an Effect service (Slice 6 — the last Phase-2 leaf).
 * pi owns the canonical session files; we keep light JSON indexes (sessions,
 * projects) plus the app-settings blob that survive server restarts. Writes are
 * atomic (tmp + rename). The **on-disk JSON format and file paths are unchanged**
 * from the pre-migration class implementation — this slice moves the code behind
 * a service interface, not a byte on disk (a fixture round-trip test in
 * test/persistence-roundtrip.test.ts pins that).
 *
 * File anatomy (the pushBus.ts template):
 *   1. data types + handle interfaces (the effectful API surface)
 *   2. `make*` effect(s) building each handle (context-free — a handle needs
 *      only a data dir, no other service)
 *   3. `Context.Tag` service class (`Persistence`, t3code's Services/ role) — a
 *      FACTORY service, since stores are opened per data dir, not global
 *   4. `PersistenceLive` Layer (t3code's Layers/ role) — joined into
 *      `serverLayers` in ../runtime.ts
 *
 * ## Leaf service; the class facade reads through `make*` directly
 *
 * Like Slice 3's push bus, each handle is CONTEXT-FREE: `makeJsonArrayStoreHandle`
 * / `makeSettingsStoreHandle` need no other service, only a data dir. So the
 * synchronous class facade in ../persistence.ts builds its handle with
 * `Effect.runSync(make*)` directly — a total run, no ManagedRuntime required —
 * exactly as `pushBus.ts` does for the bus. The {@link Persistence} service here
 * is the composition-root seam (joined into `serverLayers`) that a future
 * Effect-native consumer (Slice 7's routes, an Effect SessionManager) resolves
 * instead of `new SessionIndex()`. Until then it is a wired-but-quiet leaf, the
 * same transitional posture the push bus held between Slice 3 and Slice 5.
 *
 * ## Template caveats (Option, no runSync in service logic)
 *
 *   - `find` returns `Option<T>`, not the legacy `T | undefined` sentinel; the
 *     class facade maps back with `Option.getOrUndefined`.
 *   - No `Effect.runSync` appears in this module — every operation is an Effect;
 *     only the class facade (../persistence.ts) runs them synchronously.
 *   - ERROR CHANNEL is deliberately `E = never` for now: the write paths
 *     (`flush`, the `mkdir` in each `make*`) do real fs I/O inside `Effect.sync`,
 *     so a disk failure (ENOSPC/EACCES/EROFS) surfaces as a DEFECT, not a typed
 *     error. This is a KNOWN divergence from the piHost precedent (which models
 *     fallible I/O with tagged errors), and unlike piHost it is safe TODAY only
 *     because the sole consumer is the synchronous facade, whose
 *     `runSyncUnwrapped` re-throws the raw fs Error with its `code` intact
 *     (parity with the legacy classes — no route inspects `err.code`). When
 *     Slice 7 makes routes Effect-native and a program does `yield* settings.update(...)`,
 *     an uncatchable defect is wrong: the flush/mkdir paths must move to
 *     `Effect.try` with a `PersistenceWriteError` tagged error that the route
 *     layer maps to an HTTP 5xx. Deferred to Slice 7 (tracked in the plan) so the
 *     error shape is designed WITH its first real consumer, not speculatively.
 */

export function defaultDataDir(): string {
  return envPaths("agent-deck-electron", { suffix: "" }).data;
}

// ---------------------------------------------------------------------------
// 1. Handle interfaces (the effectful API surface)
// ---------------------------------------------------------------------------

/** One light JSON array index (sessions.json / projects.json), keyed by `id`. */
export interface JsonArrayStoreHandle<T extends { id: string }> {
  /** The live in-memory list (same reference semantics as the legacy class). */
  readonly list: Effect.Effect<T[]>;
  /** First item matching the predicate, or `None`. */
  readonly find: (predicate: (item: T) => boolean) => Effect.Effect<Option.Option<T>>;
  /** Insert or replace by `id`, then atomically flush. */
  readonly upsert: (item: T) => Effect.Effect<void>;
  /** Remove by `id`; resolves to whether anything was removed. Flushes on hit. */
  readonly remove: (id: string) => Effect.Effect<boolean>;
}

export type SessionIndexHandle = JsonArrayStoreHandle<SessionMeta>;
export type ProjectIndexHandle = JsonArrayStoreHandle<ProjectMeta>;

export interface AppSettings {
  /** Skills injected into EVERY project's parent sessions ("All Projects"). */
  defaultSkills: string[];
  /** MCP servers granted to ordinary sessions in every real project. */
  defaultMcpServers: string[];
  /** Global model/runtime MCP capability. Missing or malformed values default enabled. */
  mcpEnabled: boolean;
  /**
   * Prompt templates made available in EVERY project's parent sessions as
   * `--prompt-template` flags ("All Projects"). Native defaultPromptTemplateNames.
   */
  defaultPromptTemplates: string[];
  /** Skills the user turned off: unassignable, excluded from --skill injection. */
  disabledSkills: string[];
  /** Root folders scanned for project auto-discovery. */
  projectRoots: string[];
  /** Extension files (absolute paths) the user added to load into sessions. */
  extensions: string[];
  /** Extensions turned off: kept in the list but excluded from --extension. */
  disabledExtensions: string[];
  /** App-bundled injected commands are enabled unless their stable id is here. */
  disabledInjectedCommandIDs: string[];
  /** Imported command-library entries are disabled unless their stable id is here. */
  enabledLibraryCommandIDs: string[];
  /** Models the user hid from the picker, by "<provider>:<id>" key. */
  disabledModels: string[];
  /** SES-34: models the user marked OpenAI Fast, as `provider:id`. */
  openAIFastModels: string[];
  /**
   * Onboarding-preferences (native OnboardingPreferencesView). `defaultModel`
   * (provider-qualified "provider:id" so it launches under the right provider) /
   * `defaultThinking` seed every NEW parent ("All Projects" / Pi Agent) session's
   * launch when the request doesn't override them; `autoTitle` gates the
   * title-helper launch; `worktreeIsolation` runs each session in its own git
   * worktree; `keepWorktreeAfterMerge` preserves an isolated checkout after a
   * successful merge (the safe default); `gitAutomation` gates the Git screen's
   * Commit/Push/Merge actions.
   */
  autoTitle: boolean;
  /** Allow automatic parent-session recall and model-facing memory tools. */
  agentMemoryEnabled: boolean;
  /** Maximum grapheme clusters in model-facing recalled memory output. */
  agentMemoryInjectionCharacterBudget: number;
  /** Opt in ordinary managed children to task-relevant launch-only memory context. */
  agentMemorySubagentsEnabled: boolean;
  /** Request semantic ranking for every memory recall path when an embedder is available. */
  semanticMemoryEnabled: boolean;
  /** Stop resumable parent Pi processes after an authoritative idle boundary. */
  piAgentIdleParkingEnabled: boolean;
  /** Warm-idle delay. Runtime and HTTP validation constrain this to 1–120. */
  piAgentIdleParkingTimeoutMinutes: number;
  worktreeIsolation: boolean;
  keepWorktreeAfterMerge: boolean;
  gitAutomation: boolean;
  defaultModel: string | null;
  defaultThinking: ThinkingLevel | null;
  /**
   * How pi extensions load (native PiAgentExtensionLoadingMode). "useMyExtensions"
   * loads the user's discovered/added enabled extensions alongside Agent Deck's
   * bridges; "agentDeckManaged" loads ONLY the bridges (the user's Pi extensions
   * stay off, though still listed). Native defaults to agentDeckManaged; the port
   * keeps its shipped default of loading discovered extensions and offers the
   * stricter mode as an opt-in.
   */
  extensionLoadingMode: "useMyExtensions" | "agentDeckManaged";
  /**
   * Codex plugin skill REFERENCES (SKL-09): resolved against the plugin cache's
   * active version on every scan so they version-follow — never copied.
   */
  codexPluginSkillRefs: CodexPluginSkillRef[];
  /**
   * External prompt REFERENCES (PRM-05, native externalPromptPaths): absolute
   * paths of single `.md` files that stay where the user keeps them — scanned
   * in place, never copied into a catalog.
   */
  externalPromptPaths: string[];
  /**
   * Disabled BUILTIN prompts (PRM-06, native disabledBundledPromptNames): still
   * listed (re-enableable) but excluded from launch resolution. Only builtin
   * records are affected — a user's same-named copy keeps working.
   */
  disabledBuiltinPromptNames: string[];
  /**
   * The remembered open-in-editor choice (Slice 11): the editor id last picked
   * from the diff panel's picker, so the next open is one click. An id, never
   * a command — the server only launches editors from its own detected list.
   */
  preferredEditor: string | null;
  /**
   * Global renderer-only transcript projection. Hidden categories remain in
   * authoritative history and become visible again when re-enabled.
   */
  piAgentTranscriptVisibility: TranscriptVisibilitySettings;
  /**
   * User keybinding overrides (Slice 14): a `command -> chord` list layered over
   * the shipped `DEFAULT_KEYBINDINGS`. Empty = all defaults. Each entry is
   * validated on load and on PATCH (known command + a chord with a real
   * modifier); anything else is dropped rather than trusted.
   */
  keybindings: KeybindingBinding[];
}

const MAX_INJECTED_COMMAND_IDS = 256;
const BUILT_IN_COMMAND_ID = /^built-in:[a-z0-9][a-z0-9-]{0,63}$/;
const LIBRARY_COMMAND_ID = /^library:[0-9a-f]{32}$/;

function coerceCommandIds(value: unknown, pattern: RegExp): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(value.filter((id): id is string => typeof id === "string" && pattern.test(id))),
  ].slice(0, MAX_INJECTED_COMMAND_IDS);
}

const MCP_ASSIGNMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
function coerceMcpAssignmentNames(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (name): name is string => typeof name === "string" && MCP_ASSIGNMENT_NAME.test(name),
      ),
    ),
  ].slice(0, 256);
}

/** Keep only well-formed plugin refs — a stored blob is re-validated on load (fail closed). */
function coerceCodexPluginRefs(value: unknown): CodexPluginSkillRef[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (item): item is CodexPluginSkillRef =>
      typeof item === "object" &&
      item !== null &&
      typeof (item as CodexPluginSkillRef).marketplace === "string" &&
      typeof (item as CodexPluginSkillRef).plugin === "string" &&
      typeof (item as CodexPluginSkillRef).relPath === "string",
  );
}

/** Windows filesystems are case-insensitive: one file, one reference. */
const externalPathKey = (p: string): string =>
  process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p);

const refKey = (ref: CodexPluginSkillRef): string =>
  `${ref.marketplace} ${ref.plugin} ${ref.relPath}`;

/** Keep only well-formed overrides (known command + a valid, modifier-bearing chord). */
function coerceKeybindings(value: unknown): KeybindingBinding[] {
  if (!Array.isArray(value)) return [];
  const out: KeybindingBinding[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { command?: unknown; key?: unknown };
    if (typeof record.command !== "string" || typeof record.key !== "string") continue;
    if (!isKeybindingCommand(record.command) || !isValidChord(record.key)) continue;
    out.push({ command: record.command, key: record.key });
  }
  return out;
}

/** App-level settings (app-settings.json); the effectful surface of the store. */
export interface SettingsStoreHandle {
  readonly get: Effect.Effect<AppSettings>;
  readonly update: (patch: Partial<AppSettings>) => Effect.Effect<AppSettings>;
  readonly setDefaultSkill: (name: string, enabled: boolean) => Effect.Effect<AppSettings>;
  readonly setDefaultMcpServer: (name: string, enabled: boolean) => Effect.Effect<AppSettings>;
  readonly setDefaultPromptTemplate: (name: string, enabled: boolean) => Effect.Effect<AppSettings>;
  readonly renameDefaultPromptTemplate: (
    oldName: string,
    newName: string | null,
  ) => Effect.Effect<AppSettings>;
  readonly setDisabledSkill: (name: string, disabled: boolean) => Effect.Effect<AppSettings>;
  readonly addExtension: (extPath: string) => Effect.Effect<AppSettings>;
  readonly removeExtension: (extPath: string) => Effect.Effect<AppSettings>;
  readonly setExtensionDisabled: (extPath: string, disabled: boolean) => Effect.Effect<AppSettings>;
  readonly setInjectedCommandDisabled: (
    id: string,
    disabled: boolean,
  ) => Effect.Effect<AppSettings>;
  readonly setLibraryCommandEnabled: (id: string, enabled: boolean) => Effect.Effect<AppSettings>;
  readonly addCodexPluginSkillRefs: (
    refs: readonly CodexPluginSkillRef[],
  ) => Effect.Effect<AppSettings>;
  readonly removeCodexPluginSkillRef: (ref: CodexPluginSkillRef) => Effect.Effect<AppSettings>;
  readonly addExternalPromptPath: (promptPath: string) => Effect.Effect<AppSettings>;
  readonly removeExternalPromptPath: (promptPath: string) => Effect.Effect<AppSettings>;
  readonly setBuiltinPromptDisabled: (
    name: string,
    disabled: boolean,
  ) => Effect.Effect<AppSettings>;
  readonly setModelDisabled: (key: string, disabled: boolean) => Effect.Effect<AppSettings>;
  readonly setModelFastMode: (key: string, enabled: boolean) => Effect.Effect<AppSettings>;
  readonly enabledExtensions: Effect.Effect<string[]>;
  readonly forgetSkill: (name: string) => Effect.Effect<AppSettings>;
  readonly renameSkill: (oldName: string, newName: string) => Effect.Effect<AppSettings>;
  readonly setProjectRoot: (root: string, present: boolean) => Effect.Effect<AppSettings>;
}

// ---------------------------------------------------------------------------
// 2. `make*` effects (context-free — a data dir is all a handle needs)
// ---------------------------------------------------------------------------

/**
 * Build one JSON-array store handle. Reads the file on construction (missing or
 * corrupt → empty), keeps the items in closure-scoped state, and flushes with a
 * tmp + rename atomic write — byte-identical to the legacy `JsonArrayStore`.
 */
export const makeJsonArrayStoreHandle = <T extends { id: string }>(
  dataDir: string,
  fileName: string,
  normalizeItem: (item: T) => T = (item) => item,
): Effect.Effect<JsonArrayStoreHandle<T>> =>
  Effect.sync(() => {
    const file = path.join(dataDir, fileName);
    mkdirSync(dataDir, { recursive: true });
    let items: T[] = [];
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (Array.isArray(parsed)) items = (parsed as T[]).map(normalizeItem);
    } catch {
      // Missing or corrupt index — start fresh.
    }

    const flush = (nextItems: readonly T[]): void => {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(nextItems, null, 2));
      renameSync(tmp, file);
    };

    return {
      list: Effect.sync(() => items),
      find: (predicate) => Effect.sync(() => Option.fromNullable(items.find(predicate))),
      upsert: (item) =>
        Effect.sync(() => {
          const nextItems = [...items];
          const index = nextItems.findIndex((existing) => existing.id === item.id);
          if (index === -1) nextItems.push(item);
          else nextItems[index] = item;
          // Commit in-memory authorization only after the atomic disk write wins.
          flush(nextItems);
          items = nextItems;
        }),
      remove: (id) =>
        Effect.sync(() => {
          const index = items.findIndex((existing) => existing.id === id);
          if (index === -1) return false;
          const nextItems = items.filter((_, itemIndex) => itemIndex !== index);
          flush(nextItems);
          items = nextItems;
          return true;
        }),
    } satisfies JsonArrayStoreHandle<T>;
  });

/**
 * A JSON store keyed by string → array of records (Slice 18a: the per-session
 * checkpoint index, `{ [sessionId]: CheckpointRecord[] }`). Reads the file on
 * construction (missing or corrupt → empty), keeps the map in closure-scoped
 * state, and flushes with the SAME atomic tmp + rename write as the array store.
 * A sibling to {@link makeJsonArrayStoreHandle} for records that are grouped by
 * an owner key rather than carrying their own `id`.
 */
export interface KeyedJsonStoreHandle<T> {
  /** All records under `key` (empty when the key is absent). */
  readonly get: (key: string) => Effect.Effect<T[]>;
  /** The full map (a snapshot copy — safe for the caller to iterate). */
  readonly all: Effect.Effect<Record<string, T[]>>;
  /** Replace every record under `key`, then atomically flush. An empty array
   * removes the key entirely so the file never accretes empty buckets. */
  readonly set: (key: string, values: T[]) => Effect.Effect<void>;
  /** Drop a key entirely; resolves to whether anything was removed. */
  readonly deleteKey: (key: string) => Effect.Effect<boolean>;
}

/**
 * Build one keyed JSON-record store handle at `path.join(dataDir, ...relPath)`,
 * creating the containing directory. `relPath` is a segment list so callers can
 * nest the store (the checkpoint index lives at `checkpoints/index.json`).
 */
export const makeKeyedJsonStoreHandle = <T>(
  dataDir: string,
  relPath: readonly string[],
): Effect.Effect<KeyedJsonStoreHandle<T>> =>
  Effect.sync(() => {
    const file = path.join(dataDir, ...relPath);
    mkdirSync(path.dirname(file), { recursive: true });
    let map: Record<string, T[]> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        map = {};
        for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (Array.isArray(value)) map[key] = value as T[];
        }
      }
    } catch {
      // Missing or corrupt index — start fresh.
    }

    const flush = (): void => {
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(map, null, 2));
      renameSync(tmp, file);
    };

    return {
      get: (key) => Effect.sync(() => (map[key] ? [...map[key]] : [])),
      all: Effect.sync(() => {
        const copy: Record<string, T[]> = {};
        for (const [key, value] of Object.entries(map)) copy[key] = [...value];
        return copy;
      }),
      set: (key, values) =>
        Effect.sync(() => {
          if (values.length === 0) delete map[key];
          else map[key] = [...values];
          flush();
        }),
      deleteKey: (key) =>
        Effect.sync(() => {
          if (!(key in map)) return false;
          delete map[key];
          flush();
          return true;
        }),
    } satisfies KeyedJsonStoreHandle<T>;
  });

/**
 * Build the app-settings store handle. The per-field load validation, defaults,
 * atomic membership ops, and tmp + rename format remain compatible with the
 * legacy `SettingsStore`. The one intentional migration is the eager durable
 * semantic-preference seed described below.
 */
export const makeSettingsStoreHandle = (dataDir: string): Effect.Effect<SettingsStoreHandle> =>
  Effect.sync(() => {
    const file = path.join(dataDir, "app-settings.json");
    mkdirSync(dataDir, { recursive: true });

    const legacySemanticSeedRequested = process.env.AGENT_DECK_SEMANTIC_MEMORY === "1";
    const settingsFileExists = existsSync(file);
    let semanticMemoryPreferenceWasPersisted = false;
    // Seed a missing file eagerly. Existing bytes are eligible only after they
    // parse as an object lacking the field; corrupt/non-object evidence must be
    // left untouched and fail closed.
    let persistLegacySemanticSeed = legacySemanticSeedRequested && !settingsFileExists;
    let settings: AppSettings = {
      defaultSkills: [],
      defaultMcpServers: [],
      mcpEnabled: true,
      defaultPromptTemplates: [],
      disabledSkills: [],
      projectRoots: [],
      extensions: [],
      disabledExtensions: [],
      disabledInjectedCommandIDs: [],
      enabledLibraryCommandIDs: [],
      disabledModels: [],
      openAIFastModels: [],
      autoTitle: true, // native default: sessions are auto-titled by the helper
      agentMemoryEnabled: true,
      agentMemoryInjectionCharacterBudget: 6000,
      // Native default: delegated agents receive project memory context.
      agentMemorySubagentsEnabled: true,
      semanticMemoryEnabled: persistLegacySemanticSeed,
      piAgentIdleParkingEnabled: true,
      piAgentIdleParkingTimeoutMinutes: 10,
      worktreeIsolation: false,
      keepWorktreeAfterMerge: true,
      gitAutomation: true, // native piAgentGitAutomationEnabled default: git actions shown
      defaultModel: null,
      defaultThinking: null,
      extensionLoadingMode: "useMyExtensions", // port default: load discovered extensions
      codexPluginSkillRefs: [],
      externalPromptPaths: [],
      disabledBuiltinPromptNames: [],
      preferredEditor: null,
      piAgentTranscriptVisibility: { ...DEFAULT_TRANSCRIPT_VISIBILITY },
      keybindings: [],
    };

    try {
      const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Partial<AppSettings>;
        semanticMemoryPreferenceWasPersisted = Object.prototype.hasOwnProperty.call(
          record,
          "semanticMemoryEnabled",
        );
        persistLegacySemanticSeed =
          !semanticMemoryPreferenceWasPersisted && legacySemanticSeedRequested;
        settings = {
          defaultSkills: Array.isArray(record.defaultSkills)
            ? record.defaultSkills.map(String)
            : [],
          // Missing and malformed assignment fields safely grant no server.
          defaultMcpServers: coerceMcpAssignmentNames(record.defaultMcpServers),
          // The master policy is opt-out for both fresh and upgraded installs.
          mcpEnabled: typeof record.mcpEnabled === "boolean" ? record.mcpEnabled : true,
          defaultPromptTemplates: Array.isArray(record.defaultPromptTemplates)
            ? record.defaultPromptTemplates.map(String)
            : [],
          disabledSkills: Array.isArray(record.disabledSkills)
            ? record.disabledSkills.map(String)
            : [],
          projectRoots: Array.isArray(record.projectRoots) ? record.projectRoots.map(String) : [],
          extensions: Array.isArray(record.extensions) ? record.extensions.map(String) : [],
          disabledExtensions: Array.isArray(record.disabledExtensions)
            ? record.disabledExtensions.map(String)
            : [],
          disabledInjectedCommandIDs: coerceCommandIds(
            record.disabledInjectedCommandIDs,
            BUILT_IN_COMMAND_ID,
          ),
          enabledLibraryCommandIDs: coerceCommandIds(
            record.enabledLibraryCommandIDs,
            LIBRARY_COMMAND_ID,
          ),
          openAIFastModels: Array.isArray(record.openAIFastModels)
            ? record.openAIFastModels.map(String)
            : [],
          disabledModels: Array.isArray(record.disabledModels)
            ? record.disabledModels.map(String)
            : [],
          // Booleans default to the native defaults when absent/mistyped. The legacy
          // semantic env flag seeds only an absent field; malformed persisted values
          // fail closed instead of being re-enabled by the environment.
          autoTitle: typeof record.autoTitle === "boolean" ? record.autoTitle : true,
          // Pause is opt-out: legacy absence and malformed values both retain the
          // shipped enabled behavior. Only an explicit false pauses automation.
          agentMemoryEnabled:
            typeof record.agentMemoryEnabled === "boolean" ? record.agentMemoryEnabled : true,
          // Native decoding preserves manually persisted values above the UI
          // setter's 20,000 maximum, while enforcing the 1,000 minimum.
          agentMemoryInjectionCharacterBudget:
            typeof record.agentMemoryInjectionCharacterBudget === "number" &&
            Number.isInteger(record.agentMemoryInjectionCharacterBudget)
              ? Math.max(1_000, record.agentMemoryInjectionCharacterBudget)
              : 6_000,
          agentMemorySubagentsEnabled:
            typeof record.agentMemorySubagentsEnabled === "boolean"
              ? record.agentMemorySubagentsEnabled
              : true,
          semanticMemoryEnabled:
            typeof record.semanticMemoryEnabled === "boolean"
              ? record.semanticMemoryEnabled
              : semanticMemoryPreferenceWasPersisted
                ? false
                : legacySemanticSeedRequested,
          piAgentIdleParkingEnabled:
            typeof record.piAgentIdleParkingEnabled === "boolean"
              ? record.piAgentIdleParkingEnabled
              : true,
          piAgentIdleParkingTimeoutMinutes:
            typeof record.piAgentIdleParkingTimeoutMinutes === "number" &&
            Number.isInteger(record.piAgentIdleParkingTimeoutMinutes) &&
            record.piAgentIdleParkingTimeoutMinutes >= 1 &&
            record.piAgentIdleParkingTimeoutMinutes <= 120
              ? record.piAgentIdleParkingTimeoutMinutes
              : 10,
          worktreeIsolation:
            typeof record.worktreeIsolation === "boolean" ? record.worktreeIsolation : false,
          keepWorktreeAfterMerge:
            typeof record.keepWorktreeAfterMerge === "boolean"
              ? record.keepWorktreeAfterMerge
              : true,
          gitAutomation: typeof record.gitAutomation === "boolean" ? record.gitAutomation : true,
          defaultModel: typeof record.defaultModel === "string" ? record.defaultModel : null,
          defaultThinking:
            typeof record.defaultThinking === "string" &&
            (PI_THINKING_LEVELS as readonly string[]).includes(record.defaultThinking)
              ? (record.defaultThinking as ThinkingLevel)
              : null,
          extensionLoadingMode:
            record.extensionLoadingMode === "agentDeckManaged"
              ? "agentDeckManaged"
              : "useMyExtensions",
          codexPluginSkillRefs: coerceCodexPluginRefs(record.codexPluginSkillRefs),
          externalPromptPaths: Array.isArray(record.externalPromptPaths)
            ? record.externalPromptPaths.filter((p): p is string => typeof p === "string")
            : [],
          disabledBuiltinPromptNames: Array.isArray(record.disabledBuiltinPromptNames)
            ? record.disabledBuiltinPromptNames.filter((p): p is string => typeof p === "string")
            : [],
          preferredEditor:
            typeof record.preferredEditor === "string" ? record.preferredEditor : null,
          piAgentTranscriptVisibility: coerceTranscriptVisibility(
            record.piAgentTranscriptVisibility,
          ),
          keybindings: coerceKeybindings(record.keybindings),
        };
      } else {
        // A successfully parsed primitive/null is still invalid settings evidence.
        // Do not replace it with a legacy environment seed.
        persistLegacySemanticSeed = false;
        settings.semanticMemoryEnabled = false;
      }
    } catch {
      // A genuinely missing file may be seeded. Existing corrupt bytes are
      // preserved exactly and the preference fails closed.
      if (existsSync(file)) {
        persistLegacySemanticSeed = false;
        settings.semanticMemoryEnabled = false;
      }
    }

    let committedSettings = settings;
    let committedSemanticPreferenceWasPersisted = semanticMemoryPreferenceWasPersisted;
    const flush = (value: AppSettings = settings): void => {
      const tmp = `${file}.tmp`;
      // Fields newer than the oldest settings files stay absent when empty, keeping
      // untouched files byte-stable across load/save cycles.
      const persisted: Partial<AppSettings> = { ...value };
      if (value.defaultMcpServers.length === 0) delete persisted.defaultMcpServers;
      // Preserve untouched legacy bytes: absence is the enabled default.
      if (value.mcpEnabled === true) delete persisted.mcpEnabled;
      if (value.codexPluginSkillRefs.length === 0) delete persisted.codexPluginSkillRefs;
      if (value.externalPromptPaths.length === 0) delete persisted.externalPromptPaths;
      if (value.disabledBuiltinPromptNames.length === 0)
        delete persisted.disabledBuiltinPromptNames;
      if (value.disabledInjectedCommandIDs.length === 0)
        delete persisted.disabledInjectedCommandIDs;
      if (value.enabledLibraryCommandIDs.length === 0) delete persisted.enabledLibraryCommandIDs;
      // Keep legacy files byte-stable until the user departs from the shipped
      // parking defaults; absence means enabled/10 minutes on load.
      if (value.piAgentIdleParkingEnabled === true) delete persisted.piAgentIdleParkingEnabled;
      if (value.piAgentIdleParkingTimeoutMinutes === 10)
        delete persisted.piAgentIdleParkingTimeoutMinutes;
      // Absence is the shipped enabled state, preserving legacy settings bytes.
      // Persist only the user's explicit pause.
      if (value.agentMemoryEnabled === true) delete persisted.agentMemoryEnabled;
      if (value.agentMemoryInjectionCharacterBudget === 6000)
        delete persisted.agentMemoryInjectionCharacterBudget;
      if (value.agentMemorySubagentsEnabled === true) delete persisted.agentMemorySubagentsEnabled;
      // Omit only the untouched shipped false default. Once the user explicitly
      // chooses a value, retain false too: it must continue to override a legacy
      // AGENT_DECK_SEMANTIC_MEMORY=1 environment after restart.
      if (!semanticMemoryPreferenceWasPersisted && value.semanticMemoryEnabled === false) {
        delete persisted.semanticMemoryEnabled;
      }
      try {
        writeFileSync(tmp, JSON.stringify(persisted, null, 2));
        renameSync(tmp, file);
      } catch (error) {
        // Mutators historically assign their candidate before calling flush.
        // Restore the last durable snapshot so a failed write cannot change live
        // authorization/preferences while the route reports failure.
        settings = committedSettings;
        semanticMemoryPreferenceWasPersisted = committedSemanticPreferenceWasPersisted;
        throw error;
      }
      settings = value;
      committedSettings = value;
      committedSemanticPreferenceWasPersisted = semanticMemoryPreferenceWasPersisted;
    };

    if (persistLegacySemanticSeed) {
      // Complete the migration during construction, before callers can observe
      // an environment-only value. Future launches read this persisted true even
      // after the legacy environment variable is removed.
      semanticMemoryPreferenceWasPersisted = true;
      flush();
    }

    return {
      get: Effect.sync(() => settings),
      update: (patch) =>
        Effect.sync(() => {
          if (patch.semanticMemoryEnabled !== undefined) {
            semanticMemoryPreferenceWasPersisted = true;
          }
          settings = { ...settings, ...patch };
          flush();
          return settings;
        }),
      setDefaultSkill: (name, enabled) =>
        Effect.sync(() => {
          const next = new Set(settings.defaultSkills);
          if (enabled) next.add(name);
          else next.delete(name);
          settings = { ...settings, defaultSkills: [...next] };
          flush();
          return settings;
        }),
      setDefaultMcpServer: (name, enabled) =>
        Effect.sync(() => {
          const next = new Set(settings.defaultMcpServers);
          if (enabled) next.add(name);
          else next.delete(name);
          const nextSettings = { ...settings, defaultMcpServers: [...next] };
          // The live authorization snapshot changes only after persistence succeeds.
          flush(nextSettings);
          settings = nextSettings;
          return settings;
        }),
      setDefaultPromptTemplate: (name, enabled) =>
        Effect.sync(() => {
          const next = new Set(settings.defaultPromptTemplates);
          if (enabled) next.add(name);
          else next.delete(name);
          settings = { ...settings, defaultPromptTemplates: [...next] };
          flush();
          return settings;
        }),
      renameDefaultPromptTemplate: (oldName, newName) =>
        Effect.sync(() => {
          const next = new Set(settings.defaultPromptTemplates);
          if (!next.has(oldName)) return settings;
          next.delete(oldName);
          if (newName !== null) next.add(newName);
          settings = { ...settings, defaultPromptTemplates: [...next] };
          flush();
          return settings;
        }),
      setDisabledSkill: (name, disabled) =>
        Effect.sync(() => {
          const next = new Set(settings.disabledSkills);
          if (disabled) next.add(name);
          else next.delete(name);
          // A disabled skill can't also be a default.
          const defaults = new Set(settings.defaultSkills);
          if (disabled) defaults.delete(name);
          settings = {
            ...settings,
            defaultSkills: [...defaults],
            disabledSkills: [...next],
          };
          flush();
          return settings;
        }),
      addExtension: (extPath) =>
        Effect.sync(() => {
          const next = new Set(settings.extensions);
          next.add(extPath);
          settings = { ...settings, extensions: [...next] };
          flush();
          return settings;
        }),
      removeExtension: (extPath) =>
        Effect.sync(() => {
          settings = {
            ...settings,
            extensions: settings.extensions.filter((p) => p !== extPath),
            disabledExtensions: settings.disabledExtensions.filter((p) => p !== extPath),
          };
          flush();
          return settings;
        }),
      setExtensionDisabled: (extPath, disabled) =>
        Effect.sync(() => {
          const next = new Set(settings.disabledExtensions);
          if (disabled) next.add(extPath);
          else next.delete(extPath);
          settings = { ...settings, disabledExtensions: [...next] };
          flush();
          return settings;
        }),
      setInjectedCommandDisabled: (id, disabled) =>
        Effect.sync(() => {
          const next = new Set(
            coerceCommandIds(settings.disabledInjectedCommandIDs, BUILT_IN_COMMAND_ID),
          );
          if (BUILT_IN_COMMAND_ID.test(id)) {
            if (disabled && next.size < MAX_INJECTED_COMMAND_IDS) next.add(id);
            else if (!disabled) next.delete(id);
          }
          settings = { ...settings, disabledInjectedCommandIDs: [...next] };
          flush();
          return settings;
        }),
      setLibraryCommandEnabled: (id, enabled) =>
        Effect.sync(() => {
          const next = new Set(
            coerceCommandIds(settings.enabledLibraryCommandIDs, LIBRARY_COMMAND_ID),
          );
          if (LIBRARY_COMMAND_ID.test(id)) {
            if (enabled && next.size < MAX_INJECTED_COMMAND_IDS) next.add(id);
            else if (!enabled) next.delete(id);
          }
          settings = { ...settings, enabledLibraryCommandIDs: [...next] };
          flush();
          return settings;
        }),
      addCodexPluginSkillRefs: (refs) =>
        Effect.sync(() => {
          const seen = new Set(settings.codexPluginSkillRefs.map(refKey));
          const additions = refs.filter((ref) => {
            if (seen.has(refKey(ref))) return false;
            seen.add(refKey(ref));
            return true;
          });
          if (additions.length === 0) return settings;
          settings = {
            ...settings,
            codexPluginSkillRefs: [...settings.codexPluginSkillRefs, ...additions],
          };
          flush();
          return settings;
        }),
      removeCodexPluginSkillRef: (ref) =>
        Effect.sync(() => {
          settings = {
            ...settings,
            codexPluginSkillRefs: settings.codexPluginSkillRefs.filter(
              (item) => refKey(item) !== refKey(ref),
            ),
          };
          flush();
          return settings;
        }),
      addExternalPromptPath: (promptPath) =>
        Effect.sync(() => {
          // membership is by FILESYSTEM identity: Windows paths are case-insensitive,
          // so two casings of one file must never mint two references (review, Codex)
          const key = externalPathKey(promptPath);
          if (settings.externalPromptPaths.some((p) => externalPathKey(p) === key)) {
            return settings;
          }
          settings = {
            ...settings,
            externalPromptPaths: [...settings.externalPromptPaths, promptPath],
          };
          flush();
          return settings;
        }),
      removeExternalPromptPath: (promptPath) =>
        Effect.sync(() => {
          const key = externalPathKey(promptPath);
          settings = {
            ...settings,
            externalPromptPaths: settings.externalPromptPaths.filter(
              (p) => externalPathKey(p) !== key,
            ),
          };
          flush();
          return settings;
        }),
      setBuiltinPromptDisabled: (name, disabled) =>
        Effect.sync(() => {
          const next = new Set(settings.disabledBuiltinPromptNames);
          if (disabled) next.add(name);
          else next.delete(name);
          settings = { ...settings, disabledBuiltinPromptNames: [...next] };
          flush();
          return settings;
        }),
      setModelDisabled: (key, disabled) =>
        Effect.sync(() => {
          const next = new Set(settings.disabledModels);
          if (disabled) next.add(key);
          else next.delete(key);
          settings = { ...settings, disabledModels: [...next] };
          flush();
          return settings;
        }),
      // SES-34. Eligibility is NOT re-checked here: the route that calls this
      // owns that rule, and the config writer drops anything ineligible before
      // the extension ever sees it, so a stale stored key cannot upgrade a
      // request.
      setModelFastMode: (key, enabled) =>
        Effect.sync(() => {
          const next = new Set(settings.openAIFastModels);
          if (enabled) next.add(key);
          else next.delete(key);
          settings = { ...settings, openAIFastModels: [...next] };
          flush();
          return settings;
        }),
      enabledExtensions: Effect.sync(() => {
        const disabled = new Set(settings.disabledExtensions);
        return settings.extensions.filter((p) => !disabled.has(p));
      }),
      forgetSkill: (name) =>
        Effect.sync(() => {
          settings = {
            ...settings,
            defaultSkills: settings.defaultSkills.filter((s) => s !== name),
            disabledSkills: settings.disabledSkills.filter((s) => s !== name),
          };
          flush();
          return settings;
        }),
      renameSkill: (oldName, newName) =>
        Effect.sync(() => {
          const swap = (list: string[]): string[] => {
            const next = list.map((s) => (s === oldName ? newName : s));
            return [...new Set(next)]; // collapse a dup if newName was already present
          };
          settings = {
            ...settings,
            defaultSkills: swap(settings.defaultSkills),
            disabledSkills: swap(settings.disabledSkills),
          };
          flush();
          return settings;
        }),
      setProjectRoot: (root, present) =>
        Effect.sync(() => {
          const next = new Set(settings.projectRoots);
          if (present) next.add(root);
          else next.delete(root);
          settings = { ...settings, projectRoots: [...next] };
          flush();
          return settings;
        }),
    } satisfies SettingsStoreHandle;
  });

// ---------------------------------------------------------------------------
// 3. Service tag (factory — stores are opened per data dir) + 4. Live layer
// ---------------------------------------------------------------------------

export interface PersistenceShape {
  /** Open the sessions index (sessions.json) under `dataDir`. */
  readonly openSessionIndex: (dataDir?: string) => Effect.Effect<SessionIndexHandle>;
  /** Open the projects index (projects.json) under `dataDir`. */
  readonly openProjectIndex: (dataDir?: string) => Effect.Effect<ProjectIndexHandle>;
  /** Open the app-settings store (app-settings.json) under `dataDir`. */
  readonly openSettingsStore: (dataDir?: string) => Effect.Effect<SettingsStoreHandle>;
}

/**
 * Persistence service (t3code's Services/ role): the leaf that opens the app's
 * JSON stores. A FACTORY (like SessionPushBuses) rather than one global handle,
 * since a store is bound to a data dir — servers under different data dirs (tests)
 * open their own.
 */
export class Persistence extends Context.Tag("agent-deck/server/services/Persistence")<
  Persistence,
  PersistenceShape
>() {}

export const PersistenceLive = Layer.succeed(Persistence, {
  openSessionIndex: (dataDir = defaultDataDir()) =>
    makeJsonArrayStoreHandle<SessionMeta>(dataDir, "sessions.json", (session) => {
      const normalized = {
        ...session,
        ...(session.needsAttention === undefined
          ? {}
          : { needsAttention: session.needsAttention === true }),
      };
      if (
        typeof normalized.parkedAt !== "string" ||
        Number.isNaN(Date.parse(normalized.parkedAt)) ||
        normalized.endedAt !== undefined
      ) {
        delete normalized.parkedAt;
      }
      return normalized;
    }),
  openProjectIndex: (dataDir = defaultDataDir()) =>
    makeJsonArrayStoreHandle<ProjectMeta>(dataDir, "projects.json"),
  openSettingsStore: (dataDir = defaultDataDir()) => makeSettingsStoreHandle(dataDir),
});
