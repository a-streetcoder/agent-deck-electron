// A3 (VISION_ORCHESTRATION principle 5, delta not transcript): what a parent learns
// about one child run since it last looked, folded from the run's events between two
// cursors. Facts and references only: the full transcript stays in the Pi session
// file (the transcript route), files changed come from git (the server adds them).
//
// One fold, two windows. A run's tracker keeps the facts up to the parent's cursor
// (its last subagent.result.read) merged into one accumulator, and one small fact per
// event after it; a new cursor merges the facts it passes. So the tracker never holds
// raw events, and a look costs the events since the last look.
import type { EventEnvelope } from "./events.ts";
import type { PublicSubagentRunStatus, RunResult } from "./eventDiffs.ts";
import type { TurnOutcome, TurnToolCallRef } from "./turnRefs.ts";

/** The parent's last-looked cursor for a run: payload { uptoSeq }, subject the run. */
export const SUBAGENT_RESULT_READ = "subagent.result.read";
/** The newest answered decisions a window keeps. */
export const SUBAGENT_DELTA_MAX_DECISIONS = 20;
/** Facts a run keeps after the parent's cursor (one per event) before merging the oldest. */
export const SUBAGENT_DELTA_MAX_TAIL = 1_000;

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
  /** Undefined when no event of the run carried its state. */
  statusNow?: PublicSubagentRunStatus;
  /** The status at the cursor (later looks only). */
  statusThen?: PublicSubagentRunStatus;
  lastTurnOutcome?: TurnOutcome;
  /** Head of the newest result finished in the window (the log's public head). */
  summaryHead?: string;
  summaryBytes?: number;
  error?: string;
  /** That result is still the run's latest state (no update since): its owner may show the full text. */
  resultIsLatest?: true;
  /** The first look (sinceSeq 0): everything the log holds about the run. */
  full: boolean;
  /** The cursor this delta starts after. */
  sinceSeq: number;
  /** The newest run event folded in: the cursor to record once the delta is delivered. */
  uptoSeq: number;
  turnsCompleted: number;
  /** Turns whose entry refs could not be read in time (their tool calls are missing). */
  partialTurns?: number;
  /** Tool calls per tool name. */
  toolCalls: Record<string, number>;
  /** Names of the tools whose calls failed. */
  failedToolCalls: string[];
  /** Blocking child requests still pending now, whenever they were opened. */
  openQuestions: SubagentDeltaQuestion[];
  /** Requests answered in the window (the newest SUBAGENT_DELTA_MAX_DECISIONS). */
  decisions: SubagentDeltaDecision[];
}

/** Facts over a window of one run's events; a later window merges onto an earlier one. */
interface Facts {
  uptoSeq: number;
  status?: PublicSubagentRunStatus;
  turnsCompleted: number;
  partialTurns: number;
  lastTurnOutcome?: TurnOutcome;
  toolCalls: Record<string, number>;
  failedToolCalls: string[];
  decisions: SubagentDeltaDecision[];
  result?: RunResult;
}

const emptyFacts = (uptoSeq = 0): Facts => ({
  uptoSeq,
  turnsCompleted: 0,
  partialTurns: 0,
  toolCalls: {},
  failedToolCalls: [],
  decisions: [],
});

function mergeFacts(a: Facts, b: Facts): Facts {
  const toolCalls = { ...a.toolCalls };
  for (const [name, count] of Object.entries(b.toolCalls)) {
    toolCalls[name] = (toolCalls[name] ?? 0) + count;
  }
  const status = b.status ?? a.status;
  const lastTurnOutcome = b.lastTurnOutcome ?? a.lastTurnOutcome;
  const result = b.result ?? a.result;
  return {
    uptoSeq: Math.max(a.uptoSeq, b.uptoSeq),
    ...(status ? { status } : {}),
    turnsCompleted: a.turnsCompleted + b.turnsCompleted,
    partialTurns: a.partialTurns + b.partialTurns,
    ...(lastTurnOutcome ? { lastTurnOutcome } : {}),
    toolCalls,
    failedToolCalls: [...new Set([...a.failedToolCalls, ...b.failedToolCalls])],
    decisions: [...a.decisions, ...b.decisions].slice(-SUBAGENT_DELTA_MAX_DECISIONS),
    ...(result ? { result } : {}),
  };
}

