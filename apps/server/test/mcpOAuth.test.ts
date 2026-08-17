import { createServer } from "node:http";
import { MemoryMcpOAuthStore } from "@agent-deck/mcp";
import { describe, expect, it } from "vitest";
import {
  McpOAuthCoordinator,
  resolveMcpOAuthRedirectMode,
  type McpAuthFn,
} from "../src/mcpOAuth.ts";

/**
 * The MCP OAuth coordinator, driven by a STUBBED `auth()` so the interactive
 * relay (begin → URL issued → submit code → authorized) is exercised without a
 * real provider. The real SDK `auth()` + the browser round-trip are validated
 * locally; the store/provider contract they depend on is unit-tested in
 * packages/mcp.
 */

const SERVER_URL = "https://mcp.example.test/sse";

/** A fake `auth()`: no code → REDIRECT (issues a URL + saves a verifier); with a
 *  code → AUTHORIZED (saves tokens), exactly like the SDK's contract. */
const stubAuth: McpAuthFn = async (provider, { authorizationCode }) => {
  if (!authorizationCode) {
    provider.saveCodeVerifier("verifier-abc");
    const state = provider.state(); // mint + persist the CSRF state, as the SDK does
    await provider.redirectToAuthorization(
      new URL(`https://auth.example.test/authorize?client_id=x&state=${state}`),
    );
    return "REDIRECT";
  }
  provider.saveTokens({ access_token: `token-for-${authorizationCode}`, token_type: "Bearer" });
  return "AUTHORIZED";
};

function makeCoordinator(authFn: McpAuthFn = stubAuth) {
  return new McpOAuthCoordinator({
    store: new MemoryMcpOAuthStore(),
    redirectUrl: "http://127.0.0.1:8976/mcp/callback",
    authFn,
  });
}

describe("MCP OAuth redirect mode", () => {
  it("keeps external redirects manual and uses a configured stable loopback redirect", () => {
    expect(resolveMcpOAuthRedirectMode("https://app.example/callback")).toEqual({
      redirectUrl: "https://app.example/callback",
      automaticLoopback: false,
    });
    expect(resolveMcpOAuthRedirectMode("http://127.0.0.1:4444/configured")).toEqual({
      redirectUrl: "http://127.0.0.1:4444/configured",
      automaticLoopback: true,
    });
    expect(resolveMcpOAuthRedirectMode().automaticLoopback).toBe(true);
  });
});

