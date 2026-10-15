// A1d: the log's projections, folded once and kept current ("move readers, not
// stores"). The startup reconcile, the after-gap resync, plan history and the
// supervisor view all read this one fold: each read first folds what was appended
// since the last one. A read-only process reads the writer's files the same way.
import {
  projectLoopRuns,
  projectOpenHumanRequests,
  projectPlanDispatches,
  projectPlans,
  projectSubagentRuns,
  projectSupervisor,
  SubagentDeltaIndex,
  type EventActor,
  type EventEnvelope,
  type LoopRunsProjection,
  type OpenHumanRequest,
  type ProjectedPlanDispatch,
  type ProjectedPlanChange,
  type ProjectedSupervisorRequest,
  type SubagentRunsProjection,
  type TurnOutcome,
  type TurnToolCallRef,
} from "@agent-deck/domain";
import { MAX_EVENT_READ_LIMIT, type EventLog } from "./eventLog.ts";

export interface LogProjections {
  subagent: SubagentRunsProjection;
  loop: LoopRunsProjection;
  supervisor: Map<string, ProjectedSupervisorRequest>;
  plans: Map<string, ProjectedPlanChange[]>;
  /** A5: plan.item.dispatched, latest per (session, item). */
  dispatches: Map<string, Map<string, ProjectedPlanDispatch>>;
  /** A3: per-run delta trackers (cursor-compacted; removed runs dropped). */
  subagentDeltas: SubagentDeltaIndex;
  /** A8: human requests still waiting on a person, over the whole log. */
  openHuman: Map<string, OpenHumanRequest>;
  /** SRV-15c: per session, its turn count and its newest turns and checkpoints (refs only). */
  sessionLogs: Map<string, SessionLogState>;
  /** ts of the log's first event: older store history predates the log. */
  startedAt?: string;
}

/** The newest turns and checkpoints a session keeps in the fold (older ones: the Pi file). */
export const SESSION_LOG_MAX_TURNS = 100;
export const SESSION_LOG_MAX_CHECKPOINTS = 5;
/** Entry ids a kept turn holds at its end: where its final assistant message is. */
export const SESSION_LOG_TAIL_ENTRY_IDS = 10;
const MAX_PENDING_AUTHORS = 50;

/** One turn as read_session shows it (from the log, or from the Pi file). */
export interface SessionTurnRef {
  /** Log turns: the seq and time of its session.turn.completed. */
  seq?: number;
  at?: string;
  /** Who sent the prompt that opened it (log turns only). */
  author?: EventActor;
  label: string;
  outcome?: TurnOutcome;
  partial?: boolean;
  toolCounts: Record<string, number>;
  failedTools: string[];
  firstEntryId?: string;
  entryCount: number;
  /** The last SESSION_LOG_TAIL_ENTRY_IDS entry ids, oldest first. */
  tailEntryIds: string[];
}

export interface SessionCheckpointRef {
  seq: number;
  at: string;
  turnIndex?: number;
  label: string;
}

export interface SessionLogState {
  /** Completed top-level turns over the whole log. */
  turns: number;
  lastLabel?: string;
  /** The newest seq of an event with this sessionId. */
  uptoSeq: number;
  /** The newest SESSION_LOG_MAX_TURNS turns, oldest first. */
  recent: SessionTurnRef[];
  /** The newest SESSION_LOG_MAX_CHECKPOINTS checkpoints, oldest first. */
  checkpoints: SessionCheckpointRef[];
  /** turn id -> who prompted it, until the turn completes. */
  authors: Map<string, EventActor>;
}

export interface LogReaders {
  /** Current projections (do not mutate). */
  projections(): LogProjections;
  /** Undefined for the disabled log: read the store. */
  supervisor(): ReadonlyMap<string, ProjectedSupervisorRequest> | undefined;
  plans(sessionId: string): readonly ProjectedPlanChange[] | undefined;
  /** A3: the delta trackers, caught up; undefined for the disabled log. */
  subagentDeltas(): SubagentDeltaIndex | undefined;
  /** A8: open human requests, caught up (empty for the disabled log). */
  openHuman(): ReadonlyMap<string, OpenHumanRequest>;
  /** SRV-15c: per-session turn refs, caught up; undefined for the disabled log. */
  sessionLogs(): ReadonlyMap<string, SessionLogState> | undefined;
  /** ts of the log's first event (undefined: disabled or empty). */
  startedAt(): string | undefined;
}

