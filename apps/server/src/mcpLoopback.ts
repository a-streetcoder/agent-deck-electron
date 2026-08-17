import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface McpLoopbackResult {
  code?: string;
  state?: string;
  error?: string;
}

const RESULT_PAGE = (ok: boolean): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>Agent Deck</title></head>` +
  `<body style="font-family:system-ui;text-align:center;padding:3rem;color:#333">` +
  `<h2>${ok ? "Authorization received" : "Authorization failed"}</h2>` +
  `<p>Return to Agent Deck to finish sign-in.</p></body></html>`;

/** One-shot OAuth callback listener, bound only to IPv4 loopback. */
export class McpLoopbackServer {
  private server?: Server;
  private cancelStart?: () => void;
  private port = 0;
  private readonly bindPort: number;
  private readonly callbackPath: string;
  private readonly configuredRedirectUrl: string;

  private pending?: { resolve: (result: McpLoopbackResult) => void; timer: NodeJS.Timeout };
  private buffered?: McpLoopbackResult;
  private settled = false;
  private expectedState?: string;
  private closed = false;

  constructor(
    redirectUrl = "http://127.0.0.1:33418/mcp/oauth/callback",
    private readonly serverFactory: typeof createServer = createServer,
  ) {
    const url = new URL(redirectUrl);
    if (
      url.protocol !== "http:" ||
      (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
      !url.port
    ) {
      throw new Error("OAuth callback URL must be an http loopback URL with an explicit port");
    }
    url.hostname = "127.0.0.1";
    url.search = "";
    url.hash = "";
    this.bindPort = Number(url.port);
    this.callbackPath = url.pathname;
    this.configuredRedirectUrl = url.toString();
  }

  async start(): Promise<number> {
    if (this.server || this.closed) throw new Error("OAuth callback listener cannot be restarted");
    return await new Promise<number>((resolve, reject) => {
      const server = this.serverFactory((req, res) => this.handle(req, res));
      // Own the server before listen can yield. close() must be able to cancel a
      // pending bind rather than letting its callback publish an orphan later.
      this.server = server;
      let settled = false;
      const settleError = (error: Error, closeServer = true) => {
        if (settled) return;
        settled = true;
        this.cancelStart = undefined;
        if (this.server === server) this.server = undefined;
        if (closeServer) {
          try {
            server.close();
          } catch {
            // A server cancelled before it starts listening has nothing to close.
          }
        }
        reject(error);
      };
      const failed = (error: Error) => settleError(error);
      this.cancelStart = () => settleError(new Error("authorization cancelled"), false);
      server.once("error", failed);
      server.listen(this.bindPort, "127.0.0.1", () => {
        if (this.closed || this.server !== server) {
          settleError(new Error("authorization cancelled"));
          return;
        }
        settled = true;
        this.cancelStart = undefined;
        server.off("error", failed);
        server.on("error", () => undefined);
        this.port = (server.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  get redirectUrl(): string {
    if (!this.port) throw new Error("OAuth callback listener is not running");
    return this.configuredRedirectUrl;
  }

  setExpectedState(state: string): void {
    if (!state || this.settled) throw new Error("OAuth callback state cannot be changed");
    this.expectedState = state;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    if (req.method !== "GET") {
      res.writeHead(405, { allow: "GET" }).end();
      return;
    }
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    if (url.pathname !== this.callbackPath) {
      res.writeHead(404).end();
      return;
    }
    const code = url.searchParams.get("code") ?? undefined;
    const error = url.searchParams.get("error") ?? undefined;
    if (!code && !error) {
      res.writeHead(400).end();
      return;
    }
    const state = url.searchParams.get("state") ?? undefined;
    if (!this.expectedState || state !== this.expectedState) {
      // Another app instance or stale browser flow may share this configured
      // port. A foreign state must never consume this instance's one shot.
      res.writeHead(400).end();
      return;
    }
    res.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    res.end(RESULT_PAGE(Boolean(code) && !error));
    this.deliver({ code, state, error });
  }

  private deliver(result: McpLoopbackResult): void {
    if (this.settled || this.closed) return;
    this.settled = true;
    if (this.pending) {
      const { resolve, timer } = this.pending;
      this.pending = undefined;
      clearTimeout(timer);
      resolve(result);
    } else {
      this.buffered = result;
    }
  }

  waitForCallback(timeoutMs = 300_000): Promise<McpLoopbackResult> {
    if (this.buffered) {
      const result = this.buffered;
      this.buffered = undefined;
      return Promise.resolve(result);
    }
    if (this.closed) return Promise.resolve({ error: "authorization cancelled" });
    if (this.pending) throw new Error("OAuth callback wait already started");
    return new Promise<McpLoopbackResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending = undefined;
        this.settled = true;
        resolve({ error: "timed out waiting for the authorization redirect" });
      }, timeoutMs);
      timer.unref();
      this.pending = { resolve, timer };
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.buffered = undefined;
    if (this.pending) {
      const { resolve, timer } = this.pending;
      this.pending = undefined;
      clearTimeout(timer);
      resolve({ error: "authorization cancelled" });
    }
    const server = this.server;
    this.server = undefined;
    this.cancelStart?.();
    this.cancelStart = undefined;
    if (server) {
      await new Promise<void>((resolve) => {
        try {
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }
  }
}
