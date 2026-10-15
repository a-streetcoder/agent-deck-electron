import type { SessionPlanItem } from "@agent-deck/domain";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { disabledEventLog } from "../src/eventLog.ts";
import { createEventProducers } from "../src/eventProducers.ts";
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
  const retry = vi.fn(async () => true);
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
    planDispatcher: { retry, evaluateAll: vi.fn() },
    events,
  } as unknown as ServerContext;
  registerSessionRoutes(ctx);
  const post = (itemId: string, session = "s1") =>
    fastify.inject({ method: "POST", url: `/sessions/${session}/plan/items/${itemId}/retry` });
  return { post, retry };
}

const plan: SessionPlanItem[] = [
  { id: "a", title: "A", status: "blocked", assignee: "coder", runId: "run-1" },
  { id: "b", title: "B", status: "blocked", assignee: "coder", dependsOn: ["a"] },
  { id: "c", title: "C", status: "done", assignee: "coder", runId: "run-0" },
];

describe("A10 plan item retry route", () => {
  it("logs the person's retry, then hands it to the dispatcher as the cause", async () => {
    const events = createEventProducers(disabledEventLog());
    const recorded = vi.spyOn(events, "planItemRetried").mockReturnValue("retry-event");
    const { post, retry } = routes(plan, events);
    const response = await post("a");
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ itemIds: ["a", "b"] });
    // Anonymous on a loopback server; the member on the shared one.
    expect(recorded).toHaveBeenCalledWith(
      "s1",
      { itemId: "a", itemIds: ["a", "b"] },
      {
        type: "user",
      },
    );
    expect(retry).toHaveBeenCalledWith("s1", "a", "retry-event");
  });

  it("refuses an item that is not blocked, an unknown session and an unlogged retry", async () => {
    const { post, retry } = routes(plan);
    expect((await post("c")).json()).toMatchObject({ code: "plan_item_not_blocked" });
    expect((await post("a", "nope")).statusCode).toBe(404);
    // The disabled log refuses the append: without the intent on record nothing moves.
    const unlogged = await post("a");
    expect(unlogged.statusCode).toBe(409);
    expect(unlogged.json()).toMatchObject({ code: "plan_retry_not_recorded" });
    expect(retry).not.toHaveBeenCalled();
  });
});
