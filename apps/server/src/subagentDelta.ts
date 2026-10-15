// A3: the server half of the delta merge-back (VISION_ORCHESTRATION principle 5).
// The per-run trackers live in the log readers' fold (SubagentDeltaIndex, fed with
// the same pages as every other projection); this module answers one look, records
// the parent's cursor (subagent.result.read) after a delivery, adds the files the
// child changed in its retained worktree (git) and shapes the bounded model text.
import { existsSync } from "node:fs";
import {
  textHead,
  type SubagentDelta,
  type SubagentDeltaIndex,
  type SubagentDeltaQuestion,
} from "@agent-deck/domain";
import { gitDiffNameStatus, gitListUntracked } from "./git.ts";
import type { SubagentRunRecord } from "./subagentRunStore.ts";

/** The model text never exceeds this many characters, and is always valid JSON. */
export const SUBAGENT_DELTA_MAX_CHARS = 16_000;
export const SUBAGENT_DELTA_MAX_FILES = 200;
const QUESTION_FIELD_MAX_CHARS = 500;
const ERROR_MAX_CHARS = 4_000;
const PATH_MAX_CHARS = 300;

export interface SubagentDeltaView extends SubagentDelta {
  /** The owner's full private result (the model's look at a finished, latest result). */
  summary?: string;
  /**
   * Repo-relative paths changed in the child's retained worktree since its base
   * commit: cumulative, so present only on a full look or when turns completed.
   */
  filesChangedSinceBase?: string[];
  filesChangedSinceBaseOmitted?: number;
  /** git could not list them (the worktree was removed or is broken). */
  filesChangedSinceBaseUnavailable?: true;
  /** The full child transcript on demand (the web card's link; not in the model text). */
  transcript: { sessionId: string; runId: string; transcriptRoute: string };
}

export type SubagentDeltaRead =
  | { ok: true; delta: SubagentDeltaView; hasEvents: boolean }
  | { ok: false; reason: "not_found" };

export interface SubagentDeltaReader {
  /**
   * One look at a run owned by callerSessionId: after the parent's cursor, or from
   * the start. `privateResult` swaps the log's result head for the owner's full text.
   */
  read(
    callerSessionId: string,
    runId: string,
    options: { from: "cursor" | "start"; privateResult?: boolean },
  ): Promise<SubagentDeltaRead>;
  /** Record the cursor once a delta was delivered (monotonic: an older one is skipped). */
  delivered(callerSessionId: string, runId: string, uptoSeq: number): void;
  /**
   * A result hand-back (managed_subagent, managed_parallel, await_subagents) delivered
   * the run's newest finished event: the next look starts after it.
   */
  resultsDelivered(callerSessionId: string, runs: readonly string[] | { toolCallId: string }): void;
}

export interface SubagentDeltaDeps {
  /** The caught-up trackers; undefined when the log is disabled. */
  index: () => SubagentDeltaIndex | undefined;
  runs: {
    get(id: string): SubagentRunRecord | undefined;
    list(parentSessionId: string): SubagentRunRecord[];
  };
  /** Append subagent.result.read; false when the log refused it (read-only, closed). */
  recordRead: (parentSessionId: string, runId: string, uptoSeq: number) => boolean;
  warn?: (message: string, error?: unknown) => void;
}

const terminal = (status: string): boolean => status !== "starting" && status !== "running";

export async function filesChanged(
  record: SubagentRunRecord,
  warn: (message: string, error?: unknown) => void,
): Promise<Partial<SubagentDeltaView>> {
  const dir = record.worktreePath;
  const base = record.worktreeBaseCommit;
  // No retained worktree: the child ran in the parent's checkout, nothing to attribute.
  if (!dir || !base) return { filesChangedSinceBase: [] };
  // Removed after a merge (or by hand): the answer is unknown, not "nothing".
  if (record.worktreeCleanup === "physical_removed" || !existsSync(dir)) {
    return { filesChangedSinceBase: [], filesChangedSinceBaseUnavailable: true };
  }
  try {
    const [changed, untracked] = await Promise.all([
      gitDiffNameStatus(dir, base),
      gitListUntracked(dir),
    ]);
    const files = [...new Set([...changed.map((entry) => entry.path), ...untracked])].sort();
    return {
      filesChangedSinceBase: files.slice(0, SUBAGENT_DELTA_MAX_FILES),
      ...(files.length > SUBAGENT_DELTA_MAX_FILES
        ? { filesChangedSinceBaseOmitted: files.length - SUBAGENT_DELTA_MAX_FILES }
        : {}),
    };
  } catch (error) {
    warn(`[subagent-delta] git could not list the files of run ${record.id}`, error);
    return { filesChangedSinceBase: [], filesChangedSinceBaseUnavailable: true };
  }
}

