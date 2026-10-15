import type { ProjectMeta, SessionMeta, UserIdentity } from "@agent-deck/contracts";
import { Effect, Option } from "effect";
import { migrateProviderId } from "./azureProviderRename.ts";
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
      if (normalized.lifecycle !== "draft" && normalized.lifecycle !== "started") {
        delete normalized.lifecycle;
      }
      if (typeof normalized.draftWorktreeIsolation !== "boolean") {
        delete normalized.draftWorktreeIsolation;
      }
      if (
        normalized.draftThinkingLevel !== undefined &&
        !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          normalized.draftThinkingLevel,
        )
      ) {
        delete normalized.draftThinkingLevel;
      }
      if (!validAudit) delete normalized.finalSystemPromptAudit;
      const identity = (raw: unknown): { id: string; name?: string } | undefined => {
        if (
          !raw ||
          typeof raw !== "object" ||
          typeof (raw as { id?: unknown }).id !== "string" ||
          !["undefined", "string"].includes(typeof (raw as { name?: unknown }).name)
        ) {
          return undefined;
        }
        const user = raw as { id: string; name?: string };
        return {
          id: user.id.slice(0, 320),
          ...(user.name !== undefined ? { name: user.name.slice(0, 200) } : {}),
        };
      };
      const creator = identity((session as SessionMeta & { createdBy?: unknown }).createdBy);
      if (creator) normalized.createdBy = creator;
      else delete normalized.createdBy;
      // SRV-15b: a plain fork's origin, the same shape checks as createdBy.
      const rawFork = (session as SessionMeta & { forkedFrom?: unknown }).forkedFrom as
        | { sessionId?: unknown; title?: unknown; owner?: unknown }
        | undefined;
      if (
        !rawFork ||
        typeof rawFork !== "object" ||
        typeof rawFork.sessionId !== "string" ||
        !["undefined", "string"].includes(typeof rawFork.title)
      ) {
        delete normalized.forkedFrom;
      } else {
        const owner = identity(rawFork.owner);
        normalized.forkedFrom = {
          sessionId: rawFork.sessionId,
          ...(typeof rawFork.title === "string" ? { title: rawFork.title.slice(0, 200) } : {}),
          ...(owner ? { owner } : {}),
        };
      }
      // SRV-12c1: the move links, kept only with their exact shape.
      const shareLink = (raw: unknown, idKey: "serverSessionId" | "localSessionId") => {
        const link = raw as Record<string, unknown> | null | undefined;
        if (
          !link ||
          typeof link !== "object" ||
          typeof link[idKey] !== "string" ||
          typeof link.sharedAt !== "string" ||
          (link.mode !== "snapshot" && link.mode !== "conversation")
        ) {
          return undefined;
        }
        return link;
      };
      const sharedTo = shareLink(normalized.sharedTo, "serverSessionId");
      if (sharedTo && typeof sharedTo.serverOrigin === "string") {
        normalized.sharedTo = {
          serverOrigin: sharedTo.serverOrigin,
          serverSessionId: sharedTo.serverSessionId as string,
          sharedAt: sharedTo.sharedAt as string,
          mode: sharedTo.mode as "snapshot" | "conversation",
        };
      } else delete normalized.sharedTo;
      const sharedFrom = shareLink(normalized.sharedFrom, "localSessionId");
      if (sharedFrom && typeof sharedFrom.device === "string") {
        normalized.sharedFrom = {
          device: sharedFrom.device.slice(0, 200),
          localSessionId: sharedFrom.localSessionId as string,
          sharedAt: sharedFrom.sharedAt as string,
          mode: sharedFrom.mode as "snapshot" | "conversation",
          ...(typeof sharedFrom.exportSha256 === "string" &&
          /^[0-9a-f]{64}$/.test(sharedFrom.exportSha256)
            ? { exportSha256: sharedFrom.exportSha256 }
            : {}),
        };
      } else delete normalized.sharedFrom;
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
        !validStringArray((rawResources as { skillsOverride?: unknown }).skillsOverride) ||
        ![undefined, "off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(
          (rawResources as { thinkingOverride?: string }).thinkingOverride,
        )
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
          thinkingOverride?: NonNullable<SessionMeta["draftThinkingLevel"]>;
        };
        normalized.launchResourceConfig = {
          version: 1,
          ...(resources.providerOverride !== undefined
            ? { providerOverride: migrateProviderId(resources.providerOverride) }
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
          ...(resources.thinkingOverride !== undefined
            ? { thinkingOverride: resources.thinkingOverride }
            : {}),
        };
      }
      // Pi 1.0.3 provider rename (azure-openai-responses -> azure), mapped on load.
      const plan = normalized.launchPlan as { provider?: unknown } | null | undefined;
      if (plan && typeof plan === "object" && typeof plan.provider === "string") {
        const provider = migrateProviderId(plan.provider);
        if (provider !== plan.provider) normalized.launchPlan = { ...plan, provider };
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

/** One row per session: the authors of its user messages (sessionAuthors.ts). */
export interface SessionAuthorRecord {
  id: string;
  turns: Array<{ signature: string; author: UserIdentity; claimed?: boolean; entryId?: string }>;
}

export class SessionAuthorIndex extends JsonArrayStore<SessionAuthorRecord> {
  constructor(dataDir: string = defaultDataDir()) {
    super(dataDir, "session-authors.json", (record) => ({
      id: record.id,
      turns: Array.isArray(record.turns)
        ? record.turns.filter(
            (turn) =>
              turn &&
              typeof turn.signature === "string" &&
              turn.author &&
              typeof turn.author.id === "string",
          )
        : [],
    }));
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

  setDefaultMcpServer(name: string, enabled: boolean): AppSettings {
    return runSyncUnwrapped(this.handle.setDefaultMcpServer(name, enabled));
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

  /** SES-34: mark a model OpenAI Fast (`provider:id`). */
  setModelFastMode(key: string, enabled: boolean): AppSettings {
    return runSyncUnwrapped(this.handle.setModelFastMode(key, enabled));
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
