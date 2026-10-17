import { copyFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import type {
  ProjectMeta,
  SessionActorRef,
  SessionLaunch,
  SessionLocation,
  SessionMeta,
  SessionProvenance,
  SessionWorkspace,
  ThinkingLevel,
  UserIdentity,
} from "@agent-deck/contracts";
import {
  actorRef,
  isLegacySessionRecord,
  migrateSessionMeta,
  type SessionLocationKind,
} from "@agent-deck/domain";
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

  /** Write the loaded (normalized) items back as they are: one atomic flush. */
  protected rewrite(): void {
    const first = this.list()[0];
    if (first) this.upsert(first);
  }
}

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const SHA256 = /^[0-9a-f]{64}$/;
const MODES = ["snapshot", "conversation"] as const;
const isMode = (value: unknown): value is (typeof MODES)[number] =>
  MODES.includes(value as (typeof MODES)[number]);
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A persisted identity, bounded; undefined unless it has the exact shape. */
function identity(raw: unknown): UserIdentity | undefined {
  if (
    !isObject(raw) ||
    typeof raw.id !== "string" ||
    !["undefined", "string"].includes(typeof raw.name)
  ) {
    return undefined;
  }
  return {
    id: raw.id.slice(0, 320),
    ...(typeof raw.name === "string" ? { name: raw.name.slice(0, 200) } : {}),
  };
}

function provenanceOf(raw: unknown): SessionProvenance | undefined {
  if (!isObject(raw) || typeof raw.kind !== "string" || typeof raw.at !== "string")
    return undefined;
  const by: SessionActorRef | undefined =
    raw.by === "system"
      ? "system"
      : isObject(raw.by) && typeof raw.by.agent === "string"
        ? { agent: raw.by.agent.slice(0, 200) }
        : isObject(raw.by)
          ? actorRef(identity(raw.by.user))
          : undefined;
  if (!by) return undefined;
  const from = raw.from;
  let source: SessionProvenance["from"];
  if (isObject(from) && typeof from.sessionId === "string") {
    const owner = identity(from.owner);
    source = {
      sessionId: from.sessionId,
      ...(typeof from.serverOrigin === "string" ? { serverOrigin: from.serverOrigin } : {}),
      ...(typeof from.title === "string" ? { title: from.title.slice(0, 200) } : {}),
      ...(owner ? { owner } : {}),
      ...(typeof from.entryId === "string" ? { entryId: from.entryId } : {}),
    };
  } else if (
    isObject(from) &&
    typeof from.device === "string" &&
    typeof from.localSessionId === "string"
  ) {
    source = { device: from.device.slice(0, 200), localSessionId: from.localSessionId };
  } else if (isObject(from) && typeof from.runId === "string") {
    source = { runId: from.runId };
  }
  const recap = raw.recap;
  return {
    kind: raw.kind as SessionProvenance["kind"],
    ...(source ? { from: source } : {}),
    by,
    at: raw.at,
    ...(isObject(recap) && typeof recap.text === "string" && typeof recap.truncated === "boolean"
      ? { recap: { text: recap.text, truncated: recap.truncated } }
      : {}),
    ...(isMode(raw.mode) ? { mode: raw.mode } : {}),
  };
}

