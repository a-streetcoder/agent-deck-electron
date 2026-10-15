import { retryPlanItemUpdates, type SessionPlanItem } from "@agent-deck/domain";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { disabledEventLog } from "../src/eventLog.ts";
import { createEventProducers } from "../src/eventProducers.ts";
import type { PlanDispatcher } from "../src/planDispatcher.ts";
import { registerSessionRoutes } from "../src/routes/sessions.ts";
import { SessionMutationClaims } from "../src/sessionMutationClaims.ts";

// A10: POST /sessions/:id/plan/items/:itemId/retry, the Run tree's "Retry from node" on a
// plan item. The dispatcher's own behaviour is in planDispatcher.test.ts.
const servers: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

function routes(plan: SessionPlanItem[], events = createEventProducers(disabledEventLog())) {
  const fastify = Fastify();
  servers.push(fastify);
  // The dispatcher's contract: refuse stale or unblocked intent, else record, then act.
  const acted: string[][] = [];
  const checkRetry = vi.fn<PlanDispatcher["checkRetry"]>((_s, itemId, seen) => {
    const item = plan.find((candidate) => candidate.id === itemId);
    if (seen.generation !== undefined && seen.generation !== "gen-1") return "stale";
    if (seen.runId !== undefined && seen.runId !== (item?.runId ?? null)) return "stale";
    const itemIds = retryPlanItemUpdates(plan, itemId).map((update) => update.id);
    return itemIds.length ? itemIds : "notBlocked";
  });
  const retry = vi.fn<PlanDispatcher["retry"]>(async (s, itemId, seen, record) => {
    const itemIds = checkRetry(s, itemId, seen);
    if (typeof itemIds === "string") return itemIds;
    if (!record(itemIds)) return "unrecorded";
    acted.push(itemIds);
    return "retried";
  });
  const ctx = {
    fastify,
    sessions: {
      mutationClaims: new SessionMutationClaims(),
      get: (id: string) => (id === "s1" ? { meta: { id: "s1", cwd: "/tmp" }, plan } : undefined),
    },
    index: { list: () => [], find: () => undefined },
    projects: { find: () => undefined },
    settings: { get: () => ({}) },
    bridgeTokens: new Map(),
    askUser: { cancelSession: vi.fn() },
    broadcast: vi.fn(),
    dropDiffCache: vi.fn(),
    planDispatcher: { retry, checkRetry, evaluateAll: vi.fn() },
    events,
  } as unknown as ServerContext;
  registerSessionRoutes(ctx);
  const post = (itemId: string, session = "s1", query = "", seen: object = {}) =>
    fastify.inject({
      method: "POST",
      url: `/sessions/${session}/plan/items/${itemId}/retry${query}`,
      payload: seen,
    });
  return { post, retry, acted };
}

const plan: SessionPlanItem[] = [
  { id: "a", title: "A", status: "blocked", assignee: "coder", runId: "run-1" },
  { id: "b", title: "B", status: "blocked", assignee: "coder", dependsOn: ["a"] },
  { id: "c", title: "C", status: "done", assignee: "coder", runId: "run-0" },
];

describe("A10 plan item retry route", () => {
  it("logs the person's retry once the dispatcher accepts it, as the cause", async () => {
    const events = createEventProducers(disabledEventLog());
    const recorded = vi.spyOn(events, "planItemRetried").mockReturnValue("retry-event");
    const { post, acted } = routes(plan, events);
    const response = await post("a", "s1", "", { generation: "gen-1", runId: "run-1" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ itemIds: ["a", "b"] });
    // Anonymous on a loopback server; the member on the shared one.
    const anonymous = { type: "user" };
    expect(recorded).toHaveBeenCalledWith("s1", { itemId: "a", itemIds: ["a", "b"] }, anonymous);
    expect(acted).toEqual([["a", "b"]]);
  });

  it("a dry run only answers whether the retry would run (asked before any restore)", async () => {
    const events = createEventProducers(disabledEventLog());
    const recorded = vi.spyOn(events, "planItemRetried");
    const { post, retry } = routes(plan, events);
    expect((await post("a", "s1", "?dryRun=1")).json()).toEqual({ itemIds: ["a", "b"] });
    expect((await post("c", "s1", "?dryRun=1")).statusCode).toBe(409);
    expect(retry).not.toHaveBeenCalled();
    expect(recorded).not.toHaveBeenCalled();
  });

  it("refuses stale intent: another member replaced the plan or re-ran the item meanwhile", async () => {
    const events = createEventProducers(disabledEventLog());
    const recorded = vi.spyOn(events, "planItemRetried");
    const { post, acted } = routes(plan, events);
    for (const seen of [{ generation: "gen-0" }, { runId: "run-old" }, { generation: null }]) {
      const dry = await post("a", "s1", "?dryRun=1", seen);
      expect(dry.json()).toMatchObject({ code: "plan_retry_stale" });
      const real = await post("a", "s1", "", seen);
      expect(real.statusCode).toBe(409);
      expect(real.json()).toMatchObject({ code: "plan_retry_stale" });
    }
    // A run-less item is named with runId null.
    expect((await post("b", "s1", "?dryRun=1", { runId: null })).json()).toEqual({
      itemIds: ["b"],
    });
    expect(recorded).not.toHaveBeenCalled();
    expect(acted).toEqual([]);
  });

  it("refuses an item that is not blocked, an unknown session and an unlogged retry", async () => {
    const events = createEventProducers(disabledEventLog());
    const recorded = vi.spyOn(events, "planItemRetried");
    const { post, acted } = routes(plan, events);
    expect((await post("c")).json()).toMatchObject({ code: "plan_item_not_blocked" });
    // Nothing is logged for a refused retry.
    expect(recorded).not.toHaveBeenCalled();
    expect((await post("a", "nope")).statusCode).toBe(404);
    // The disabled log refuses the append: without the intent on record nothing moves.
    const unlogged = await post("a");
    expect(unlogged.statusCode).toBe(409);
    expect(unlogged.json()).toMatchObject({ code: "plan_retry_not_recorded" });
    expect(acted).toEqual([]);
  });
});
