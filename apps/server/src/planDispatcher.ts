// A5: the plan dispatcher (VISION_ORCHESTRATION principles 2 and 4). The graph logic is
// pure (packages/domain planScheduler.ts); this module only reacts to log events, spawns
// subagents through A4's spawn path and writes the outcome back as plan updates.
//
// Level-triggered: every relevant event recomputes the session's plan from scratch, so a
// repeated or missed event changes nothing. A pass first SETTLES (a dispatched item whose
// run ended becomes done, blocked or verified; blocked items block their dependants),
// then DISPATCHES the ready frontier. Settling always runs; dispatching (and verifying)
// only for a session whose own agent set or updated the plan in this process ("owned"),
// and never after the user stopped one of its runs until the agent touches the plan
// again. Restores, forks, reopens and restarts therefore settle but spawn nothing.
//
// The parent agent is not prompted when items finish: it reads the plan (panel, log,
// update_session_plan's result) on its next turn.
import {
  applyPlanUpdates,
  propagateBlocked,
  readyFrontier,
  sameAgent,
  type EventEnvelope,
  type ProjectedPlanDispatch,
  type SessionPlanItem,
  type SessionPlanUpdate,
  type SubagentVerdict,
} from "@agent-deck/domain";
import type { SubagentRunRecord } from "./subagentRunStore.ts";
import type { VerifierOutcome } from "./verifier.ts";

/** Fan-in: each dependency result handed to a dependant, and all of them together. */
export const MAX_DEPENDENCY_SUMMARY_CHARS = 2_000;
export const MAX_DEPENDENCY_CONTEXT_CHARS = 20_000;
const MAX_NOTE_CHARS = 500;

export type PlanRun = Pick<SubagentRunRecord, "status" | "summary">;

export interface PlanDispatcherDeps {
  subscribe: (subscriber: (event: EventEnvelope) => void) => () => void;
  /** False when dispatches cannot be logged (read-only log): nothing is dispatched. */
  writable: () => boolean;
  /** The live session's current plan; undefined when the session is not live. */
  plan: (sessionId: string) => readonly SessionPlanItem[] | undefined;
  /** The id of the plan event that set the current plan (set_session_plan, restore). */
  generation: (sessionId: string) => string | undefined;
  /** A server-written update: logged as system, caused by causationId. */
  updatePlan: (sessionId: string, updates: SessionPlanUpdate[], causationId?: string) => void;
  /** plan.item.dispatched, latest per item (the log projection). */
  dispatches: (sessionId: string) => ReadonlyMap<string, ProjectedPlanDispatch> | undefined;
  /** The owning session's private run record (full summary). */
  run: (sessionId: string, runId: string) => PlanRun | undefined;
  /** Free detached-child slots (A4 cap); 0 while delegation is off. */
  slots: (sessionId: string) => number;
  /** A4 spawn: resolves once the run is accepted; "wait" when the child cap refused it. */
  spawn: (
    sessionId: string,
    task: string,
    options: { agentName: string; worktree: boolean },
  ) => Promise<{ runId: string; done: Promise<{ text: string }> } | "wait">;
  /** A7 launchVerifier on the producer's run; "wait" when the child cap refused it. */
  verify: (
    sessionId: string,
    request: { targetRunId: string; task: string; agentName: string },
  ) => Promise<{ runId: string; done: Promise<VerifierOutcome> } | "wait">;
  recordDispatch: (
    sessionId: string,
    dispatch: { itemId: string; runId: string; agentName: string; generation?: string },
    causationId?: string,
  ) => boolean;
  recordVerified: (
    sessionId: string,
    verified: {
      itemId: string;
      runId: string;
      producerRunId: string;
      verdict: SubagentVerdict["decision"];
      reason: string;
    },
    causationId?: string,
  ) => boolean;
  liveSessions: () => string[];
  warn: (message: string, error?: unknown) => void;
}

export interface PlanDispatcher {
  /** Recompute one session now; resolves when the pass is done. */
  evaluate(sessionId: string, causationId?: string): Promise<void>;
  /** Recompute every live session (the delegation setting changed). */
  evaluateAll(): Promise<void>;
  close(): void;
}

const runActive = (run: { status: string } | undefined): boolean =>
  run?.status === "starting" || run?.status === "running";

const itemTask = (item: SessionPlanItem): string => item.task ?? item.title;

/** What the verifier is told the producer was asked to do. */
export function verifierTask(item: SessionPlanItem): string {
  return `${item.title}\n\nA plan item assigned to ${item.assignee ?? "unknown"}.\n\nItem task:\n${itemTask(item)}`;
}

