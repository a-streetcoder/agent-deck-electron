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

  // ── Recovery (crash-safe write fallout; preserved offline) ───────────────────
  listRecoveries(): ResourceRecovery[];
  restoreRecovery(token: string): ResourceRecovery;
  acknowledgeRecovery(token: string): void;
}
