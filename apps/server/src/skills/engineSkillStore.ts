/**
 * EngineSkillStore — the P3 implementation of the {@link SkillStore} seam, backed by the
 * shared skill engine (Syncr ADR-0004; handover `Syncr/docs/handover-agent-deck-p3.md`).
 *
 * Settled architecture:
 * - **Reads stay agent-deck's** — `listSkills` delegates to the pi-shaped scanner
 *   (`scanSkillsFor`). The engine's own reader is for Syncr's Tauri host and is never
 *   consumed here, which removes the entire "engine-reader-disagrees-with-pi" defect class.
 * - **Writes / recovery go to the engine** — one storage implementation shared with the
 *   standalone Syncr app, so a storage bug reproduces in one place.
 *
 * Errors from the addon arrive as `Error` with a `RESOURCE_*` code prefix (NAPI has no
 * structured error channel); this maps them back to `ResourceCatalogCapabilityError` so the
 * REST routes keep their existing HTTP status mapping.
 */

import {
  ResourceCatalogCapabilityError,
  acknowledgeResourceRecovery,
  listResourceRecoveries,
  restoreResourceRecovery,
  type ResourceRecovery,
} from "@agent-deck/resources";
import type { ResourceCatalogErrorCode } from "@agent-deck/resources";
import type { SkillInfo } from "@agent-deck/domain";
import type { SkillEdit, SkillScope, SkillStore } from "./skillStore.ts";
import type { SkillEngineNative } from "./skillEngineNative.ts";

/** Catalog the native recovery API namespaces skill recoveries under. */
const SKILL_RECOVERY_CATALOG = "global-skills";

/** Host hooks + the engine addon the store needs. */
export interface EngineSkillStoreDeps {
  /** The engine addon (from `loadSkillEngineNative()`, or a fake in tests). */
  engine: SkillEngineNative;
  /** agent-deck's pi-shaped scanner — the reader (unchanged from NativeSkillStore). */
  scanSkillsFor(projectId?: string): SkillInfo[];
  /** Home dir — the write/recovery root for global-scope catalogs. */
  home: string;
  /** Resolve a projectId to its filesystem root (`rootsFor(projectId).projectPath`). */
  projectRootFor(projectId?: string): string | undefined;
}

/** RESOURCE_* codes the engine may prefix a message with (mirrors ResourceCatalogErrorCode). */
const RESOURCE_CODES: ReadonlySet<string> = new Set<ResourceCatalogErrorCode>([
  "RESOURCE_INVALID_PATH",
  "RESOURCE_NOT_FOUND",
  "RESOURCE_ALREADY_EXISTS",
  "RESOURCE_BUSY",
  "RESOURCE_UNSAFE_COMPONENT",
  "RESOURCE_RECONCILE_INCOMPLETE",
  "RESOURCE_NATIVE_UNAVAILABLE",
  "RESOURCE_INVALID_UTF8",
  "RESOURCE_IO",
]);

/** Re-throw an engine error as ResourceCatalogCapabilityError when it carries a code prefix. */
function mapEngineError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  const separator = message.indexOf(":");
  if (separator > 0) {
    const code = message.slice(0, separator).trim();
    if (RESOURCE_CODES.has(code)) {
      throw new ResourceCatalogCapabilityError(
        code as ResourceCatalogErrorCode,
        message.slice(separator + 1).trim() || message,
      );
    }
  }
  throw error instanceof Error ? error : new Error(message);
}

function fromEngine<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    return mapEngineError(error);
  }
}

export class EngineSkillStore implements SkillStore {
  constructor(private readonly deps: EngineSkillStoreDeps) {}

