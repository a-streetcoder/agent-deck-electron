import type { ProjectMeta, SessionMeta } from "@agent-deck/contracts";
import { Effect, Option } from "effect";
import { runSyncUnwrapped } from "./effectRun.ts";
import {
  defaultDataDir,
  makeJsonArrayStoreHandle,
  makeSettingsStoreHandle,
  type AppSettings,
  type JsonArrayStoreHandle,
  type SettingsStoreHandle,
} from "./services/persistence.ts";

/**
 * App-data persistence — the synchronous class facade over the Slice 6 Effect
 * service (services/persistence.ts). pi owns the canonical session files; we keep
 * light JSON indexes (sessions, projects) and the app-settings blob that survive
 * server restarts. Writes are atomic (tmp + rename). The **on-disk JSON format and
 * file paths are unchanged** — this is the same storage, now behind a service.
 *
 * These classes keep the exact API the routes / SessionManager / server bootstrap
 * depend on, so no consumer churns in this slice (Effect-native at Slice 7). Each
 * store's real state + I/O lives in a context-free {@link JsonArrayStoreHandle} /
 * {@link SettingsStoreHandle} built by the service's `make*` effect; the facade
 * runs those effects synchronously with no ManagedRuntime (a context-free handle
 * needs none), exactly as `pushBus.ts` adapts the push-bus service. Read-only ops
 * are total, so they use `Effect.runSync` directly; every fallible write/construct
 * (the tmp+rename flush, the `mkdirSync` on open) instead goes through
 * {@link runSyncUnwrapped} so an fs error re-surfaces as the ORIGINAL Error the
 * legacy class threw — not Effect's FiberFailure wrapper — matching the same
 * unwrap the sibling `pushBus.ts` facade applies to subscriber exceptions.
 */

export { defaultDataDir };
export type { AppSettings } from "./services/persistence.ts";

/** Thin synchronous facade over a {@link JsonArrayStoreHandle}. */
class JsonArrayStore<T extends { id: string }> {
  private readonly handle: JsonArrayStoreHandle<T>;

  constructor(dataDir: string, fileName: string, normalizeItem?: (item: T) => T) {
    this.handle = runSyncUnwrapped(makeJsonArrayStoreHandle<T>(dataDir, fileName, normalizeItem));
  }

  list(): T[] {
    return Effect.runSync(this.handle.list);
  }

  find(predicate: (item: T) => boolean): T | undefined {
    return Option.getOrUndefined(Effect.runSync(this.handle.find(predicate)));
  }

  upsert(item: T): void {
    runSyncUnwrapped(this.handle.upsert(item));
  }

  remove(id: string): boolean {
    return runSyncUnwrapped(this.handle.remove(id));
  }
}

export class SessionIndex extends JsonArrayStore<SessionMeta> {
  constructor(dataDir: string = defaultDataDir()) {
    super(dataDir, "sessions.json", (session) => {
      const rawAudit = (session as SessionMeta & { finalSystemPromptAudit?: unknown })
        .finalSystemPromptAudit;
      const validAudit =
        rawAudit !== null &&
        typeof rawAudit === "object" &&
        typeof (rawAudit as Record<string, unknown>).text === "string" &&
        typeof (rawAudit as Record<string, unknown>).capturedAt === "string" &&
        !Number.isNaN(Date.parse((rawAudit as Record<string, unknown>).capturedAt as string));
      const normalized = {
        ...session,
        ...(session.needsAttention === undefined
          ? {}
          : { needsAttention: session.needsAttention === true }),
      };
      if (!validAudit) delete normalized.finalSystemPromptAudit;
      const rawResources = (session as SessionMeta & { launchResourceConfig?: unknown })
        .launchResourceConfig;
      const validStringArray = (value: unknown): value is string[] | undefined =>
        value === undefined ||
        (Array.isArray(value) &&
          value.length <= 256 &&
          value.every((item) => typeof item === "string" && item.length <= 4096));
      if (
        !rawResources ||
        typeof rawResources !== "object" ||
        (rawResources as { version?: unknown }).version !== 1 ||
        !["undefined", "string"].includes(
          typeof (rawResources as { providerOverride?: unknown }).providerOverride,
        ) ||
        !["undefined", "string"].includes(
          typeof (rawResources as { modelOverride?: unknown }).modelOverride,
        ) ||
        !validStringArray((rawResources as { extensionsOverride?: unknown }).extensionsOverride) ||
        !validStringArray((rawResources as { skillsOverride?: unknown }).skillsOverride)
      ) {
        delete normalized.launchResourceConfig;
        delete normalized.launchResourceFingerprint;
      } else {
        // Rebuild from the public allowlist instead of retaining unknown fields.
        // In particular, never surface an envOverride written by a pre-release
        // build: session metadata is persisted and returned over HTTP/WS.
        const resources = rawResources as {
          providerOverride?: string;
          modelOverride?: string;
          extensionsOverride?: string[];
          skillsOverride?: string[];
        };
        normalized.launchResourceConfig = {
          version: 1,
          ...(resources.providerOverride !== undefined
            ? { providerOverride: resources.providerOverride }
            : {}),
          ...(resources.modelOverride !== undefined
            ? { modelOverride: resources.modelOverride }
            : {}),
          ...(resources.extensionsOverride !== undefined
            ? { extensionsOverride: [...resources.extensionsOverride] }
            : {}),
          ...(resources.skillsOverride !== undefined
            ? { skillsOverride: [...resources.skillsOverride] }
            : {}),
        };
      }
      if (
        typeof normalized.launchResourceFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(normalized.launchResourceFingerprint)
      ) {
        delete normalized.launchResourceFingerprint;
      }
      if (typeof normalized.resourceRefreshError !== "string") {
        delete normalized.resourceRefreshError;
      } else {
        normalized.resourceRefreshError = normalized.resourceRefreshError.slice(0, 500);
      }
      if (
        typeof normalized.parkedAt !== "string" ||
        Number.isNaN(Date.parse(normalized.parkedAt)) ||
        normalized.endedAt !== undefined
      ) {
        delete normalized.parkedAt;
      }
      return normalized;
    });
  }
}

