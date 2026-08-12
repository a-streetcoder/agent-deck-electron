import { useEffect } from "react";
import { onFocusSession } from "@/lib/native";
import { useAppStore } from "./store.ts";
import { focusSessionFromNotification } from "./wsBridge.ts";

let nextRoutingToken = 0;

/** Route an Electron notification click through the same guarded session
 * activation path used by the sidebar and command palette. A token suppresses
 * focus-triggered acknowledgement of the old selection while target lookup and
 * activation are still asynchronous. */
export function useNotificationRouting(): void {
  useEffect(
    () =>
      onFocusSession((sessionId) => {
        const token = ++nextRoutingToken;
        useAppStore.getState().setAttentionRoutingToken(token);
        void focusSessionFromNotification(sessionId)
          .finally(() => {
            const store = useAppStore.getState();
            if (store.attentionRoutingToken === token) store.setAttentionRoutingToken(null);
          })
          .catch(() => {
            // Routing owns only suppression cleanup; wsBridge reports navigation errors.
          });
      }),
    [],
  );
}
