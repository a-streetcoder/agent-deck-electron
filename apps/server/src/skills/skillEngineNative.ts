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

import type { SkillInfo } from "@agent-deck/domain";

/** Writable catalog scope, matching agent-deck's `SkillScope`. */
export type EngineSkillScope = "global" | "library" | "project";

/** A recoverable displaced tree (engine shape; maps to agent-deck's `ResourceRecovery`
 *  as `{ token, skillName: slug }`). */
export interface RecoveryInfo {
  token: string;
  slug: string;
  path: string;
}

/** One skill's upstream drift. `kind` is `"added" | "changed" | "removed"`. */
export interface GitDelta {
  name: string;
  kind: string;
}

export interface GitImportResult {
  collectionId: string;
  skills: string[];
}

/** One discoverable skill in a repository preview (SKL-03). `skillMd` is the SKILL.md content
 *  (engine-capped at 64 KB) so the host derives display name/description with the pinned Pi
 *  frontmatter parser; absent when the skill has no SKILL.md at its root. */
export interface GitSkillPreview {
  name: string;
  fileCount: number;
  skillMd?: string;
}

export interface GitInspectResult {
  collectionId: string;
  skills: GitSkillPreview[];
}

export interface GitSyncResult {
  applied: string[];
  conflicts: string[];
}

export interface GitRepoInfo {
  collectionId: string;
  url: string;
  gitRef?: string;
  subpath?: string;
  scope: string;
  skills: string[];
}

/** One path both sides moved. Kinds are `"file" | "directory" | "missing"`. */
export interface GitPathConflict {
  path: string;
  localKind: string;
  remoteKind: string;
}

/** Per-path conflict detail for one skill, plus the `mergeId` that identifies this presentation. */
export interface GitConflictDetail {
  mergeId: string;
  paths: GitPathConflict[];
}

/** One caller decision. `resolution` is `"mine" | "remote"`; omitted paths default to `"mine"`. */
export interface GitPathChoice {
  path: string;
  resolution: "mine" | "remote";
}

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

  // ── Recovery (engine store; `RecoveryInfo`, not agent-deck's `ResourceRecovery`) ──
  listRecoveries(root: string): RecoveryInfo[];
  /** Restore a displaced tree; returns the restored path. */
  restoreRecovery(root: string, token: string): string;
  acknowledgeRecovery(root: string, token: string): void;

  // ── Git-repo collections (0.1.5; retires agent-deck's managedSkillRepositories) ──
  /** Import a git repo as a managed, re-syncable collection; skills land in the ordinary
   *  catalogs. All-or-nothing. */
  importGitRepo(
    home: string,
    projectRoot: string | undefined,
    scope: EngineSkillScope,
    url: string,
    gitRef: string | undefined,
    subpath: string | undefined,
    /** SKL-04 (0.1.6): import only these skills; the selection persists engine-side — later
     *  check/sync never surface or materialize an upstream skill outside it. Omit = full. */
    selected: string[] | undefined,
  ): GitImportResult;
  /** Preview a repo BEFORE importing (SKL-03, 0.1.6): clone + discover, materialize nothing.
   *  The clone stays cached so a following `importGitRepo` imports exactly what was shown;
   *  empty `skills` = no SKILL.md anywhere (the preview cleans itself up). Refuses an
   *  already-imported url/ref/subpath. */
  inspectGitRepo(
    home: string,
    url: string,
    gitRef: string | undefined,
    subpath: string | undefined,
  ): GitInspectResult;
  /** Remove an unconfirmed preview (user cancelled). Idempotent; refuses an imported
   *  collection (that is `forgetGitRepo`'s job). (0.1.6) */
  discardGitPreview(home: string, collectionId: string): void;
  /** Preview upstream drift; fetches, writes nothing. */
  checkGitRepo(home: string, collectionId: string): GitDelta[];
  /** Pull + apply one-sided (three-way-merged) changes; both-sides motion → `conflicts`. */
  syncGitRepo(home: string, projectRoot: string | undefined, collectionId: string): GitSyncResult;
  /** Per-path conflict detail for one conflicted skill. Refuses RESOURCE_NOT_FOUND for a
   *  collection with no base snapshot (a 0.1.4 import) — use the whole-skill form there. */
  conflictPaths(
    home: string,
    projectRoot: string | undefined,
    collectionId: string,
    name: string,
  ): GitConflictDetail;
  /** Settle a whole conflicted skill in one direction; re-establishes a base snapshot. */
  resolveGitConflict(
    home: string,
    projectRoot: string | undefined,
    collectionId: string,
    name: string,
    resolution: "remote" | "local",
  ): RecoveryInfo[];
  /** Settle a conflicted skill per path. `mergeId` must be the one `conflictPaths` returned;
   *  a stale mergeId refuses RESOURCE_STALE. */
  resolveGitConflictPaths(
    home: string,
    projectRoot: string | undefined,
    collectionId: string,
    name: string,
    mergeId: string,
    choices: GitPathChoice[],
  ): RecoveryInfo[];
  /** Forget a collection; `removeSkills` displaces (recoverable), never hard-deletes. */
  forgetGitRepo(
    home: string,
    projectRoot: string | undefined,
    collectionId: string,
    removeSkills: boolean,
  ): void;
  /** Every imported collection under `home`. */
  listGitRepos(home: string): GitRepoInfo[];
}

/**
 * Resolve the native addon, mirroring how `loop-catalog-native` is loaded:
 *
 * 1. **Packaged Electron** — the platform `.node` is staged into `resources/skill-engine-native/`
 *    by `build-backend.mjs` + electron-builder `extraResources`; require it directly via
 *    `process.resourcesPath`. The bundled server can't resolve the private package from inside
 *    app.asar, so a bare import fails there.
 * 2. **Env override** — `AGENT_DECK_SKILL_ENGINE_NATIVE_PATH` for hermetic/dev runs.
 * 3. **Dev / tests** — resolve `@a-streetcoder/skill-engine-native/native` from node_modules (the
 *    widened specifier keeps `tsc` from statically resolving it before the dep is installed).
 *
 * A missing addon throws a clear, actionable error rather than a raw module-not-found.
 */
export async function loadSkillEngineNative(): Promise<SkillEngineNative> {
  const { existsSync, readdirSync } = await import("node:fs");
  const nodePath = (await import("node:path")).default;
  const { createRequire } = await import("node:module");
  const req = createRequire(import.meta.url);

  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  const stagedDir = resourcesPath ? nodePath.join(resourcesPath, "skill-engine-native") : undefined;
  const stagedBinary =
    stagedDir && existsSync(stagedDir)
      ? readdirSync(stagedDir)
          .map((entry) => nodePath.join(stagedDir, entry))
          .find((candidate) => candidate.endsWith(".node"))
      : undefined;
  const override = process.env.AGENT_DECK_SKILL_ENGINE_NATIVE_PATH?.trim() || undefined;

  for (const candidate of [override, stagedBinary]) {
    if (candidate && existsSync(candidate)) {
      // A NAPI `.node` exports the surface directly (the meta package's loader only picks the
      // right binary, which we've already done).
      return req(candidate) as SkillEngineNative;
    }
  }

  try {
    const specifier: string = "@a-streetcoder/skill-engine-native/native";
    const mod = (await import(specifier)) as {
      default?: SkillEngineNative;
    } & Partial<SkillEngineNative>;
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