export class ProjectIndex extends JsonArrayStore<ProjectMeta> {
  constructor(dataDir: string = defaultDataDir()) {
    super(dataDir, "projects.json");
  }
}

/** App-level settings (app-settings.json), atomic writes like the indexes. */
export class SettingsStore {
  private readonly handle: SettingsStoreHandle;

  constructor(dataDir: string = defaultDataDir()) {
    this.handle = runSyncUnwrapped(makeSettingsStoreHandle(dataDir));
  }

  get(): AppSettings {
    return Effect.runSync(this.handle.get);
  }

  update(patch: Partial<AppSettings>): AppSettings {
    return runSyncUnwrapped(this.handle.update(patch));
  }

  /**
   * Atomic membership ops — computed against CURRENT state so concurrent
   * clients can't clobber each other with stale whole-array replacements.
   */
  setDefaultSkill(name: string, enabled: boolean): AppSettings {
    return runSyncUnwrapped(this.handle.setDefaultSkill(name, enabled));
  }

  setDefaultPromptTemplate(name: string, enabled: boolean): AppSettings {
    return runSyncUnwrapped(this.handle.setDefaultPromptTemplate(name, enabled));
  }

  /** Rename/delete upkeep: rewrite (or drop, with newName=null) a default entry. */
  renameDefaultPromptTemplate(oldName: string, newName: string | null): AppSettings {
    return runSyncUnwrapped(this.handle.renameDefaultPromptTemplate(oldName, newName));
  }

  setDisabledSkill(name: string, disabled: boolean): AppSettings {
    return runSyncUnwrapped(this.handle.setDisabledSkill(name, disabled));
  }

  /** Add an extension path (idempotent), enabled by default. */
  addExtension(extPath: string): AppSettings {
    return runSyncUnwrapped(this.handle.addExtension(extPath));
  }

  /** Remove an extension path from both lists entirely. */
  removeExtension(extPath: string): AppSettings {
    return runSyncUnwrapped(this.handle.removeExtension(extPath));
  }

  setExtensionDisabled(extPath: string, disabled: boolean): AppSettings {
    return runSyncUnwrapped(this.handle.setExtensionDisabled(extPath, disabled));
  }

  setInjectedCommandDisabled(id: string, disabled: boolean): AppSettings {
    return runSyncUnwrapped(this.handle.setInjectedCommandDisabled(id, disabled));
  }

  setLibraryCommandEnabled(id: string, enabled: boolean): AppSettings {
    return runSyncUnwrapped(this.handle.setLibraryCommandEnabled(id, enabled));
  }

  /** Record Codex plugin skill references (SKL-09), deduped by identity. */
  addCodexPluginSkillRefs(
    refs: readonly AppSettings["codexPluginSkillRefs"][number][],
  ): AppSettings {
    return runSyncUnwrapped(this.handle.addCodexPluginSkillRefs(refs));
  }

  removeCodexPluginSkillRef(ref: AppSettings["codexPluginSkillRefs"][number]): AppSettings {
    return runSyncUnwrapped(this.handle.removeCodexPluginSkillRef(ref));
  }

  /** Reference an external prompt file in place (PRM-05), idempotent. */
  addExternalPromptPath(promptPath: string): AppSettings {
    return runSyncUnwrapped(this.handle.addExternalPromptPath(promptPath));
  }

  removeExternalPromptPath(promptPath: string): AppSettings {
    return runSyncUnwrapped(this.handle.removeExternalPromptPath(promptPath));
  }

  /** Silence/re-enable a bundled builtin prompt (PRM-06). */
  setBuiltinPromptDisabled(name: string, disabled: boolean): AppSettings {
    return runSyncUnwrapped(this.handle.setBuiltinPromptDisabled(name, disabled));
  }

  /** Hide/show a model in the picker, by its "<provider>:<id>" key. */
  setModelDisabled(key: string, disabled: boolean): AppSettings {
    return runSyncUnwrapped(this.handle.setModelDisabled(key, disabled));
  }

  /** Enabled extension paths — merged into every session launch. */
  enabledExtensions(): string[] {
    return Effect.runSync(this.handle.enabledExtensions);
  }

  /** Drop a skill name from every list (used when a skill is deleted). */
  forgetSkill(name: string): AppSettings {
    return runSyncUnwrapped(this.handle.forgetSkill(name));
  }

  /** Re-point a renamed skill in every app-level list (default + disabled). */
  renameSkill(oldName: string, newName: string): AppSettings {
    return runSyncUnwrapped(this.handle.renameSkill(oldName, newName));
  }

  /** Add or remove a discovery root (atomic membership op). */
  setProjectRoot(root: string, present: boolean): AppSettings {
    return runSyncUnwrapped(this.handle.setProjectRoot(root, present));
  }
}
