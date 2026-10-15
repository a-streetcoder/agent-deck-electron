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
  type EventEnvelope,
  type LoopRunsProjection,
  type OpenHumanRequest,
  type ProjectedPlanDispatch,
  type ProjectedPlanChange,
  type ProjectedSupervisorRequest,
  type SubagentRunsProjection,
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
  /** SRV-15c: completed top-level turns per session, and the newest one's prompt label. */
  sessionTurns: Map<string, SessionTurnCount>;
  /** ts of the log's first event: older store history predates the log. */
  startedAt?: string;
}

export interface SessionTurnCount {
  turns: number;
  lastLabel?: string;
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
  /** SRV-15c: turn counts per session, caught up; undefined for the disabled log. */
  sessionTurns(): ReadonlyMap<string, SessionTurnCount> | undefined;
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
    sessionTurns: new Map(),
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
        countSessionTurn(state.sessionTurns, event);
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
    sessionTurns: () => (disabled ? undefined : catchUp().sessionTurns),
  };
}

/** A child's turns carry no sessionId (their parent is the run), so only top-level turns count. */
function countSessionTurn(counts: Map<string, SessionTurnCount>, event: EventEnvelope): void {
  if (!event.sessionId) return;
  if (event.kind === "session.removed") counts.delete(event.sessionId);
  if (event.kind !== "session.turn.completed") return;
  const label = (event.payload as { label?: unknown } | null)?.label;
  counts.set(event.sessionId, {
    turns: (counts.get(event.sessionId)?.turns ?? 0) + 1,
    ...(typeof label === "string" && label ? { lastLabel: label } : {}),
  });
}
