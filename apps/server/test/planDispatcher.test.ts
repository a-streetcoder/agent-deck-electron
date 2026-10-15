import {
  applyPlanUpdates,
  type EventEnvelope,
  type ProjectedPlanDispatch,
  type SessionPlanItem,
} from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import {
  createPlanDispatcher,
  MAX_DEPENDENCY_CONTEXT_CHARS,
  type PlanDispatcherDeps,
} from "../src/planDispatcher.ts";
import type { SubagentRunStatus } from "../src/subagentRunStore.ts";

/** A stub world: one session's plan, a run store, a dispatch log and a stub spawn. */
function world(initial: SessionPlanItem[]) {
  let plan = initial;
  let generation: string | undefined = "gen-1";
  let slots = 8;
  const runs = new Map<string, { status: SubagentRunStatus; summary?: string }>();
  const dispatches = new Map<string, ProjectedPlanDispatch>();
  const recorded: Record<string, unknown>[] = [];
  const verified: Record<string, unknown>[] = [];
  const causes: (string | undefined)[] = [];
  const spawned: {
    task: string;
    agentName: string;
    verifier: boolean;
    worktree: boolean;
    runId: string;
  }[] = [];
  const answers = new Map<string, (text: string) => void>();
  const subscribers = new Set<(event: EventEnvelope) => void>();
  let seq = 0;
  let spawnHook: (() => void) | undefined;
  let refuse = 0;
  const deps: PlanDispatcherDeps = {
    subscribe: (fn) => {
      subscribers.add(fn);
      return () => subscribers.delete(fn);
    },
    writable: () => true,
    plan: () => plan,
    generation: () => generation,
    updatePlan: (_s, updates, causationId) => {
      plan = applyPlanUpdates(plan, updates);
      causes.push(causationId);
    },
    dispatches: () => dispatches,
    run: (_s, runId) => runs.get(runId),
    filesChanged: async () => ["src/a.ts"],
    slots: () => slots,
    spawn: async (_s, task, options) => {
      spawnHook?.();
      if (refuse > 0) {
        refuse -= 1;
        return "wait";
      }
      const runId = `run-${spawned.length + 1}`;
      spawned.push({ task, ...options, runId });
      runs.set(runId, { status: "running" });
      const done = new Promise<{ text: string }>((resolve) =>
        answers.set(runId, (text) => {
          runs.set(runId, { status: "completed", summary: text });
          resolve({ text });
        }),
      );
      return { runId, done };
    },
    recordDispatch: (_s, dispatch, causationId) => {
      recorded.push({ ...dispatch, causationId });
      dispatches.set(dispatch.itemId, dispatch);
      return true;
    },
    recordVerified: (_s, entry, causationId) => {
      verified.push({ ...entry, causationId });
      return true;
    },
    liveSessions: () => ["s1"],
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
  const AGENT = { type: "agent", sessionId: "s1" } as const;
  return {
    deps,
    runs,
    dispatches,
    recorded,
    verified,
    causes,
    spawned,
    emit,
    /** The agent sets or updates the plan (the owner's live intent). */
    agentPlan: () => emit("plan.changed", AGENT),
    /** A dispatched run ends: the store's subagent.run.finished. */
    finish: (
      runId: string,
      status: SubagentRunStatus = "completed",
      summary = `${runId} result`,
    ) => {
      runs.set(runId, { status, summary });
      return emit("subagent.run.finished");
    },
    answer: (runId: string, text: string) => answers.get(runId)?.(text),
    settle: async () => {
      for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    },
    plan: () => plan,
    setPlan: (next: SessionPlanItem[]) => (plan = next),
    setGeneration: (next: string) => (generation = next),
    setSlots: (next: number) => (slots = next),
    refuseNext: (times: number) => (refuse = times),
    onSpawn: (hook: () => void) => (spawnHook = hook),
    status: () => Object.fromEntries(plan.map((i) => [i.id, i.status])),
  };
}

const todo = (id: string, extra: Partial<SessionPlanItem> = {}): SessionPlanItem => ({
  id,
  title: `Build ${id}`,
  status: "todo",
  assignee: "coder",
  ...extra,
});

describe("plan dispatcher", () => {
  it("runs assigned items one at a time in the checkout, then the dependant with their results", async () => {
    const w = world([
      todo("a", { task: "Write part A carefully" }),
      todo("b"),
      todo("c", { dependsOn: ["a", "b"] }),
      { id: "manual", title: "Manual", status: "todo" },
    ]);
    const dispatcher = createPlanDispatcher(w.deps);
    const planEvent = w.agentPlan();
    await w.settle();
    expect(w.spawned.map((s) => s.task)).toEqual(["Write part A carefully"]);
    expect(w.recorded).toEqual([
      {
        itemId: "a",
        runId: "run-1",
        agentName: "coder",
        generation: "gen-1",
        causationId: planEvent,
      },
    ]);
    expect(w.status()).toEqual({ a: "in_progress", b: "todo", c: "todo", manual: "todo" });

    // Repeated passes while running change nothing (level-triggered, idempotent).
    await dispatcher.evaluate("s1");
    expect(w.spawned).toHaveLength(1);

    const finishedA = w.finish("run-1", "completed", "A_RESULT");
    await w.settle();
    expect(w.status()).toMatchObject({ a: "done", b: "in_progress", c: "todo" });
    expect(w.recorded[1]).toMatchObject({ itemId: "b", causationId: finishedA });
    // The server's plan writes name the finish as their cause.
    expect(w.causes.at(-1)).toBe(finishedA);

    const finishedB = w.finish("run-2", "completed", "B_RESULT");
    await w.settle();
    expect(w.spawned[2]?.task).toMatch(/^Build c[\s\S]*A_RESULT[\s\S]*B_RESULT/);
    expect(w.recorded[2]).toMatchObject({ itemId: "c", causationId: finishedB });
    dispatcher.close();
  });

  it("runs isolated items in parallel, each in its own worktree", async () => {
    const w = world([todo("a", { isolated: true }), todo("b", { isolated: true }), todo("c")]);
    const dispatcher = createPlanDispatcher(w.deps);
    w.agentPlan();
    await w.settle();
    expect(w.spawned.map((s) => [s.runId, s.worktree])).toEqual([
      ["run-1", true],
      ["run-2", true],
      ["run-3", false],
    ]);
    dispatcher.close();
  });

  it("caps the fan-in: each dependency result and the total", async () => {
    const deps = Array.from({ length: 12 }, (_, i) => `d${i}`);
    const w = world([
      ...deps.map((id) => ({
        ...todo(id),
        status: "done" as const,
        runId: `r-${id}`,
      })),
      todo("join", { dependsOn: deps }),
    ]);
    for (const id of deps)
      w.runs.set(`r-${id}`, { status: "completed", summary: "x".repeat(5_000) });
    const dispatcher = createPlanDispatcher(w.deps);
    w.agentPlan();
    await w.settle();
    const task = w.spawned[0]!.task;
    expect(task.match(/x+/g)?.every((run) => run.length <= 2_000)).toBe(true);
    expect((task.match(/x/g) ?? []).length).toBe(MAX_DEPENDENCY_CONTEXT_CHARS);
    dispatcher.close();
  });

  it("settles a restored or forked plan but never dispatches it", async () => {
    // A fork inherits runIds; a restart restores them: no live intent in this process.
    const w = world([
      todo("a", { status: "in_progress", runId: "old-run" }),
      todo("b", { dependsOn: ["a"] }),
      todo("free"),
    ]);
    w.runs.set("old-run", { status: "interrupted" });
    const dispatcher = createPlanDispatcher(w.deps);
    w.emit("plan.changed"); // the restore (system actor)
    await w.settle();
    await dispatcher.evaluate("s1");
    expect(w.status()).toEqual({ a: "blocked", b: "blocked", free: "todo" });
    expect(w.spawned).toHaveLength(0);
    // The agent touching the plan is live intent again.
    w.agentPlan();
    await w.settle();
    expect(w.spawned.map((s) => s.task)).toEqual(["Build free"]);
    dispatcher.close();
  });

  it("Stop mid-plan: the stopped item blocks and nothing else starts until the agent acts", async () => {
    const w = world([todo("a"), todo("b"), todo("c")]);
    const dispatcher = createPlanDispatcher(w.deps);
    w.agentPlan();
    await w.settle();
    w.finish("run-1", "stopped");
    await w.settle();
    expect(w.status()).toEqual({ a: "blocked", b: "todo", c: "todo" });
    expect(w.spawned).toHaveLength(1);
    w.agentPlan();
    await w.settle();
    expect(w.spawned.map((s) => s.task)).toEqual(["Build a", "Build b"]);
    dispatcher.close();
  });

  it("ignores dispatches of an older plan generation", async () => {
    const w = world([todo("a")]);
    w.dispatches.set("a", { runId: "stale", agentName: "coder", generation: "gen-0" });
    w.runs.set("stale", { status: "running" });
    const dispatcher = createPlanDispatcher(w.deps);
    w.agentPlan();
    await w.settle();
    expect(w.spawned.map((s) => s.runId)).toEqual(["run-1"]);
    dispatcher.close();
  });

  it("waits at the child cap instead of blocking, and retries on the next pass", async () => {
    const w = world([todo("a")]);
    const dispatcher = createPlanDispatcher(w.deps);
    w.refuseNext(1);
    w.agentPlan();
    await w.settle();
    expect(w.status()).toEqual({ a: "todo" });
    await dispatcher.evaluate("s1"); // e.g. a freed slot woke the plan
    expect(w.status()).toEqual({ a: "in_progress" });
    dispatcher.close();
  });

  it("skips a dispatch when the plan changed during the pass", async () => {
    const w = world([todo("a", { isolated: true }), todo("b", { isolated: true })]);
    const dispatcher = createPlanDispatcher(w.deps);
    w.onSpawn(() => w.setGeneration("gen-2"));
    w.agentPlan();
    await w.settle();
    // a launched (and is recorded) but the new plan decides about b: not launched here.
    expect(w.spawned).toHaveLength(1);
    expect(w.plan().find((i) => i.id === "b")?.status).toBe("todo");
    dispatcher.close();
  });

  it("verifies with a different agent: APPROVE marks done, REJECT blocks with the reason", async () => {
    const w = world([
      todo("a", { verifiedBy: "reviewer", isolated: true }),
      todo("b", { verifiedBy: "reviewer", isolated: true }),
    ]);
    const dispatcher = createPlanDispatcher(w.deps);
    w.agentPlan();
    await w.settle();
    const finished = w.finish("run-1", "completed", "A_DONE");
    w.finish("run-2", "completed", "B_DONE");
    await w.settle();
    const verifiers = w.spawned.filter((s) => s.verifier);
    expect(verifiers.map((v) => [v.agentName, v.worktree])).toEqual([
      ["reviewer", false],
      ["reviewer", false],
    ]);
    expect(verifiers[0]?.task).toMatch(/^verify: Build a/);
    expect(verifiers[0]?.task).toContain("A_DONE");
    expect(verifiers[0]?.task).toContain("- src/a.ts");
    expect(verifiers[0]?.task).toContain("APPROVE or REJECT alone on the first line");
    // A second pass while verifying spawns no second verifier.
    await dispatcher.evaluate("s1");
    expect(w.spawned.filter((s) => s.verifier)).toHaveLength(2);
    w.answer(verifiers[0]!.runId, "APPROVE\nLooks right.");
    w.answer(verifiers[1]!.runId, "REJECT: tests missing");
    await w.settle();
    expect(w.status()).toEqual({ a: "done", b: "blocked" });
    expect(w.plan()[1]?.note).toBe("REJECT: tests missing");
    expect(w.verified).toEqual([
      expect.objectContaining({
        itemId: "a",
        verdict: "APPROVE",
        producerRunId: "run-1",
        causationId: finished,
      }),
      expect.objectContaining({ itemId: "b", verdict: "REJECT", reason: "REJECT: tests missing" }),
    ]);
    dispatcher.close();
  });

  it("discards a verdict when the item was reassigned during verification", async () => {
    const w = world([todo("a", { verifiedBy: "reviewer" })]);
    const dispatcher = createPlanDispatcher(w.deps);
    w.agentPlan();
    await w.settle();
    w.finish("run-1");
    await w.settle();
    const verifier = w.spawned.find((s) => s.verifier)!;
    w.setPlan(w.plan().map((item) => ({ ...item, verifiedBy: "auditor" })));
    w.answer(verifier.runId, "APPROVE");
    await w.settle();
    expect(w.verified).toEqual([]);
    // The next pass verifies again with the new verifier.
    expect(w.spawned.filter((s) => s.verifier).map((s) => s.agentName)).toEqual([
      "reviewer",
      "auditor",
    ]);
    expect(w.status()).toEqual({ a: "in_progress" });
    dispatcher.close();
  });

  it("waits while delegation is off, then resumes on a setting change", async () => {
    const w = world([todo("a", { verifiedBy: "reviewer" })]);
    const dispatcher = createPlanDispatcher(w.deps);
    w.agentPlan();
    await w.settle();
    w.setSlots(0);
    w.finish("run-1");
    await w.settle();
    expect(w.spawned.filter((s) => s.verifier)).toHaveLength(0);
    w.setSlots(8);
    await dispatcher.evaluateAll();
    expect(w.spawned.filter((s) => s.verifier)).toHaveLength(1);
    dispatcher.close();
  });

  it("settles from the logged dispatch after a rewrite dropped the item's runId", async () => {
    const w = world([todo("a", { status: "in_progress" })]);
    w.dispatches.set("a", { runId: "r9", agentName: "coder", generation: "gen-1" });
    w.runs.set("r9", { status: "completed", summary: "ok" });
    const dispatcher = createPlanDispatcher(w.deps);
    await dispatcher.evaluate("s1");
    expect(w.plan()).toEqual([{ ...todo("a"), status: "done", runId: "r9" }]);
    dispatcher.close();
  });
});
