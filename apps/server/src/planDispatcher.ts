// A5: the plan dispatcher (VISION_ORCHESTRATION principles 2 and 4). The graph logic is
// pure (packages/domain planScheduler.ts); this module only reacts to log events, spawns
// subagents through A4's spawn path and writes the outcome back as plan updates.
//
// Level-triggered: every relevant event recomputes the session's plan from scratch, so a
// repeated or missed event changes nothing. An item is dispatched once: it goes to
// in_progress with its runId the moment its run is accepted, and readyFrontier only
// returns todo items; an item reset to todo while its run is still active waits for it.
// After a restart, boot recovery has already marked interrupted runs terminal, so their
// in_progress items settle as blocked on the session's next plan event (its restore).
import {
  applyPlanUpdates,
  propagateBlocked,
  readyFrontier,
  type EventEnvelope,
  type LoopCheckerDecision,
  type ProjectedPlanDispatch,
  type SessionPlanItem,
  type SessionPlanUpdate,
} from "@agent-deck/domain";
import { parseVerdict } from "./loopEngine.ts";
import type { SubagentRunRecord } from "./subagentRunStore.ts";

/** A dependency result handed to the dependant's task, per dependency. */
const MAX_DEPENDENCY_SUMMARY_CHARS = 2_000;
const VERDICTS = new Set<LoopCheckerDecision>(["APPROVE", "REJECT"]);

export interface PlanDispatcherDeps {
  subscribe: (subscriber: (event: EventEnvelope) => void) => () => void;
  /** False when dispatches cannot be logged (read-only log): nothing is dispatched. */
  writable: () => boolean;
  /** The live session's current plan; undefined when the session is not live. */
  plan: (sessionId: string) => readonly SessionPlanItem[] | undefined;
  updatePlan: (sessionId: string, updates: SessionPlanUpdate[]) => void;
  /** plan.item.dispatched, latest per item (the log projection). */
  dispatches: (sessionId: string) => ReadonlyMap<string, ProjectedPlanDispatch> | undefined;
  /** The owning session's private run record (full summary). */
  run: (
    sessionId: string,
    runId: string,
  ) => Pick<SubagentRunRecord, "status" | "summary"> | undefined;
  /** Delegation allowed for the session, and the free detached-child slots (A4 cap). */
  slots: (sessionId: string) => number;
  /** A4 spawn: resolves once the run is accepted; `done` settles with the child's answer. */
  spawn: (
    sessionId: string,
    task: string,
    options: { agentName: string; verifier: boolean },
  ) => Promise<{ runId: string; done: Promise<{ text: string }> }>;
  recordDispatch: (
    sessionId: string,
    dispatch: { itemId: string; runId: string; agentName: string },
    causationId?: string,
  ) => boolean;
  warn: (message: string, error?: unknown) => void;
}

export interface PlanDispatcher {
  /** Recompute one session now (tests, restart); resolves when the pass is done. */
  evaluate(sessionId: string, causationId?: string): Promise<void>;
  close(): void;
}

const runActive = (run: { status: string } | undefined): boolean =>
  run?.status === "starting" || run?.status === "running";

export function verifierTask(item: SessionPlanItem, summary: string): string {
  return [
    `Verify the result of this plan item. You did not produce it; review it read-only.`,
    `Plan item: ${item.title}`,
    `Producer (${item.assignee ?? "unknown"}) summary:\n${summary || "(no summary)"}`,
    `Answer with APPROVE or REJECT alone on the first line, then your reasons.`,
  ].join("\n\n");
}