function locationOf(raw: unknown, where: SessionLocationKind, creator?: UserIdentity) {
  const location: SessionLocation = {
    // Never a stored fact: the side of the process reading the index decides.
    kind: where,
  };
  if (!isObject(raw)) {
    if (creator) location.owner = creator;
    return location;
  }
  const owner = identity(raw.owner);
  if (owner) location.owner = owner;
  // SRV-12c1/12c3: the copy that continues, kept only with its exact shape.
  const live = raw.live;
  if (
    isObject(live) &&
    typeof live.sessionId === "string" &&
    typeof live.at === "string" &&
    isMode(live.mode)
  ) {
    if (typeof live.serverOrigin === "string")
      location.live = {
        serverOrigin: live.serverOrigin,
        sessionId: live.sessionId,
        at: live.at,
        mode: live.mode,
      };
    else if (typeof live.device === "string")
      location.live = {
        device: live.device.slice(0, 200),
        sessionId: live.sessionId,
        at: live.at,
        mode: live.mode,
      };
  }
  const transfer = raw.transfer;
  if (
    isObject(transfer) &&
    transfer.direction === "return" &&
    ["token", "serverOrigin", "sessionId", "until"].every(
      (key) => typeof transfer[key] === "string",
    ) &&
    ["undefined", "string"].includes(typeof transfer.ref)
  ) {
    location.transfer = {
      direction: "return",
      token: transfer.token as string,
      serverOrigin: transfer.serverOrigin as string,
      sessionId: transfer.sessionId as string,
      ...(typeof transfer.ref === "string" ? { ref: transfer.ref } : {}),
      until: transfer.until as string,
    };
  }
  const pr = raw.mergePr;
  if (
    isObject(pr) &&
    typeof pr.url === "string" &&
    /^https:\/\//.test(pr.url) &&
    Number.isSafeInteger(pr.number) &&
    ["undefined", "string"].includes(typeof pr.openedAt)
  ) {
    location.mergePr = {
      url: pr.url,
      number: pr.number as number,
      ...(typeof pr.openedAt === "string" ? { openedAt: pr.openedAt } : {}),
    };
  }
  return location;
}

function workspaceOf(raw: unknown): SessionWorkspace | undefined {
  if (!isObject(raw)) return undefined;
  const workspace = Object.fromEntries(
    (["path", "identity", "branch", "sourceBranch", "cleanupBranchHead", "ownerSessionId"] as const)
      .filter((key) => typeof raw[key] === "string")
      .map((key) => [key, raw[key]]),
  ) as SessionWorkspace;
  return Object.keys(workspace).length > 0 ? workspace : undefined;
}

const validStringArray = (value: unknown): value is string[] | undefined =>
  value === undefined ||
  (Array.isArray(value) &&
    value.length <= 256 &&
    value.every((item) => typeof item === "string" && item.length <= 4096));

function launchOf(raw: unknown): SessionLaunch | undefined {
  if (!isObject(raw)) return undefined;
  const launch: SessionLaunch = {};
  const resources = raw.resourceConfig;
  if (
    isObject(resources) &&
    resources.version === 1 &&
    ["undefined", "string"].includes(typeof resources.providerOverride) &&
    ["undefined", "string"].includes(typeof resources.modelOverride) &&
    validStringArray(resources.extensionsOverride) &&
    validStringArray(resources.skillsOverride) &&
    (resources.thinkingOverride === undefined ||
      THINKING_LEVELS.includes(resources.thinkingOverride as string))
  ) {
    // Rebuild from the public allowlist instead of retaining unknown fields.
    // In particular, never surface an envOverride written by a pre-release
    // build: session metadata is persisted and returned over HTTP/WS.
    launch.resourceConfig = {
      version: 1,
      ...(typeof resources.providerOverride === "string"
        ? { providerOverride: migrateProviderId(resources.providerOverride) }
        : {}),
      ...(typeof resources.modelOverride === "string"
        ? { modelOverride: resources.modelOverride }
        : {}),
      ...(resources.extensionsOverride !== undefined
        ? { extensionsOverride: [...(resources.extensionsOverride as string[])] }
        : {}),
      ...(resources.skillsOverride !== undefined
        ? { skillsOverride: [...(resources.skillsOverride as string[])] }
        : {}),
      ...(resources.thinkingOverride !== undefined
        ? { thinkingOverride: resources.thinkingOverride as ThinkingLevel }
        : {}),
    };
    // The fingerprint describes those resources: never one without them.
    if (typeof raw.fingerprint === "string" && SHA256.test(raw.fingerprint))
      launch.fingerprint = raw.fingerprint;
  }
  // Pi 1.0.3 provider rename (azure-openai-responses -> azure), mapped on load.
  const plan = raw.plan;
  if (isObject(plan) && typeof plan.provider === "string") {
    launch.plan = { ...plan, provider: migrateProviderId(plan.provider) };
  } else if (plan !== undefined) launch.plan = plan;
  if (typeof raw.refreshError === "string") launch.refreshError = raw.refreshError.slice(0, 500);
  return Object.keys(launch).length > 0 ? launch : undefined;
}