/** What the store knows about a run the log has no events for. */
const storeOnlyDelta = (record: SubagentRunRecord): SubagentDelta => ({
  runId: record.id,
  statusNow: record.status,
  ...(record.summary !== undefined ? { summaryHead: record.summary } : {}),
  ...(record.error !== undefined ? { error: record.error } : {}),
  full: true,
  sinceSeq: 0,
  uptoSeq: 0,
  turnsCompleted: 0,
  toolCalls: {},
  failedToolCalls: [],
  openQuestions: [],
  decisions: [],
});

export function createSubagentDeltaReader(deps: SubagentDeltaDeps): SubagentDeltaReader {
  const warn = deps.warn ?? (() => {});
  let warnedReadOnly = false;
  const owned = (caller: string, runId: string): SubagentRunRecord | undefined => {
    const record = deps.runs.get(runId);
    return record && record.parentSessionId === caller ? record : undefined;
  };

  const reader: SubagentDeltaReader = {
    async read(callerSessionId, runId, { from, privateResult = false }) {
      const record = owned(callerSessionId, runId);
      if (!record) return { ok: false, reason: "not_found" };
      const fromLog = deps.index()?.delta(runId, from);
      const delta: SubagentDeltaView = {
        ...(fromLog ?? storeOnlyDelta(record)),
        transcript: {
          sessionId: record.parentSessionId,
          runId,
          transcriptRoute: `/sessions/${encodeURIComponent(record.parentSessionId)}/subagent-runs/${encodeURIComponent(runId)}/transcript`,
        },
      };
      // A run older than the log carries no state event: the store knows its status.
      delta.statusNow ??= record.status;
      if (privateResult && delta.resultIsLatest && terminal(record.status)) {
        delete delta.summaryHead;
        delete delta.error;
        if (record.summary !== undefined) delta.summary = record.summary;
        if (record.error !== undefined) delta.error = record.error;
      }
      if (delta.full || delta.turnsCompleted > 0) {
        Object.assign(delta, await filesChanged(record, warn));
      }
      return { ok: true, delta, hasEvents: fromLog !== undefined };
    },

    delivered(callerSessionId, runId, uptoSeq) {
      const tracker = deps.index()?.get(runId);
      if (!tracker || uptoSeq <= tracker.cursor) return;
      if (deps.recordRead(callerSessionId, runId, uptoSeq)) return;
      if (!warnedReadOnly) {
        warnedReadOnly = true;
        warn(
          "[subagent-delta] the event log refused the read cursor (read-only or closed): every look stays a full summary",
        );
      }
    },

    resultsDelivered(callerSessionId, runs) {
      const ids = Array.isArray(runs)
        ? runs
        : deps.runs
            .list(callerSessionId)
            .filter(
              (record) => record.turnToolCallId === (runs as { toolCallId: string }).toolCallId,
            )
            .map((record) => record.id);
      for (const runId of ids) {
        const record = owned(callerSessionId, runId);
        const finishedSeq = deps.index()?.get(runId)?.lastFinishedSeq;
        if (record && terminal(record.status) && finishedSeq !== undefined) {
          reader.delivered(callerSessionId, runId, finishedSeq);
        }
      }
    },
  };
  return reader;
}

const capQuestion = <T extends SubagentDeltaQuestion & { response?: string }>(item: T): T => {
  const out = { ...item };
  for (const key of ["title", "message", "response"] as const) {
    const value = out[key];
    if (typeof value === "string")
      out[key] = textHead(value, QUESTION_FIELD_MAX_CHARS) as T[typeof key];
  }
  return out;
};

