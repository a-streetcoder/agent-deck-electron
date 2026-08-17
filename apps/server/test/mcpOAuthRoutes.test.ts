import { MemoryMcpOAuthStore } from "@agent-deck/mcp";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { McpOAuthCoordinator, type McpAuthFn } from "../src/mcpOAuth.ts";
import { registerMcpRoutes } from "../src/routes/mcp.ts";

const authFn: McpAuthFn = async (provider, { authorizationCode }) => {
  if (authorizationCode) {
    provider.saveTokens({ access_token: "route-token", token_type: "Bearer" });
    return "AUTHORIZED";
  }
  provider.saveCodeVerifier("route-verifier");
  const state = provider.state();
  const url = new URL("https://auth.example/authorize");
  url.searchParams.set("state", state);
  url.searchParams.set("redirect_uri", String(provider.redirectUrl));
  await provider.redirectToAuthorization(url);
  return "REDIRECT";
};

describe("MCP OAuth routes", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("automatically refreshes and broadcasts only the exact project/server target", async () => {
    const fastify = Fastify({ logger: false });
    const oauth = new McpOAuthCoordinator({
      store: new MemoryMcpOAuthStore(),
      redirectUrl: "http://127.0.0.1:38978/fallback",
      automaticLoopback: true,
      authFn,
    });
    cleanups.push(async () => {
      await oauth.close();
      await fastify.close();
    });
    const refreshes: Array<[string, string]> = [];
    const broadcasts: string[] = [];
    const projects = Object.assign([{ id: "project-a", assignedMcpServers: ["srv"] }], {
      list: () => [{ id: "project-a", assignedMcpServers: ["srv"] }],
    });
    const mcp = {
      httpUrlFor: (id: string, scope: string) =>
        id === "srv" && scope === "project-a" ? "https://mcp.example/sse" : undefined,
      refresh: async (id: string, scope: string) => {
        refreshes.push([id, scope]);
        return { id, connected: true, toolNames: [] };
      },
      status: () => [{ id: "srv", connected: true, toolNames: [] }],
    };
    registerMcpRoutes({
      fastify,
      mcp,
      mcpOAuth: oauth,
      projects,
      oauthKey: (scope: string, id: string) => `${scope}::${id}`,
      effectiveMcpConfigs: () => ({
        valid: true,
        configs: [{ id: "srv", url: "https://mcp.example/sse" }],
      }),
      projectHasEffectiveMcpGrant: (projectId: string, id: string) =>
        projectId === "project-a" && id === "srv",
      broadcast: (message: { type: string }) => broadcasts.push(message.type),
    } as unknown as ServerContext);

    const response = await fastify.inject({
      method: "POST",
      url: "/mcp/srv/login?projectId=project-a",
    });
    expect(response.statusCode).toBe(200);
    const auth = response.json<{ auth: { authUrl: string } }>().auth;
    const authUrl = new URL(auth.authUrl);
    const redirect = authUrl.searchParams.get("redirect_uri")!;
    await fetch(`${redirect}?code=route-code&state=${authUrl.searchParams.get("state")}`);

    await expect.poll(() => refreshes).toEqual([["srv", "project-a"]]);
    expect(broadcasts).toEqual(["resources_changed"]);
  });
});
