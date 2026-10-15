// A3 (VISION_ORCHESTRATION principle 5, delta not transcript): what a parent learns
// about one child run since it last looked, folded from the run's events between two
// cursors. Facts and references only: the full transcript stays in the Pi session
// file (the transcript route), files touched come from git (the server adds them).
import type { EventEnvelope } from "./events.ts";
import {
  projectSubagentRuns,
  projectSupervisor,
  type PublicSubagentRunStatus,
  type RunResult,
} from "./eventDiffs.ts";
import type { TurnOutcome, TurnToolCallRef } from "./turnRefs.ts";

/** The parent's last-looked cursor for a run: payload { uptoSeq }, subject the run. */
export const SUBAGENT_RESULT_READ = "subagent.result.read";
/** The newest tool calls are kept; older ones are counted in toolCallsOmitted. */
export const SUBAGENT_DELTA_MAX_TOOL_CALLS = 100;

export interface SubagentDeltaQuestion {
  id: string;
  method?: string;
  title?: string;
  message?: string;
}

export interface SubagentDeltaDecision extends SubagentDeltaQuestion {
  response?: string;
}

export interface SubagentDelta {
  runId: string;
  /** The cursor this delta starts after (0: the first look). */
  sinceSeq: number;
  /** The newest run event folded in: the next look's sinceSeq. */
  uptoSeq: number;
  /** The first look: everything the log holds about the run. */
  full: boolean;
  /** Undefined when the log has no created event for the run (it predates the log). */
  statusNow?: PublicSubagentRunStatus;
  /** The status at the cursor (later looks only). */
  statusThen?: PublicSubagentRunStatus;
  /** Child turns completed since the cursor. */
  turnsCompleted: number;
  lastTurnOutcome?: TurnOutcome;
  /** Turns whose entry refs could not be read in time (their tool calls are missing). */
  partialTurns?: number;
  toolCallsSinceLastLook: TurnToolCallRef[];
  toolCallsOmitted?: number;
  /** Blocking child requests still pending now, whenever they were opened. */
  openQuestions: SubagentDeltaQuestion[];
  /** Requests answered since the cursor. */
  decisions: SubagentDeltaDecision[];
  /** Head of the newest result finished since the cursor. */
  summaryHead?: string;
  summaryBytes?: number;
  error?: string;
}

type DeltaEvent = Pick<EventEnvelope, "seq" | "kind" | "subject" | "payload" | "actor"> &
  Partial<Pick<EventEnvelope, "parent" | "id" | "ts" | "sessionId">>;

const isRestart = (event: DeltaEvent): boolean =>
  event.kind === "server.started" || event.kind === "writer.acquired";

/**
 * The run's own events, from events ascending by seq: run lifecycle, the child's turns, its
 * supervisor requests and their answers (joined on the request id), plus the
 * restart markers the supervisor fold needs. The parent's read markers are not part
 * of the run's history.
 */
export function subagentRunEvents<T extends DeltaEvent>(events: Iterable<T>, runId: string): T[] {
  const requests = new Set<string>();
  const out: T[] = [];
  for (const event of events) {
    if (event.kind === SUBAGENT_RESULT_READ) continue;
    const own =
      (event.subject.type === "subagentRun" && event.subject.id === runId) ||
      (event.parent?.type === "subagentRun" && event.parent.id === runId);
    if (own && event.subject.type === "supervisorRequest") requests.add(event.subject.id);
    if (
      own ||
      isRestart(event) ||
      (event.subject.type === "supervisorRequest" && requests.has(event.subject.id))
    ) {
      out.push(event);
    }
  }
  return out.sort((a, b) => a.seq - b.seq);
}

