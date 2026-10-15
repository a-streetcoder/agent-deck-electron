// A3: the server half of the delta merge-back (VISION_ORCHESTRATION principle 5).
// The pure fold is subagentDelta in @agent-deck/domain; this module feeds it the
// run's events from the log, finds the parent's last cursor (its own
// subagent.result.read events), adds the files the child touched (git, in its
// retained worktree) and points at the full transcript route.
import { existsSync } from "node:fs";
import {
  lastSubagentReadSeq,
  SUBAGENT_RESULT_READ,
  subagentDelta,
  textHead,
  type EventEnvelope,
  type SubagentDelta,
} from "@agent-deck/domain";
import { MAX_EVENT_READ_LIMIT, type EventLog } from "./eventLog.ts";
import { gitDiffNameStatus, gitListUntracked } from "./git.ts";
import type { SubagentRunRecord } from "./subagentRunStore.ts";

/** The model gets at most this much delta text, like other bounded hand-offs. */
export const SUBAGENT_DELTA_MAX_CHARS = 16_000;
export const SUBAGENT_DELTA_MAX_FILES = 200;

export interface SubagentDeltaView extends SubagentDelta {
  /** Repo-relative paths changed in the child's worktree since its base commit. */
  filesTouched: string[];
  filesTouchedOmitted?: number;
  /** git could not list them (the worktree is gone or broken); filesTouched is empty. */
  filesTouchedUnavailable?: true;
  /** The full child transcript, on demand (the transcript route of the parent session). */
  transcript: { sessionId: string; runId: string; transcriptRoute: string };
}

export type SubagentDeltaRead =
  | { ok: true; delta: SubagentDeltaView; hasEvents: boolean; record: SubagentRunRecord }
  | { ok: false; reason: "not_found" };

export interface SubagentDeltaReader {
  /**
   * The delta of one run owned by callerSessionId. `since: "lastRead"` starts after
   * the parent's last subagent.result.read (the bridge tool); `"start"` is the full
   * summary (the web card), and never moves the parent's cursor.
   */
  read(
    callerSessionId: string,
    runId: string,
    since: "lastRead" | "start",
  ): Promise<SubagentDeltaRead>;
}

const relevant = (event: EventEnvelope): boolean =>
  event.subject.type === "subagentRun" ||
  event.parent?.type === "subagentRun" ||
  event.subject.type === "supervisorRequest" ||
  event.kind === "server.started" ||
  event.kind === "writer.acquired";

async function filesTouched(
  record: SubagentRunRecord,
  warn: (message: string, error?: unknown) => void,
): Promise<
  Pick<SubagentDeltaView, "filesTouched" | "filesTouchedOmitted" | "filesTouchedUnavailable">
> {
  const dir = record.worktreePath;
  const base = record.worktreeBaseCommit;
  // No retained worktree: the child ran in the parent's checkout, nothing to attribute.
  if (!dir || !base || record.worktreeCleanup === "physical_removed") return { filesTouched: [] };
  if (!existsSync(dir)) return { filesTouched: [], filesTouchedUnavailable: true };
  try {
    const [changed, untracked] = await Promise.all([
      gitDiffNameStatus(dir, base),
      gitListUntracked(dir),
    ]);
    const files = [...new Set([...changed.map((entry) => entry.path), ...untracked])].sort();
    return {
      filesTouched: files.slice(0, SUBAGENT_DELTA_MAX_FILES),
      ...(files.length > SUBAGENT_DELTA_MAX_FILES
        ? { filesTouchedOmitted: files.length - SUBAGENT_DELTA_MAX_FILES }
        : {}),
    };
  } catch (error) {
    warn(`[subagent-delta] git could not list the files of run ${record.id}`, error);
    return { filesTouched: [], filesTouchedUnavailable: true };
  }
}

export function createSubagentDeltaReader(
  log: Pick<EventLog, "lastSeq" | "read">,
  runs: { get(id: string): SubagentRunRecord | undefined },
  warn: (message: string, error?: unknown) => void = () => {},
): SubagentDeltaReader {
  // ponytail: every subagent-related event since boot stays in memory (a few per
  // run); fold per run or snapshot with A1e when the log outgrows that.
  const events: EventEnvelope[] = [];
  let afterSeq = 0;
  const catchUp = (): void => {
    while (log.lastSeq() > afterSeq) {
      const page = log.read({ afterSeq, limit: MAX_EVENT_READ_LIMIT });
      for (const event of page.events) if (relevant(event)) events.push(event);
      if (page.nextAfterSeq === undefined || page.nextAfterSeq <= afterSeq) break;
      afterSeq = page.nextAfterSeq;
    }
  };

  return {
    async read(callerSessionId, runId, since) {
      const record = runs.get(runId);
      if (!record || record.parentSessionId !== callerSessionId) {
        return { ok: false, reason: "not_found" };
      }
      catchUp();
      const reads = events.filter(
        (event) => event.kind === SUBAGENT_RESULT_READ && event.sessionId === callerSessionId,
      );
      const sinceSeq = since === "lastRead" ? lastSubagentReadSeq(reads, runId) : 0;
      const delta = subagentDelta(events, { runId, sinceSeq });
      const hasEvents = events.some(
        (event) =>
          (event.subject.type === "subagentRun" && event.subject.id === runId) ||
          (event.parent?.type === "subagentRun" && event.parent.id === runId),
      );
      // A run older than the log has no created event: the store knows its status.
      delta.statusNow ??= record.status;
      const transcriptRoute = `/sessions/${encodeURIComponent(record.parentSessionId)}/subagent-runs/${encodeURIComponent(runId)}/transcript`;
      return {
        ok: true,
        hasEvents,
        record,
        delta: {
          ...delta,
          ...(await filesTouched(record, warn)),
          transcript: { sessionId: record.parentSessionId, runId, transcriptRoute },
        },
      };
    },
  };
}

/** The tool result text: the delta as JSON, or the store's result when the log has none. */
export function renderSubagentDelta(read: Extract<SubagentDeltaRead, { ok: true }>): string {
  if (!read.hasEvents) {
    const { record } = read;
    const result = record.error ?? record.summary ?? "(the subagent returned no output)";
    return textHead(
      `No event history for Deck subagent ${record.id} (it predates the event log or the log is unavailable).\nStatus: ${record.status}\n\n${result}`,
      SUBAGENT_DELTA_MAX_CHARS,
    );
  }
  return textHead(JSON.stringify(read.delta, null, 2), SUBAGENT_DELTA_MAX_CHARS);
}
