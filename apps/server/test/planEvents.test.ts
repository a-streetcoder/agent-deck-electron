import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionPlanItem } from "@agent-deck/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makePlanEventService } from "../src/services/planEvents.ts";

/**
 * SUB-14: a durable history of plan changes, matching native's
 * `PiAgentSessionStore.appendPlanEvent` — the store keeps how the plan evolved,
 * not just its current state.
 */

const items = (...titles: string[]): SessionPlanItem[] =>
  titles.map((title, index) => ({ id: `p${index + 1}`, title, status: "todo" as const }));

describe("plan event history (SUB-14)", () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "plan-events-"));
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("classifies the first plan as created and a later one as replaced", () => {
    const service = makePlanEventService({ dataDir });
    service.record("s1", "set", [], items("draft the api"));
    service.record("s1", "set", items("draft the api"), items("draft the api", "write the tests"));

    expect(service.list("s1").map((event) => event.kind)).toEqual(["created", "replaced"]);
    expect(service.list("s1")[1]?.items.map((item) => item.title)).toEqual([
      "draft the api",
      "write the tests",
    ]);
  });

  it("records a replacement that reuses the same item ids as replaced, not updated", () => {
    const service = makePlanEventService({ dataDir });
    service.record("s1", "set", [], items("old title"));
    // Same id, same length, different content: a shape-based classifier calls
    // this an in-place patch, but the agent replaced the whole plan and native
    // records `replaced` because the replacement API is what ran (Codex).
    service.record("s1", "set", items("old title"), items("new title"));

    expect(service.list("s1").map((event) => event.kind)).toEqual(["created", "replaced"]);
  });

  it("records a restated plan, because declaring a plan is itself the event", () => {
    const service = makePlanEventService({ dataDir });
    const plan = items("draft the api");
    service.record("s1", "set", [], plan);
    // Native's setSessionPlan has no change detection — only update does.
    service.record("s1", "set", plan, plan);

    expect(service.list("s1").map((event) => event.kind)).toEqual(["created", "replaced"]);
  });

  it("records emptying a plan as cleared, with no items", () => {
    const service = makePlanEventService({ dataDir });
    service.record("s1", "set", [], items("draft the api"));
    service.record("s1", "set", items("draft the api"), []);

    const events = service.list("s1");
    expect(events.map((event) => event.kind)).toEqual(["created", "cleared"]);
    expect(events[1]?.items).toEqual([]);
  });

  it("ignores an update that changed nothing, and clearing what was already empty", () => {
    const service = makePlanEventService({ dataDir });
    const plan = items("draft the api");
    service.record("s1", "set", [], plan);
    // Native's updateSessionPlan returns early on `guard changed else`, so a
    // patch for an unknown id — or one that rewrites a value with itself —
    // must not manufacture history.
    service.record("s1", "update", plan, plan);
    service.record("s1", "set", [], []);

    expect(service.list("s1")).toHaveLength(1);
  });

  it("records an in-place item edit as updated", () => {
    const service = makePlanEventService({ dataDir });
    service.record("s1", "set", [], items("draft the api"));
    service.record("s1", "update", items("draft the api"), [
      { id: "p1", title: "draft the api", status: "done" },
    ]);

    const events = service.list("s1");
    expect(events.map((event) => event.kind)).toEqual(["created", "updated"]);
    expect(events[1]?.items[0]?.status).toBe("done");
  });

  it("keeps only the most recent 100 events, as native's suffix(100) does", () => {
    const service = makePlanEventService({ dataDir });
    for (let i = 0; i < 130; i++) {
      service.record("s1", "set", i === 0 ? [] : items(`step ${i - 1}`), items(`step ${i}`));
    }

    const events = service.list("s1");
    expect(events).toHaveLength(100);
    expect(events[0]?.items[0]?.title).toBe("step 30");
    expect(events[99]?.items[0]?.title).toBe("step 129");
  });

  it("survives a restart and stays scoped to its own session", () => {
    const service = makePlanEventService({ dataDir });
    service.record("s1", "set", [], items("session one"));
    service.record("s2", "set", [], items("session two"));

    const reopened = makePlanEventService({ dataDir });
    expect(reopened.list("s1").map((event) => event.items[0]?.title)).toEqual(["session one"]);
    expect(reopened.list("s2").map((event) => event.items[0]?.title)).toEqual(["session two"]);
    expect(reopened.list("unknown")).toEqual([]);
  });

  it("keeps a snapshot of the plan as it stood, not a live reference", () => {
    const service = makePlanEventService({ dataDir });
    const plan = items("draft the api");
    service.record("s1", "set", [], plan);
    plan[0]!.title = "mutated afterwards";

    expect(service.list("s1")[0]?.items[0]?.title).toBe("draft the api");
  });

  it("seeds a created event for a forked session inheriting a plan it has no history for", () => {
    const service = makePlanEventService({ dataDir });
    // A fork copies the source's plan onto a NEW session id, so the fork's own
    // bucket is empty. Native seeds exactly this case at load time: a plan
    // holding no events gets a synthetic `created`.
    service.record("fork", "restore", [], items("inherited step"));

    const events = service.list("fork");
    expect(events.map((event) => event.kind)).toEqual(["created"]);
    expect(events[0]?.items[0]?.title).toBe("inherited step");
  });

  it("leaves an existing history alone when a reopened session replays its plan", () => {
    const service = makePlanEventService({ dataDir });
    service.record("s1", "set", [], items("draft the api"));
    // Reopening republishes the same plan; recording it would forge a second
    // "created" on every relaunch.
    service.record("s1", "restore", [], items("draft the api"));
    service.record("s1", "restore", [], items("draft the api"));

    expect(service.list("s1").map((event) => event.kind)).toEqual(["created"]);
  });

  it("records nothing when a restore carries no plan", () => {
    const service = makePlanEventService({ dataDir });
    service.record("s1", "restore", [], []);

    expect(service.list("s1")).toEqual([]);
  });

  it("drops a deleted session's history from disk", () => {
    const service = makePlanEventService({ dataDir });
    service.record("s1", "set", [], items("session one"));
    service.record("s2", "set", [], items("session two"));
    service.deleteSession("s1");

    expect(service.list("s1")).toEqual([]);
    expect(makePlanEventService({ dataDir }).list("s1")).toEqual([]);
    // The bucket is removed outright rather than left as an empty array.
    const onDisk = JSON.parse(
      readFileSync(path.join(dataDir, "plan-events", "index.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(onDisk)).toEqual(["s2"]);
  });
});
