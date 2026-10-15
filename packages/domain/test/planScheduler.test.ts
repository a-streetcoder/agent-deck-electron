import { describe, expect, it } from "vitest";
import { projectPlanDispatches } from "../src/eventDiffs.ts";
import {
  detectCycles,
  planDepths,
  propagateBlocked,
  readyFrontier,
  validatePlanGraph,
} from "../src/planScheduler.ts";
import { applyPlanUpdates, type PlanItemStatus, type SessionPlanItem } from "../src/transcript.ts";

const item = (
  id: string,
  status: PlanItemStatus = "todo",
  dependsOn?: string[],
): SessionPlanItem => ({
  id,
  title: id.toUpperCase(),
  status,
  ...(dependsOn ? { dependsOn } : {}),
});
const ids = (items: readonly SessionPlanItem[]): string[] => items.map((i) => i.id);

describe("readyFrontier", () => {
  it("treats a flat plan as all ready (old plans stay valid)", () => {
    expect(ids(readyFrontier([item("a"), item("b", "done"), item("c")]))).toEqual(["a", "c"]);
  });

  it("walks a chain one item at a time", () => {
    const chain = [item("a"), item("b", "todo", ["a"]), item("c", "todo", ["b"])];
    expect(ids(readyFrontier(chain))).toEqual(["a"]);
    const afterA = applyPlanUpdates(chain, [{ id: "a", status: "done" }]);
    expect(ids(readyFrontier(afterA))).toEqual(["b"]);
    expect(
      ids(readyFrontier(applyPlanUpdates(afterA, [{ id: "b", status: "in_progress" }]))),
    ).toEqual([]);
  });

  it("joins a diamond only when both branches are done", () => {
    const diamond = [
      item("a", "done"),
      item("b", "todo", ["a"]),
      item("c", "todo", ["a"]),
      item("d", "todo", ["b", "c"]),
    ];
    expect(ids(readyFrontier(diamond))).toEqual(["b", "c"]);
    const oneDone = applyPlanUpdates(diamond, [{ id: "b", status: "done" }]);
    expect(ids(readyFrontier(oneDone))).toEqual(["c"]);
    expect(ids(readyFrontier(applyPlanUpdates(oneDone, [{ id: "c", status: "done" }])))).toEqual([
      "d",
    ]);
  });

  it("does not count a skipped dependency as done", () => {
    expect(ids(readyFrontier([item("a", "skipped"), item("b", "todo", ["a"])]))).toEqual([]);
  });
});

describe("propagateBlocked", () => {
  it("blocks every todo item downstream of a blocked or skipped one", () => {
    const plan = [
      item("a", "blocked"),
      item("b", "todo", ["a"]),
      item("c", "todo", ["b"]),
      item("s", "skipped"),
      item("t", "todo", ["s"]),
      item("free"),
      item("running", "in_progress", ["a"]),
    ];
    const next = propagateBlocked(plan);
    expect(Object.fromEntries(next.map((i) => [i.id, i.status]))).toEqual({
      a: "blocked",
      b: "blocked",
      c: "blocked",
      s: "skipped",
      t: "blocked",
      free: "todo",
      running: "in_progress",
    });
    expect(next[5]).toBe(plan[5]);
  });
});

describe("cycles and validation", () => {
  it("finds a cycle and names its path", () => {
    expect(
      detectCycles([item("a", "todo", ["c"]), item("b", "todo", ["a"]), item("c", "todo", ["b"])]),
    ).toEqual(["a", "c", "b", "a"]);
    expect(detectCycles([item("a"), item("b", "todo", ["a"])])).toBeUndefined();
  });

  it("rejects cycles, self and unknown dependencies, and a self-verifying producer", () => {
    expect(validatePlanGraph([item("a", "todo", ["b"]), item("b", "todo", ["a"])])).toMatch(
      /dependency cycle: a -> b -> a/,
    );
    expect(validatePlanGraph([item("a", "todo", ["a"])])).toMatch(/depends on itself/);
    expect(validatePlanGraph([item("a", "todo", ["zz"])])).toMatch(/unknown item zz/);
    expect(validatePlanGraph([{ ...item("a"), assignee: "coder", verifiedBy: "coder" }])).toMatch(
      /verifiedBy must differ from assignee/,
    );
    expect(
      validatePlanGraph([
        { ...item("a"), assignee: "coder", verifiedBy: "reviewer" },
        item("b", "todo", ["a"]),
      ]),
    ).toBeUndefined();
  });
});

describe("planDepths and dispatch projection", () => {
  it("lays a diamond out in three lanes", () => {
    const depths = planDepths([
      item("d", "todo", ["b", "c"]),
      item("b", "todo", ["a"]),
      item("c", "todo", ["a"]),
      item("a"),
    ]);
    expect(Object.fromEntries(depths)).toEqual({ a: 0, b: 1, c: 1, d: 2 });
  });

  it("keeps the latest dispatch per session item", () => {
    const event = (id: string, itemId: string, runId: string) => ({
      id,
      kind: "plan.item.dispatched",
      sessionId: "s1",
      subject: { type: "plan", id: "s1" },
      payload: { itemId, runId, agentName: "coder" },
    });
    const first = projectPlanDispatches([event("e1", "a", "r1"), event("e2", "b", "r2")]);
    const next = projectPlanDispatches([event("e3", "a", "r3")], first);
    expect(next.get("s1")?.get("a")).toEqual({ runId: "r3", agentName: "coder", eventId: "e3" });
    expect(next.get("s1")?.get("b")?.runId).toBe("r2");
    // The initial projection is not mutated.
    expect(first.get("s1")?.get("a")?.runId).toBe("r1");
  });
});
