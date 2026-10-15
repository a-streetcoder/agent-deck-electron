import {
  applyPlanUpdates,
  type EventEnvelope,
  type ProjectedPlanDispatch,
  type SessionPlanItem,
} from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { createPlanDispatcher, type PlanDispatcherDeps } from "../src/planDispatcher.ts";
import type { SubagentRunStatus } from "../src/subagentRunStore.ts";

/** A stub world: one session's plan, a run store, a log of dispatches, and a stub spawn. */
function world(initial: SessionPlanItem[], options: { slots?: number } = {}) {
  let plan = initial;
  const runs = new Map<string, { status: SubagentRunStatus; summary?: string }>();
  const dispatches = new Map<string, ProjectedPlanDispatch>();
  const recorded: { itemId: string; runId: string; agentName: string; causationId?: string }[] = [];
  const spawned: { task: string; agentName: string; verifier: boolean; runId: string }[] = [];
  const verifierAnswers: ((text: string) => void)[] = [];
  const subscribers = new Set<(event: EventEnvelope) => void>();
  let seq = 0;
  const deps: PlanDispatcherDeps = {
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    writable: () => true,
    plan: () => plan,
    updatePlan: (_s, updates) => {
      plan = applyPlanUpdates(plan, updates);
    },
    dispatches: () => dispatches,
    run: (_s, runId) => runs.get(runId),
    slots: () => options.slots ?? 8,
    spawn: async (_s, task, { agentName, verifier }) => {
      const runId = `run-${spawned.length + 1}`;
      spawned.push({ task, agentName, verifier, runId });
      if (verifier) {
        return {
          runId,
          done: new Promise((resolve) => verifierAnswers.push((text) => resolve({ text }))),
        };
      }
      runs.set(runId, { status: "running" });
      return { runId, done: new Promise(() => {}) };
    },
    recordDispatch: (_s, dispatch, causationId) => {
      recorded.push({ ...dispatch, ...(causationId ? { causationId } : {}) });
      dispatches.set(dispatch.itemId, { runId: dispatch.runId, agentName: dispatch.agentName });
      return true;
    },
    warn: () => {},
  };
  const emit = (kind: string, actor: EventEnvelope["actor"] = { type: "system" }): string => {
    seq += 1;
    const event = {
      v: 1,
      id: `ev-${seq}`,
      seq,
      ts: new Date().toISOString(),
      logId: "log",
      kind,
      projectId: null,
      sessionId: "s1",
      subject: { type: "plan", id: "s1" },
      actor,
      payload: {},
    } satisfies EventEnvelope;
    for (const fn of subscribers) fn(event);
    return event.id;
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return {
    deps,
    runs,
    dispatches,
    recorded,
    spawned,
    verifierAnswers,
    emit,
    settle,
    plan: () => plan,
    status: () => Object.fromEntries(plan.map((i) => [i.id, i.status])),
  };
}

const AGENT = { type: "agent", sessionId: "s1" } as const;

describe("plan dispatcher", () => {
  it("dispatches ready assigned items once, then the dependant with the dependencies' results", async () => {
    const w = world([
      { id: "a", title: "Build A", status: "todo", assignee: "coder" },
      { id: "b", title: "Build B", status: "todo", assignee: "coder" },
      { id: "c", title: "Join", status: "todo", assignee: "coder", dependsOn: ["a", "b"] },
      { id: "manual", title: "Manual", status: "todo" },
    ]);
    const dispatcher = createPlanDispatcher(w.deps);
    const planEvent = w.emit("plan.changed", AGENT);
    await w.settle();
    expect(w.spawned.map((s) => s.task)).toEqual(["Build A", "Build B"]);
    expect(w.recorded).toEqual([
      { itemId: "a", runId: "run-1", agentName: "coder", causationId: planEvent },
      { itemId: "b", runId: "run-2", agentName: "coder", causationId: planEvent },
    ]);
    expect(w.status()).toEqual({ a: "in_progress", b: "in_progress", c: "todo", manual: "todo" });
    expect(w.plan()[0]?.runId).toBe("run-1");

    // Repeated events while running change nothing (level-triggered, idempotent).
    w.emit("plan.changed", AGENT);
    await dispatcher.evaluate("s1");
    expect(w.spawned).toHaveLength(2);

    w.runs.set("run-1", { status: "completed", summary: "A_RESULT" });
    w.emit("subagent.run.finished");
    await w.settle();
    expect(w.status()).toMatchObject({ a: "done", c: "todo" });
    expect(w.spawned).toHaveLength(2);

    w.runs.set("run-2", { status: "completed", summary: "B_RESULT" });
    const finished = w.emit("subagent.run.finished");
    await w.settle();
    expect(w.spawned).toHaveLength(3);
    expect(w.spawned[2]?.task).toContain("Join");
    expect(w.spawned[2]?.task).toContain("A_RESULT");
    expect(w.spawned[2]?.task).toContain("B_RESULT");
    expect(w.recorded[2]).toEqual({
      itemId: "c",
      runId: "run-3",
      agentName: "coder",
      causationId: finished,
    });
    dispatcher.close();
  });

  it("does not re-dispatch after a restart, and settles an interrupted run as blocked downstream", async () => {
    const w = world([
      { id: "a", title: "A", status: "in_progress", assignee: "coder", runId: "old-run" },
      { id: "b", title: "B", status: "todo", assignee: "coder", dependsOn: ["a"] },
    ]);
    w.dispatches.set("a", { runId: "old-run", agentName: "coder" });
    w.runs.set("old-run", { status: "running" });
    // A fresh process (no plan event of the owner seen yet) re-evaluates the restored plan.
    const dispatcher = createPlanDispatcher(w.deps);
    await dispatcher.evaluate("s1");
    expect(w.spawned).toHaveLength(0);
    // Boot recovery marked it interrupted: the item fails and blocks its dependant.
    w.runs.set("old-run", { status: "interrupted" });
    w.emit("plan.changed");
    await w.settle();
    expect(w.status()).toEqual({ a: "blocked", b: "blocked" });
    expect(w.spawned).toHaveLength(0);
    dispatcher.close();
  });

  it("verifies with a different agent and applies its verdict", async () => {
    const w = world([
      { id: "a", title: "A", status: "todo", assignee: "coder", verifiedBy: "reviewer" },
      { id: "b", title: "B", status: "todo", assignee: "coder", verifiedBy: "reviewer" },
    ]);
    const dispatcher = createPlanDispatcher(w.deps);
    w.emit("plan.changed", AGENT);
    await w.settle();
    w.runs.set("run-1", { status: "completed", summary: "A_DONE" });
    w.runs.set("run-2", { status: "completed", summary: "B_DONE" });
    w.emit("subagent.run.finished");
    await w.settle();
    const verifiers = w.spawned.filter((s) => s.verifier);
    expect(verifiers.map((v) => v.agentName)).toEqual(["reviewer", "reviewer"]);
    expect(verifiers[0]?.task).toContain("A_DONE");
    expect(w.status()).toEqual({ a: "in_progress", b: "in_progress" });
    // A second pass while verifying spawns no second verifier.
    await dispatcher.evaluate("s1");
    expect(w.spawned.filter((s) => s.verifier)).toHaveLength(2);
    w.verifierAnswers[0]?.("APPROVE\nLooks right.");
    w.verifierAnswers[1]?.("REJECT: tests missing");
    await w.settle();
    await w.settle();
    expect(w.status()).toEqual({ a: "done", b: "blocked" });
    dispatcher.close();
  });

  it("settles from the logged dispatch after a rewrite dropped the item's runId", async () => {
    const w = world([{ id: "a", title: "A", status: "in_progress", assignee: "coder" }]);
    w.dispatches.set("a", { runId: "r9", agentName: "coder" });
    w.runs.set("r9", { status: "completed", summary: "ok" });
    const dispatcher = createPlanDispatcher(w.deps);
    await dispatcher.evaluate("s1");
    expect(w.plan()).toEqual([
      { id: "a", title: "A", status: "done", assignee: "coder", runId: "r9" },
    ]);
    dispatcher.close();
  });

  it("respects the child cap and skips sessions whose owner never set the plan", async () => {
    const items: SessionPlanItem[] = [
      { id: "a", title: "A", status: "todo", assignee: "coder" },
      { id: "b", title: "B", status: "todo", assignee: "coder" },
    ];
    const capped = world(items, { slots: 1 });
    const one = createPlanDispatcher(capped.deps);
    capped.emit("plan.changed", AGENT);
    await capped.settle();
    expect(capped.spawned).toHaveLength(1);
    one.close();

    // A fork inherits the plan through a system restore: nothing is dispatched.
    const forked = world(items);
    const two = createPlanDispatcher(forked.deps);
    forked.emit("plan.changed");
    await forked.settle();
    expect(forked.spawned).toHaveLength(0);
    two.close();
  });
});
