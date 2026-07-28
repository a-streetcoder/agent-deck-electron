/**
 * Typed contract for the shared skill engine's NAPI addon
 * (`@syncr/skill-engine-native`, built in the Syncr repo — Syncr ADR-0004; handover
 * `Syncr/docs/handover-agent-deck-p3.md`).
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
 * The addon is not resolvable yet (distribution TBD with the Syncr team). `EngineSkillStore`
 * depends on THIS interface, not the concrete module, so it compiles and unit-tests against
 * an injected fake now; `loadSkillEngineNative()` binds the real addon once the consumption
 * path is set.
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
 * Resolve the native addon. The addon is loaded across the same candidate ladder
 * `loop-catalog-native` uses (env override → package `native/` → cwd workspace → Electron
 * `resourcesPath`) — that resolution lives in the addon's own loader once the package is
 * consumable. Until the Syncr team and we settle distribution (git pin / published npm /
 * local path), this throws a clear, actionable error rather than a module-not-found.
 */
export function loadSkillEngineNative(): SkillEngineNative {
  throw new Error(
    "skill engine addon not wired yet: @syncr/skill-engine-native is built in the Syncr repo " +
      "but its consumption path (git pin / npm / local link) is not set. See " +
      "docs/skill-store-contract.md and Syncr/docs/handover-agent-deck-p3.md.",
  );
}
