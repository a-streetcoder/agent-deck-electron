/**
 * SkillStore — the consolidation seam (ADR-0002 P1b; Syncr ADR-0004).
 *
 * One interface in front of agent-deck's skill catalog + authoring + versioning.
 * Today it is implemented by `NativeSkillStore` (a thin adapter over
 * `@agent-deck/resources` + `loop-catalog-native`). Later the same interface is
 * implemented by the shared, Syncr-owned skill engine (embedded via NAPI), so the
 * swap is a one-line binding change — consumers depend on THIS, not on the concrete
 * functions.
 *
 * Scope. This seam owns the **single-user, local** skill lifecycle that is stable
 * and cleanly separable today: catalog read, authoring (create/edit/delete/rename),
 * local file import, content-version snapshot, and recovery. It deliberately does
 * NOT cover:
 *   - agent-deck RUNTIME — skill *assignment* (default/project/disabled → explicit
 *     `--skill` paths to Pi per session), Loops, session worktrees. These stay in
 *     agent-deck (they were never skill-store) and are out of this interface.
 *   - REPO SYNC — importing an arbitrary GitHub repo and re-syncing a tracked
 *     upstream (`/resources/skills/import-git`, `/resources/skill-repos/:id/*`).
 *     That logic (clone → discover → sanitize untrusted tree → 3-way merge) is the
 *     part that MOVES INTO the shared engine (Syncr ADR-0004). It stays inline in
 *     its route handlers for now and will be adopted through this seam when the
 *     engine lands (ADR-0002 P3) — deliberately not force-extracted here.
 *
 * `projectId` (agent-deck's identifier, resolved to catalog roots by the host) is
 * used rather than a raw path, matching how the rest of the server addresses skills.
 */

import type { ResourceRecovery } from "@agent-deck/resources";
import type { SkillInfo } from "@agent-deck/domain";
import type {
  GitConflictDetail,
  GitDelta,
  GitImportResult,
  GitInspectResult,
  GitPathChoice,
  GitRepoInfo,
  GitSyncResult,
} from "./skillEngineNative.ts";

/** Writable catalog scope for a skill mutation (matches the resources
 *  `WritableScope`: skills are global or project; `library` is accepted for
 *  parity but built-in skills are not user-writable). */
export type SkillScope = "global" | "library" | "project";

/** Edit payload for creating/updating a skill's SKILL.md. */
export interface SkillEdit {
  description?: string;
  body?: string;
}

/**
 * The stable, single-user skill lifecycle — transport-agnostic. Every operation
 * works offline; a cloud-sync layer, when present, composes around an implementation
 * of this interface rather than being part of the contract.
 */
export interface SkillStore {
  // ── Catalog (read) ──────────────────────────────────────────────────────────
  /** Skills visible for a project (global + project scope). Maps: `scanSkills`. */
  listSkills(projectId?: string): SkillInfo[];

  // ── Authoring (write) ────────────────────────────────────────────────────────
  /** Create/overwrite a skill's SKILL.md; returns its path. Maps: `writeSkillFile`. */
  writeSkill(scope: SkillScope, name: string, edit: SkillEdit, projectId?: string): string;
  /** Delete a skill directory. Maps: `deleteSkillDir`. */
  deleteSkill(scope: SkillScope, name: string, projectId?: string): void;
  /** Rename a skill directory; returns the new path. Maps: `renameSkillDir`. */
  renameSkill(scope: SkillScope, name: string, newName: string, projectId?: string): string;
  /** Import a single local `.md` skill file; returns its path. Maps: `importSkillFile`. */
  importLocalSkill(scope: SkillScope, sourcePath: string, projectId?: string): string;

  // ── Recovery (engine store — displaced trees from edits + git-conflict resolution) ──
  listRecoveries(): ResourceRecovery[];
  restoreRecovery(token: string): ResourceRecovery;
  acknowledgeRecovery(token: string): void;
  /** Filesystem path of a recovery's displaced tree (desktop trash integration). */
  recoveryPath(token: string): string;

  // ── Git-repo collections (managed skill repositories) ────────────────────────
  // The engine clones, discovers, sanitizes, and materializes into the ordinary catalogs.
  // Collections are GLOBAL (the UI only imports at global scope); state lives engine-side.
  /** Import a git repo as a managed collection. `url` is the resolved clone URL. `selected`
   *  (SKL-04) imports only those skills; the selection persists engine-side. */
  importGitRepo(url: string, ref?: string, subpath?: string, selected?: string[]): GitImportResult;
  /** Preview a repo BEFORE importing (SKL-03): clone + discover, materialize nothing; the
   *  clone stays cached so the following import matches what was shown. */
  inspectGitRepo(url: string, ref?: string, subpath?: string): GitInspectResult;
  /** Remove an unconfirmed preview (user cancelled). Idempotent. */
  discardGitPreview(collectionId: string): void;
  /** Every imported collection. */
  listGitRepos(): GitRepoInfo[];
  /** Preview upstream drift; writes nothing. */
  checkGitRepo(collectionId: string): GitDelta[];
  /** Pull + apply one-sided changes; both-sides motion is reported in `conflicts`. */
  syncGitRepo(collectionId: string): GitSyncResult;
  /** Per-path detail for one conflicted skill; throws RESOURCE_NOT_FOUND if no base snapshot. */
  conflictPaths(collectionId: string, name: string): GitConflictDetail;
  /** Settle a whole conflicted skill in one direction. */
  resolveGitConflict(
    collectionId: string,
    name: string,
    resolution: "remote" | "local",
  ): ResourceRecovery[];
  /** Settle a conflicted skill per path; a stale `mergeId` throws RESOURCE_STALE. */
  resolveGitConflictPaths(
    collectionId: string,
    name: string,
    mergeId: string,
    choices: GitPathChoice[],
  ): ResourceRecovery[];
  /** Forget a collection; `removeSkills` displaces (recoverable), never hard-deletes. */
  forgetGitRepo(collectionId: string, removeSkills: boolean): void;
}
