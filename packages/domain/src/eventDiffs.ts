// A1b2 diff-based producers and projections (pure). The subagent run store and the
// loop engine commit whole states; these functions turn (previous public view, next
// public view) into event drafts, and fold events back into the same public view.
// Invariant (property test over recorded states):
//   reduce(project(prev), diff(prev, next)) == project(next)
// Payloads are whitelists: capability fields, paths, lock keys and agent outputs never
// leave the stores. Every event carries the full public entity it changes (not a
// patch), so a reader that missed events converges on the next one.
//
// Two child node kinds exist until A9: subagentRun (managed_subagent / managed_parallel,
// in the subagent store) and loopChild (a role run inside a loop iteration, from
// LoopRun.iterations[].children; its transcript lives in loopSessionSnapshots).
import {
  redactPaths,
  type EventActor,
  type EventDraft,
  type EventEnvelope,
  type NodeRef,
  type PathPrefix,
} from "./events.ts";
import { capText, EVENT_LABEL_MAX_CHARS } from "./turnRefs.ts";
import {
  isLoopRunTerminal,
  type LoopCheckerDecision,
  type LoopChildRecord,
  type LoopRun,
  type LoopRunArtifact,
  type LoopRunIteration,
  type LoopTimelineEvent,
  type LoopWorktreeReview,
} from "./loops.ts";

/**
 * The log holds facts and references: free text is cut to its head (summaries, task,
 * prompts, notes) and errors to their tail, so every event stays far below
 * MAX_EVENT_BYTES even fully JSON-escaped (tested through serializeEvent). The full
 * text stays in the store, read by run id.
 */
export const MAX_EVENT_TEXT_CHARS = 4_000;
export const MAX_EVENT_ERROR_BYTES = 16_000;
const ELLIPSIS = "\u2026";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Keep the newest UTF-8 suffix of value within maxBytes without cutting a code point. */
export function utf8Suffix(value: string, maxBytes: number): string {
  const encoded = encoder.encode(value);
  if (encoded.byteLength <= maxBytes) return value;
  let start = encoded.byteLength - maxBytes;
  // Skip UTF-8 continuation bytes so the suffix starts on a code point.
  while (start < encoded.byteLength && ((encoded[start] as number) & 0xc0) === 0x80) start += 1;
  return decoder.decode(encoded.subarray(start));
}