/**
 * One persisted record as the server trusts it: a legacy record is migrated to
 * the v2 shape first (ADR 0006), then every field is kept only with its exact
 * shape, so nothing malformed reaches a route or the wire.
 */
export function normalizeSession(stored: SessionMeta, where: SessionLocationKind): SessionMeta {
  const session = migrateSessionMeta(stored, where);
  const normalized: SessionMeta = {
    ...session,
    ...(session.needsAttention === undefined
      ? {}
      : { needsAttention: session.needsAttention === true }),
  };
  // Only a draft is persisted; every other lifecycle is derived.
  if (normalized.lifecycle !== "draft") delete normalized.lifecycle;
  if (typeof normalized.draftWorktreeIsolation !== "boolean") {
    delete normalized.draftWorktreeIsolation;
  }
  if (
    normalized.draftThinkingLevel !== undefined &&
    !THINKING_LEVELS.includes(normalized.draftThinkingLevel)
  ) {
    delete normalized.draftThinkingLevel;
  }
  const audit: unknown = session.finalSystemPromptAudit;
  if (
    !isObject(audit) ||
    typeof audit.text !== "string" ||
    typeof audit.capturedAt !== "string" ||
    Number.isNaN(Date.parse(audit.capturedAt))
  ) {
    delete normalized.finalSystemPromptAudit;
  }
  const creator = identity(session.createdBy);
  if (creator) normalized.createdBy = creator;
  else delete normalized.createdBy;
  normalized.provenance = provenanceOf(session.provenance) ?? {
    kind: "created",
    by: actorRef(creator),
    at: normalized.createdAt,
  };
  normalized.location = locationOf(session.location, where, creator);
  const workspace = workspaceOf(session.workspace);
  if (workspace) normalized.workspace = workspace;
  else delete normalized.workspace;
  const launch = launchOf(session.launch);
  if (launch) normalized.launch = launch;
  else delete normalized.launch;
  if (
    typeof normalized.transcriptSha256 !== "string" ||
    !SHA256.test(normalized.transcriptSha256)
  ) {
    delete normalized.transcriptSha256;
  }
  if (
    typeof normalized.parkedAt !== "string" ||
    Number.isNaN(Date.parse(normalized.parkedAt)) ||
    normalized.endedAt !== undefined
  ) {
    delete normalized.parkedAt;
  }
  return normalized;
}

export class SessionIndex extends JsonArrayStore<SessionMeta> {
  /** `where`: the side this index lives on, every record's `location.kind`. */
  constructor(dataDir: string = defaultDataDir(), where: SessionLocationKind = "local") {
    let legacy = false;
    super(dataDir, "sessions.json", (stored) => {
      // Unversioned, or a legacy key an older build wrote beside a migrated record.
      if (isLegacySessionRecord(stored)) legacy = true;
      return normalizeSession(stored, where);
    });
    // ADR 0006: a legacy index is written back in the v2 shape. The file as it
    // was the first time is kept beside it (sessions.v1.bak.json) for one
    // release: written to a temporary file and renamed, so an interrupted copy
    // never leaves a partial backup, and never replaced by a later one.
    if (legacy) {
      const file = path.join(dataDir, "sessions.json");
      const backup = path.join(dataDir, "sessions.v1.bak.json");
      if (!existsSync(backup)) {
        const temporary = `${backup}.tmp`;
        copyFileSync(file, temporary);
        renameSync(temporary, backup);
      }
      this.rewrite();
    }
  }
}

/** One row per session: the authors of its user messages (sessionAuthors.ts). */
export interface SessionAuthorRecord {
  id: string;
  turns: Array<{
    signature: string;
    author: UserIdentity;
    claimed?: boolean;
    entryId?: string;
    inherited?: boolean;
    claimedAt?: number;
  }>;
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
