import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

/** The only bearer token an `oauth` mock server accepts. */
export const MOCK_OAUTH_TOKEN = "mock-mcp-access-token";

export interface MockHttpMcpServer {
  /** The Streamable HTTP endpoint to configure as an http MCP server. */
  url: string;
  close(): Promise<void>;
}

/**
 * A tiny Streamable HTTP MCP server for tests: one `echo` tool, served over a
 * loopback Node http server in stateless JSON-response mode (no session ids —
 * one shared transport handles every request). Lets a test exercise the full
 * http MCP path (connect → listTools → forward) the way the stdio fixture does
 * for stdio. Start it, point AGENT_DECK_MCP_SERVERS at `{ id, url }`, close after.
 */
export async function startMockHttpMcpServer(
  options: {
    /** Put /mcp behind a fake OAuth authorization server on the same origin
     * (protected-resource and server metadata, dynamic registration, PKCE code
     * flow whose /authorize redirects straight back with a code). Only the
     * token it issues is accepted. */
    oauth?: boolean;
  } = {},
): Promise<MockHttpMcpServer> {
  const mcp = new McpServer({ name: "mock-mcp-http", version: "0.0.1" });
  mcp.tool("echo", "Echo a message back", { message: z.string() }, ({ message }) => ({
    content: [{ type: "text", text: `mcp http echo: ${message}` }],
  }));
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  await mcp.connect(transport);

  let origin = "";
  const json = (res: ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const oauthRoute = (req: IncomingMessage, res: ServerResponse): boolean => {
    const url = new URL(req.url ?? "/", origin);
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource/mcp":
        json(res, 200, { resource: `${origin}/mcp`, authorization_servers: [origin] });
        return true;
      case "/.well-known/oauth-authorization-server":
        json(res, 200, {
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          registration_endpoint: `${origin}/register`,
          response_types_supported: ["code"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
        });
        return true;
      case "/register": {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          const metadata = JSON.parse(body) as { redirect_uris?: string[] };
          json(res, 201, {
            client_id: "mock-client",
            redirect_uris: metadata.redirect_uris,
            token_endpoint_auth_method: "none",
          });
        });
        return true;
      }
      case "/authorize": {
        const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
        redirect.searchParams.set("code", "mock-code");
        redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
        res.writeHead(302, { location: redirect.href });
        res.end();
        return true;
      }
      case "/token":
        req.resume();
        req.on("end", () =>
          json(res, 200, {
            access_token: MOCK_OAUTH_TOKEN,
            token_type: "Bearer",
            expires_in: 3600,
          }),
        );
        return true;
    }
    return false;
  };

  const http: Server = createServer((req, res) => {
    if (options.oauth && oauthRoute(req, res)) return;
    if (
      options.oauth &&
      (req.url ?? "").startsWith("/mcp") &&
      req.headers.authorization !== `Bearer ${MOCK_OAUTH_TOKEN}`
    ) {
      res.writeHead(401, {
        "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      });
      res.end();
      return;
    }
    // Only serve the advertised endpoint — so a client posting to the wrong path
    // fails loudly instead of the test silently passing on a routing regression.
    if ((req.url ?? "").split("?")[0] !== "/mcp") {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      void transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  origin = `http://127.0.0.1:${port}`;

  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        void transport.close();
        http.close(() => resolve());
      }),
  };
}
