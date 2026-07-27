/**
 * NativeSkillStore — the in-tree implementation of the {@link SkillStore} seam
 * (ADR-0002 P1b). A thin adapter over `@agent-deck/resources` + `loop-catalog-native`,
 * so route handlers and the launch flow depend on the interface, not the concrete
 * functions. When the shared Syncr engine lands (ADR-0002 P3), a second
 * implementation replaces this one behind the same interface with no call-site churn.
 */

import {
  type ResourceRecovery,
  type ResourceRoots,
  acknowledgeResourceRecovery,
  deleteSkillDir,
  importSkillFile,
  listResourceRecoveries,
  renameSkillDir,
  restoreResourceRecovery,
  writeSkillFile,
} from "@agent-deck/resources";
import type { SkillInfo } from "@agent-deck/domain";
import type { SkillEdit, SkillScope, SkillStore } from "./skillStore.ts";

/** Catalog the native recovery API namespaces skill recoveries under. */
const SKILL_RECOVERY_CATALOG = "global-skills";

/** Host hooks the store needs to resolve catalog roots the same way the server does. */
export interface NativeSkillStoreDeps {
  /** Resolve catalog roots for a project (the server's `rootsFor`). */
  rootsFor(projectId?: string): ResourceRoots;
  /** Managed skill-collection roots merged into a scan (the server's scan helper). */
  scanSkillsFor(projectId?: string): SkillInfo[];
  /** Home dir — the anchor for global-scope recovery operations. */
  home: string;
}

export class NativeSkillStore implements SkillStore {
  constructor(private readonly deps: NativeSkillStoreDeps) {}

  listSkills(projectId?: string): SkillInfo[] {
    return this.deps.scanSkillsFor(projectId);
  }

  writeSkill(scope: SkillScope, name: string, edit: SkillEdit, projectId?: string): string {
    return writeSkillFile(this.deps.rootsFor(projectId), scope, name, edit);
  }

  deleteSkill(scope: SkillScope, name: string, projectId?: string): void {
    deleteSkillDir(this.deps.rootsFor(projectId), scope, name);
  }

  renameSkill(scope: SkillScope, name: string, newName: string, projectId?: string): string {
    return renameSkillDir(this.deps.rootsFor(projectId), scope, name, newName);
  }

  importLocalSkill(scope: SkillScope, sourcePath: string, projectId?: string): string {
    return importSkillFile(this.deps.rootsFor(projectId), scope, sourcePath);
  }

  // Skill recoveries live under the global-skills catalog (matches the recovery
  // routes' `resourceHome(), "global-skills"` calls).
  listRecoveries(): ResourceRecovery[] {
    return listResourceRecoveries(this.deps.home, SKILL_RECOVERY_CATALOG);
  }

  restoreRecovery(token: string): ResourceRecovery {
    return restoreResourceRecovery(this.deps.home, SKILL_RECOVERY_CATALOG, token);
  }

  acknowledgeRecovery(token: string): void {
    acknowledgeResourceRecovery(this.deps.home, SKILL_RECOVERY_CATALOG, token);
  }
}
