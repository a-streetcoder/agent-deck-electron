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
  const nativeMcpRefusal = vi.fn((_sessionId: string, call: { serverId: string }) =>
    call.serverId === "docs"
      ? undefined
      : `MCP server "${call.serverId}" is no longer assigned to this session.`,
  );
  const dispatch = vi.fn();
  const handles = registerBridgeRoutes({
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
  const authorize = async (sessionId: string, server: string, generation?: string) => {
    const reply = await handles.handleBridgeCall(
      sessionId,
      {
        tool: "__mcp_authorize__",
        toolCallId: "call-1",
        params: { serverId: server, server, toolName: `mcp__${server}__search` },
      },
      new AbortController().signal,
      generation,
    );
    return { statusCode: reply.status, json: () => reply.body };
  };
  return { authorize, nativeMcpRefusal, dispatch };
}

describe("__mcp_authorize__ bridge callback", () => {
  it("refuses a session without a bridge before asking the policy", async () => {
    const h = harness();
    expect((await h.authorize("ended-child", "docs")).statusCode).toBe(403);
    expect(h.nativeMcpRefusal).not.toHaveBeenCalled();
  });

  it("refuses a call from a process of an earlier launch (a stale generation)", async () => {
    const h = harness();
    expect((await h.authorize("child", "docs", "token-c")).statusCode).toBe(200);
    const stale = await h.authorize("child", "docs", "token-from-the-last-launch");
    expect(stale.statusCode).toBe(403);
    expect(JSON.stringify(stale.json())).toContain("earlier launch");
    expect(h.nativeMcpRefusal).toHaveBeenCalledTimes(1);
  });

  it("rejects a child whose bridge has no native MCP", async () => {
    const h = harness();
    expect((await h.authorize("plain-child", "docs")).statusCode).toBe(403);
  });

  it("answers a child from the live policy and never dispatches as a tool", async () => {
    const h = harness();
    expect((await h.authorize("child", "docs")).json()).toEqual({ allow: true });
    expect((await h.authorize("child", "gamma")).json()).toEqual({
      allow: false,
      reason: 'MCP server "gamma" is no longer assigned to this session.',
    });
    expect(h.nativeMcpRefusal).toHaveBeenLastCalledWith("child", {
      serverId: "gamma",
      server: "gamma",
      toolName: "mcp__gamma__search",
    });
    expect(h.dispatch).not.toHaveBeenCalled();
  });
});
