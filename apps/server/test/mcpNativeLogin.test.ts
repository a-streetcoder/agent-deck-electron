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

  function harness(options: { native?: boolean; shared?: boolean } = {}) {
    const fastify = Fastify({ logger: false });
    apps.push(fastify);
    if (options.shared)
      fastify.addHook("onRequest", async (request) => {
        setRequestUser(request.raw, { id: "user-a", email: "a@example.test" });
      });
    const prompts: Array<[string, string]> = [];
    const session = (id: string, owner: string) => ({
      meta: { id, projectId: "p1", createdBy: { id: owner } },
      prompt: async (text: string) => {
        prompts.push([id, text]);
      },
    });
    const live = new Map([
      ["s-a", session("s-a", "user-a")],
      ["s-b", session("s-b", "user-b")],
    ]);
    registerMcpRoutes({
      fastify,
      sharedServer: options.shared === true,
      nativeMcp: () => options.native !== false,
      sessions: { get: (id: string) => live.get(id) },
      // The id map gives `my.docs` the Pi name `my_docs`.
      nativeMcpNameFor: (_meta: unknown, id: string) => (id === "my.docs" ? "my_docs" : undefined),
    } as unknown as ServerContext);
    const post = (serverId: string, sessionId: string) =>
      fastify.inject({
        method: "POST",
        url: `/mcp/${encodeURIComponent(serverId)}/native-login`,
        payload: { sessionId },
      });
    return { post, prompts };
  }

  it("sends /mcp login with the session's Pi name for the server", async () => {
    const { post, prompts } = harness();
    const response = await post("my.docs", "s-a");
    expect(response.statusCode).toBe(202);
    expect(prompts).toEqual([["s-a", "/mcp login my_docs"]]);
  });

  it("refuses a server the session does not have, an unknown session and the flag-off path", async () => {
    const h = harness();
    expect((await h.post("other", "s-a")).statusCode).toBe(404);
    expect((await h.post("my.docs", "missing")).statusCode).toBe(404);
    const off = harness({ native: false });
    expect((await off.post("my.docs", "s-a")).statusCode).toBe(409);
    expect([...h.prompts, ...off.prompts]).toEqual([]);
  });

  it("on a shared server, refuses another user's session (its Pi stores tokens in the owner's dir)", async () => {
    const { post, prompts } = harness({ shared: true });
    expect((await post("my.docs", "s-b")).statusCode).toBe(403);
    expect((await post("my.docs", "s-a")).statusCode).toBe(202);
    expect(prompts).toEqual([["s-a", "/mcp login my_docs"]]);
  });
});
