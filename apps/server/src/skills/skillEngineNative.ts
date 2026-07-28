/**
 * Typed contract for the shared skill engine's NAPI addon
 * (`@a-streetcoder/skill-engine-native`, built in the Syncr repo — Syncr ADR-0004;
 * handover `Syncr/docs/handover-agent-deck-p3.md`). Published privately to GitHub
 * Packages under the `@a-streetcoder` scope (it must match the repo owner). Two entry
 * points: `@a-streetcoder/skill-engine-native` is the typed soft-loading surface;
 * `@a-streetcoder/skill-engine-native/native` is the raw ESM binding. A build-time token
 * installs it; end users never need one.
 *
 * agent-deck consumes the engine for WRITES + versioning + fan-out + recovery. It does
 * NOT consume the engine's `listSkills` reader — that is for Syncr's Tauri app, which has
 * no pi loader; agent-deck keeps its own pi-shaped scanner (see `EngineSkillStore`). The
 * `listSkills` method is included here for completeness but is unused by the store.
 *
 * Root parameters carry the FULL root set (home + optional projectRoot) plus a `scope`
 * string that bounds which catalog may be touched — per the handover's write-target
 * resolution: a write lands in the catalog the reader actually reads (possibly a `.pi`
 * catalog during the migration window), while `scope` bounds the search. Mutations must
 * NOT resolve unconditionally to the canonical catalog.
 *
 * The package is consumable (tarball today; tagged GitHub Packages release wiring landed).
 * `EngineSkillStore` still depends on THIS interface, not the concrete module, so it
 * compiles and unit-tests against an injected fake; `loadSkillEngineNative()` binds the real
 * addon once the dependency is installed into the workspace.
 */

import type { ResourceRecovery } from "@agent-deck/resources";
import type { SkillInfo } from "@agent-deck/domain";

/** Writable catalog scope, matching agent-deck's `SkillScope`. */
export type EngineSkillScope = "global" | "library" | "project";

/**
 * The engine addon surface. Errors are thrown as `Error` whose message is prefixed with
 * a `RESOURCE_*` code (NAPI has no structured error channel); `EngineSkillStore` maps
 * that back to `ResourceCatalogCapabilityError` so the routes keep their HTTP mapping.
 */
export interface SkillEngineNative {
  /** For the Tauri host only — agent-deck reads via its own scanner. */
  listSkills(home: string, projectRoot: string | undefined, libraryRoots: string[]): SkillInfo[];

  /** Create/overwrite a skill; returns the SKILL.md path. */
  writeSkill(
    home: string,
    projectRoot: string | undefined,
    scope: EngineSkillScope,
    name: string,
    description: string | undefined,
    body: string | undefined,
  ): string;

  deleteSkill(
    home: string,
    projectRoot: string | undefined,
    scope: EngineSkillScope,
    name: string,
  ): void;

  /** Rename a skill; returns the new SKILL.md path. */
  renameSkill(
    home: string,
    projectRoot: string | undefined,
    scope: EngineSkillScope,
    name: string,
    newName: string,
  ): string;

  /** Import a local skill file/dir; returns the SKILL.md path. */
  importLocalSkill(
    home: string,
    projectRoot: string | undefined,
    scope: EngineSkillScope,
    sourcePath: string,
  ): string;

  /** Project canonical `<root>/.agents/skills/<slug>` → the tool dirs it was linked into. */
  fanOut(root: string, slug: string): string[];

  listRecoveries(root: string): ResourceRecovery[];
  restoreRecovery(root: string, token: string): ResourceRecovery;
  acknowledgeRecovery(root: string, token: string): void;
}

/**
 * Resolve the native addon from `@a-streetcoder/skill-engine-native/native` (the raw ESM
 * binding; the package's own loader handles the `.node` candidate ladder). Kept as a soft
 * dynamic import so this workspace still builds before the dependency is installed — a
 * missing package throws a clear, actionable error rather than a hard module-not-found at
 * load time. Wired into `EngineSkillStore` in `server.ts` once the dependency is added.
 */
export async function loadSkillEngineNative(): Promise<SkillEngineNative> {
  try {
    // A widened (`: string`) specifier keeps `tsc` from statically resolving the module,
    // so the workspace still builds before the optional dependency is installed.
    const specifier: string = "@a-streetcoder/skill-engine-native/native";
    const mod = (await import(specifier)) as {
      default?: SkillEngineNative;
    } & Partial<SkillEngineNative>;
    // The binding may expose the surface as the default export or as named exports.
    return (mod.default ?? (mod as unknown as SkillEngineNative)) satisfies SkillEngineNative;
  } catch (cause) {
    throw new Error(
      "skill engine addon unavailable: install `@a-streetcoder/skill-engine-native` " +
        "(published privately to GitHub Packages under the @a-streetcoder scope; a build-time " +
        "token is required to install, not to run). See docs/skill-store-contract.md and " +
        "Syncr/docs/handover-agent-deck-p3.md.",
      { cause },
    );
  }
}
