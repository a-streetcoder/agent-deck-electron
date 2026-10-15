import { describe, expect, it } from "vitest";
import {
  comparePlanHistory,
  equivalenceReport,
  mergePlanHistory,
  mergeSupervisorRequests,
  placeAfterAnchors,
  projectPlans,
  projectSupervisor,
  type ProjectedPlanChange,
} from "../src/index.ts";

const T = "2026-10-15T08:00:00.000Z"; // one timestamp for every entry: order never uses it

interface Entry {
  id: string;
  createdAt: string;
  source?: "log";
}

const entry = (id: string, createdAt = T): Entry => ({ id, createdAt });
const change = (id: string, imported?: { afterId?: string }): ProjectedPlanChange => ({
  id,
  kind: "updated",
  items: [],
  at: T,
  ...(imported ? { imported } : {}),
});
const fromLog = (c: { id: string }): Entry => ({ id: c.id, createdAt: T, source: "log" });
const ids = (items: { id: string }[]) => items.map((item) => item.id);

describe("A1d placeAfterAnchors", () => {
  it("places at the start, after an anchor, at the end for an unknown anchor, ties in order", () => {
    const placed = placeAfterAnchors(
      [entry("a"), entry("b")],
      [
        { item: entry("x1"), afterId: "a" },
        { item: entry("x2"), afterId: "a" },
        { item: entry("s") },
        { item: entry("u"), afterId: "gone" },
      ],
    );
    expect(ids(placed)).toEqual(["s", "a", "x1", "x2", "b", "u"]);
  });
});

describe("A1d mergePlanHistory", () => {
  it("keeps log order, places imports and store-only entries by store predecessor", () => {
    // Log: live L1, live L2, then two pre-A1 imports and one lost append imported later.
    const logged = [
      change("L1"),
      change("L2"),
      change("P1", {}),
      change("P2", { afterId: "P1" }),
      change("X", { afterId: "L1" }),
    ];
    // The store holds P2, L1, X, L2 and S (S never reached the log yet); P1 fell off the cap.
    const stored = ["P2", "L1", "X", "L2", "S"].map((id) => entry(id));
    const merged = mergePlanHistory(logged, stored, fromLog);
    expect(ids(merged)).toEqual(["P1", "P2", "L1", "X", "L2", "S"]);
    expect(merged[0]?.source).toBe("log"); // the redacted copy is marked
    expect(merged.slice(1).every((item) => item.source === undefined)).toBe(true);
  });
});

describe("A1d mergeSupervisorRequests", () => {
  it("prefers own entries, filters by parent and places a failed append by createdAt", () => {
    const logged = projectSupervisor([
      {
        kind: "supervisor.request.opened",
        subject: { type: "supervisorRequest", id: "old" },
        payload: { parentSessionId: "p", createdAt: "2026-10-15T07:00:00.000Z" },
      },
      { kind: "writer.acquired", subject: { type: "server", id: "w" }, payload: {} },
      {
        kind: "supervisor.request.opened",
        subject: { type: "supervisorRequest", id: "b" },
        payload: { parentSessionId: "p", createdAt: "2026-10-15T09:00:00.000Z" },
      },
      {
        kind: "supervisor.request.opened",
        subject: { type: "supervisorRequest", id: "other" },
        payload: { parentSessionId: "q", createdAt: "2026-10-15T09:00:00.000Z" },
      },
    ]);
    expect(logged.get("old")?.status).toBe("interrupted");
    const own = [entry("b", "2026-10-15T09:00:00.000Z"), entry("lost", "2026-10-15T08:00:00.000Z")];
    const merged = mergeSupervisorRequests(
      logged,
      own,
      (request) => ({ id: request.id, createdAt: request.createdAt ?? "", source: "log" as const }),
      "p",
    );
    expect(ids(merged)).toEqual(["old", "lost", "b"]);
    expect(merged[2]).toBe(own[0]);
  });
});

describe("A1d comparePlanHistory and the report", () => {
  it("labels imports by the log start, counts content mismatches, ignores redacted titles", () => {
    const stored = [
      { id: "pre", kind: "created", items: [], at: "2026-01-01T00:00:00.000Z" },
      {
        id: "same",
        kind: "updated",
        items: [{ id: "i".repeat(300), status: "todo", title: "/home/u/x" }],
        at: T,
      },
      { id: "changed", kind: "updated", items: [{ id: "a", status: "done" }], at: T },
      { id: "lost", kind: "updated", items: [], at: T },
    ];
    const logged = projectPlans(
      [
        {
          id: "same",
          kind: "plan.changed",
          sessionId: "s",
          subject: { type: "plan", id: "s" },
          payload: {
            kind: "updated",
            items: [{ id: `${"i".repeat(199)}…`, status: "todo", title: "<home>/x" }],
          },
        },
        {
          id: "changed",
          kind: "plan.changed",
          sessionId: "s",
          subject: { type: "plan", id: "s" },
          payload: { kind: "updated", items: [{ id: "a", status: "todo" }] },
        },
      ],
      [],
    ).get("s")!;
    const result = comparePlanHistory(stored, logged, "2026-10-01T00:00:00.000Z");
    expect(result.contentMismatches).toBe(1);
    expect(result.missing.map((m) => [m.event.id, m.afterId, m.imported])).toEqual([
      ["pre", undefined, true],
      ["lost", "changed", false],
    ]);
    expect(
      equivalenceReport({
        readOnly: false,
        failures: 0,
        runs: { subagentReconciled: 1, subagentRecovered: 2, loopReconciled: 0, loopRecovered: 0 },
        plans: { imported: 1, reconciled: 1, contentMismatches: 1 },
      }),
    ).toMatchObject({ planImported: 1, mismatches: 3 });
    expect(equivalenceReport({ readOnly: true, failures: 0 }).mismatches).toBe(0);
  });
});