/**
 * The tool result: the delta as compact JSON, newest state first, always valid and
 * within SUBAGENT_DELTA_MAX_CHARS. Over the cap it drops the rarest tool names, then
 * files, then the oldest decisions and questions, then cuts the result text.
 */
export function renderSubagentDelta(view: SubagentDeltaView, hasEvents = true): string {
  const files = (view.filesChangedSinceBase ?? []).map((file) => textHead(file, PATH_MAX_CHARS));
  const toolCalls = Object.entries(view.toolCalls).sort((a, b) => b[1] - a[1]);
  let decisions = view.decisions.map(capQuestion);
  let questions = view.openQuestions.map(capQuestion);
  let summary = view.summary ?? view.summaryHead;
  let error =
    view.error !== undefined && view.error.length > ERROR_MAX_CHARS
      ? `…${view.error.slice(-ERROR_MAX_CHARS)}`
      : view.error;
  const omitted = {
    toolNames: 0,
    files: view.filesChangedSinceBaseOmitted ?? 0,
    decisions: 0,
    questions: 0,
  };
  let keptTools = toolCalls.length;
  let keptFiles = files.length;
  let summaryTruncated = false;

  const text = (): string =>
    JSON.stringify({
      statusNow: view.statusNow,
      lastTurnOutcome: view.lastTurnOutcome,
      summary,
      ...(summaryTruncated ? { summaryTruncated: true, summaryBytes: view.summaryBytes } : {}),
      error,
      statusThen: view.statusThen,
      runId: view.runId,
      ...(hasEvents
        ? {}
        : { note: "No event history for this run: status and result from the store." }),
      full: view.full,
      sinceSeq: view.sinceSeq,
      uptoSeq: view.uptoSeq,
      turnsCompleted: view.turnsCompleted,
      partialTurns: view.partialTurns,
      toolCalls: Object.fromEntries(toolCalls.slice(0, keptTools)),
      ...(omitted.toolNames ? { toolNamesOmitted: omitted.toolNames } : {}),
      failedToolCalls: view.failedToolCalls,
      ...(view.filesChangedSinceBase
        ? {
            filesChangedSinceBase: files.slice(0, keptFiles),
            ...(omitted.files ? { filesChangedSinceBaseOmitted: omitted.files } : {}),
            ...(view.filesChangedSinceBaseUnavailable
              ? { filesChangedSinceBaseUnavailable: true }
              : {}),
          }
        : {}),
      openQuestions: questions,
      ...(omitted.questions ? { openQuestionsOmitted: omitted.questions } : {}),
      decisions,
      ...(omitted.decisions ? { decisionsOmitted: omitted.decisions } : {}),
    });
  const over = (): number => text().length - SUBAGENT_DELTA_MAX_CHARS;

  while (over() > 0 && keptTools > 0) {
    const keep = Math.floor(keptTools / 2);
    omitted.toolNames += keptTools - keep;
    keptTools = keep;
  }
  while (over() > 0 && keptFiles > 0) {
    const keep = Math.floor(keptFiles / 2);
    omitted.files += keptFiles - keep;
    keptFiles = keep;
  }
  while (over() > 0 && decisions.length > 0) {
    const keep = Math.floor(decisions.length / 2);
    omitted.decisions += decisions.length - keep;
    decisions = keep ? decisions.slice(-keep) : [];
  }
  while (over() > 0 && questions.length > 0) {
    const keep = Math.floor(questions.length / 2);
    omitted.questions += questions.length - keep;
    questions = questions.slice(0, keep);
  }
  // Escapes make the JSON longer than the text, so cut by the excess and re-measure.
  while (over() > 0 && summary) {
    summaryTruncated = true;
    summary = textHead(summary, Math.max(0, summary.length - over() - 1));
    if (summary === "…") summary = "";
  }
  while (over() > 0 && error) {
    error = textHead(error, Math.max(0, error.length - over() - 1));
    if (error === "…") error = "";
  }
  const out = text();
  return out.length <= SUBAGENT_DELTA_MAX_CHARS
    ? out
    : JSON.stringify({ statusNow: view.statusNow, runId: view.runId, truncated: true });
}
