import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { registerBridgeRoutes } from "../src/routes/bridge.ts";
import { SupervisorLog } from "../src/supervisor.ts";

function harness(requestId = "request-1", parentSessionId = "parent-a") {
  const fastify = Fastify();
  const supervisor = new SupervisorLog();
  supervisor.record({
    id: requestId,
    parentSessionId,
    cellId: "child-card",
    method: "need_decision",
    message: "Choose a format",
  });
  const answerSupervisorQuestion = vi.fn();
  const pendingSupervisor = new Map<
    string,
    {
      parentSessionId: string;
      childSessionId: string;
      settle: (result: { content: string; isError?: boolean }) => void;
    }
  >();
  const childResults: Array<{ content: string; isError?: boolean }> = [];
  pendingSupervisor.set(requestId, {
    parentSessionId,
    childSessionId: "child-a",
    settle: (result) => {
      pendingSupervisor.delete(requestId);
      childResults.push(result);
    },
  });
  const handles = registerBridgeRoutes({
    fastify,
    sessions: {
      get: (sessionId: string) =>
        sessionId === parentSessionId ? { answerSupervisorQuestion } : undefined,
    },
    bridge: { dispatch: vi.fn() },
    bridgeTokens: new Map(),
    askUser: {},
    supervisor,
    childSupervisors: new Map(),
    pendingSupervisor,
    memoryEnabled: false,
    memoryBaseDir: "",
    recallMemories: vi.fn(),
  } as unknown as ServerContext);
  return {
    fastify,
    supervisor,
    pendingSupervisor,
    childResults,
    answerSupervisorQuestion,
    handles,
  };
}

describe("supervisor answer coordinator handle", () => {
  it("owner-scopes lookup and leaves a foreign parent's request untouched", async () => {
    const h = harness();
    expect(h.handles.answerSupervisor("request-1", "no access", "parent-b")).toBe(false);
    expect(h.pendingSupervisor.has("request-1")).toBe(true);
    expect(h.supervisor.list("parent-a")[0]?.status).toBe("pending");
    expect(h.answerSupervisorQuestion).not.toHaveBeenCalled();
    expect(h.childResults).toEqual([]);
    await h.fastify.close();
  });

  it("settles the child, card, and log once, then rejects the stale race loser", async () => {
    const h = harness();
    const results = [
      h.handles.answerSupervisor("request-1", "use JSON", "parent-a"),
      h.handles.answerSupervisor("request-1", "use YAML", "parent-a"),
    ];

    expect(results).toEqual([true, false]);
    expect(h.pendingSupervisor.has("request-1")).toBe(false);
    expect(h.childResults).toEqual([{ content: "use JSON" }]);
    expect(h.answerSupervisorQuestion).toHaveBeenCalledOnce();
    expect(h.answerSupervisorQuestion).toHaveBeenCalledWith("request-1", "use JSON");
    expect(h.supervisor.list("parent-a")[0]).toMatchObject({
      status: "answered",
      response: "use JSON",
    });
    await h.fastify.close();
  });

  it("returns false for cancelled and otherwise stale request ids", async () => {
    const h = harness("cancelled");
    h.pendingSupervisor.delete("cancelled");
    h.supervisor.markCancelled("cancelled", "child ended");

    expect(h.handles.answerSupervisor("cancelled", "late", "parent-a")).toBe(false);
    expect(h.handles.answerSupervisor("unknown", "late", "parent-a")).toBe(false);
    expect(h.supervisor.list("parent-a")[0]).toMatchObject({ status: "cancelled" });
    await h.fastify.close();
  });
});