describe("McpOAuthCoordinator", () => {
  it("uses an external configured redirect exactly and remains manual", async () => {
    const mode = resolveMcpOAuthRedirectMode("https://app.example/oauth/callback");
    const auth: McpAuthFn = async (provider) => {
      provider.saveCodeVerifier("verifier");
      const state = provider.state();
      const url = new URL("https://auth.example/authorize");
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", String(provider.redirectUrl));
      await provider.redirectToAuthorization(url);
      return "REDIRECT";
    };
    const coord = new McpOAuthCoordinator({
      store: new MemoryMcpOAuthStore(),
      ...mode,
      authFn: auth,
    });
    const begun = await coord.beginAuth("srv", SERVER_URL);
    expect(begun.automatic).toBe(false);
    expect(new URL(begun.authUrl!).searchParams.get("redirect_uri")).toBe(
      "https://app.example/oauth/callback",
    );
    await coord.close();
  });

  it("clears ambiguous unbound V1 owner credentials on first V2 bind", async () => {
    const store = new MemoryMcpOAuthStore();
    store.save("project::server", {
      tokens: { access_token: "legacy-secret", token_type: "Bearer" },
    });
    const coord = new McpOAuthCoordinator({
      store,
      redirectUrl: "https://app.example/callback",
    });
    const provider = coord.providerFor('v2:["project","server"]', SERVER_URL, {
      projectId: "project",
      serverId: "server",
    });
    expect(store.load("project::server")).toBeUndefined();
    expect(provider.tokens()).toBeUndefined();
    await coord.close();
  });

  it("fails closed before connection when a scoped server URL changes or an id is recreated", async () => {
    const store = new MemoryMcpOAuthStore();
    const coord = new McpOAuthCoordinator({
      store,
      redirectUrl: "https://app.example/callback",
    });
    const owner = { projectId: "project", serverId: "same-id" };
    const original = coord.providerFor("opaque", "https://mcp.example/one", owner);
    original.saveTokens({ access_token: "secret-one", token_type: "Bearer" });
    expect(original.isAuthorized()).toBe(true);
    const changed = coord.providerFor("opaque", "https://mcp.example/two", owner);
    expect(changed.tokens()).toBeUndefined();
    await coord.clear("opaque");
    const recreated = coord.providerFor("opaque", "https://mcp.example/two", owner);
    expect(recreated.tokens()).toBeUndefined();
    await coord.close();
  });

  it("starts unauthenticated for an unknown server", () => {
    const coord = makeCoordinator();
    expect(coord.state("srv").status).toBe("unauthenticated");
    expect(coord.isAuthorized("srv")).toBe(false);
  });

  it("issues an authorization URL on begin, then authorizes on the callback code", async () => {
    const coord = makeCoordinator();

    const begun = await coord.beginAuth("srv", SERVER_URL);
    expect(begun.status).toBe("authorizing");
    expect(begun.authUrl).toContain("https://auth.example.test/authorize");
    expect(coord.isAuthorized("srv")).toBe(false);

    const state = new URL(begun.authUrl!).searchParams.get("state")!;
    const done = await coord.submitCode("srv", SERVER_URL, "browser-code", state);
    expect(done.status).toBe("authorized");
    expect(coord.isAuthorized("srv")).toBe(true);
    expect(coord.state("srv").status).toBe("authorized");
  });

  it("short-circuits to authorized when begin finds existing valid tokens", async () => {
    // An auth() that returns AUTHORIZED immediately (tokens already valid).
    const preAuthed: McpAuthFn = async (provider, { authorizationCode }) => {
      if (!authorizationCode) {
        provider.saveTokens({ access_token: "cached", token_type: "Bearer" });
        return "AUTHORIZED";
      }
      return "AUTHORIZED";
    };
    const coord = makeCoordinator(preAuthed);
    const begun = await coord.beginAuth("srv", SERVER_URL);
    expect(begun.status).toBe("authorized");
    expect(begun.authUrl).toBeUndefined();
    expect(coord.isAuthorized("srv")).toBe(true);
  });

  it("records an error when auth() throws", async () => {
    const boom: McpAuthFn = async () => {
      throw new Error("discovery failed: 404");
    };
    const coord = makeCoordinator(boom);
    const state = await coord.beginAuth("srv", SERVER_URL);
    expect(state.status).toBe("error");
    expect(state.error).toContain("discovery failed");
  });

  it("falls back to a truthful manual flow when the stable loopback port cannot bind", async () => {
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen(38977, "127.0.0.1", resolve));
    const coord = new McpOAuthCoordinator({
      store: new MemoryMcpOAuthStore(),
      redirectUrl: "http://127.0.0.1:38977/manual",
      automaticLoopback: true,
      authFn: stubAuth,
    });
    try {
      const state = await coord.beginAuth("srv", SERVER_URL);
      expect(state.status).toBe("authorizing");
      expect(state.automatic).toBe(false);
      expect(state.notice).toContain("Enter the authorization code manually");
    } finally {
      await coord.close();
      await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it("captures a loopback callback automatically with the attempt's exact redirect URI", async () => {
    let exchanged = 0;
    const auth: McpAuthFn = async (provider, { authorizationCode }) => {
      if (authorizationCode) {
        exchanged += 1;
        provider.saveTokens({ access_token: "automatic-token", token_type: "Bearer" });
        return "AUTHORIZED";
      }
      expect(provider.clientMetadata.redirect_uris).toEqual([String(provider.redirectUrl)]);
      provider.saveCodeVerifier("verifier");
      const state = provider.state();
      const url = new URL("https://auth.example.test/authorize");
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", String(provider.redirectUrl));
      await provider.redirectToAuthorization(url);
      return "REDIRECT";
    };
    let completed!: (value: void) => void;
    const completion = new Promise<void>((resolve) => (completed = resolve));
    const coord = new McpOAuthCoordinator({
      store: new MemoryMcpOAuthStore(),
      redirectUrl: "http://127.0.0.1:38977/manual",
      automaticLoopback: true,
      authFn: auth,
    });
    const begun = await coord.beginAuth("project::srv", SERVER_URL, (state) => {
      if (state.status === "authorized") completed();
    });
    const authUrl = new URL(begun.authUrl!);
    const redirect = authUrl.searchParams.get("redirect_uri")!;
    expect(redirect).toBe("http://127.0.0.1:38977/manual");
    await fetch(`${redirect}?code=browser-code&state=${authUrl.searchParams.get("state")}`);
    await completion;
    expect(exchanged).toBe(1);
    expect(coord.state("project::srv").status).toBe("authorized");
    await expect(fetch(`${redirect}?code=late`)).rejects.toThrow();
    await coord.close();
  });

  it("publishes the login provider synchronously so reconciliation cannot replace it", async () => {
    let authProvider: Parameters<McpAuthFn>[0] | undefined;
    const auth: McpAuthFn = async (provider) => {
      authProvider = provider;
      provider.saveCodeVerifier("verifier");
      const state = provider.state();
      await provider.redirectToAuthorization(
        new URL(`https://auth.example/authorize?state=${state}`),
      );
      return "REDIRECT";
    };
    const coord = makeCoordinator(auth);
    const beginning = coord.beginAuth("same", SERVER_URL);
    const connectionProvider = coord.providerFor("same", SERVER_URL);
    expect(coord.state("same").status).toBe("authorizing");
    await beginning;
    expect(connectionProvider).toBe(authProvider);
    expect(coord.state("same").status).toBe("authorizing");
    await coord.close();
  });

  it("reserves the newer generation before asynchronous startup can let an older begin overwrite it", async () => {
    let starts = 0;
    const auth: McpAuthFn = async (provider) => {
      starts += 1;
      provider.saveCodeVerifier(`verifier-${starts}`);
      const state = provider.state();
      await provider.redirectToAuthorization(
        new URL(`https://auth.example/authorize?state=${state}&start=${starts}`),
      );
      return "REDIRECT";
    };
    const coord = makeCoordinator(auth);
    const older = coord.beginAuth("same", SERVER_URL);
    const newer = coord.beginAuth("same", SERVER_URL);
    await older;
    const current = await newer;
    expect(starts).toBe(1);
    expect(current.authUrl).toContain("start=1");
    expect(coord.state("same").authUrl).toBe(current.authUrl);
    await coord.close();
  });

  it("supersedes same-target attempts and isolates projects", async () => {
    const coord = makeCoordinator();
    const first = await coord.beginAuth("project-a::srv", SERVER_URL);
    const other = await coord.beginAuth("project-b::srv", SERVER_URL);
    const second = await coord.beginAuth("project-a::srv", SERVER_URL);
    const firstState = new URL(first.authUrl!).searchParams.get("state")!;
    const secondState = new URL(second.authUrl!).searchParams.get("state")!;
    const otherState = new URL(other.authUrl!).searchParams.get("state")!;
    expect((await coord.submitCode("project-a::srv", SERVER_URL, "stale", firstState)).status).toBe(
      "error",
    );
    const restarted = await coord.beginAuth("project-a::srv", SERVER_URL);
    const restartedState = new URL(restarted.authUrl!).searchParams.get("state")!;
    expect((await coord.submitCode("project-b::srv", SERVER_URL, "other", otherState)).status).toBe(
      "authorized",
    );
    expect(secondState).not.toBe(restartedState);
    expect(
      (await coord.submitCode("project-a::srv", SERVER_URL, "new", restartedState)).status,
    ).toBe("authorized");
  });

  it("cancels project attempts and releases their listeners without late exchange", async () => {
    let exchanges = 0;
    const auth: McpAuthFn = async (provider, { authorizationCode }) => {
      if (authorizationCode) {
        exchanges += 1;
        return "AUTHORIZED";
      }
      provider.saveCodeVerifier("verifier");
      const state = provider.state();
      const url = new URL("https://auth.example/authorize");
      url.searchParams.set("state", state);
      url.searchParams.set("redirect_uri", String(provider.redirectUrl));
      await provider.redirectToAuthorization(url);
      return "REDIRECT";
    };
    const coord = new McpOAuthCoordinator({
      store: new MemoryMcpOAuthStore(),
      redirectUrl: "http://127.0.0.1:38977/fallback",
      automaticLoopback: true,
      authFn: auth,
    });
    const begun = await coord.beginAuth("project-a::srv", SERVER_URL, undefined, {
      projectId: "project-a",
      serverId: "srv",
    });
    const redirect = new URL(begun.authUrl!).searchParams.get("redirect_uri")!;
    await coord.cancelProject("project-a");
    expect(coord.state("project-a::srv").status).toBe("unauthenticated");
    await expect(fetch(`${redirect}?code=late&state=x`)).rejects.toThrow();
    expect(exchanges).toBe(0);
    await coord.close();
  });

  it("cancels all project generations for config removal and all server generations for mutation", async () => {
    const coord = makeCoordinator();
    await coord.beginAuth("opaque-a-one", SERVER_URL, undefined, {
      projectId: "project-a::nested",
      serverId: "one::nested",
    });
    await coord.beginAuth("opaque-a-two", SERVER_URL, undefined, {
      projectId: "project-a::nested",
      serverId: "two",
    });
    await coord.beginAuth("opaque-b-one", SERVER_URL, undefined, {
      projectId: "project-b",
      serverId: "one::nested",
    });
    await coord.cancelProject("project-a::nested");
    expect(coord.state("opaque-a-one").status).toBe("unauthenticated");
    expect(coord.state("opaque-a-two").status).toBe("unauthenticated");
    expect(coord.state("opaque-b-one").status).toBe("authorizing");
    await coord.cancelServer("one::nested");
    expect(coord.state("opaque-b-one").status).toBe("unauthenticated");
    await coord.close();
  });

  it("shutdown prevents an in-flight exchange from persisting tokens", async () => {
    let release!: () => void;
    const auth: McpAuthFn = async (provider, { authorizationCode }) => {
      if (!authorizationCode) {
        provider.saveCodeVerifier("verifier");
        const state = provider.state();
        await provider.redirectToAuthorization(
          new URL(`https://auth.example/authorize?state=${state}`),
        );
        return "REDIRECT";
      }
      await new Promise<void>((resolve) => (release = resolve));
      provider.saveTokens({ access_token: "late-secret", token_type: "Bearer" });
      return "AUTHORIZED";
    };
    const coord = makeCoordinator(auth);
    const begun = await coord.beginAuth("project::srv", SERVER_URL);
    const state = new URL(begun.authUrl!).searchParams.get("state")!;
    const completing = coord.submitCode("project::srv", SERVER_URL, "code", state);
    await Promise.resolve();
    let closed = false;
    const closing = coord.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    release();
    await closing;
    expect((await completing).status).toBe("error");
    expect(coord.isAuthorized("project::srv")).toBe(false);
  });

  it("clears a server's auth on logout", async () => {
    const coord = makeCoordinator();
    const begun = await coord.beginAuth("srv", SERVER_URL);
    const state = new URL(begun.authUrl!).searchParams.get("state")!;
    await coord.submitCode("srv", SERVER_URL, "browser-code", state);
    expect(coord.isAuthorized("srv")).toBe(true);

    await coord.clear("srv");
    expect(coord.state("srv").status).toBe("unauthenticated");
    expect(coord.isAuthorized("srv")).toBe(false);
  });
});