export interface SubagentRunTracker {
  runId: string;
  status?: PublicSubagentRunStatus;
  /** Open blocking requests (a restart closes them: the supervisor restart rule). */
  pending: Map<string, SubagentDeltaQuestion>;
  /** The parent's cursor: the uptoSeq of its newest subagent.result.read. */
  cursor: number;
  /** Facts up to the cursor. */
  base: Facts;
  /** One fact per run event after the cursor, ascending. */
  tail: Facts[];
  /** The newest run event. */
  lastSeq: number;
  /** The newest subagent.run.finished: where a result hand-back puts the cursor. */
  lastFinishedSeq?: number;
  /** The newest run-state event is a finished one. */
  latestIsFinished: boolean;
}

type DeltaEvent = Pick<EventEnvelope, "seq" | "kind" | "subject" | "payload"> &
  Partial<Pick<EventEnvelope, "parent">>;

const question = (payload: Partial<SubagentDeltaQuestion> | null | undefined, id: string) => ({
  id,
  ...(payload?.method ? { method: payload.method } : {}),
  ...(payload?.title ? { title: payload.title } : {}),
  ...(payload?.message ? { message: payload.message } : {}),
});

/**
 * Every subagent run's tracker, fed events in seq order (the server's log fold feeds
 * it page by page). Removed runs are dropped; requests are joined to their run only
 * while open.
 */
export class SubagentDeltaIndex {
  private readonly runs = new Map<string, SubagentRunTracker>();
  private readonly requestRun = new Map<string, string>();

  get(runId: string): SubagentRunTracker | undefined {
    return this.runs.get(runId);
  }

  get size(): number {
    return this.runs.size;
  }

  apply(event: DeltaEvent): void {
    if (event.kind === "server.started" || event.kind === "writer.acquired") {
      for (const tracker of this.runs.values()) tracker.pending.clear();
      this.requestRun.clear();
      return;
    }
    if (event.kind === SUBAGENT_RESULT_READ) {
      const upto = (event.payload as { uptoSeq?: unknown } | null)?.uptoSeq;
      if (typeof upto === "number") this.advance(event.subject.id, upto);
      return;
    }
    if (event.subject.type === "subagentRun") {
      this.applyRunState(event);
      return;
    }
    if (event.parent?.type === "subagentRun") {
      const tracker = this.tracker(event.parent.id, event.seq);
      if (event.kind === "session.turn.completed") {
        const payload = (event.payload ?? {}) as {
          toolCalls?: TurnToolCallRef[];
          partial?: boolean;
          outcome?: TurnOutcome;
        };
        const fact = emptyFacts(event.seq);
        fact.turnsCompleted = 1;
        fact.lastTurnOutcome = payload.outcome ?? "completed";
        if (payload.partial) fact.partialTurns = 1;
        for (const call of payload.toolCalls ?? []) {
          fact.toolCalls[call.name] = (fact.toolCalls[call.name] ?? 0) + 1;
          if (call.isError === true && !fact.failedToolCalls.includes(call.name)) {
            fact.failedToolCalls.push(call.name);
          }
        }
        this.push(tracker, fact);
      } else if (
        event.kind === "supervisor.request.opened" &&
        event.subject.type === "supervisorRequest"
      ) {
        const id = event.subject.id;
        tracker.pending.set(id, question(event.payload as Partial<SubagentDeltaQuestion>, id));
        this.requestRun.set(id, tracker.runId);
      }
      return;
    }
    if (event.subject.type === "supervisorRequest") {
      const id = event.subject.id;
      const runId = this.requestRun.get(id);
      const tracker = runId ? this.runs.get(runId) : undefined;
      const open = tracker?.pending.get(id);
      if (!tracker || !open) return;
      if (
        event.kind !== "supervisor.request.answered" &&
        event.kind !== "supervisor.request.cancelled"
      )
        return;
      tracker.pending.delete(id);
      this.requestRun.delete(id);
      tracker.lastSeq = Math.max(tracker.lastSeq, event.seq);
      if (event.kind === "supervisor.request.answered") {
        const response = (event.payload as { response?: unknown } | null)?.response;
        const fact = emptyFacts(event.seq);
        fact.decisions.push({ ...open, ...(typeof response === "string" ? { response } : {}) });
        this.push(tracker, fact);
      }
    }
  }

  /** Record the parent's cursor; `create` starts a tracker for a run not seen yet. */
  advance(runId: string, uptoSeq: number, create = false): void {
    const tracker = create ? this.tracker(runId, 0) : this.runs.get(runId);
    if (!tracker || uptoSeq <= tracker.cursor) return;
    let passed = 0;
    while (passed < tracker.tail.length && (tracker.tail[passed] as Facts).uptoSeq <= uptoSeq) {
      tracker.base = mergeFacts(tracker.base, tracker.tail[passed] as Facts);
      passed += 1;
    }
    tracker.tail.splice(0, passed);
    tracker.cursor = uptoSeq;
  }