// ponytail: every boot folds all history; projection snapshots when startup passes ~1 s.
export function createLogReaders(log: EventLog): LogReaders {
  // disabledEventLog() is the only log without an id: it holds nothing to read.
  const disabled = log.logId === "";
  let afterSeq = 0;
  const state: LogProjections = {
    subagent: new Map(),
    loop: new Map(),
    supervisor: new Map(),
    plans: new Map(),
    dispatches: new Map(),
    subagentDeltas: new SubagentDeltaIndex(),
    openHuman: new Map(),
    sessionLogs: new Map(),
  };
  const catchUp = (): LogProjections => {
    while (log.lastSeq() > afterSeq) {
      const page = log.read({ afterSeq, limit: MAX_EVENT_READ_LIMIT });
      state.startedAt ??= page.events[0]?.ts;
      state.subagent = projectSubagentRuns(page.events, state.subagent.values());
      state.loop = projectLoopRuns(page.events, state.loop.values());
      state.supervisor = projectSupervisor(page.events, state.supervisor);
      state.plans = projectPlans(page.events, state.plans);
      state.dispatches = projectPlanDispatches(page.events, state.dispatches);
      state.openHuman = projectOpenHumanRequests(page.events, state.openHuman);
      for (const event of page.events) {
        state.subagentDeltas.apply(event);
        foldSessionLog(state.sessionLogs, event);
      }
      if (page.nextAfterSeq === undefined || page.nextAfterSeq <= afterSeq) break;
      afterSeq = page.nextAfterSeq;
    }
    return state;
  };
  return {
    projections: catchUp,
    supervisor: () => (disabled ? undefined : catchUp().supervisor),
    plans: (sessionId) => (disabled ? undefined : (catchUp().plans.get(sessionId) ?? [])),
    subagentDeltas: () => (disabled ? undefined : catchUp().subagentDeltas),
    openHuman: () => (disabled ? new Map() : catchUp().openHuman),
    sessionLogs: () => (disabled ? undefined : catchUp().sessionLogs),
    startedAt: () => (disabled ? undefined : catchUp().startedAt),
  };
}

/**
 * SRV-15c: one session's refs, incremental. A child's turns carry no sessionId (their
 * parent is the run), so only top-level turns count.
 */
export function foldSessionLog(logs: Map<string, SessionLogState>, event: EventEnvelope): void {
  const sessionId = event.sessionId;
  if (!sessionId) return;
  if (event.kind === "session.removed") {
    logs.delete(sessionId);
    return;
  }
  let state = logs.get(sessionId);
  if (!state) {
    state = { turns: 0, uptoSeq: 0, recent: [], checkpoints: [], authors: new Map() };
    logs.set(sessionId, state);
  }
  state.uptoSeq = Math.max(state.uptoSeq, event.seq);
  // The prompt that opened a turn (a steer or follow-up joins it: no parent edge).
  if (event.kind === "turn.prompted" && event.parent?.type === "session") {
    if (!state.authors.has(event.subject.id)) state.authors.set(event.subject.id, event.actor);
    if (state.authors.size > MAX_PENDING_AUTHORS) {
      state.authors.delete(state.authors.keys().next().value as string);
    }
    return;
  }
  if (event.kind === "checkpoint.created") {
    const payload = (event.payload ?? {}) as { turnIndex?: unknown; label?: unknown };
    state.checkpoints.push({
      seq: event.seq,
      at: event.ts,
      ...(typeof payload.turnIndex === "number" ? { turnIndex: payload.turnIndex } : {}),
      label: typeof payload.label === "string" ? payload.label : "",
    });
    if (state.checkpoints.length > SESSION_LOG_MAX_CHECKPOINTS) state.checkpoints.shift();
    return;
  }
  if (event.kind !== "session.turn.completed") return;
  const payload = (event.payload ?? {}) as Partial<{
    label: unknown;
    outcome: TurnOutcome;
    partial: unknown;
    toolCalls: unknown;
    entryIds: unknown;
  }>;
  const label = typeof payload.label === "string" ? payload.label : "";
  const calls = Array.isArray(payload.toolCalls) ? (payload.toolCalls as TurnToolCallRef[]) : [];
  const entryIds = Array.isArray(payload.entryIds)
    ? payload.entryIds.filter((id): id is string => typeof id === "string")
    : [];
  const toolCounts: Record<string, number> = {};
  const failed = new Set<string>();
  for (const call of calls) {
    const name = typeof call?.name === "string" ? call.name : "";
    toolCounts[name] = (toolCounts[name] ?? 0) + 1;
    if (call?.isError === true) failed.add(name);
  }
  const author = state.authors.get(event.subject.id);
  state.authors.delete(event.subject.id);
  state.turns += 1;
  if (label) state.lastLabel = label;
  else delete state.lastLabel;
  state.recent.push({
    seq: event.seq,
    at: event.ts,
    ...(author ? { author } : {}),
    label,
    outcome: payload.outcome ?? "completed",
    ...(payload.partial === true ? { partial: true } : {}),
    toolCounts,
    failedTools: [...failed],
    ...(entryIds[0] ? { firstEntryId: entryIds[0] } : {}),
    entryCount: entryIds.length,
    tailEntryIds: entryIds.slice(-SESSION_LOG_TAIL_ENTRY_IDS),
  });
  if (state.recent.length > SESSION_LOG_MAX_TURNS) state.recent.shift();
}
