import type { SessionDraftGateway } from "./sessionDrafts.ts";
import type { IncomingMessage } from "node:http";
import { RPC_WS_PATH } from "@agent-deck/contracts";
import type { DiffPush, ServerMessage } from "@agent-deck/contracts";
import type { FastifyInstance } from "fastify";
import type { DiffGateway } from "./diffGateway.ts";
import type { EditorLauncher } from "./editorLauncher.ts";
import type { CheckpointRollbackGateway } from "./checkpointRollback.ts";
import { setupRpcEndpoint } from "./rpcHandler.ts";
import type { ScriptRunnerGateway } from "./scriptRunnerGateway.ts";
import type { SessionManager } from "./SessionManager.ts";
import type { SessionImageStore } from "./sessionImages.ts";
import type { SessionPasteStore } from "./sessionPastes.ts";
import type { CheckpointServiceShape } from "./services/checkpoints.ts";
import type { FileService } from "./services/files.ts";
import type { TerminalGateway } from "./terminalGateway.ts";
import { authenticateProxiedRequest, type CloudflareAccessVerifier } from "./trustedProxy.ts";
import type { SessionAuthorStore } from "./sessionAuthors.ts";
import type { EventProducers } from "./eventProducers.ts";

export interface WebSocketLayer {
  /** Push a server message to every connected RPC client (wrapped as a frame). */
  broadcast: (message: ServerMessage) => void;
  /** Push a diff notification to every connected RPC client (Slice 9). */
  broadcastDiff: (message: DiffPush) => void;
  /** Atomically reject upgrades/frames and close current clients. */
  closeAdmission: () => void;
  /** Settle every frame dispatched before admission closed. */
  drain: () => Promise<void>;
  /** Force-close the `/rpc` socket server after dispatched work drains. */
  close: () => void;
  /** The upgrade's origin rule, shared with the REST guard in server.ts. */
  isTrustedOrigin: (origin: string | undefined, host: string | undefined) => boolean;
}

/**
 * The WebSocket layer: socket-upgrade accept (with the local-origin guard) routed
 * to the Effect-RPC endpoint on `/rpc` (rpcHandler.ts). The legacy bare-envelope
 * `/ws` path was retired in Slice 7c — `/rpc` is now the only transport, and the
 * contracts Effect Schema is the sole runtime validator at the socket boundary.
 */
export function setupWebSocket(deps: {
  fastify: FastifyInstance;
  sessions: SessionManager;
  drafts?: SessionDraftGateway;
  terminals: TerminalGateway;
  diffs: DiffGateway;
  editors: EditorLauncher;
  files: FileService;
  scripts: ScriptRunnerGateway;
  checkpoints: CheckpointServiceShape;
  rollback: CheckpointRollbackGateway;
  sessionImages: SessionImageStore;
  sessionPastes: SessionPasteStore;
  sessionAuthors?: SessionAuthorStore;
  /** A1 event log producers (turn.prompted). */
  events?: EventProducers;
  /** SRV-09: trusted proxy on, host launchers refuse. */
  sharedServer?: boolean;
  /** Remote-server POC: browser origin reachable through the trusted proxy. */
  publicOrigin?: string;
  /** Remote-server POC: when set, every upgrade must carry a valid Access assertion. */
  accessVerifier?: CloudflareAccessVerifier;
}): WebSocketLayer {
  const { fastify, sessions, terminals, diffs, editors, files, scripts, checkpoints, rollback } =
    deps;

  // The Effect-RPC endpoint (rpcHandler.ts): per-connection frame dispatch,
  // subscribe/replay, and broadcast — all sharing the SessionManager facade.
  const rpc = setupRpcEndpoint({
    sessions,
    drafts: deps.drafts,
    terminals,
    diffs,
    editors,
    files,
    scripts,
    checkpoints,
    rollback,
    sessionImages: deps.sessionImages,
    sessionPastes: deps.sessionPastes,
    sessionAuthors: deps.sessionAuthors,
    events: deps.events,
    sharedServer: deps.sharedServer,
  });

  // Browsers may open cross-origin WebSockets to localhost services; only
  // accept upgrades from local origins (or non-browser clients, which send
  // no Origin header) so a hostile web page can't drive sessions.
  const isTrustedOrigin = (origin: string | undefined, host: string | undefined): boolean => {
    if (origin === undefined) return true; // ws library clients, curl, tests
    // Remote-server POC: the proxied browser origin is trusted as-is; its Host
    // is whatever cloudflared forwards, and the Access assertion (below) is
    // what actually authenticates the connection.
    if (deps.publicOrigin && origin === deps.publicOrigin) return true;
    if (!host) return false;
    try {
      const url = new URL(origin);
      const loopback =
        url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1";
      // A random localhost web page must not bootstrap the control-plane token.
      // Vite's proxy preserves its Host, so development remains same-origin too.
      return (
        (url.protocol === "http:" || url.protocol === "https:") && loopback && url.host === host
      );
    } catch {
      return false;
    }
  };

  let admissionClosed = false;
  fastify.server.on("upgrade", (request: IncomingMessage, socket, head) => {
    if (admissionClosed || !isTrustedOrigin(request.headers.origin, request.headers.host)) {
      socket.destroy();
      return;
    }
    // Only `/rpc` (the Effect-RPC frames) is accepted; anything else is rejected.
    if (request.url !== RPC_WS_PATH) {
      socket.destroy();
      return;
    }
    const accept = (): void => {
      if (admissionClosed || socket.destroyed) {
        socket.destroy();
        return;
      }
      rpc.wss.handleUpgrade(request, socket, head, (ws) => {
        if (admissionClosed) {
          ws.close(1012, "Server shutting down");
          return;
        }
        rpc.wss.emit("connection", ws, request);
      });
    };
    if (!deps.accessVerifier) {
      accept();
      return;
    }
    // Trusted proxy on: the upgrade is authenticated like any HTTP request, and
    // the verified user is attached to the raw request for rpcHandler.
    void authenticateProxiedRequest(deps.accessVerifier, request).then(
      (result) => (result.user ? accept() : socket.destroy()),
      () => socket.destroy(),
    );
  });

  return {
    isTrustedOrigin,
    broadcast: rpc.broadcast,
    broadcastDiff: rpc.broadcastDiff,
    closeAdmission: () => {
      if (admissionClosed) return;
      admissionClosed = true;
      rpc.closeAdmission();
    },
    drain: rpc.drain,
    close: () => {
      // `wss.close()` with `noServer: true` does NOT destroy accepted client
      // sockets — it only waits for them to leave. Terminate them so every
      // connection's 'close' handler (subscription + terminal teardown in
      // rpcHandler) runs deterministically during server shutdown instead of
      // whenever the remote peer decides to hang up.
      for (const client of rpc.wss.clients) client.terminate();
      rpc.wss.close();
    },
  };
}
