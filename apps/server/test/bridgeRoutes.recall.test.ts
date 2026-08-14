import Fastify from "fastify";
import type { SemanticRecallStatus } from "@agent-deck/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { registerBridgeRoutes } from "../src/routes/bridge.ts";

const fastifies: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(fastifies.splice(0).map((fastify) => fastify.close()));
});

const recallStatus: SemanticRecallStatus = {
  readiness: "not_checked",
  mode: "lexical",
  reason: null,
  message: "Semantic ranking has not been checked.",
};

function harness(memoryEnabled: boolean, cwd?: string) {
  const fastify = Fastify();
  fastifies.push(fastify);
  const recall = vi.fn();
  registerBridgeRoutes({
    fastify,
    sessions: { get: () => (cwd ? { meta: { cwd } } : undefined) },
    bridge: { dispatch: vi.fn() },
    bridgeTokens: new Map([["session-a", "token-a"]]),
    askUser: {},
    supervisor: {},
    childSupervisors: new Map(),
    pendingSupervisor: new Map(),
    memoryEnabled,
    memoryBaseDir: "/tmp/memory",
    semanticRecall: { getStatus: () => recallStatus, recall },
  } as unknown as ServerContext);
  const invoke = (params: Record<string, unknown>) =>
    fastify.inject({
      method: "POST",
      url: "/bridge",
      payload: {
        sessionId: "session-a",
        token: "token-a",
        tool: "__recall__",
        toolCallId: "recall-a",
        params,
      },
    });
  return { invoke, recall };
}

describe("__recall__ bridge metadata", () => {
  it.each([
    {
      name: "memory is disabled",
      memoryEnabled: false,
      cwd: "/project",
      params: { query: "oauth" },
    },
    {
      name: "the session has no project",
      memoryEnabled: true,
      cwd: undefined,
      params: { query: "oauth" },
    },
    { name: "the query is empty", memoryEnabled: true, cwd: "/project", params: { query: "  " } },
  ])("returns passive recall metadata when $name", async ({ memoryEnabled, cwd, params }) => {
    const { invoke, recall } = harness(memoryEnabled, cwd);
    const response = await invoke(params);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ content: "", recall: recallStatus });
    expect(recall).not.toHaveBeenCalled();
  });
});