  /** The delta after the parent's cursor, or (`from: "start"`) the whole run. */
  delta(runId: string, from: "cursor" | "start"): SubagentDelta | undefined {
    const tracker = this.runs.get(runId);
    if (!tracker) return undefined;
    const since = tracker.tail.reduce(mergeFacts, emptyFacts(tracker.cursor));
    const sinceSeq = from === "start" ? 0 : tracker.cursor;
    const window = sinceSeq === 0 ? mergeFacts(tracker.base, since) : since;
    const result = window.result;
    const statusThen = sinceSeq > 0 ? tracker.base.status : undefined;
    return {
      runId,
      ...(tracker.status ? { statusNow: tracker.status } : {}),
      ...(statusThen ? { statusThen } : {}),
      ...(window.lastTurnOutcome ? { lastTurnOutcome: window.lastTurnOutcome } : {}),
      ...(result?.summary !== undefined ? { summaryHead: result.summary } : {}),
      ...(result?.summaryBytes !== undefined ? { summaryBytes: result.summaryBytes } : {}),
      ...(result?.error !== undefined ? { error: result.error } : {}),
      ...(result && tracker.latestIsFinished ? { resultIsLatest: true as const } : {}),
      full: sinceSeq === 0,
      sinceSeq,
      uptoSeq: Math.max(sinceSeq, tracker.lastSeq),
      turnsCompleted: window.turnsCompleted,
      ...(window.partialTurns ? { partialTurns: window.partialTurns } : {}),
      toolCalls: window.toolCalls,
      failedToolCalls: window.failedToolCalls,
      openQuestions: [...tracker.pending.values()],
      decisions: window.decisions,
    };
  }

  private tracker(runId: string, seq: number): SubagentRunTracker {
    let tracker = this.runs.get(runId);
    if (!tracker) {
      tracker = {
        runId,
        pending: new Map(),
        cursor: 0,
        base: emptyFacts(),
        tail: [],
        lastSeq: 0,
        latestIsFinished: false,
      };
      this.runs.set(runId, tracker);
    }
    tracker.lastSeq = Math.max(tracker.lastSeq, seq);
    return tracker;
  }

  // ponytail: a parent that never looks lets the tail reach the cap; past it the two
  // oldest facts merge, so a cursor landing between them counts both after it.
  private push(tracker: SubagentRunTracker, fact: Facts): void {
    tracker.tail.push(fact);
    if (tracker.tail.length > SUBAGENT_DELTA_MAX_TAIL) {
      const [first, second] = tracker.tail.splice(0, 2) as [Facts, Facts];
      tracker.tail.unshift(mergeFacts(first, second));
    }
  }

  private applyRunState(event: DeltaEvent): void {
    const runId = event.subject.id;
    if (event.kind === "subagent.run.removed") {
      const tracker = this.runs.get(runId);
      for (const id of tracker?.pending.keys() ?? []) this.requestRun.delete(id);
      this.runs.delete(runId);
      return;
    }
    const payload = event.payload as {
      run?: { status?: PublicSubagentRunStatus };
      result?: RunResult;
    } | null;
    const status = payload?.run?.status;
    if (!status) return;
    const tracker = this.tracker(runId, event.seq);
    tracker.status = status;
    const finished = event.kind === "subagent.run.finished";
    tracker.latestIsFinished = finished;
    const fact = emptyFacts(event.seq);
    fact.status = status;
    if (finished) {
      tracker.lastFinishedSeq = event.seq;
      fact.result = payload?.result ?? { status };
    }
    this.push(tracker, fact);
  }
}

/**
 * The pure form: fold `events` (ascending by seq, any superset of the run's) with
 * the cursor at sinceSeq. Read markers in `events` are ignored: the cursor is given.
 */
export function subagentDelta(
  events: Iterable<DeltaEvent>,
  { runId, sinceSeq }: { runId: string; sinceSeq: number },
): SubagentDelta {
  const index = new SubagentDeltaIndex();
  let placed = sinceSeq === 0;
  for (const event of events) {
    if (event.kind === SUBAGENT_RESULT_READ) continue;
    if (!placed && event.seq > sinceSeq) {
      index.advance(runId, sinceSeq, true);
      placed = true;
    }
    index.apply(event);
  }
  if (!placed) index.advance(runId, sinceSeq, true);
  return (
    index.delta(runId, "cursor") ?? {
      runId,
      full: true,
      sinceSeq: 0,
      uptoSeq: 0,
      turnsCompleted: 0,
      toolCalls: {},
      failedToolCalls: [],
      openQuestions: [],
      decisions: [],
    }
  );
}
