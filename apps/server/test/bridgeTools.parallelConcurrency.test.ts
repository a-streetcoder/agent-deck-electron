import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import { registerDeckBridgeTools } from "../src/bridgeTools.ts";
import type { SessionManager } from "../src/SessionManager.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function harness(runSubagent: ReturnType<typeof vi.fn>) {
  const parent = { isRunning: true };
  const sessions = {
    get: vi.fn(() => parent),
    runSubagent,
  } as unknown as SessionManager;
  const bridge = new BridgeRegistry();
  registerDeckBridgeTools(bridge, sessions);
  const dispatch = (params: Record<string, unknown>) =>
    bridge.dispatch(
      {
        tool: "managed_parallel",
        params,
        sessionId: randomUUID(),
        toolCallId: "parallel-call",
        token: "test-token",
      },
      { token: "test-token" },
    );
  return { bridge, dispatch, parent, sessions };
}

const tasks = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ task: `task-${index + 1}` }));

async function turn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("managed_parallel bounded concurrency", () => {
  it("advertises the strict integer concurrency contract and default", () => {
    const { bridge } = harness(vi.fn());
    const spec = bridge.specs().find((candidate) => candidate.name === "managed_parallel")!;
    const concurrency = (spec.parameters.properties as Record<string, unknown>).concurrency;

    expect(concurrency).toEqual(
      expect.objectContaining({ type: "integer", minimum: 1, maximum: 8 }),
    );
    expect(spec.description).toContain("defaults to 4");
    expect(spec.promptSnippet).toContain("concurrency?");
    expect(spec.promptSnippet).toContain("default 4");
  });

  it.each([0, 9, 1.5, "2"])("rejects invalid concurrency %p before launch", async (value) => {
    const runSubagent = vi.fn();
    const { dispatch } = harness(runSubagent);

    const response = await dispatch({ concurrency: value, tasks: tasks(1) });

    expect(response.isError).toBe(true);
    expect(response.content).toContain("Invalid managed_parallel arguments");
    expect(runSubagent).not.toHaveBeenCalled();
  });

  it("defaults to at most four active children and starts queued work as slots free", async () => {
    const gates = tasks(6).map(() => deferred<string>());
    let active = 0;
    let maxActive = 0;
    const runSubagent = vi.fn((_parent, task: string) => {
      const index = Number(task.slice("task-".length)) - 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      return gates[index]!.promise.finally(() => {
        active -= 1;
      });
    });
    const { dispatch } = harness(runSubagent);

    const responsePromise = dispatch({ tasks: tasks(6) });
    await turn();
    expect(runSubagent).toHaveBeenCalledTimes(4);
    expect(maxActive).toBe(4);

    gates[1]!.resolve("result-2");
    await turn();
    expect(runSubagent).toHaveBeenCalledTimes(5);
    expect(active).toBe(4);
    gates[4]!.resolve("result-5");
    await turn();
    expect(runSubagent).toHaveBeenCalledTimes(6);
    expect(active).toBe(4);

    for (const [index, gate] of gates.entries()) gate.resolve(`result-${index + 1}`);
    await responsePromise;
    expect(maxActive).toBe(4);
  });

  it.each([
    { requested: 2, count: 5, expected: 2 },
    { requested: 8, count: 3, expected: 3 },
  ])("uses requested concurrency $requested capped by $count tasks", async (scenario) => {
    const gate = deferred<string>();
    let active = 0;
    let maxActive = 0;
    const runSubagent = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await gate.promise;
      active -= 1;
      return "done";
    });
    const { dispatch } = harness(runSubagent);

    const responsePromise = dispatch({
      concurrency: scenario.requested,
      tasks: tasks(scenario.count),
    });
    await turn();
    expect(runSubagent).toHaveBeenCalledTimes(scenario.expected);
    expect(maxActive).toBe(scenario.expected);
    gate.resolve("go");
    await responsePromise;
  });

  it("renders reverse completion and mixed failure in input order", async () => {
    const gates = tasks(3).map(() => deferred<string>());
    const runSubagent = vi.fn((_parent, task: string) => {
      const index = Number(task.slice("task-".length)) - 1;
      return gates[index]!.promise;
    });
    const { dispatch } = harness(runSubagent);

    const responsePromise = dispatch({ concurrency: 3, tasks: tasks(3) });
    await turn();
    gates[2]!.resolve("third result");
    gates[1]!.reject(new Error("second failed"));
    gates[0]!.resolve("first result");
    const response = await responsePromise;

    expect(response.isError).toBe(false);
    expect(response.content).toBe(
      "### Subagent 1\nfirst result\n\n" +
        "### Subagent 2 (failed)\nError: second failed\n\n" +
        "### Subagent 3\nthird result",
    );
  });

  it("forwards worktree to every child when slots begin", async () => {
    const runSubagent = vi.fn().mockResolvedValue("done");
    const { dispatch } = harness(runSubagent);

    await dispatch({ concurrency: 1, worktree: true, tasks: tasks(2) });

    expect(runSubagent).toHaveBeenCalledTimes(2);
    for (const call of runSubagent.mock.calls) {
      expect(call).toEqual([
        expect.any(String),
        expect.any(String),
        undefined,
        undefined,
        undefined,
        "parallel",
        true,
      ]);
    }
  });

  it("does not launch queued tasks after parent teardown", async () => {
    const first = deferred<string>();
    const runSubagent = vi.fn().mockImplementation(() => first.promise);
    const { dispatch, parent } = harness(runSubagent);

    const responsePromise = dispatch({ concurrency: 1, tasks: tasks(3) });
    await turn();
    expect(runSubagent).toHaveBeenCalledTimes(1);

    parent.isRunning = false;
    first.resolve("first completed during teardown");
    const response = await responsePromise;

    expect(runSubagent).toHaveBeenCalledTimes(1);
    expect(response.isError).toBe(false);
    expect(response.content).toContain("### Subagent 1\nfirst completed during teardown");
    expect(response.content).toContain(
      "### Subagent 2 (failed)\nError: parent session is no longer running; queued subagent cancelled",
    );
    expect(response.content).toContain(
      "### Subagent 3 (failed)\nError: parent session is no longer running; queued subagent cancelled",
    );
  });
});