/** The parent's last cursor for a run: the newest subagent.result.read uptoSeq, else 0. */
export function lastSubagentReadSeq(events: Iterable<DeltaEvent>, runId: string): number {
  let seq = 0;
  for (const event of events) {
    if (event.kind !== SUBAGENT_RESULT_READ || event.subject.id !== runId) continue;
    const upto = (event.payload as { uptoSeq?: unknown } | null)?.uptoSeq;
    if (typeof upto === "number" && upto > seq) seq = upto;
  }
  return seq;
}

const question = (request: {
  id: string;
  method?: string;
  title?: string;
  message?: string;
}): SubagentDeltaQuestion => ({
  id: request.id,
  ...(request.method ? { method: request.method } : {}),
  ...(request.title ? { title: request.title } : {}),
  ...(request.message ? { message: request.message } : {}),
});

/**
 * Fold a run's events into what changed after sinceSeq. `events` may be the whole
 * log or any superset of the run's events; status and open questions are folded
 * over all of them, everything else only over the events after the cursor.
 */
export function subagentDelta(
  events: Iterable<DeltaEvent>,
  { runId, sinceSeq }: { runId: string; sinceSeq: number },
): SubagentDelta {
  const own = subagentRunEvents(events, runId);
  const runEvents = own.filter((event) => !isRestart(event));
  const after = runEvents.filter((event) => event.seq > sinceSeq);
  const statusAt = (upto: number): PublicSubagentRunStatus | undefined =>
    projectSubagentRuns(runEvents.filter((event) => event.seq <= upto)).get(runId)?.status;

  const delta: SubagentDelta = {
    runId,
    sinceSeq,
    uptoSeq: Math.max(sinceSeq, runEvents.at(-1)?.seq ?? 0),
    full: sinceSeq === 0,
    turnsCompleted: 0,
    toolCallsSinceLastLook: [],
    openQuestions: [],
    decisions: [],
  };
  const statusNow = statusAt(Number.POSITIVE_INFINITY);
  if (statusNow) delta.statusNow = statusNow;
  const statusThen = sinceSeq > 0 ? statusAt(sinceSeq) : undefined;
  if (statusThen) delta.statusThen = statusThen;

  const toolCalls: TurnToolCallRef[] = [];
  let partialTurns = 0;
  const answered = new Set<string>();
  for (const event of after) {
    if (event.kind === "session.turn.completed") {
      const payload = (event.payload ?? {}) as {
        toolCalls?: TurnToolCallRef[];
        partial?: boolean;
        outcome?: TurnOutcome;
      };
      delta.turnsCompleted += 1;
      delta.lastTurnOutcome = payload.outcome ?? "completed";
      if (payload.partial) partialTurns += 1;
      for (const call of payload.toolCalls ?? []) {
        toolCalls.push({ id: call.id, name: call.name, isError: call.isError === true });
      }
    } else if (event.kind === "supervisor.request.answered") {
      answered.add(event.subject.id);
    } else if (event.kind === "subagent.run.finished") {
      const result = (event.payload as { result?: RunResult } | null)?.result;
      delete delta.summaryHead;
      delete delta.summaryBytes;
      delete delta.error;
      if (result?.summary !== undefined) delta.summaryHead = result.summary;
      if (result?.summaryBytes !== undefined) delta.summaryBytes = result.summaryBytes;
      if (result?.error !== undefined) delta.error = result.error;
    }
  }
  if (partialTurns) delta.partialTurns = partialTurns;
  delta.toolCallsSinceLastLook = toolCalls.slice(-SUBAGENT_DELTA_MAX_TOOL_CALLS);
  if (toolCalls.length > SUBAGENT_DELTA_MAX_TOOL_CALLS) {
    delta.toolCallsOmitted = toolCalls.length - SUBAGENT_DELTA_MAX_TOOL_CALLS;
  }

  for (const request of projectSupervisor(own).values()) {
    if (request.status === "pending") delta.openQuestions.push(question(request));
    else if (request.status === "answered" && answered.has(request.id)) {
      delta.decisions.push({
        ...question(request),
        ...(request.response ? { response: request.response } : {}),
      });
    }
  }
  return delta;
}
