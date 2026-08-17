import { EventEmitter } from "node:events";
import type { createServer, Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpLoopbackServer } from "../src/mcpLoopback.ts";

/**
 * The one-shot loopback redirect catcher (native MCPLoopbackServer). Hermetic:
 * a real 127.0.0.1 server is started and a real fetch stands in for the browser
 * redirect — no OAuth provider needed.
 */

let server: McpLoopbackServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("McpLoopbackServer", () => {
  it("captures the redirect's code + state and answers with a close-me page", async () => {
    server = new McpLoopbackServer("http://127.0.0.1:38976/callback");
    const port = await server.start();
    expect(server.redirectUrl).toBe(`http://127.0.0.1:${port}/callback`);
    server.setExpectedState("the-state");

    const waiting = server.waitForCallback(5000);
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=the-code&state=the-state`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Authorization received");
    expect(html).not.toContain("Signed in");

    expect(await waiting).toEqual({ code: "the-code", state: "the-state", error: undefined });
  });

  it("buffers a callback that arrives BEFORE waitForCallback is called", async () => {
    server = new McpLoopbackServer("http://127.0.0.1:38976/callback");
    const port = await server.start();
    server.setExpectedState("s");
    await fetch(`http://127.0.0.1:${port}/callback?code=early&state=s`);
    // Wait is called only now — the earlier result is still delivered.
    expect(await server.waitForCallback(5000)).toEqual({
      code: "early",
      state: "s",
      error: undefined,
    });
  });

  it("delivers an OAuth error param", async () => {
    server = new McpLoopbackServer("http://127.0.0.1:38976/callback");
    const port = await server.start();
    server.setExpectedState("s");
    const waiting = server.waitForCallback(5000);
    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied&state=s`);
    const result = await waiting;
    expect(result.error).toBe("access_denied");
    expect(result.code).toBeUndefined();
  });

  it("is one-shot: a second redirect is answered but does not overwrite the first", async () => {
    server = new McpLoopbackServer("http://127.0.0.1:38976/callback");
    const port = await server.start();
    server.setExpectedState("s1");
    const waiting = server.waitForCallback(5000);
    await fetch(`http://127.0.0.1:${port}/callback?code=first&state=s1`);
    expect(await waiting).toMatchObject({ code: "first" });

    // A stray second redirect with foreign state is rejected and cannot buffer
    // a result that a later wait could pick up.
    const res = await fetch(`http://127.0.0.1:${port}/callback?code=second&state=s2`);
    expect(res.status).toBe(400);
    expect(await server.waitForCallback(150)).toEqual({
      error: "timed out waiting for the authorization redirect",
    });
  });

  it("rejects wrong paths and methods without consuming the callback", async () => {
    server = new McpLoopbackServer("http://127.0.0.1:38976/callback");
    const port = await server.start();
    server.setExpectedState("s");
    const waiting = server.waitForCallback(5000);
    expect((await fetch(`http://127.0.0.1:${port}/wrong?code=secret`)).status).toBe(404);
    expect(
      (await fetch(`http://127.0.0.1:${port}/callback?code=secret`, { method: "POST" })).status,
    ).toBe(405);
    expect((await fetch(`http://127.0.0.1:${port}/callback?code=foreign&state=other`)).status).toBe(
      400,
    );
    await fetch(`http://127.0.0.1:${port}/callback?code=right&state=s`);
    expect(await waiting).toMatchObject({ code: "right", state: "s" });
  });

  it("close cancels a pending listen before start can publish the server", async () => {
    let onListening!: () => void;
    const fake = new EventEmitter() as EventEmitter & {
      listen: ReturnType<typeof vi.fn>;
      close: ReturnType<typeof vi.fn>;
      address: ReturnType<typeof vi.fn>;
    };
    fake.listen = vi.fn((_port: number, _host: string, callback: () => void) => {
      onListening = callback;
      return fake;
    });
    fake.close = vi.fn((callback?: () => void) => {
      callback?.();
      return fake;
    });
    fake.address = vi.fn(() => ({ address: "127.0.0.1", family: "IPv4", port: 38976 }));
    const factory = vi.fn(() => fake as unknown as Server);
    server = new McpLoopbackServer(
      "http://127.0.0.1:38976/callback",
      factory as unknown as typeof createServer,
    );

    const starting = server.start();
    const cancelled = expect(starting).rejects.toThrow("authorization cancelled");
    await server.close();
    await cancelled;
    onListening();

    expect(fake.close).toHaveBeenCalledTimes(1);
    expect(() => server!.redirectUrl).toThrow("not running");
  });

  it("close settles a pending wait and releases the port", async () => {
    server = new McpLoopbackServer("http://127.0.0.1:38976/callback");
    const port = await server.start();
    const waiting = server.waitForCallback(5000);
    await server.close();
    expect(await waiting).toEqual({ error: "authorization cancelled" });
    server = undefined;
    await expect(fetch(`http://127.0.0.1:${port}/callback?code=late`)).rejects.toThrow();
  });

  it("ignores stray requests with no code/error (404, no resolve)", async () => {
    server = new McpLoopbackServer("http://127.0.0.1:38976/callback");
    const port = await server.start();
    const res = await fetch(`http://127.0.0.1:${port}/favicon.ico`);
    expect(res.status).toBe(404);
    // The wait still times out rather than resolving on the stray request.
    expect(await server.waitForCallback(150)).toEqual({
      error: "timed out waiting for the authorization redirect",
    });
  });
});
