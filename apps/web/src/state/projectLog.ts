import type { EventEnvelope } from "@agent-deck/domain";

/** A1c: the open project's tail of the event log (GET /events + project_events nudges). */
export const PROJECT_LOG_LIMIT = 2_000;

export interface ProjectLogState {
  /** The open project; null = no project open, which shows every project's events. */
  projectId: string | null;
  logId: string;
  /** The afterSeq cursor: events at or below it are already applied. */
  lastSeq: number;
  /** Ascending by seq, the newest PROJECT_LOG_LIMIT. */
  events: EventEnvelope[];
}

/** The GET /events response. */
export interface ProjectEventPage {
  logId: string;
  lastSeq: number;
  events: EventEnvelope[];
  more: boolean;
  nextAfterSeq?: number;
  nextBeforeSeq?: number;
}

/**
 * Applies one page. A different project or logId starts over (the server's log was
 * replaced); otherwise seqs at or below the cursor are dropped, and gaps are normal
 * (other projects' events, dedupe). A forward page advances the cursor to its
 * nextAfterSeq; a tail page (no afterSeq) to the server's lastSeq.
 */
export function ingestProjectEvents(
  previous: ProjectLogState | null,
  projectId: string | null,
  page: ProjectEventPage,
): ProjectLogState {
  const same = previous?.projectId === projectId && previous.logId === page.logId;
  const floor = same ? previous.lastSeq : 0;
  const fresh = page.events.filter((event) => event.seq > floor);
  return {
    projectId,
    logId: page.logId,
    lastSeq: Math.max(floor, page.nextAfterSeq ?? page.lastSeq),
    events: (same ? [...previous.events, ...fresh] : fresh).slice(-PROJECT_LOG_LIMIT),
  };
}
