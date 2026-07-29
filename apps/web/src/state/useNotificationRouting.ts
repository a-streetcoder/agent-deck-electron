import { useEffect } from "react";
import { onFocusSession } from "@/lib/native";
import { focusSessionFromNotification } from "./wsBridge.ts";

/** Route an Electron notification click through the same guarded session
 * activation path used by the sidebar and command palette. */
export function useNotificationRouting(): void {
  useEffect(
    () =>
      onFocusSession((sessionId) => {
        void focusSessionFromNotification(sessionId);
      }),
    [],
  );
}