export function createPlanDispatcher(deps: PlanDispatcherDeps): PlanDispatcher {
  let closed = false;
  /** Sessions whose own agent set or updated a plan in this process (the plan owner). */
  const owned = new Set<string>();
  /** Producer runs whose verifier is running in this process. */
  const verifying = new Set<string>();
  const queues = new Map<string, Promise<void>>();

  const dispatchOf = (
    sessionId: string,
    item: SessionPlanItem,
  ): ProjectedPlanDispatch | undefined =>
    deps.dispatches(sessionId)?.get(item.id) ??
    (item.runId ? { runId: item.runId, agentName: item.assignee } : undefined);

  const dependencyContext = (
    sessionId: string,
    items: readonly SessionPlanItem[],
    item: SessionPlanItem,
  ): string => {
    const lines = (item.dependsOn ?? []).flatMap((id) => {
      const dep = items.find((candidate) => candidate.id === id);
      const runId = dep && dispatchOf(sessionId, dep)?.runId;
      const summary = runId ? deps.run(sessionId, runId)?.summary : undefined;
      return dep && summary
        ? [`- ${dep.title} (Deck run ${runId}):\n${summary.slice(0, MAX_DEPENDENCY_SUMMARY_CHARS)}`]
        : [];
    });
    return lines.length
      ? `\n\nResults of the plan items this one depends on:\n${lines.join("\n")}`
      : "";
  };

  const verify = (
    sessionId: string,
    item: SessionPlanItem,
    runId: string,
    summary: string,
  ): void => {
    verifying.add(runId);
    const settle = (status: "done" | "blocked"): void => {
      verifying.delete(runId);
      const current = deps.plan(sessionId)?.find((candidate) => candidate.id === item.id);
      // The agent rewrote the item meanwhile: its word wins.
      if (!closed && current?.status === "in_progress" && current.runId === runId) {
        deps.updatePlan(sessionId, [{ id: item.id, status }]);
      }
      if (!closed) void schedule(sessionId);
    };
    deps
      .spawn(sessionId, verifierTask(item, summary), {
        agentName: item.verifiedBy!,
        verifier: true,
      })
      .then(({ done }) => done)
      .then(({ text }) =>
        settle(parseVerdict(text, VERDICTS).decision === "APPROVE" ? "done" : "blocked"),
      )
      .catch((error: unknown) => {
        deps.warn(`plan verifier for item ${item.id} failed`, error);
        settle("blocked");
      });
  };

  const evaluateNow = async (sessionId: string, causationId?: string): Promise<void> => {
    if (closed) return;
    const items = deps.plan(sessionId);
    if (!items?.some((item) => item.assignee)) return;
    let slots = deps.slots(sessionId);
    const updates: SessionPlanUpdate[] = [];

    // 1. Settle dispatched items whose run ended.
    for (const item of items) {
      if (item.status !== "in_progress") continue;
      const dispatch = dispatchOf(sessionId, item);
      if (!dispatch) continue;
      // One patch per item: applyPlanUpdates applies the first patch for an id only.
      const patch: SessionPlanUpdate = { id: item.id };
      if (item.runId !== dispatch.runId) patch.runId = dispatch.runId;
      const run = deps.run(sessionId, dispatch.runId);
      if (runActive(run) || verifying.has(dispatch.runId)) {
        // Still running (or being verified).
      } else if (dispatch.agentName !== undefined && dispatch.agentName !== item.assignee) {
        // Reassigned while running: the old agent's result does not count.
        patch.status = "todo";
      } else if (run?.status !== "completed") {
        // Failed, stopped, interrupted by a restart, or its record is gone.
        patch.status = "blocked";
      } else if (!item.verifiedBy) {
        patch.status = "done";
      } else if (slots > 0 && deps.writable()) {
        slots -= 1;
        verify(sessionId, { ...item, runId: dispatch.runId }, dispatch.runId, run.summary ?? "");
      }
      if (Object.keys(patch).length > 1) updates.push(patch);
    }

    // 2. Blocked and skipped items block everything downstream.
    const settled = applyPlanUpdates(items, updates);
    const next = propagateBlocked(settled);
    next.forEach((item, i) => {
      if (item.status !== settled[i]?.status) updates.push({ id: item.id, status: item.status });
    });
    if (updates.length) deps.updatePlan(sessionId, updates);

    // 3. Dispatch the ready frontier: only the plan owner's plans, only when it can be logged.
    const known = deps.dispatches(sessionId);
    if (!owned.has(sessionId) && !known?.size && !items.some((item) => item.runId)) return;
    if (!deps.writable()) return;
    for (const item of readyFrontier(next)) {
      if (closed || slots <= 0) return;
      if (!item.assignee) continue;
      const previous = dispatchOf(sessionId, item);
      if (previous && runActive(deps.run(sessionId, previous.runId))) continue;
      slots -= 1;
      let runId: string;
      try {
        const task = `${item.title}${dependencyContext(sessionId, next, item)}`;
        ({ runId } = await deps.spawn(sessionId, task, {
          agentName: item.assignee,
          verifier: false,
        }));
      } catch (error) {
        deps.warn(`plan item ${item.id} could not be dispatched`, error);
        deps.updatePlan(sessionId, [{ id: item.id, status: "blocked" }]);
        continue;
      }
      deps.recordDispatch(
        sessionId,
        { itemId: item.id, runId, agentName: item.assignee },
        causationId,
      );
      deps.updatePlan(sessionId, [{ id: item.id, status: "in_progress", runId }]);
    }
  };

  // One pass at a time per session: a pass awaits spawns, and the plan updates it makes
  // trigger the next pass, which must see them.
  const schedule = (sessionId: string, causationId?: string): Promise<void> => {
    const next = (queues.get(sessionId) ?? Promise.resolve())
      .then(() => evaluateNow(sessionId, causationId))
      .catch((error: unknown) => deps.warn(`plan dispatch for session ${sessionId} failed`, error));
    queues.set(sessionId, next);
    void next.then(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
    return next;
  };

  const unsubscribe = deps.subscribe((event) => {
    if (closed || !event.sessionId) return;
    const relevant =
      event.kind === "plan.changed" ||
      event.kind === "subagent.run.finished" ||
      event.kind === "subagent.run.removed";
    if (!relevant) return;
    if (
      event.kind === "plan.changed" &&
      event.actor.type === "agent" &&
      event.actor.sessionId === event.sessionId
    ) {
      owned.add(event.sessionId);
    }
    // Subscribers must not append: run the pass after this append returns.
    const sessionId = event.sessionId;
    queueMicrotask(() => void schedule(sessionId, event.id));
  });

  return {
    evaluate: schedule,
    close() {
      closed = true;
      unsubscribe();
    },
  };
}
