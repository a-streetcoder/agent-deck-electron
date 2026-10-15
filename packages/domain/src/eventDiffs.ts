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
import type { EventActor, EventDraft, EventEnvelope, NodeRef } from "./events.ts";
import {
  isLoopRunTerminal,
  type LoopChildRecord,
  type LoopRun,
  type LoopRunArtifact,
  type LoopRunIteration,
  type LoopTimelineEvent,
  type LoopWorktreeReview,
} from "./loops.ts";

/** Producers cap their own strings so an event stays far below MAX_EVENT_BYTES. */
export const MAX_EVENT_SUMMARY_BYTES = 256_000;
export const MAX_EVENT_TASK_BYTES = 50_000;
export const MAX_EVENT_TEXT_BYTES = 16_000;

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

const cap = (value: string | undefined, maxBytes: number): string | undefined =>
  value === undefined ? undefined : utf8Suffix(value, maxBytes);

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
  Partial<Pick<EventEnvelope, "id" | "ts" | "sessionId">>;

// ---------------------------------------------------------------------------
// Subagent runs

export type PublicSubagentRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

/** What the log may hold about a subagent run: the record minus every capability field. */
export interface PublicSubagentRun {
  id: string;
  parentSessionId: string;
  /** The managed_subagent / managed_parallel tool call that created the run. */
  parentToolCallId?: string;
  task: string;
  agent?: string;
  status: PublicSubagentRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string;
  error?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  source?: "single" | "parallel";
  /** Opaque identity the transcript cell already exposes; the token never leaves the store. */
  artifactRootId?: string;
}

/** A4's structured result, the payload of *.finished. */
export interface RunResult {
  status: string;
  summary?: string;
  error?: string;
  tokens?: { input?: number; output?: number };
  durationMs?: number;
  model?: string;
  artifactRootId?: string;
}

const SUBAGENT_KEYS = [
  "id",
  "parentSessionId",
  "parentToolCallId",
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
  "artifactRootId",
] as const satisfies readonly (keyof PublicSubagentRun)[];

/** Whitelist projection of a stored record (the server's record is a structural superset). */
export function toPublicSubagentRun(record: PublicSubagentRun): PublicSubagentRun {
  const run = pick(record, SUBAGENT_KEYS);
  run.task = utf8Suffix(run.task, MAX_EVENT_TASK_BYTES);
  if (run.summary !== undefined) run.summary = utf8Suffix(run.summary, MAX_EVENT_SUMMARY_BYTES);
  if (run.error !== undefined) run.error = utf8Suffix(run.error, MAX_EVENT_TEXT_BYTES);
  return run;
}

const subagentActive = (status: string): boolean => status === "starting" || status === "running";

