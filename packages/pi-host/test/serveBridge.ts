import {
  bridgeUiResponse,
  parseBridgeUiRequest,
  type BridgeReply,
  type BridgeWireCall,
} from "../src/bridge.ts";
import type { PiSession } from "../src/PiSession.ts";

/**
 * Stand in for the app side of the stdio bridge: answer every bridge dialog
 * `session` emits with `handler`'s reply (a body alone is a 200). A handler
 * that returns `undefined` never answers, as an app that went away.
 */
export function serveBridge(
  session: PiSession,
  handler: (
    call: BridgeWireCall,
  ) =>
    | BridgeReply
    | { body: unknown }
    | undefined
    | Promise<BridgeReply | { body: unknown } | undefined>,
): void {
  session.on("event", (event) => {
    const request = parseBridgeUiRequest(event);
    if (!request?.call) return;
    void Promise.resolve(handler(request.call)).then((reply) => {
      if (!reply || !session.isRunning) return;
      session.respondToUiRequest(
        bridgeUiResponse(request.id, { status: 200, ...reply } as BridgeReply),
      );
    });
  });
}
