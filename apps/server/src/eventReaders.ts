// A1d: the log's projections, folded once and kept current ("move readers, not
// stores"). The startup reconcile, the after-gap resync, plan history and the
// supervisor view all read this one fold: each read first folds what was appended
// since the last one. A read-only process reads the writer's files the same way.
import {
  projectLoopRuns,
  projectPlanDispatches,
  projectPlans,
  projectSubagentRuns,
  projectSupervisor,
  type LoopRunsProjection,
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
  /** ts of the log's first event: older store history predates the log. */
  startedAt?: string;
}

export interface LogReaders {
  /** Current projections (do not mutate). */
  projections(): LogProjections;
  /** Undefined for the disabled log: read the store. */
  supervisor(): ReadonlyMap<string, ProjectedSupervisorRequest> | undefined;
  plans(sessionId: string): readonly ProjectedPlanChange[] | undefined;
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
      if (page.nextAfterSeq === undefined || page.nextAfterSeq <= afterSeq) break;
      afterSeq = page.nextAfterSeq;
    }
    return state;
  };
  return {
    projections: catchUp,
    supervisor: () => (disabled ? undefined : catchUp().supervisor),
    plans: (sessionId) => (disabled ? undefined : (catchUp().plans.get(sessionId) ?? [])),
  };
}