export function subagentRunResult(run: PublicSubagentRun): RunResult {
  const tokens = pick({ input: run.inputTokens, output: run.outputTokens }, ["input", "output"]);
  return {
    status: run.status,
    ...pick(run, ["summary", "error", "durationMs", "model", "artifactRootId"]),
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
      const parent: NodeRef = run.parentToolCallId
        ? { type: "toolCall", id: run.parentToolCallId }
        : { type: "session", id: run.parentSessionId };
      out.push({ ...base, kind: "subagent.run.created", parent, payload: { run } });
    }
    if (!subagentActive(run.status) && (!old || subagentActive(old.status))) {
      // The summary and error travel once, in the result.
      const { summary: _summary, error: _error, ...rest } = run;
      out.push({
        ...base,
        kind: "subagent.run.finished",
        payload: { run: rest, result: subagentRunResult(run) },
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

/** Fold subagent.run.* events onto a projection (a copy of initial). Other kinds are skipped. */
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
      case "subagent.run.updated":
        if (payload?.run) state.set(id, payload.run);
        break;
      case "subagent.run.finished":
        if (payload?.run && payload.result) {
          state.set(id, {
            ...payload.run,
            ...pick(payload.result, ["summary", "error"]),
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
  goalDecision?: LoopRunIteration["goalDecision"];
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
  artifactDirectoryId?: string;
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
  "artifactDirectoryId",
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

function toPublicIteration(iteration: LoopRunIteration): PublicLoopIteration {
  const validation = iteration.validationResult;
  return {
    ...pick(iteration, ["id", "index", "startedAt", "endedAt", "checkerDecision", "goalDecision"]),
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
      note: utf8Suffix(entry.note, MAX_EVENT_TEXT_BYTES),
    })),
    children: (iteration.children ?? []).map((child) => {
      const out = pick(child, CHILD_KEYS);
      if (out.error !== undefined) out.error = utf8Suffix(out.error, MAX_EVENT_TEXT_BYTES);
      return out;
    }),
    artifacts: (iteration.artifacts ?? []).map((artifact) => pick(artifact, ARTIFACT_KEYS)),
  };
}

/**
 * Whitelist projection of a LoopRun. Builds fresh objects all the way down, so it is
 * also the deep copy the engine keeps between persists (runs are edited in place).
 */
export function toPublicLoopRun(run: LoopRun): PublicLoopRun {
  const summary = pick(run, RUN_KEYS);
  if (summary.launchContext !== undefined) {
    summary.launchContext = utf8Suffix(summary.launchContext, MAX_EVENT_TEXT_BYTES);
  }
  if (summary.checkpointPrompt !== undefined) {
    summary.checkpointPrompt = utf8Suffix(summary.checkpointPrompt, MAX_EVENT_TEXT_BYTES);
  }
  const review = run.review ? pick(run.review, REVIEW_KEYS) : undefined;
  if (review?.error !== undefined) review.error = cap(review.error, MAX_EVENT_TEXT_BYTES);
  return {
    ...summary,
    ...(run.launch?.writeTarget ? { writeTarget: run.launch.writeTarget } : {}),
    iterations: run.iterations.map(toPublicIteration),
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
    ...(run.artifactDirectoryId ? { artifactRootId: run.artifactDirectoryId } : {}),
  };
}

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
          kind: "loop.artifact.added",
          subject: iterationRef,
          payload: { ...nested, artifact },
        });
      }
    }
    // The run event goes last so *.finished follows its final iteration facts.
    if (isLoopRunTerminal(run.status) && (!old || !isLoopRunTerminal(old.status))) {
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
      case "loop.artifact.added": {
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
 * supervisor.request.opened / answered / cancelled, payload = the request fields. The
 * supervisor log is memory-only, so a request still pending at a later server.started
 * is closed as interrupted (the restart rule).
 */
export function projectSupervisor(
  events: Iterable<ProjectedEvent>,
): Map<string, ProjectedSupervisorRequest> {
  const state = new Map<string, ProjectedSupervisorRequest>();
  for (const event of events) {
    if (event.kind === "server.started") {
      for (const [id, request] of state) {
        if (request.status === "pending") state.set(id, { ...request, status: "interrupted" });
      }
      continue;
    }
    if (event.subject.type !== "supervisorRequest") continue;
    const id = event.subject.id;
    const payload = (event.payload ?? {}) as Partial<ProjectedSupervisorRequest>;
    const old = state.get(id);
    if (event.kind === "supervisor.request.opened") {
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
}

/** plan.changed, payload = SessionPlanEvent minus id/sessionId/at, grouped by session in log order. */
export function projectPlans(events: Iterable<ProjectedEvent>): Map<string, ProjectedPlanChange[]> {
  const state = new Map<string, ProjectedPlanChange[]>();
  for (const event of events) {
    if (event.kind !== "plan.changed" || !event.sessionId) continue;
    const payload = (event.payload ?? {}) as { kind?: string; items?: unknown[] };
    if (typeof payload.kind !== "string" || !Array.isArray(payload.items)) continue;
    const history = state.get(event.sessionId) ?? [];
    history.push({
      ...(event.id ? { id: event.id } : {}),
      kind: payload.kind,
      items: payload.items,
      ...(event.ts ? { at: event.ts } : {}),
    });
    state.set(event.sessionId, history);
  }
  return state;
}