/** The first maxChars UTF-16 units plus an ellipsis, never splitting a surrogate pair. */
export function textHead(value: string, maxChars = MAX_EVENT_TEXT_CHARS): string {
  if (value.length <= maxChars) return value;
  let end = maxChars;
  const last = value.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${value.slice(0, end)}${ELLIPSIS}`;
}

/** How the server shapes free text for the log: which local roots to redact. */
export interface PublicViewOptions {
  pathPrefixes?: readonly PathPrefix[];
}

// Redact before capping, so a cut never leaves half a path behind.
const headText = (value: string, options: PublicViewOptions): string =>
  textHead(redactPaths(value, options.pathPrefixes));
const errorText = (value: string, options: PublicViewOptions): string =>
  utf8Suffix(redactPaths(value, options.pathPrefixes), MAX_EVENT_ERROR_BYTES);

/** Copy only the listed keys whose value is defined (JSON shape: no undefined keys). */
function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const key of keys) if (value[key] !== undefined) out[key] = value[key];
  return out;
}

/** Deep equality over JSON values; key order and undefined-valued keys do not matter. */
export function sameJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const other = b as unknown[];
    return a.length === other.length && a.every((item, index) => sameJson(item, other[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) if (!sameJson(left[key], right[key])) return false;
  return true;
}

const SYSTEM: EventActor = { type: "system" };

type ProjectedEvent = Pick<EventEnvelope, "kind" | "subject" | "payload"> &
  Partial<Pick<EventEnvelope, "id" | "ts" | "sessionId" | "origin">>;

// ---------------------------------------------------------------------------
// Subagent runs

export type PublicSubagentRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

/** A7: a verifier's decision; the loop checker's set without FAIL. */
export type VerifierDecision = Exclude<LoopCheckerDecision, "FAIL">;

/** A7: the verdict a verifier run gave on its target run ("missing": no decision line). */
export interface SubagentVerdict {
  decision: VerifierDecision | "missing";
  reason: string;
  verifierRunId: string;
}

/** What the log may hold about a subagent run: the record minus every capability field. */
export interface PublicSubagentRun {
  id: string;
  parentSessionId: string;
  /** The managed_subagent / managed_parallel tool call that created the run. */
  parentToolCallId?: string;
  /** The tool call of the current turn (a continuation replaces it): maps a call to its result. */
  turnToolCallId?: string;
  /** Head of the task (MAX_EVENT_TEXT_CHARS). */
  task: string;
  agent?: string;
  status: PublicSubagentRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  /** Head of the result; the full text is in the store. */
  summary?: string;
  /** UTF-8 bytes of the full summary in the store. */
  summaryBytes?: number;
  error?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  source?: "single" | "parallel";
  /** A7: a verifier run, and the run it verifies (same parent session). */
  role?: "verify";
  targetRunId?: string;
  /** A7: on the TARGET run, the latest verifier's verdict. */
  verdict?: SubagentVerdict;
}

/** A4's structured result, the payload of *.finished. */
export interface RunResult {
  status: string;
  summary?: string;
  summaryBytes?: number;
  error?: string;
  tokens?: { input?: number; output?: number };
  durationMs?: number;
  model?: string;
}

const SUBAGENT_KEYS = [
  "id",
  "parentSessionId",
  "parentToolCallId",
  "turnToolCallId",
  "task",
  "agent",
  "status",
  "createdAt",
  "updatedAt",
  "completedAt",
  "summary",
  "error",
  "model",
  "inputTokens",
  "outputTokens",
  "durationMs",
  "source",
  "role",
  "targetRunId",
  "verdict",
] as const satisfies readonly (keyof PublicSubagentRun)[];

/** Whitelist projection of a stored record (the server's record is a structural superset). */
export function toPublicSubagentRun(
  record: PublicSubagentRun,
  options: PublicViewOptions = {},
): PublicSubagentRun {
  const run: PublicSubagentRun = pick(record, SUBAGENT_KEYS);
  run.task = headText(run.task, options);
  if (run.summary !== undefined) {
    run.summaryBytes = encoder.encode(run.summary).byteLength;
    run.summary = headText(run.summary, options);
  }
  if (run.error !== undefined) run.error = errorText(run.error, options);
  if (run.verdict) run.verdict = { ...run.verdict, reason: headText(run.verdict.reason, options) };
  return run;
}

const subagentActive = (status: string): boolean => status === "starting" || status === "running";

export function subagentRunResult(run: PublicSubagentRun): RunResult {
  const tokens = pick({ input: run.inputTokens, output: run.outputTokens }, ["input", "output"]);
  return {
    status: run.status,
    ...pick(run, ["summary", "summaryBytes", "error", "durationMs", "model"]),
    ...(Object.keys(tokens).length ? { tokens } : {}),
  };
}

/** Events that turn the prev public view into next (both sets of public records). */
export function diffSubagentRuns(
  prev: readonly PublicSubagentRun[],
  next: readonly PublicSubagentRun[],
): EventDraft[] {
  const before = new Map(prev.map((run) => [run.id, run]));
  const out: EventDraft[] = [];
  for (const run of next) {
    const old = before.get(run.id);
    before.delete(run.id);
    const base = {
      subject: { type: "subagentRun", id: run.id } as NodeRef,
      sessionId: run.parentSessionId,
      actor: SYSTEM,
    };
    if (!old) {
      // A7: a verifier is a child of the run it verifies.
      const parent: NodeRef = run.targetRunId
        ? { type: "subagentRun", id: run.targetRunId }
        : run.parentToolCallId
          ? { type: "toolCall", id: run.parentToolCallId }
          : { type: "session", id: run.parentSessionId };
      out.push({ ...base, kind: "subagent.run.created", parent, payload: { run } });
    }
    // Once per turn: a continuation goes finished -> updated (active) -> finished.
    if (!subagentActive(run.status) && (!old || subagentActive(old.status))) {
      // The summary and error travel once, in the result.
      const { summary: _summary, summaryBytes: _bytes, error: _error, ...rest } = run;
      out.push({
        ...base,
        kind: "subagent.run.finished",
        payload: { run: rest, result: subagentRunResult(run) },
      });
    } else if (old && run.verdict && !sameJson(old.verdict, run.verdict)) {
      // A7: a new verdict on the target run; carries the whole run like updated.
      out.push({
        ...base,
        kind: "subagent.run.verified",
        payload: {
          run,
          runId: run.id,
          verifierRunId: run.verdict.verifierRunId,
          verdict: run.verdict.decision,
          reason: run.verdict.reason,
        },
      });
    } else if (old && !sameJson(old, run)) {
      out.push({ ...base, kind: "subagent.run.updated", payload: { run } });
    }
  }
  for (const old of before.values()) {
    out.push({
      kind: "subagent.run.removed",
      subject: { type: "subagentRun", id: old.id },
      sessionId: old.parentSessionId,
      actor: SYSTEM,
      payload: { id: old.id },
    });
  }
  return out;
}

export type SubagentRunsProjection = Map<string, PublicSubagentRun>;

/**
 * Fold subagent.run.* events onto a projection (a copy of initial). Other kinds are
 * skipped, and so are updates for a run whose created event is missing: the startup
 * reconcile then sees the run absent and writes created again (with its tree edge).
 */
export function projectSubagentRuns(
  events: Iterable<ProjectedEvent>,
  initial: Iterable<PublicSubagentRun> = [],
): SubagentRunsProjection {
  const state: SubagentRunsProjection = new Map([...initial].map((run) => [run.id, run]));
  for (const event of events) {
    if (event.subject.type !== "subagentRun") continue;
    const id = event.subject.id;
    const payload = event.payload as
      | { run?: PublicSubagentRun; result?: RunResult }
      | null
      | undefined;
    switch (event.kind) {
      case "subagent.run.created":
        if (payload?.run) state.set(id, payload.run);
        break;
      case "subagent.run.updated":
      case "subagent.run.verified":
        if (payload?.run && state.has(id)) state.set(id, payload.run);
        break;
      case "subagent.run.finished":
        if (payload?.run && payload.result && state.has(id)) {
          state.set(id, {
            ...payload.run,
            ...pick(payload.result, ["summary", "summaryBytes", "error"]),
          });
        }
        break;
      case "subagent.run.removed":
        state.delete(id);
        break;
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Loop runs

export type PublicLoopTimelineEvent = LoopTimelineEvent;
export type PublicLoopChild = Omit<LoopChildRecord, "output">;
export type PublicLoopArtifact = Omit<LoopRunArtifact, "filePath">;
export type PublicLoopReview = Omit<
  LoopWorktreeReview,
  "patchArtifact" | "changedFiles" | "archivedPath"
>;

export interface PublicLoopIterationSummary {
  id: string;
  index: number;
  startedAt: string;
  endedAt?: string;
  checkerDecision?: LoopRunIteration["checkerDecision"];
  checkerVerdictParse?: LoopRunIteration["checkerVerdictParse"];
  goalDecision?: LoopRunIteration["goalDecision"];
  goalVerdictParse?: LoopRunIteration["goalVerdictParse"];
  validationPassed: boolean | null;
  /** Outcome only: never the command, working directory or stdio. */
  validation?: {
    classification: string;
    exitCode: number | null;
    durationMs: number;
    passed: boolean;
  };
}

export interface PublicLoopIteration extends PublicLoopIterationSummary {
  timeline: PublicLoopTimelineEvent[];
  children: PublicLoopChild[];
  artifacts: PublicLoopArtifact[];
}

/** Run-level public fields: no definitionSnapshot, paths, launch ownership or lock keys. */
export interface PublicLoopRunSummary {
  id: string;
  sessionId?: string;
  catalogId?: string;
  loopName: string;
  structure?: LoopRun["structure"];
  launchContext?: string;
  launchContextScope?: LoopRun["launchContextScope"];
  projectId?: string;
  retryOf?: string;
  writeTarget?: string;
  checkpointPrompt?: string;
  status: LoopRun["status"];
  currentIteration: number;
  maxIterations: number;
  stopReason?: LoopRun["stopReason"];
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

export interface PublicLoopRun extends PublicLoopRunSummary {
  iterations: PublicLoopIteration[];
  review?: PublicLoopReview;
}

const RUN_KEYS = [
  "id",
  "sessionId",
  "catalogId",
  "loopName",
  "structure",
  "launchContext",
  "launchContextScope",
  "projectId",
  "retryOf",
  "checkpointPrompt",
  "status",
  "currentIteration",
  "maxIterations",
  "stopReason",
  "startedAt",
  "updatedAt",
  "endedAt",
] as const satisfies readonly (keyof LoopRun & keyof PublicLoopRunSummary)[];

const REVIEW_KEYS = [
  "status",
  "updatedAt",
  "availableAt",
  "applyingAt",
  "appliedAt",
  "discardingAt",
  "discardedAt",
  "uncertainAt",
  "patchHash",
  "patchBytes",
  "patchTruncated",
  "error",
] as const satisfies readonly (keyof PublicLoopReview)[];

const CHILD_KEYS = [
  "id",
  "phase",
  "stageIndex",
  "branchIndex",
  "agentName",
  "status",
  "queuedAt",
  "startedAt",
  "endedAt",
  "error",
] as const satisfies readonly (keyof PublicLoopChild)[];

const ARTIFACT_KEYS = [
  "id",
  "phase",
  "stageIndex",
  "branchIndex",
  "agentName",
  "filename",
  "bytes",
  "createdAt",
] as const satisfies readonly (keyof PublicLoopArtifact)[];

const TIMELINE_KEYS = [
  "id",
  "phase",
  "roleName",
  "note",
  "timestamp",
  "stageIndex",
  "branchIndex",
] as const satisfies readonly (keyof LoopTimelineEvent)[];

function toPublicIteration(
  iteration: LoopRunIteration,
  options: PublicViewOptions,
): PublicLoopIteration {
  const validation = iteration.validationResult;
  return {
    ...pick(iteration, [
      "id",
      "index",
      "startedAt",
      "endedAt",
      "checkerDecision",
      "checkerVerdictParse",
      "goalDecision",
      "goalVerdictParse",
    ]),
    validationPassed: iteration.validationPassed,
    ...(validation
      ? {
          validation: {
            classification: validation.classification,
            exitCode: validation.exitCode,
            durationMs: validation.durationMs,
            passed: validation.passed,
          },
        }
      : {}),
    timeline: (iteration.timeline ?? []).map((entry) => ({
      ...pick(entry, TIMELINE_KEYS),
      note: headText(entry.note, options),
    })),
    children: (iteration.children ?? []).map((child) => {
      const out = pick(child, CHILD_KEYS);
      if (out.error !== undefined) out.error = errorText(out.error, options);
      return out;
    }),
    artifacts: (iteration.artifacts ?? []).map((artifact) => pick(artifact, ARTIFACT_KEYS)),
  };
}

/**
 * Whitelist projection of a LoopRun. Builds fresh objects all the way down, so it is
 * also the deep copy the engine keeps between persists (runs are edited in place).
 */
export function toPublicLoopRun(run: LoopRun, options: PublicViewOptions = {}): PublicLoopRun {
  const summary = pick(run, RUN_KEYS);
  if (summary.launchContext !== undefined) {
    summary.launchContext = headText(summary.launchContext, options);
  }
  if (summary.checkpointPrompt !== undefined) {
    summary.checkpointPrompt = headText(summary.checkpointPrompt, options);
  }
  const review = run.review ? pick(run.review, REVIEW_KEYS) : undefined;
  if (review?.error !== undefined) review.error = errorText(review.error, options);
  return {
    ...summary,
    ...(run.launch?.writeTarget ? { writeTarget: run.launch.writeTarget } : {}),
    iterations: run.iterations.map((iteration) => toPublicIteration(iteration, options)),
    ...(review ? { review } : {}),
  };
}

function loopRunSummary(run: PublicLoopRun): PublicLoopRunSummary {
  const { iterations: _iterations, review: _review, ...summary } = run;
  return summary;
}

function iterationSummary(iteration: PublicLoopIteration): PublicLoopIterationSummary {
  const { timeline: _timeline, children: _children, artifacts: _artifacts, ...summary } = iteration;
  return summary;
}

export function loopRunResult(run: PublicLoopRunSummary): RunResult & { stopReason?: string } {
  const durationMs =
    run.endedAt !== undefined ? Date.parse(run.endedAt) - Date.parse(run.startedAt) : undefined;
  return {
    status: run.status,
    ...(run.stopReason ? { stopReason: run.stopReason } : {}),
    ...(durationMs !== undefined && Number.isFinite(durationMs) ? { durationMs } : {}),
  };
}

const awaitingHuman = (run: PublicLoopRunSummary): boolean =>
  run.status === "stopped" && run.stopReason === "humanInputRequired";

/** Items of next whose id is new or whose content changed against prev. */
function changedById<T extends { id: string }>(
  prev: readonly T[] | undefined,
  next: readonly T[],
): T[] {
  const before = new Map((prev ?? []).map((item) => [item.id, item]));
  return next.filter((item) => !sameJson(before.get(item.id), item));
}

/**
 * Events that turn prev into next. Nested items are appended or upserted by id;
 * nothing in the engine removes an iteration, timeline entry, child or artifact.
 */
export function diffLoopRuns(
  prev: readonly PublicLoopRun[],
  next: readonly PublicLoopRun[],
): EventDraft[] {
  const before = new Map(prev.map((run) => [run.id, run]));
  const out: EventDraft[] = [];
  for (const run of next) {
    const old = before.get(run.id);
    before.delete(run.id);
    const base = {
      ...(run.sessionId ? { sessionId: run.sessionId } : {}),
      ...(run.projectId ? { projectId: run.projectId } : {}),
      actor: SYSTEM,
    };
    const runRef: NodeRef = { type: "loopRun", id: run.id };
    const summary = loopRunSummary(run);
    if (!old) {
      out.push({
        ...base,
        kind: "loop.run.started",
        subject: runRef,
        ...(run.sessionId ? { parent: { type: "session", id: run.sessionId } as NodeRef } : {}),
        payload: { run: summary },
      });
    }
    if (!sameJson(old?.review, run.review)) {
      out.push({
        ...base,
        kind: "loop.review.changed",
        subject: runRef,
        payload: { runId: run.id, ...(run.review ? { review: run.review } : {}) },
      });
    }
    const oldIterations = new Map((old?.iterations ?? []).map((item) => [item.id, item]));
    for (const iteration of run.iterations) {
      const previous = oldIterations.get(iteration.id);
      const iterationRef: NodeRef = { type: "loopIteration", id: iteration.id };
      const current = iterationSummary(iteration);
      if (!previous) {
        out.push({
          ...base,
          kind: "loop.iteration.started",
          subject: iterationRef,
          parent: runRef,
          payload: { runId: run.id, iteration: current },
        });
      } else if (!sameJson(iterationSummary(previous), current)) {
        out.push({
          ...base,
          kind: "loop.iteration.updated",
          subject: iterationRef,
          payload: { runId: run.id, iteration: current },
        });
      }
      const nested = { runId: run.id, iterationId: iteration.id };
      for (const entry of changedById(previous?.timeline, iteration.timeline)) {
        out.push({
          ...base,
          kind: "loop.timeline.appended",
          subject: iterationRef,
          payload: { ...nested, entry },
        });
      }
      const oldChildren = new Set((previous?.children ?? []).map((child) => child.id));
      for (const child of changedById(previous?.children, iteration.children)) {
        out.push({
          ...base,
          kind: "loop.child.upserted",
          subject: { type: "loopChild", id: child.id },
          ...(oldChildren.has(child.id) ? {} : { parent: iterationRef }),
          payload: { ...nested, child },
        });
      }
      for (const artifact of changedById(previous?.artifacts, iteration.artifacts)) {
        out.push({
          ...base,
          kind: "loop.artifact.upserted",
          subject: iterationRef,
          payload: { ...nested, artifact },
        });
      }
    }
    // The run event goes last so *.finished follows its final iteration facts. A Human
    // Approval run pauses as stopped/humanInputRequired (finished once); the decision
    // after the pause finishes it again with the resolved stop reason.
    if (
      isLoopRunTerminal(run.status) &&
      (!old || !isLoopRunTerminal(old.status) || (awaitingHuman(old) && !awaitingHuman(run)))
    ) {
      out.push({
        ...base,
        kind: "loop.run.finished",
        subject: runRef,
        payload: { run: summary, result: loopRunResult(summary) },
      });
    } else if (old && !sameJson(loopRunSummary(old), summary)) {
      out.push({ ...base, kind: "loop.run.updated", subject: runRef, payload: { run: summary } });
    }
  }
  for (const old of before.values()) {
    out.push({
      ...(old.sessionId ? { sessionId: old.sessionId } : {}),
      ...(old.projectId ? { projectId: old.projectId } : {}),
      actor: SYSTEM,
      kind: "loop.run.removed",
      subject: { type: "loopRun", id: old.id },
      payload: { runId: old.id },
    });
  }
  return out;
}

export type LoopRunsProjection = Map<string, PublicLoopRun>;

function upsert<T extends { id: string }>(items: T[], item: T): T[] {
  const index = items.findIndex((candidate) => candidate.id === item.id);
  if (index < 0) return [...items, item];
  return items.map((candidate, at) => (at === index ? item : candidate));
}

/** Fold loop.* events onto a projection (a copy of initial). Facts for unknown runs are skipped. */
export function projectLoopRuns(
  events: Iterable<ProjectedEvent>,
  initial: Iterable<PublicLoopRun> = [],
): LoopRunsProjection {
  const state: LoopRunsProjection = new Map([...initial].map((run) => [run.id, run]));
  for (const event of events) {
    if (!event.kind.startsWith("loop.")) continue;
    const payload = (event.payload ?? {}) as {
      run?: PublicLoopRunSummary;
      runId?: string;
      iterationId?: string;
      iteration?: PublicLoopIterationSummary;
      review?: PublicLoopReview;
      entry?: PublicLoopTimelineEvent;
      child?: PublicLoopChild;
      artifact?: PublicLoopArtifact;
    };
    switch (event.kind) {
      case "loop.run.started":
      case "loop.run.updated":
      case "loop.run.finished": {
        if (!payload.run) break;
        const old = state.get(payload.run.id);
        // Like subagent runs: no started, no run (reconcile writes started again).
        if (!old && event.kind !== "loop.run.started") break;
        state.set(payload.run.id, {
          ...payload.run,
          iterations: old?.iterations ?? [],
          ...(old?.review ? { review: old.review } : {}),
        });
        break;
      }
      case "loop.run.removed":
        if (payload.runId) state.delete(payload.runId);
        break;
      case "loop.review.changed": {
        const run = payload.runId ? state.get(payload.runId) : undefined;
        if (!run) break;
        const { review: _review, ...rest } = run;
        state.set(run.id, payload.review ? { ...rest, review: payload.review } : rest);
        break;
      }
      case "loop.iteration.started":
      case "loop.iteration.updated": {
        const run = payload.runId ? state.get(payload.runId) : undefined;
        if (!run || !payload.iteration) break;
        const old = run.iterations.find((item) => item.id === payload.iteration!.id);
        const iteration: PublicLoopIteration = {
          ...payload.iteration,
          timeline: old?.timeline ?? [],
          children: old?.children ?? [],
          artifacts: old?.artifacts ?? [],
        };
        state.set(run.id, { ...run, iterations: upsert(run.iterations, iteration) });
        break;
      }
      case "loop.timeline.appended":
      case "loop.child.upserted":
      case "loop.artifact.upserted": {
        const run = payload.runId ? state.get(payload.runId) : undefined;
        const iteration = run?.iterations.find((item) => item.id === payload.iterationId);
        if (!run || !iteration) break;
        const updated: PublicLoopIteration =
          event.kind === "loop.timeline.appended" && payload.entry
            ? { ...iteration, timeline: upsert(iteration.timeline, payload.entry) }
            : event.kind === "loop.child.upserted" && payload.child
              ? { ...iteration, children: upsert(iteration.children, payload.child) }
              : payload.artifact
                ? { ...iteration, artifacts: upsert(iteration.artifacts, payload.artifact) }
                : iteration;
        state.set(run.id, { ...run, iterations: upsert(run.iterations, updated) });
        break;
      }
    }
  }
  return state;
}

// ---------------------------------------------------------------------------
// Supervisor requests and plan history (A1b1 produces these kinds; A1d reads them).

export interface ProjectedSupervisorRequest {
  id: string;
  parentSessionId?: string;
  cellId?: string;
  method?: string;
  title?: string;
  message?: string;
  status: "recorded" | "pending" | "answered" | "cancelled" | "interrupted";
  response?: string;
  createdAt?: string;
}

/**
 * supervisor.progress.recorded and supervisor.request.opened / answered / cancelled,
 * payload = the request fields. The
 * supervisor log is memory-only, so a request still pending at a later server.started
 * (or writer.acquired: a read-only process became the writer) is closed as interrupted
 * (the restart rule).
 */
export function projectSupervisor(
  events: Iterable<ProjectedEvent>,
  initial: Iterable<[string, ProjectedSupervisorRequest]> = [],
): Map<string, ProjectedSupervisorRequest> {
  const state = new Map<string, ProjectedSupervisorRequest>(initial);
  for (const event of events) {
    if (event.kind === "server.started" || event.kind === "writer.acquired") {
      for (const [id, request] of state) {
        if (request.status === "pending") state.set(id, { ...request, status: "interrupted" });
      }
      continue;
    }
    if (event.subject.type !== "supervisorRequest") continue;
    const id = event.subject.id;
    const payload = (event.payload ?? {}) as Partial<ProjectedSupervisorRequest>;
    const old = state.get(id);
    if (event.kind === "supervisor.progress.recorded") {
      // A progress_update is not a request, but SupervisorLog lists it as "recorded".
      state.set(id, { ...payload, id, status: "recorded" });
    } else if (event.kind === "supervisor.request.opened") {
      state.set(id, { status: "pending", ...payload, id });
    } else if (event.kind === "supervisor.request.answered" && old) {
      state.set(id, { ...old, ...payload, id, status: "answered" });
    } else if (event.kind === "supervisor.request.cancelled" && old && old.status !== "answered") {
      state.set(id, { ...old, ...payload, id, status: "cancelled" });
    }
  }
  return state;
}

export interface ProjectedPlanChange {
  /** The event id. */
  id?: string;
  kind: string;
  items: unknown[];
  /** The event ts. */
  at?: string;
  /**
   * Reconcile imports only: the id of the store entry it followed (absent = the first).
   * Imports land after newer live events in the log, so readers place them by this
   * anchor, never by clock.
   */
  imported?: { afterId?: string };
}

/**
 * plan.changed, payload = SessionPlanEvent minus id/sessionId (`at` and `afterId` only on
 * reconcile imports, which keep the store's time and position), grouped by session in
 * log order. Extends a
 * copy of initial (arrays are copied on first touch).
 */
export function projectPlans(
  events: Iterable<ProjectedEvent>,
  initial: Iterable<[string, ProjectedPlanChange[]]> = [],
): Map<string, ProjectedPlanChange[]> {
  const state = new Map<string, ProjectedPlanChange[]>(initial);
  const copied = new Set<string>();
  for (const event of events) {
    if (event.kind !== "plan.changed" || !event.sessionId) continue;
    const payload = (event.payload ?? {}) as {
      kind?: string;
      items?: unknown[];
      at?: string;
      afterId?: string;
    };
    if (typeof payload.kind !== "string" || !Array.isArray(payload.items)) continue;
    let history = state.get(event.sessionId);
    if (!history || !copied.has(event.sessionId)) {
      history = [...(history ?? [])];
      copied.add(event.sessionId);
      state.set(event.sessionId, history);
    }
    const at = typeof payload.at === "string" ? payload.at : event.ts;
    history.push({
      ...(event.id ? { id: event.id } : {}),
      kind: payload.kind,
      items: payload.items,
      ...(at ? { at } : {}),
      ...(event.origin === "reconcile"
        ? { imported: typeof payload.afterId === "string" ? { afterId: payload.afterId } : {} }
        : {}),
    });
  }
  return state;
}

/** A5: the latest plan.item.dispatched of one plan item. */
export interface ProjectedPlanDispatch {
  runId: string;
  agentName?: string;
  /** The plan generation: id of the plan.changed that set the plan (set_session_plan). */
  generation?: string;
  /** The dispatch event's id. */
  eventId?: string;
}

/**
 * A5: plan.item.dispatched, latest per (session, item); readers ignore a dispatch of an
 * older generation. Extends a copy of initial.
 */
export function projectPlanDispatches(
  events: Iterable<ProjectedEvent>,
  initial: Iterable<[string, Map<string, ProjectedPlanDispatch>]> = [],
): Map<string, Map<string, ProjectedPlanDispatch>> {
  const state = new Map(initial);
  const copied = new Set<string>();
  for (const event of events) {
    if (event.kind !== "plan.item.dispatched" || !event.sessionId) continue;
    const payload = (event.payload ?? {}) as {
      itemId?: unknown;
      runId?: unknown;
      agentName?: unknown;
      generation?: unknown;
    };
    if (typeof payload.itemId !== "string" || typeof payload.runId !== "string") continue;
    if (!copied.has(event.sessionId)) {
      state.set(event.sessionId, new Map(state.get(event.sessionId)));
      copied.add(event.sessionId);
    }
    state.get(event.sessionId)!.set(payload.itemId, {
      runId: payload.runId,
      ...(typeof payload.agentName === "string" ? { agentName: payload.agentName } : {}),
      ...(typeof payload.generation === "string" ? { generation: payload.generation } : {}),
      ...(event.id ? { eventId: event.id } : {}),
    });
  }
  return state;
}

/** A5: the current plan generation: the id of the latest plan event that set a whole plan. */
export function planGeneration(
  history: readonly ProjectedPlanChange[] | undefined,
): string | undefined {
  for (let i = (history?.length ?? 0) - 1; i >= 0; i -= 1) {
    const change = history![i]!;
    // Reconcile imports are history from before the log, never the current plan.
    if (!change.imported && (change.kind === "created" || change.kind === "replaced"))
      return change.id;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// A1d cut-over merges: readers take membership and order from the log and exact detail
// from the store ("move readers, not stores"); the startup equivalence report.

/** plan.changed carries at most this many items (the producer's whitelist). */
export const MAX_PLAN_EVENT_ITEMS = 200;

/**
 * Insert each anchored item right after the item whose id is afterId (at the start when
 * afterId is absent, at the end when it is unknown), after the items already placed on
 * the same anchor: ties keep the anchored order, never a clock.
 */
export function placeAfterAnchors<T extends { id: string }>(
  base: readonly T[],
  anchored: readonly { item: T; afterId?: string }[],
): T[] {
  const out = [...base];
  const anchorOf = new Map<T, string | undefined>();
  for (const { item, afterId } of anchored) {
    let at = 0;
    if (afterId !== undefined) {
      const found = out.findIndex((candidate) => candidate.id === afterId);
      at = found < 0 ? out.length : found + 1;
    }
    while (at < out.length && anchorOf.has(out[at] as T) && anchorOf.get(out[at] as T) === afterId)
      at += 1;
    out.splice(at, 0, item);
    anchorOf.set(item, afterId);
  }
  return out;
}

/**
 * A session's plan history: logged transitions in log order, reconcile imports at their
 * store position (after their recorded store predecessor), store entries the log lacks
 * after their store predecessor. Exact entries come from the store by id; the rest from
 * fromLog (capped and redacted copies).
 */
export function mergePlanHistory<T extends { id: string }>(
  logged: readonly ProjectedPlanChange[],
  stored: readonly T[],
  fromLog: (change: ProjectedPlanChange & { id: string }) => T,
): T[] {
  const exact = new Map(stored.map((event) => [event.id, event]));
  const seen = new Set<string>();
  const base: T[] = [];
  const anchored: { item: T; afterId?: string }[] = [];
  for (const change of logged) {
    if (change.id === undefined || seen.has(change.id)) continue;
    seen.add(change.id);
    const item = exact.get(change.id) ?? fromLog({ ...change, id: change.id });
    if (change.imported) anchored.push({ item, afterId: change.imported.afterId });
    else base.push(item);
  }
  stored.forEach((event, index) => {
    if (!seen.has(event.id)) anchored.push({ item: event, afterId: stored[index - 1]?.id });
  });
  return placeAfterAnchors(base, anchored);
}

/**
 * The supervisor view: membership and status from the log (requests an earlier writer
 * left pending read as interrupted); this process's own entries stay exact, and one
 * whose append failed is placed in createdAt order.
 */
export function mergeSupervisorRequests<T extends { id: string; createdAt: string }>(
  logged: ReadonlyMap<string, ProjectedSupervisorRequest>,
  own: readonly T[],
  fromLog: (request: ProjectedSupervisorRequest) => T,
  parentSessionId?: string,
): T[] {
  const exact = new Map(own.map((entry) => [entry.id, entry]));
  const out: T[] = [];
  for (const request of logged.values()) {
    if (parentSessionId !== undefined && request.parentSessionId !== parentSessionId) continue;
    out.push(exact.get(request.id) ?? fromLog(request));
    exact.delete(request.id);
  }
  for (const entry of exact.values()) {
    const at = out.findIndex((candidate) => candidate.createdAt > entry.createdAt);
    out.splice(at < 0 ? out.length : at, 0, entry);
  }
  return out;
}

export interface StoredPlanEventLike {
  id: string;
  kind: string;
  items: readonly { id: string; status: string }[];
  at: string;
}

export interface PlanHistoryComparison<T> {
  /** Store entries the log lacks, with their store predecessor, oldest first. */
  missing: { event: T; afterId?: string; imported: boolean }[];
  /** Same id, different kind, item ids or statuses (titles are redacted in the log). */
  contentMismatches: number;
}

/**
 * Compare a session's stored history with its log projection. A missing entry older
 * than the log itself (logStartedAt) is history from before A1 (imported); a newer one
 * is a lost append. The clock only labels the count, it never orders entries.
 */
export function comparePlanHistory<T extends StoredPlanEventLike>(
  stored: readonly T[],
  logged: readonly ProjectedPlanChange[],
  logStartedAt?: string,
): PlanHistoryComparison<T> {
  const byId = new Map(logged.map((change) => [change.id, change]));
  const result: PlanHistoryComparison<T> = { missing: [], contentMismatches: 0 };
  stored.forEach((event, index) => {
    const change = byId.get(event.id);
    if (!change) {
      result.missing.push({
        event,
        afterId: stored[index - 1]?.id,
        imported: logStartedAt === undefined || event.at < logStartedAt,
      });
      return;
    }
    const items = event.items.slice(0, MAX_PLAN_EVENT_ITEMS);
    const same =
      change.kind === event.kind &&
      change.items.length === items.length &&
      items.every((item, i) => {
        const other = change.items[i] as { id?: unknown; status?: unknown } | undefined;
        return (
          other?.id === capText(item.id, EVENT_LABEL_MAX_CHARS) && other.status === item.status
        );
      });
    if (!same) result.contentMismatches += 1;
  });
  return result;
}

export interface EquivalenceReport {
  /** Another process holds writer.lock (or the log is disabled): it reconciles. */
  readOnly: boolean;
  /** Reconcile steps that threw (run stores, plan history). */
  failures: number;
  subagentReconciled: number;
  subagentRecovered: number;
  loopReconciled: number;
  loopRecovered: number;
  /** Plan history from before the log, imported once (not a mismatch). */
  planImported: number;
  /** Plan store entries the log lacked (lost appends), written back. */
  planReconciled: number;
  planContentMismatches: number;
  /** Zero on a clean boot. Recovered counts are boot recovery, not mismatches. */
  mismatches: number;
}

export function equivalenceReport(input: {
  readOnly: boolean;
  failures: number;
  runs?: Pick<
    EquivalenceReport,
    "subagentReconciled" | "subagentRecovered" | "loopReconciled" | "loopRecovered"
  >;
  plans?: { imported: number; reconciled: number; contentMismatches: number };
}): EquivalenceReport {
  const runs = input.runs ?? {
    subagentReconciled: 0,
    subagentRecovered: 0,
    loopReconciled: 0,
    loopRecovered: 0,
  };
  const plans = input.plans ?? { imported: 0, reconciled: 0, contentMismatches: 0 };
  return {
    readOnly: input.readOnly,
    failures: input.failures,
    ...runs,
    planImported: plans.imported,
    planReconciled: plans.reconciled,
    planContentMismatches: plans.contentMismatches,
    mismatches:
      runs.subagentReconciled + runs.loopReconciled + plans.reconciled + plans.contentMismatches,
  };
}