export function createPlanDispatcher(deps: PlanDispatcherDeps): PlanDispatcher {
  let closed = false;
  /** Sessions whose own agent set or updated a plan in this process, not since stopped. */
  const owned = new Set<string>();
  /** Producer runs whose verifier is running in this process. */
  const verifying = new Set<string>();
  /** The last event that could make an item ready (a finish, the agent's plan change). */
  const lastCause = new Map<string, string>();
  const queues = new Map<string, Promise<void>>();

  const dispatchOf = (
    sessionId: string,
    item: SessionPlanItem,
    generation: string | undefined,
  ): ProjectedPlanDispatch | undefined => {
    const logged = deps.dispatches(sessionId)?.get(item.id);
    if (logged && logged.generation === generation) return logged;
    // A carried item (re-sent unchanged into a new generation) keeps its runId.
    return item.runId ? { runId: item.runId, agentName: item.assignee } : undefined;
  };

  const dependencyContext = (
    sessionId: string,
    items: readonly SessionPlanItem[],
    item: SessionPlanItem,
    generation: string | undefined,
  ): string => {
    let budget = MAX_DEPENDENCY_CONTEXT_CHARS;
    const lines: string[] = [];
    for (const id of item.dependsOn ?? []) {
      const dep = items.find((candidate) => candidate.id === id);
      const runId = dep && dispatchOf(sessionId, dep, generation)?.runId;
      const summary = runId ? deps.run(sessionId, runId)?.summary : undefined;
      if (!dep || !summary || budget <= 0) continue;
      const text = summary.slice(0, Math.min(MAX_DEPENDENCY_SUMMARY_CHARS, budget));
      budget -= text.length;
      lines.push(`- ${dep.title} (Deck run ${runId}):\n${text}`);
    }
    return lines.length
      ? `\n\nResults of the plan items this one depends on:\n${lines.join("\n")}`
      : "";
  };

  const verify = async (
    sessionId: string,
    item: SessionPlanItem,
    producerRunId: string,
    cause: string | undefined,
  ): Promise<"started" | "wait"> => {
    const snapshot = { assignee: item.assignee, verifiedBy: item.verifiedBy! };
    const spawned = await deps.verify(sessionId, {
      targetRunId: producerRunId,
      task: verifierTask(item),
      agentName: snapshot.verifiedBy,
    });
    if (spawned === "wait") return "wait";
    verifying.add(producerRunId);
    const settle = (verdict: SubagentVerdict["decision"], reason: string): void => {
      verifying.delete(producerRunId);
      if (closed) return;
      if (deps.run(sessionId, spawned.runId)?.status === "stopped") owned.delete(sessionId);
      const current = deps.plan(sessionId)?.find((candidate) => candidate.id === item.id);
      // Applies only to the item as it was verified: a rewrite, reassignment or new
      // verifier meanwhile discards the verdict, and the next pass recomputes.
      const unchanged =
        current?.status === "in_progress" &&
        current.runId === producerRunId &&
        current.assignee === snapshot.assignee &&
        sameAgent(current.verifiedBy, snapshot.verifiedBy);
      if (unchanged) {
        deps.recordVerified(
          sessionId,
          { itemId: item.id, runId: spawned.runId, producerRunId, verdict, reason },
          cause,
        );
        const note =
          verdict === "APPROVE"
            ? null
            : (reason || "The verifier gave no verdict.").slice(0, MAX_NOTE_CHARS);
        deps.updatePlan(
          sessionId,
          [{ id: item.id, status: verdict === "APPROVE" ? "done" : "blocked", note }],
          cause,
        );
      }
      void schedule(sessionId);
    };
    // launchVerifier's done never rejects: a verifier that did not finish is "missing".
    void spawned.done.then((outcome) =>
      settle(outcome.decision, outcome.text.trim() || outcome.reason),
    );
    return "started";
  };

  const evaluateNow = async (sessionId: string, trigger?: string): Promise<void> => {
    if (closed) return;
    const items = deps.plan(sessionId);
    if (!items?.some((item) => item.assignee)) return;
    const generation = deps.generation(sessionId);
    const cause = trigger ?? lastCause.get(sessionId);
    const may = (): boolean => !closed && owned.has(sessionId) && deps.writable();
    let slots = deps.slots(sessionId);
    const updates: SessionPlanUpdate[] = [];
    const toVerify: { item: SessionPlanItem; runId: string }[] = [];

    // 1. Settle dispatched items whose run ended.
    for (const item of items) {
      if (item.status !== "in_progress") continue;
      const dispatch = dispatchOf(sessionId, item, generation);
      if (!dispatch) continue;
      // One patch per item: applyPlanUpdates applies the first patch for an id only.
      const patch: SessionPlanUpdate = { id: item.id };
      if (item.runId !== dispatch.runId) patch.runId = dispatch.runId;
      const run = deps.run(sessionId, dispatch.runId);
      if (run?.status === "stopped") owned.delete(sessionId);
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
      } else {
        toVerify.push({ item: { ...item, runId: dispatch.runId }, runId: dispatch.runId });
      }
      if (Object.keys(patch).length > 1) updates.push(patch);
    }

    // 2. Blocked items block everything downstream.
    const settled = applyPlanUpdates(items, updates);
    const next = propagateBlocked(settled);
    next.forEach((item, i) => {
      if (item.status !== settled[i]?.status) updates.push({ id: item.id, status: item.status });
    });
    if (updates.length) deps.updatePlan(sessionId, updates, cause);

    // 3. Verify and dispatch: only the plan owner's live intent, only when it can be logged.
    for (const { item, runId } of toVerify) {
      if (!may() || slots <= 0) return;
      let started: "started" | "wait";
      try {
        started = await verify(sessionId, item, runId, cause);
      } catch (error) {
        // Refused (the target vanished) or the launch failed: the item cannot be verified.
        deps.warn(`plan verifier for item ${item.id} could not start`, error);
        deps.updatePlan(
          sessionId,
          [
            {
              id: item.id,
              status: "blocked",
              note: `The verifier could not start: ${error instanceof Error ? error.message : String(error)}`.slice(
                0,
                MAX_NOTE_CHARS,
              ),
            },
          ],
          cause,
        );
        continue;
      }
      if (started === "wait") return;
      slots -= 1;
    }
    // One assigned item at a time in the parent's checkout; isolated items run in their
    // own worktrees, alongside each other and the one in the checkout.
    let checkoutBusy = next.some(
      (item) =>
        item.assignee &&
        !item.isolated &&
        item.status === "in_progress" &&
        dispatchOf(sessionId, item, generation),
    );
    for (const item of readyFrontier(next)) {
      if (!may() || slots <= 0) return;
      if (!item.assignee || (!item.isolated && checkoutBusy)) continue;
      const previous = dispatchOf(sessionId, item, generation);
      if (previous && runActive(deps.run(sessionId, previous.runId))) continue;
      // The plan changed during an earlier await of this pass: the next pass decides.
      const unchanged = (): boolean => {
        const current = deps.plan(sessionId)?.find((candidate) => candidate.id === item.id);
        return (
          deps.generation(sessionId) === generation &&
          current?.status === "todo" &&
          current.assignee === item.assignee &&
          itemTask(current) === itemTask(item)
        );
      };
      if (!unchanged()) return;
      const task = `${itemTask(item)}${dependencyContext(sessionId, next, item, generation)}`;
      let spawned: Awaited<ReturnType<PlanDispatcherDeps["spawn"]>>;
      try {
        spawned = await deps.spawn(sessionId, task, {
          agentName: item.assignee,
          worktree: item.isolated === true,
        });
      } catch (error) {
        deps.warn(`plan item ${item.id} could not be dispatched`, error);
        if (unchanged()) deps.updatePlan(sessionId, [{ id: item.id, status: "blocked" }], cause);
        continue;
      }
      if (spawned === "wait") return;
      slots -= 1;
      const adopt = unchanged();
      deps.recordDispatch(
        sessionId,
        { itemId: item.id, runId: spawned.runId, agentName: item.assignee, generation },
        cause,
      );
      if (!adopt) {
        deps.warn(`plan item ${item.id} changed while its run ${spawned.runId} launched`);
        return;
      }
      deps.updatePlan(
        sessionId,
        [{ id: item.id, status: "in_progress", runId: spawned.runId, note: null }],
        cause,
      );
      if (!item.isolated) checkoutBusy = true;
    }
  };

  // One pass at a time per session: a pass awaits spawns, and the plan updates it makes
  // trigger the next pass, which must see them.
  const schedule = (sessionId: string, trigger?: string): Promise<void> => {
    const next = (queues.get(sessionId) ?? Promise.resolve())
      .then(() => evaluateNow(sessionId, trigger))
      .catch((error: unknown) => deps.warn(`plan dispatch for session ${sessionId} failed`, error));
    queues.set(sessionId, next);
    void next.then(() => {
      if (queues.get(sessionId) === next) queues.delete(sessionId);
    });
    return next;
  };

  const unsubscribe = deps.subscribe((event) => {
    if (closed || !event.sessionId) return;
    const sessionId = event.sessionId;
    const agentPlan =
      event.kind === "plan.changed" &&
      event.actor.type === "agent" &&
      event.actor.sessionId === sessionId;
    if (agentPlan) owned.add(sessionId);
    if (agentPlan || event.kind === "subagent.run.finished") lastCause.set(sessionId, event.id);
    if (
      event.kind !== "plan.changed" &&
      event.kind !== "subagent.run.finished" &&
      event.kind !== "subagent.run.removed"
    ) {
      return;
    }
    // Subscribers must not append: run the pass after this append returns.
    const trigger = agentPlan || event.kind === "subagent.run.finished" ? event.id : undefined;
    queueMicrotask(() => void schedule(sessionId, trigger));
  });

  return {
    evaluate: schedule,
    evaluateAll: async () => {
      await Promise.all(deps.liveSessions().map((sessionId) => schedule(sessionId)));
    },
    close() {
      closed = true;
      unsubscribe();
    },
  };
}