  /**
   * Resolve a mutation's roots ONCE, before the engine is touched:
   * - `projectRoot` — passed to the engine (undefined for global/library scope). A
   *   project-scoped write with no resolvable root fails RESOURCE_INVALID_PATH here, not
   *   after a partial engine write.
   * - `fanRoot` — where the canonical catalog fan-out is rooted (the project root for
   *   project scope, else home).
   */
  private resolveRoots(
    scope: SkillScope,
    projectId?: string,
  ): { projectRoot: string | undefined; fanRoot: string } {
    if (scope === "project") {
      const projectRoot = this.deps.projectRootFor(projectId);
      if (!projectRoot) {
        throw new ResourceCatalogCapabilityError(
          "RESOURCE_INVALID_PATH",
          "projectId required for project scope",
        );
      }
      return { projectRoot, fanRoot: projectRoot };
    }
    return { projectRoot: undefined, fanRoot: this.deps.home };
  }

  // ── Read (agent-deck's scanner, never the engine) ────────────────────────────
  listSkills(projectId?: string): SkillInfo[] {
    return this.deps.scanSkillsFor(projectId);
  }

  // ── Write (the engine) ───────────────────────────────────────────────────────
  writeSkill(scope: SkillScope, name: string, edit: SkillEdit, projectId?: string): string {
    const { projectRoot, fanRoot } = this.resolveRoots(scope, projectId);
    const path = fromEngine(() =>
      this.deps.engine.writeSkill(
        this.deps.home,
        projectRoot,
        scope,
        name,
        edit.description,
        edit.body,
      ),
    );
    this.fanOutBestEffort(fanRoot, name);
    return path;
  }

  deleteSkill(scope: SkillScope, name: string, projectId?: string): void {
    const { projectRoot } = this.resolveRoots(scope, projectId);
    fromEngine(() => this.deps.engine.deleteSkill(this.deps.home, projectRoot, scope, name));
  }

  renameSkill(scope: SkillScope, name: string, newName: string, projectId?: string): string {
    const { projectRoot, fanRoot } = this.resolveRoots(scope, projectId);
    const path = fromEngine(() =>
      this.deps.engine.renameSkill(this.deps.home, projectRoot, scope, name, newName),
    );
    this.fanOutBestEffort(fanRoot, newName);
    return path;
  }

  importLocalSkill(scope: SkillScope, sourcePath: string, projectId?: string): string {
    const { projectRoot } = this.resolveRoots(scope, projectId);
    return fromEngine(() =>
      this.deps.engine.importLocalSkill(this.deps.home, projectRoot, scope, sourcePath),
    );
  }

  // ── Recovery (native, transitional) ──────────────────────────────────────────
  // Recovery stays on the native `global-skills` store, NOT the engine. In agent-deck's
  // single-user, no-sync scope the recovery producers are the legacy skill-repo (its "Take
  // Remote" displaces a local skill) and native displacement — both write here. The engine
  // only produces recoveries during its sync/conflict path, which agent-deck doesn't drive
  // yet. When P4 removes the legacy repo and sync lands, recovery moves to the engine
  // (`this.deps.engine.*Recovery`, already on the contract).
  listRecoveries(): ResourceRecovery[] {
    return listResourceRecoveries(this.deps.home, SKILL_RECOVERY_CATALOG);
  }

  restoreRecovery(token: string): ResourceRecovery {
    return restoreResourceRecovery(this.deps.home, SKILL_RECOVERY_CATALOG, token);
  }

  acknowledgeRecovery(token: string): void {
    acknowledgeResourceRecovery(this.deps.home, SKILL_RECOVERY_CATALOG, token);
  }

  /** Project the canonical skill into the machine's other installed tool dirs. Best-effort:
   *  a fan-out failure (e.g. a tool dir permission issue) must not fail the authored write —
   *  agent-deck itself reads the canonical catalog directly and passes explicit `--skill`. */
  private fanOutBestEffort(root: string, slug: string): void {
    try {
      this.deps.engine.fanOut(root, slug);
    } catch {
      // Intentionally swallowed — see doc comment. The canonical write already succeeded.
    }
  }
}
