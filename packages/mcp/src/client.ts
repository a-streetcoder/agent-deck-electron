import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

/**
 * A thin wrapper over an MCP client connection. pi core has no built-in MCP
 * (concepts/pi-runtime-vs-agent-deck.md), so Agent Deck proxies a configured
 * MCP server's tools into pi sessions over the bridge substrate: the server
 * lists an MCP server's tools and forwards each call here. This package stays
 * MCP-focused; apps/server maps these tools onto the bridge.
 */

/** A tool exposed by an MCP server. */
export interface McpToolInfo {
  name: string;
  description: string;
  /** JSON-Schema object for the tool's arguments (from the MCP server). */
  inputSchema: Record<string, unknown>;
}

/** The result of forwarding a tool call to the MCP server. */
export interface McpCallResult {
  /** Flattened text content returned to the model. */
  content: string;
  isError: boolean;
}

export interface McpRequestOptions {
  /** Cancels the in-flight MCP request and propagates cancellation to the SDK. */
  signal?: AbortSignal;
  /** Bounds one discovery or tool call. */
  timeoutMs?: number;
}

/** A broken or hostile server must not make catalog discovery unbounded. */
const MAX_TOOL_PAGES = 100;
const MAX_DISCOVERED_TOOLS = 2_000;

/** A stdio MCP server the app spawns and talks to over its stdin/stdout. */
export interface StdioServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

/** A remote MCP server reached over Streamable HTTP (the modern MCP transport,
 * which subsumes the older HTTP+SSE). */
export interface HttpServerConfig {
  url: string;
  /** Extra request headers (e.g. Authorization) sent on every HTTP request. */
  headers?: Record<string, string>;
}

export interface McpConnectOptions {
  /** Cancels transport startup or the MCP initialize handshake. */
  signal?: AbortSignal;
  /** Bounds the SDK initialize request after transport startup. */
  timeoutMs?: number;
}

function flattenContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "object" && part !== null && "text" in part
        ? String((part as { text: unknown }).text)
        : "",
    )
    .join("");
}

export class McpClient {
  private constructor(private readonly client: Client) {}

  /** Connect to an already-constructed transport (used by tests via in-memory). */
  static async connect(
    transport: Transport,
    name = "agent-deck",
    options: McpConnectOptions = {},
  ): Promise<McpClient> {
    const client = new Client({ name, version: "0.0.1" });
    const abortError = (): Error =>
      options.signal?.reason instanceof Error
        ? options.signal.reason
        : new Error("MCP connection aborted");
    if (options.signal?.aborted) {
      await transport.close().catch(() => {});
      throw abortError();
    }
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => {
        void client.close().catch(() => {});
        reject(abortError());
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([
        client.connect(transport, {
          signal: options.signal,
          timeout: options.timeoutMs,
          maxTotalTimeout: options.timeoutMs,
        }),
        aborted,
      ]);
      return new McpClient(client);
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    } finally {
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Spawn and connect to a stdio MCP server. */
  static async connectStdio(
    config: StdioServerConfig,
    options: McpConnectOptions = {},
  ): Promise<McpClient> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      // Merge over the SDK's safe default env (PATH/HOME/…): passing only the
      // custom vars would otherwise drop them and the server couldn't launch.
      env: config.env ? { ...getDefaultEnvironment(), ...config.env } : undefined,
      cwd: config.cwd,
    });
    return await McpClient.connect(transport, "agent-deck", options);
  }

  /**
   * Connect to a remote MCP server over Streamable HTTP. Pass an `authProvider`
   * (an McpOAuthProvider) for a server behind OAuth: the transport then drives
   * the SDK handshake, and on an unauthenticated server it throws
   * UnauthorizedError after calling the provider's redirectToAuthorization — the
   * caller runs the relay, calls transport.finishAuth(code), and reconnects.
   */
  static async connectHttp(
    config: HttpServerConfig,
    options: McpConnectOptions & { authProvider?: OAuthClientProvider } = {},
  ): Promise<McpClient> {
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit: config.headers ? { headers: config.headers } : undefined,
      authProvider: options.authProvider,
    });
    return await McpClient.connect(transport, "agent-deck", options);
  }

  /** List the server's tools as plain JSON-Schema-carrying descriptors. */
  async listTools(options: McpRequestOptions = {}): Promise<McpToolInfo[]> {
    const startedAt = Date.now();
    const tools: Awaited<ReturnType<Client["listTools"]>>["tools"] = [];
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    let pages = 0;
    do {
      if (pages >= MAX_TOOL_PAGES) throw new Error("MCP listTools exceeded its page limit");
      pages += 1;
      const remaining = options.timeoutMs
        ? Math.max(1, options.timeoutMs - (Date.now() - startedAt))
        : undefined;
      if (
        options.timeoutMs !== undefined &&
        remaining !== undefined &&
        remaining <= 1 &&
        Date.now() - startedAt >= options.timeoutMs
      ) {
        throw new Error(`MCP listTools timed out after ${options.timeoutMs}ms`);
      }
      const page = await this.client.listTools(cursor ? { cursor } : undefined, {
        signal: options.signal,
        timeout: remaining,
        maxTotalTimeout: remaining,
      });
      if (tools.length + page.tools.length > MAX_DISCOVERED_TOOLS) {
        throw new Error("MCP listTools exceeded its tool limit");
      }
      tools.push(...page.tools);
      cursor = page.nextCursor;
      if (cursor && seenCursors.has(cursor)) throw new Error("MCP listTools repeated its cursor");
      if (cursor) seenCursors.add(cursor);
    } while (cursor);
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? tool.name,
      inputSchema: (tool.inputSchema as Record<string, unknown> | undefined) ?? {
        type: "object",
        properties: {},
      },
    }));
  }

  /** Forward a tool call to the MCP server and flatten its result. */
  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: McpRequestOptions = {},
  ): Promise<McpCallResult> {
    const result = await this.client.callTool({ name, arguments: args }, undefined, {
      signal: options.signal,
      timeout: options.timeoutMs,
      maxTotalTimeout: options.timeoutMs,
    });
    return {
      content: flattenContent(result.content),
      isError: result.isError === true,
    };
  }

  async close(): Promise<void> {
    await this.client.close();
  }
}
