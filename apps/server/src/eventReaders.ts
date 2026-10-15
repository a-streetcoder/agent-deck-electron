// A1d: the read side of the cut-over ("move readers, not stores"). Plan history and
// the supervisor view take membership, order and status from the log's projections;
// the stores keep their writes and still supply exact detail by id.
import {
  projectPlans,
  projectSupervisor,
  type ProjectedPlanChange,
  type ProjectedSupervisorRequest,
} from "@agent-deck/domain";
import { MAX_EVENT_READ_LIMIT, type EventLog } from "./eventLog.ts";

export interface LogReaders {
  /** Undefined while the log cannot hold this process's writes (read-only or disabled): read the store. */
  supervisor(): ReadonlyMap<string, ProjectedSupervisorRequest> | undefined;
  plans(sessionId: string): readonly ProjectedPlanChange[] | undefined;
}

/** Projections folded incrementally: each read first folds the events appended since the last one. */
export function createLogReaders(log: EventLog): LogReaders {
  let afterSeq = 0;
  let supervisor = new Map<string, ProjectedSupervisorRequest>();
  let plans = new Map<string, ProjectedPlanChange[]>();
  const catchUp = (): boolean => {
    if (!log.writable) return false;
    while (log.lastSeq() > afterSeq) {
      const page = log.read({ afterSeq, limit: MAX_EVENT_READ_LIMIT });
      supervisor = projectSupervisor(page.events, supervisor);
      plans = projectPlans(page.events, plans);
      if (page.nextAfterSeq === undefined || page.nextAfterSeq <= afterSeq) break;
      afterSeq = page.nextAfterSeq;
    }
    return true;
  };
  return {
    supervisor: () => (catchUp() ? supervisor : undefined),
    plans: (sessionId) => (catchUp() ? (plans.get(sessionId) ?? []) : undefined),
  };
}
