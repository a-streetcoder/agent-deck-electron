// ADR 0006: the session record v2. Pure functions over SessionMeta: the one-off
// migration of a legacy record, the explicit lifecycle, the operations a record
// allows an actor (every route refusal keyed on lifecycle, location, provenance
// and owner goes through `allowedOperations`), and lineage over provenance.
import type {
  LaunchResourceConfig,
  LegacySessionMeta,
  SessionActorRef,
  SessionLifecycle,
  SessionLiveCopy,
  SessionLocation,
  SessionMeta,
  SessionProvenance,
  UserIdentity,
} from "@agent-deck/contracts";

export type SessionLocationKind = SessionLocation["kind"];

const LEGACY_KEYS = [
  "launchPlan",
  "launchResourceConfig",
  "launchResourceFingerprint",
  "resourceRefreshError",
  "worktreePath",
  "worktreeIdentity",
  "worktreeBranch",
  "worktreeSourceBranch",
  "worktreeCleanupBranchHead",
  "worktreeOwnerSessionId",
  "loopReviewRunId",
  "forkProvenance",
  "forkedFrom",
  "sharedTo",
  "returnedFrom",
  "returnPending",
  "mergePr",
  "sharedFrom",
] as const;

type Loose = Record<string, unknown>;
const isObject = (value: unknown): value is Loose =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const mode = (value: unknown): "snapshot" | "conversation" | undefined =>
  value === "snapshot" || value === "conversation" ? value : undefined;
const identity = (value: unknown): UserIdentity | undefined =>
  isObject(value) && typeof value.id === "string"
    ? { id: value.id, ...(typeof value.name === "string" ? { name: value.name } : {}) }
    : undefined;

