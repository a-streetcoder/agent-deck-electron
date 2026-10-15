import type { EventEnvelope } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import type { EventSubscriber } from "../src/eventLog.ts";
import { awaitSubagentRuns, type SubagentRunRecord } from "../src/subagentRunStore.ts";

const run = (id: string, status: SubagentRunRecord["status"]): SubagentRunRecord => ({
  id,
  parentSessionId: "parent",
  task: "task",
  status,
  createdAt: "2026-10-15T00:00:00.000Z",
  updatedAt: "2026-10-15T00:00:00.000Z",
  ...(status === "completed"
    ? { summary: "done", inputTokens: 3, outputTokens: 5, durationMs: 42, model: "mock" }
    : {}),
});

const finished = (id: string): EventEnvelope =>
  ({
    kind: "subagent.run.finished",
    subject: { type: "subagentRun", id },
  }) as EventEnvelope;

/** A stub log and store that record the order of subscribe and read calls. */
function stub(initial: Record<string, SubagentRunRecord>) {
  const calls: string[] = [];
  const store = { ...initial };
  const subscribers = new Set<EventSubscriber>();
  return {
    calls,
    store,
    emit: (event: EventEnvelope) => subscribers.forEach((subscriber) => subscriber(event)),
    subscriberCount: () => subscribers.size,
    deps: {
      subscribe: (subscriber: EventSubscriber) => {
        calls.push("subscribe");
        subscribers.add(subscriber);
        return () => subscribers.delete(subscriber);
      },
      read: (id: string) => {
        calls.push(`read:${id}`);
        return store[id];
      },
    },
  };
}

describe("awaitSubagentRuns", () => {
  it("subscribes before the first store read, so a finish between them is not missed", async () => {
    const log = stub({ a: run("a", "running") });
    // The run finishes right after the subscription, before the check: the commit
    // lands in the store and its event fires while nobody has read yet.
    const subscribe = log.deps.subscribe;
    log.deps.subscribe = (subscriber) => {
      const unsubscribe = subscribe(subscriber);
      log.store.a = run("a", "completed");
      return unsubscribe;
    };
    const outcome = await awaitSubagentRuns(["a"], log.deps, { timeoutMs: 5_000 });
    expect(log.calls[0]).toBe("subscribe");
    expect(outcome.timedOut).toBe(false);
    expect(outcome.results).toEqual([
      {
        id: "a",
        status: "completed",
        summary: "done",
        durationMs: 42,
        model: "mock",
        tokens: { input: 3, output: 5 },
      },
    ]);
    expect(log.subscriberCount()).toBe(0);
  });

  it("wakes on subagent.run.finished for a wanted run and ignores other runs", async () => {
    const log = stub({ a: run("a", "running"), b: run("b", "running") });
    const pending = awaitSubagentRuns(["a", "b"], log.deps, { timeoutMs: 5_000 });
    log.store.a = run("a", "completed");
    log.emit(finished("a"));
    log.store.c = run("c", "completed");
    log.emit(finished("c"));
    log.store.b = run("b", "stopped");
    log.emit(finished("b"));
    const outcome = await pending;
    expect(outcome.timedOut).toBe(false);
    expect(outcome.results.map((r) => [r.id, r.status])).toEqual([
      ["a", "completed"],
      ["b", "stopped"],
    ]);
  });

  it("returns partial results with current statuses on timeout and unsubscribes", async () => {
    const log = stub({ a: run("a", "completed"), b: run("b", "running") });
    const outcome = await awaitSubagentRuns(["a", "b", "ghost"], log.deps, { timeoutMs: 20 });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.results.map((r) => [r.id, r.status])).toEqual([
      ["a", "completed"],
      ["b", "running"],
      ["ghost", "not_found"],
    ]);
    expect(log.subscriberCount()).toBe(0);
  });

  it("wakes on an in-process settle when the log never publishes (read-only log)", async () => {
    const log = stub({ a: run("a", "running") });
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => (settle = resolve));
    const pending = awaitSubagentRuns(
      ["a"],
      { ...log.deps, settled: () => settled },
      { timeoutMs: 5_000 },
    );
    log.store.a = run("a", "failed");
    settle();
    expect((await pending).results[0]?.status).toBe("failed");
  });
});
