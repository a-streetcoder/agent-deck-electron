import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { registerMcpRoutes } from "../src/routes/mcp.ts";
import { setRequestUser } from "../src/trustedProxy.ts";

/** PI-03d: the MCP screen's Sign in sends `/mcp login <pi-name>` to a live session. */
describe("POST /mcp/:id/native-login", () => {
  const apps: Array<ReturnType<typeof Fastify>> = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function harness(options: { shared?: boolean } = {}) {
    const fastify = Fastify({ logger: false });
    apps.push(fastify);
    if (options.shared)
      fastify.addHook("onRequest", async (request) => {
        setRequestUser(request.raw, { id: "user-a", email: "a@example.test" });
      });
    const prompts: Array<[string, string]> = [];
    const session = (id: string, owner?: string, resumes = true) => {
      const self = {
        meta: {
          id,
          projectId: "p1",
          woken: false,
          ...(owner ? { createdBy: { id: owner } } : {}),
        } as Record<string, unknown>,
        // Waking a parked session publishes a new meta (its spawn's name map).
        getState: async () => {
          if (!resumes) throw new Error("pi exited during startup");
          self.meta = { ...self.meta, woken: true };
          return {};
        },
        prompt: async (text: string) => {
          prompts.push([id, text]);
        },
      };
      return self;
    };
    const live = new Map([
      ["s-a", session("s-a", "user-a")],
      ["s-b", session("s-b", "user-b")],
      ["s-legacy", session("s-legacy")],
      ["s-broken", session("s-broken", "user-a", false)],
    ]);
    registerMcpRoutes({
      fastify,
      sharedServer: options.shared === true,
      sessions: { get: (id: string) => live.get(id) },
      // The id map gives `my.docs` the Pi name `my_docs`, but only in the meta
      // the woken spawn published: the lookup must come after getState().
      nativeMcpNameFor: (meta: { woken?: boolean }, id: string) =>
        id === "my.docs" && meta.woken ? "my_docs" : undefined,
    } as unknown as ServerContext);
    const post = (serverId: string, sessionId: string) =>
      fastify.inject({
        method: "POST",
        url: `/mcp/${encodeURIComponent(serverId)}/native-login`,
        payload: { sessionId },
      });
    return { post, prompts };
  }

  it("wakes the session first, then sends /mcp login with its Pi name for the server", async () => {
    const { post, prompts } = harness();
    const response = await post("my.docs", "s-a");
    expect(response.statusCode).toBe(202);
    expect(prompts).toEqual([["s-a", "/mcp login my_docs"]]);
  });

  it("refuses a server the session does not have and an unknown session", async () => {
    const h = harness();
    expect((await h.post("other", "s-a")).statusCode).toBe(404);
    expect((await h.post("my.docs", "missing")).statusCode).toBe(404);
    expect(h.prompts).toEqual([]);
  });

  it("answers 502 when the session cannot start, without sending the command", async () => {
    const { post, prompts } = harness();
    const response = await post("my.docs", "s-broken");
    expect(response.statusCode).toBe(502);
    expect(response.json<{ error: string }>().error).toContain("pi exited during startup");
    expect(prompts).toEqual([]);
  });

  it("on a shared server, refuses another user's session (its Pi stores tokens in the owner's dir)", async () => {
    const { post, prompts } = harness({ shared: true });
    expect((await post("my.docs", "s-b")).statusCode).toBe(403);
    // A legacy session without an owner runs on the operator's shared dir.
    expect((await post("my.docs", "s-legacy")).statusCode).toBe(403);
    expect((await post("my.docs", "s-a")).statusCode).toBe(202);
    expect(prompts).toEqual([["s-a", "/mcp login my_docs"]]);
  });
});
