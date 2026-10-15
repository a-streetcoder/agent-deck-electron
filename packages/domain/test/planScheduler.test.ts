import { describe, expect, it } from "vitest";
import { planGeneration, projectPlanDispatches } from "../src/eventDiffs.ts";
import {
  carryPlanProgress,
  detectCycles,
  planDepths,
  propagateBlocked,
  readyFrontier,
  retryPlanItemUpdates,
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

  it("counts a skipped dependency as satisfied (not needed), a blocked one as not", () => {
    expect(ids(readyFrontier([item("a", "skipped"), item("b", "todo", ["a"])]))).toEqual(["b"]);
    expect(ids(readyFrontier([item("a", "blocked"), item("b", "todo", ["a"])]))).toEqual([]);
  });
});

describe("propagateBlocked", () => {
  it("blocks every todo item downstream of a blocked one; skipped satisfies", () => {
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
      t: "todo",
      free: "todo",
      running: "in_progress",
    });
    expect(next[5]).toBe(plan[5]);
  });
});

describe("retryPlanItemUpdates (A10)", () => {
  it("reopens a blocked item and its blocked dependants only", () => {
    const plan = [
      item("a", "done"),
      item("b", "blocked", ["a"]),
      item("c", "blocked", ["b"]),
      item("d", "blocked", ["c"]),
      item("other", "blocked"),
      item("after", "done", ["b"]),
    ];
    expect(retryPlanItemUpdates(plan, "b")).toEqual([
      { id: "b", status: "todo" },
      { id: "c", status: "todo" },
      { id: "d", status: "todo" },
    ]);
    expect(retryPlanItemUpdates(plan, "a")).toEqual([]);
    expect(retryPlanItemUpdates(plan, "missing")).toEqual([]);
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
    expect(validatePlanGraph([{ ...item("a"), assignee: "coder", verifiedBy: "Coder" }])).toMatch(
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

describe("carryPlanProgress", () => {
  const done: SessionPlanItem = {
    ...item("a", "done"),
    assignee: "coder",
    runId: "r1",
    note: "kept",
  };
  it("keeps finished or running work of an unchanged item re-sent without a status", () => {
    const resent = { ...item("a"), assignee: "coder" };
    const running = { ...done, id: "b", status: "in_progress" as const, runId: "r2" };
    expect(
      carryPlanProgress(
        [done, running],
        [resent, { ...resent, id: "b", title: "A" }, item("new")],
        new Set(),
      ),
    ).toEqual([done, { ...running }, item("new")]);
  });
  it("starts over when the model states a status or the item changed", () => {
    const resent = { ...item("a"), assignee: "coder" };
    expect(carryPlanProgress([done], [resent], new Set(["a"]))).toEqual([resent]);
    const retitled = { ...resent, title: "Other" };
    expect(carryPlanProgress([done], [retitled], new Set())).toEqual([retitled]);
    const reassigned = { ...resent, assignee: "other" };
    expect(carryPlanProgress([done], [reassigned], new Set())).toEqual([reassigned]);
    const blocked = { ...done, status: "blocked" as const };
    expect(carryPlanProgress([blocked], [resent], new Set())).toEqual([resent]);
  });
});

describe("planDepths and dispatch projection", () => {
  it("names the current plan generation: the latest live set, not an import", () => {
    expect(
      planGeneration([
        { id: "g1", kind: "created", items: [] },
        { id: "u1", kind: "updated", items: [] },
        { id: "g2", kind: "replaced", items: [] },
        { id: "old", kind: "created", items: [], imported: {} },
        { id: "u2", kind: "updated", items: [] },
      ]),
    ).toBe("g2");
    expect(planGeneration(undefined)).toBeUndefined();
  });

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
      payload: { itemId, runId, agentName: "coder", generation: "g1" },
    });
    const first = projectPlanDispatches([event("e1", "a", "r1"), event("e2", "b", "r2")]);
    const next = projectPlanDispatches([event("e3", "a", "r3")], first);
    expect(next.get("s1")?.get("a")).toEqual({
      runId: "r3",
      agentName: "coder",
      generation: "g1",
      eventId: "e3",
    });
    expect(next.get("s1")?.get("b")?.runId).toBe("r2");
    // The initial projection is not mutated.
    expect(first.get("s1")?.get("a")?.runId).toBe("r1");
  });
});