/** Copy only the keys whose value is defined; undefined when none is. */
function defined<T extends object>(value: T): T | undefined {
  const out = Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** The person who made a record, as provenance names them. */
export const actorRef = (user: UserIdentity | undefined): SessionActorRef => (user ? { user } : {});

function legacyProvenance(old: Loose, by: SessionActorRef, createdAt: string): SessionProvenance {
  // First: the Loop review marker is a capability (read-only merge, its diff
  // base), never to be lost to another origin on the same record.
  if (str(old.loopReviewRunId)) {
    return { kind: "reviewed", from: { runId: old.loopReviewRunId as string }, by, at: createdAt };
  }
  const fork = old.forkProvenance;
  if (
    isObject(fork) &&
    fork.version === 1 &&
    str(fork.sourceSessionId) &&
    str(fork.sourceEntryId) &&
    typeof fork.recap === "string" &&
    typeof fork.recapTruncated === "boolean"
  ) {
    return {
      kind: "forked",
      from: {
        sessionId: fork.sourceSessionId as string,
        entryId: fork.sourceEntryId as string,
        ...(typeof fork.sourceTitle === "string" ? { title: fork.sourceTitle } : {}),
      },
      by,
      at: createdAt,
      recap: { text: fork.recap, truncated: fork.recapTruncated },
    };
  }
  const forked = old.forkedFrom;
  if (isObject(forked) && str(forked.sessionId)) {
    const owner = identity(forked.owner);
    return {
      kind: "forked",
      from: {
        sessionId: forked.sessionId as string,
        ...(typeof forked.title === "string" ? { title: forked.title } : {}),
        ...(owner ? { owner } : {}),
      },
      by,
      at: createdAt,
    };
  }
  const shared = old.sharedFrom;
  if (isObject(shared) && str(shared.device) && str(shared.localSessionId)) {
    const moved = mode(shared.mode);
    return {
      kind: "imported",
      from: { device: shared.device as string, localSessionId: shared.localSessionId as string },
      by,
      at: str(shared.sharedAt) ?? createdAt,
      ...(moved ? { mode: moved } : {}),
    };
  }
  const back = old.returnedFrom;
  if (isObject(back) && str(back.serverSessionId) && str(back.serverOrigin)) {
    return {
      kind: "returned",
      from: {
        sessionId: back.serverSessionId as string,
        serverOrigin: back.serverOrigin as string,
      },
      by,
      at: str(back.returnedAt) ?? createdAt,
    };
  }
  return { kind: "created", by, at: createdAt };
}

function legacyLive(old: Loose): SessionLiveCopy | undefined {
  const link = old.sharedTo;
  if (!isObject(link)) return undefined;
  const at = str(link.sharedAt);
  const moved = mode(link.mode);
  if (!at || !moved) return undefined;
  if (typeof link.serverOrigin === "string" && str(link.serverSessionId))
    return {
      serverOrigin: link.serverOrigin,
      sessionId: link.serverSessionId as string,
      at,
      mode: moved,
    };
  if (link.serverOrigin === null && str(link.device) && str(link.deviceSessionId))
    return {
      device: link.device as string,
      sessionId: link.deviceSessionId as string,
      at,
      mode: moved,
    };
  return undefined;
}

function legacyLocation(old: Loose, where: SessionLocationKind): SessionLocation {
  const owner = identity(old.createdBy);
  const live = legacyLive(old);
  const pending = old.returnPending;
  const transfer =
    isObject(pending) &&
    str(pending.token) &&
    str(pending.serverOrigin) &&
    str(pending.serverSessionId) &&
    str(pending.until)
      ? {
          direction: "return" as const,
          token: pending.token as string,
          serverOrigin: pending.serverOrigin as string,
          sessionId: pending.serverSessionId as string,
          ...(typeof pending.ref === "string" ? { ref: pending.ref } : {}),
          until: pending.until as string,
        }
      : undefined;
  const opened = isObject(old.mergePr)
    ? old.mergePr
    : isObject(old.returnedFrom) && isObject(old.returnedFrom.mergePr)
      ? old.returnedFrom.mergePr
      : undefined;
  const mergePr =
    opened && typeof opened.url === "string" && typeof opened.number === "number"
      ? {
          url: opened.url,
          number: opened.number,
          ...(typeof opened.openedAt === "string" ? { openedAt: opened.openedAt } : {}),
        }
      : undefined;
  return {
    kind: where,
    ...(owner ? { owner } : {}),
    ...(live ? { live } : {}),
    ...(transfer ? { transfer } : {}),
    ...(mergePr ? { mergePr } : {}),
  };
}

const PROVENANCE_KEYS = [
  "loopReviewRunId",
  "forkProvenance",
  "forkedFrom",
  "sharedFrom",
  "returnedFrom",
] as const;
const WORKSPACE_KEYS = [
  "worktreePath",
  "worktreeIdentity",
  "worktreeBranch",
  "worktreeSourceBranch",
  "worktreeCleanupBranchHead",
  "worktreeOwnerSessionId",
] as const;
const LAUNCH_KEYS = [
  "launchPlan",
  "launchResourceConfig",
  "launchResourceFingerprint",
  "resourceRefreshError",
] as const;

const carries = (record: Loose, keys: readonly string[]): boolean =>
  keys.some((key) => record[key] !== undefined);

/**
 * Whether a stored record needs the migration: no schemaVersion, a legacy key
 * (an older build wrote it, also beside a migrated record), or the old
 * `started` lifecycle.
 */
export function isLegacySessionRecord(record: object): boolean {
  const raw = record as Loose;
  return (
    typeof raw.schemaVersion !== "number" ||
    carries(raw, LEGACY_KEYS) ||
    (raw.lifecycle !== undefined && raw.lifecycle !== "draft")
  );
}

/**
 * Map a record to the v2 shape. Pure and idempotent. Every legacy block goes to
 * its new home and is removed; a field this version does not know is kept.
 * Per group (provenance, location, workspace, launch), legacy keys win over the
 * grouped object: only an older build writes them, also beside a record this
 * version already migrated (a rollback build, another checkout's backend), and
 * its view of that group is the newer one. A group without legacy keys keeps
 * the object the record has. `where` is the side the index lives on (a device,
 * or the shared server), always the location's kind. Shape checks stay with the
 * persistence normalizer, which runs on the result.
 */
export function migrateSessionMeta(
  legacy: LegacySessionMeta | SessionMeta,
  where: SessionLocationKind,
): SessionMeta {
  const old = legacy as Loose;
  const record: Loose = { ...old };
  for (const key of LEGACY_KEYS) delete record[key];
  delete record.lifecycle;
  const current = record as SessionMeta;
  const createdAt = str(old.createdAt) ?? "";
  const by = actorRef(identity(old.createdBy));
  const workspace = carries(old, WORKSPACE_KEYS)
    ? defined({
        path: str(old.worktreePath),
        identity: str(old.worktreeIdentity),
        branch: str(old.worktreeBranch),
        sourceBranch: str(old.worktreeSourceBranch),
        cleanupBranchHead: str(old.worktreeCleanupBranchHead),
        ownerSessionId: str(old.worktreeOwnerSessionId),
      })
    : isObject(current.workspace)
      ? current.workspace
      : undefined;
  const launch = carries(old, LAUNCH_KEYS)
    ? defined({
        plan: old.launchPlan,
        resourceConfig: isObject(old.launchResourceConfig)
          ? (old.launchResourceConfig as LaunchResourceConfig)
          : undefined,
        fingerprint: str(old.launchResourceFingerprint),
        refreshError: str(old.resourceRefreshError),
      })
    : isObject(current.launch)
      ? current.launch
      : undefined;
  const provenance =
    !carries(old, PROVENANCE_KEYS) && isObject(current.provenance)
      ? current.provenance
      : legacyProvenance(old, by, createdAt);
  const stored = isObject(current.location) ? current.location : undefined;
  const fromLegacy = legacyLocation(old, where);
  // Per key: what the old writer wrote replaces that part only (a merge as PR
  // on an old server leaves the pointer and the hand-off as they were). A key
  // it deleted without writing another is invisible here.
  const location: SessionLocation = { ...(stored ?? fromLegacy) };
  const pick = <K extends "live" | "transfer" | "mergePr">(key: K, written: boolean) => {
    if (!written) return;
    if (fromLegacy[key] === undefined) delete location[key];
    else location[key] = fromLegacy[key];
  };
  pick("live", old.sharedTo !== undefined);
  pick("transfer", old.returnPending !== undefined);
  pick(
    "mergePr",
    old.mergePr !== undefined ||
      (isObject(old.returnedFrom) && old.returnedFrom.mergePr !== undefined),
  );
  if (!location.owner && fromLegacy.owner) location.owner = fromLegacy.owner;
  const shared = old.sharedFrom;
  const exportSha256 = isObject(shared) ? str(shared.exportSha256) : undefined;
  const lifecycle = old.lifecycle === "draft" ? "draft" : undefined;
  const migrated: SessionMeta = {
    ...current,
    schemaVersion: 2,
    provenance,
    location: { ...location, kind: where },
    ...(exportSha256 ? { transcriptSha256: exportSha256 } : {}),
  };
  if (lifecycle) migrated.lifecycle = lifecycle;
  if (workspace) migrated.workspace = workspace;
  else delete migrated.workspace;
  if (launch) migrated.launch = launch;
  else delete migrated.launch;
  return migrated;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** The session's current owner: `location.owner`, else its creator. The one
 * source for every owner check and every use of the owner's identity. */
export function sessionOwner(
  record: Pick<SessionMeta, "location" | "createdBy">,
): UserIdentity | undefined {
  const owner = isObject(record.location) ? record.location.owner : undefined;
  return isObject(owner) && typeof owner.id === "string" ? owner : record.createdBy;
}

/** The Loop run a retained review session belongs to (its provenance). */
export function reviewRunId(record: Pick<SessionMeta, "provenance">): string | undefined {
  const from: unknown = record.provenance?.kind === "reviewed" ? record.provenance.from : undefined;
  return isObject(from) && typeof from.runId === "string" ? from.runId : undefined;
}

/** A Loop session: its review copy, or the run's own parent session. */
export const isLoopSession = (record: Pick<SessionMeta, "provenance" | "agentName">): boolean =>
  reviewRunId(record) !== undefined || record.agentName?.startsWith("Loop ·") === true;

/** The copy that continues, when this record is a frozen pointer. */
export function liveCopy(record: Pick<SessionMeta, "location">): SessionLiveCopy | undefined {
  const live = record.location?.live;
  return isObject(live) && typeof live.sessionId === "string"
    ? (live as SessionLiveCopy)
    : undefined;
}

/** The shared-server copy a device pointer follows (absent for any other record). */
export function serverCopy(
  record: Pick<SessionMeta, "location">,
): Extract<SessionLiveCopy, { serverOrigin: string }> | undefined {
  const live = liveCopy(record);
  return live && "serverOrigin" in live && typeof live.serverOrigin === "string" ? live : undefined;
}

/** The location once a pointer is unlinked: an ordinary session again. */
export function withoutLiveCopy(location: SessionLocation | undefined): SessionLocation {
  const { live: _live, ...rest } = location ?? { kind: "local" as const };
  return rest;
}

/** The location once its hand-off is complete (or given up). */
export function withoutTransfer(location: SessionLocation | undefined): SessionLocation {
  const { transfer: _transfer, ...rest } = location ?? { kind: "local" as const };
  return rest;
}

/**
 * The explicit lifecycle. Only `draft` is persisted; the rest is derived from
 * the record and, for `moving`, from the hand-off claim the caller holds.
 */
export function sessionLifecycle(
  record: Pick<SessionMeta, "lifecycle" | "location" | "endedAt" | "parkedAt">,
  runtime: { moving?: boolean } = {},
): SessionLifecycle {
  if (liveCopy(record)) return "pointer";
  if (runtime.moving || record.lifecycle === "moving") return "moving";
  if (record.lifecycle === "draft") return "draft";
  if (record.endedAt) return "ended";
  if (record.parkedAt) return "parked";
  return "running";
}

// ---------------------------------------------------------------------------
// Allowed operations
// ---------------------------------------------------------------------------

export type SessionOperation =
  /** A prompt (socket or POST /sessions/:id/prompt). */
  | "prompt"
  /** A steer or follow-up into the running turn. */
  | "steer"
  | "rollback"
  | "compact"
  /** set_model / set_thinking. */
  | "configure"
  /** Any other request on the live runtime (state, models, commands). */
  | "runtime"
  | "resume"
  | "rename"
  | "planRetry"
  | "composerDraft"
  /** Start a subagent run from this session. */
  | "delegate"
  /** A plain fork: a full duplicate ("Continue locally" on a pointer). */
  | "fork"
  /** Fork or re-run at a message. */
  | "historyFork"
  | "merge"
  /** The shared server's merge: push and open a pull request as the owner. */
  | "mergePullRequest"
  /** Device → shared server. */
  | "move"
  /** Shared server → device: start the return. */
  | "return"
  /** Shared server: record that the device has the session again. */
  | "returnFinish"
  /** Shared server: cancel a prepared return. */
  | "returnCancel"
  | "delete"
  | "pin"
  /** ADR 0007: add a refused host to the project's sandbox allow-list. */
  | "sandboxAllowHost";

export const SESSION_OPERATIONS: readonly SessionOperation[] = [
  "prompt",
  "steer",
  "rollback",
  "compact",
  "configure",
  "runtime",
  "resume",
  "rename",
  "planRetry",
  "composerDraft",
  "delegate",
  "fork",
  "historyFork",
  "merge",
  "mergePullRequest",
  "move",
  "return",
  "returnFinish",
  "returnCancel",
  "delete",
  "pin",
  "sandboxAllowHost",
];

/** Why an operation is refused: the HTTP status, the wire code and the message. */
export interface OperationRefusal {
  status: number;
  /** Absent where the route never sent one (a plain fork of a Loop session). */
  code?: string;
  error: string;
}

/** Who asks: the verified user (absent without sign-in) and whether they run the server. */
export interface SessionActor {
  user?: UserIdentity;
  operator?: boolean;
}

export interface AllowedOperations {
  lifecycle: SessionLifecycle;
  allowed: ReadonlySet<SessionOperation>;
  refused: Partial<Record<SessionOperation, OperationRefusal>>;
}

export const POINTER_REFUSAL =
  "This session continues on another copy (on the shared server, or back on its device). Open it there, or continue from this copy.";
export const MOVING_REFUSAL =
  "This session is moving between a device and the shared server. Wait until the move finishes or is cancelled.";
export const LOOP_FORK_REFUSAL =
  "A Loop session cannot be forked. Open its run from Loops instead.";
export const LOOP_REVIEW_PROMPT_REFUSAL =
  "A Loop review session runs from its Loop. Open the run from Loops instead.";

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

const conflict = (code: string | undefined, error: string): OperationRefusal => ({
  status: 409,
  ...(code ? { code } : {}),
  error,
});

/** Operations a frozen pointer refuses with session_shared (fork, delete, pin stay open). */
const POINTER_FROZEN: readonly SessionOperation[] = [
  "prompt",
  "steer",
  "rollback",
  "compact",
  "configure",
  "runtime",
  "resume",
  "rename",
  "planRetry",
  "delegate",
  "historyFork",
  "merge",
  "mergePullRequest",
];
/** Operations a session refuses with session_moving while it is handed over. */
const MOVE_FROZEN: readonly SessionOperation[] = [
  "prompt",
  "steer",
  "rollback",
  "compact",
  "configure",
  "delegate",
  "rename",
  "planRetry",
];

function refusalFor(
  operation: SessionOperation,
  record: SessionMeta,
  lifecycle: SessionLifecycle,
  actor: SessionActor | undefined,
): OperationRefusal | undefined {
  const live = liveCopy(record);
  const location = record.location?.kind ?? "local";
  const owner = sessionOwner(record);
  const isOwner = !!actor?.user && !!owner && actor.user.id === owner.id;
  const draft = lifecycle === "draft" || !record.piSessionFile;
  const loop = isLoopSession(record);
  switch (operation) {
    case "move":
      if (location === "server")
        return conflict("share_refused", "This session is already on a shared server.");
      if (live)
        return conflict(
          "share_refused",
          `This session already continues on ${"serverOrigin" in live ? hostOf(live.serverOrigin) : (live.device ?? "another device")}.`,
        );
      if (draft)
        return conflict(
          "share_refused",
          "This session has nothing to move yet: send a first message.",
        );
      if (loop) return conflict("share_refused", "A Loop session cannot move to a server.");
      return undefined;
    case "return":
    case "returnFinish":
    case "returnCancel": {
      if (location !== "server")
        return conflict(undefined, "A session goes back to a device from a shared server.");
      if (operation === "returnCancel") {
        return isOwner || (!!actor?.user && actor.operator === true)
          ? undefined
          : {
              status: 403,
              code: "return_forbidden",
              error:
                "Only the person who owns this session, or the operator, can cancel its return.",
            };
      }
      if (!isOwner)
        return {
          status: 403,
          code: "return_forbidden",
          error: "Only the person who owns this session can bring it back.",
        };
      if (operation === "returnFinish") return undefined;
      if (lifecycle === "moving")
        return conflict(
          "return_in_progress",
          "A return of this session is already prepared. Finish it, or cancel it first.",
        );
      if (live)
        return conflict(
          "return_refused",
          `This session already continues on ${"device" in live ? live.device : "a device"}.`,
        );
      const from: unknown =
        record.provenance?.kind === "imported" ? record.provenance.from : undefined;
      if (!isObject(from) || typeof from.device !== "string")
        return conflict(
          "return_refused",
          "This session did not come from a device: there is nothing to bring back.",
        );
      if (draft) return conflict("return_refused", "This session has nothing to bring back yet.");
      if (loop) return conflict("return_refused", "A Loop session cannot move to a device.");
      return undefined;
    }
    case "composerDraft":
      if (lifecycle === "moving")
        return conflict(
          "session_moving",
          "This session is moving between a device and the shared server.",
        );
      if (live) return conflict("session_shared", "This session continues on another copy.");
      return undefined;
    default:
      break;
  }
  if (live && POINTER_FROZEN.includes(operation))
    return conflict("session_shared", POINTER_REFUSAL);
  if (lifecycle === "moving" && MOVE_FROZEN.includes(operation))
    return conflict("session_moving", MOVING_REFUSAL);
  switch (operation) {
    case "prompt":
    case "steer":
      return reviewRunId(record) ? conflict(undefined, LOOP_REVIEW_PROMPT_REFUSAL) : undefined;
    case "fork":
      return loop ? conflict(undefined, LOOP_FORK_REFUSAL) : undefined;
    case "historyFork":
      return loop ? conflict("history_fork_refused", LOOP_FORK_REFUSAL) : undefined;
    case "merge":
      return reviewRunId(record)
        ? conflict(
            "loop_review_read_only",
            "Loop review sessions are read-only. Merge and apply are unavailable.",
          )
        : undefined;
    case "mergePullRequest":
      if (reviewRunId(record))
        return conflict(
          "loop_review_read_only",
          "Loop review sessions are read-only. Merge and apply are unavailable.",
        );
      // The operator acts for an owner; without one there is no connection to
      // push with, so nobody may (never a local merge into the server checkout).
      return isOwner || (!!owner && !!actor?.user && actor.operator === true)
        ? undefined
        : {
            status: 403,
            code: "merge_forbidden",
            error:
              "Only the person who owns this session, or the operator, can open its pull request.",
          };
    case "sandboxAllowHost":
      // A desktop has one person; on the server the project is shared, so
      // only the owner (or the operator for them) widens its allow-list.
      if (location !== "server") return undefined;
      return isOwner || (!!actor?.user && actor.operator === true)
        ? undefined
        : {
            status: 403,
            code: "sandbox_allow_forbidden",
            error:
              "Only the person who owns this session, or the operator, can allow a host for its project.",
          };
    default:
      return undefined;
  }
}

/**
 * What `actor` may do with `record` now, and why each other operation is
 * refused. Decided from the lifecycle, the location (pointer, side, owner) and
 * the provenance only; runtime facts (a running turn, live subagents, a git
 * check, the project link) stay with the route that has them. `moving` is the
 * hand-off claim the caller holds for this session.
 */
export function allowedOperations(
  record: SessionMeta,
  actor?: SessionActor,
  runtime: { moving?: boolean } = {},
): AllowedOperations {
  const lifecycle = sessionLifecycle(record, runtime);
  const allowed = new Set<SessionOperation>();
  const refused: Partial<Record<SessionOperation, OperationRefusal>> = {};
  for (const operation of SESSION_OPERATIONS) {
    const refusal = refusalFor(operation, record, lifecycle, actor);
    if (refusal) refused[operation] = refusal;
    else allowed.add(operation);
  }
  return { lifecycle, allowed, refused };
}

/** The refusal for one operation, or undefined when it is allowed. */
export const operationRefusal = (
  record: SessionMeta,
  operation: SessionOperation,
  actor?: SessionActor,
  runtime: { moving?: boolean } = {},
): OperationRefusal | undefined => allowedOperations(record, actor, runtime).refused[operation];

// ---------------------------------------------------------------------------
// Lineage
// ---------------------------------------------------------------------------

export interface SessionLineage {
  /** The source this record came from, then its source, … (those in `records`, nearest first). */
  ancestors: SessionMeta[];
  /** Records made from this one, directly or through another, breadth first. */
  descendants: SessionMeta[];
}

const sourceId = (record: SessionMeta): string | undefined => {
  const from: unknown = isObject(record.provenance) ? record.provenance.from : undefined;
  return isObject(from) && typeof from.sessionId === "string" ? from.sessionId : undefined;
};

/** Walk `provenance.from` both ways from `sessionId`. Cycle-safe; no store. */
export function lineage(records: readonly SessionMeta[], sessionId: string): SessionLineage {
  const byId = new Map(records.map((record) => [record.id, record]));
  const seen = new Set([sessionId]);
  const ancestors: SessionMeta[] = [];
  for (let id = byId.get(sessionId) && sourceId(byId.get(sessionId)!); id && !seen.has(id); ) {
    seen.add(id);
    const source = byId.get(id);
    if (!source) break;
    ancestors.push(source);
    id = sourceId(source);
  }
  const descendants: SessionMeta[] = [];
  const queue = [sessionId];
  const visited = new Set([sessionId]);
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const record of records) {
      if (visited.has(record.id) || sourceId(record) !== parent) continue;
      visited.add(record.id);
      descendants.push(record);
      queue.push(record.id);
    }
  }
  return { ancestors, descendants };
}
