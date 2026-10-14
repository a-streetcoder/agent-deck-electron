import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { registerBridgeRoutes } from "../src/routes/bridge.ts";

const fastifies: ReturnType<typeof Fastify>[] = [];
afterEach(async () => {
  await Promise.all(fastifies.splice(0).map((fastify) => fastify.close()));
});

function harness() {
  const fastify = Fastify();
  fastifies.push(fastify);
  // A child granted `docs` only; the live policy is stubbed per server.
  const nativeMcpRefusal = vi.fn((_sessionId: string, server: string) =>
    server === "docs" ? undefined : `MCP server "${server}" is no longer assigned to this session.`,
  );
  const dispatch = vi.fn();
  registerBridgeRoutes({
    fastify,
    sessions: { get: () => undefined },
    bridge: { dispatch },
    bridgeTokens: new Map([
      ["child", "token-c"],
      ["plain-child", "token-p"],
    ]),
    childAllowedTools: new Map([
      ["child", new Set(["contact_supervisor", "__mcp_authorize__"])],
      ["plain-child", new Set(["contact_supervisor"])],
    ]),
    askUser: {},
    supervisor: {},
    childSupervisors: new Map(),
    pendingSupervisor: new Map(),
    memoryEnabled: false,
    agentMemoryEnabled: () => false,
    memoryBaseDir: "",
    nativeMcpRefusal,
  } as unknown as ServerContext);
  const authorize = (sessionId: string, token: string, server: string) =>
    fastify.inject({
      method: "POST",
      url: "/bridge",
      payload: {
        sessionId,
        token,
        tool: "__mcp_authorize__",
        toolCallId: "call-1",
        params: { toolName: `mcp__${server}__search`, server, tool: "search", input: {} },
      },
    });
  return { authorize, nativeMcpRefusal, dispatch };
}

describe("__mcp_authorize__ bridge callback", () => {
  it("rejects a bad token before asking the policy", async () => {
    const h = harness();
    expect((await h.authorize("child", "wrong", "docs")).statusCode).toBe(403);
    expect(h.nativeMcpRefusal).not.toHaveBeenCalled();
  });

  it("rejects a child whose bridge has no native MCP", async () => {
    const h = harness();
    expect((await h.authorize("plain-child", "token-p", "docs")).statusCode).toBe(403);
  });

  it("answers a child from the live policy and never dispatches as a tool", async () => {
    const h = harness();
    expect((await h.authorize("child", "token-c", "docs")).json()).toEqual({ allow: true });
    expect((await h.authorize("child", "token-c", "gamma")).json()).toEqual({
      allow: false,
      reason: 'MCP server "gamma" is no longer assigned to this session.',
    });
    expect(h.nativeMcpRefusal).toHaveBeenLastCalledWith("child", "gamma", "search");
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
