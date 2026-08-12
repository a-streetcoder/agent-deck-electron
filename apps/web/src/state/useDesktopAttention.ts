import { useEffect, useRef } from "react";
import type { SessionMeta } from "@agent-deck/contracts";
import { isElectron, notifyAttention, syncAttention } from "@/lib/native";
import { projectDisplayName, sessionDisplayTitle } from "@/lib/sessionTitle";
import { useAppStore } from "./store.ts";
import { acknowledgeSessionAttention } from "./wsBridge.ts";

/** Durable attention edges between two catalog observations. An absent legacy
 * value is false; hydration is a baseline, so restart never duplicates native
 * notifications. */
export function newlyAttentiveSessionIds(
  previous: ReadonlyMap<string, boolean> | null,
  sessions: readonly SessionMeta[],
): string[] {
  if (previous === null) return [];
  return sessions
    .filter((session) => session.needsAttention === true && previous.get(session.id) !== true)
    .map((session) => session.id);
}

/** Observe every session's backend-owned durable marker, not only the selected
 * transcript. Main independently fetches backend truth for its distinct badge. */
export function useDesktopAttention(): void {
  const sessions = useAppStore((state) => state.sessions);
  const sessionsLoaded = useAppStore((state) => state.sessionsLoaded);
  const session = useAppStore((state) => state.session);
  const view = useAppStore((state) => state.view);
  const projects = useAppStore((state) => state.projects);
  const attentionRoutingToken = useAppStore((state) => state.attentionRoutingToken);
  const previousRef = useRef<Map<string, boolean> | null>(null);
  const acknowledgingRef = useRef(new Set<string>());

  useEffect(() => {
    if (!sessionsLoaded) return;
    const previous = previousRef.current;
    const newlyAttentive = newlyAttentiveSessionIds(previous, sessions);
    previousRef.current = new Map(
      sessions.map((item) => [item.id, item.needsAttention === true] as const),
    );

    // Hydration and every durable metadata change reconcile the shell badge.
    if (isElectron()) syncAttention();
    if (newlyAttentive.length === 1) {
      const item = sessions.find((candidate) => candidate.id === newlyAttentive[0]);
      if (item) {
        const title = sessionDisplayTitle(item.title, projectDisplayName(projects, item.projectId));
        useAppStore.getState().setAttentionAnnouncement(`${title} needs attention.`);
      }
    } else if (newlyAttentive.length > 1) {
      useAppStore
        .getState()
        .setAttentionAnnouncement(`${newlyAttentive.length} sessions need attention.`);
    }
    for (const id of newlyAttentive) {
      const item = sessions.find((candidate) => candidate.id === id);
      if (!item || !isElectron()) continue;
      const title = sessionDisplayTitle(item.title, projectDisplayName(projects, item.projectId));
      notifyAttention({
        sessionId: id,
        title,
        body: "This session needs your attention",
      });
    }
  }, [projects, sessions, sessionsLoaded]);

  useEffect(() => {
    const acknowledgeIfVisible = (): void => {
      const selected = useAppStore.getState();
      const selectedSession = selected.session;
      if (
        selected.attentionRoutingToken !== null ||
        selected.view !== "chat" ||
        selectedSession?.needsAttention !== true ||
        document.visibilityState !== "visible" ||
        !document.hasFocus() ||
        acknowledgingRef.current.has(selectedSession.id)
      ) {
        return;
      }
      acknowledgingRef.current.add(selectedSession.id);
      void acknowledgeSessionAttention(selectedSession.id)
        .catch(() => {
          // Keep the durable marker visible; a later focus/metadata edge retries.
        })
        .finally(() => {
          acknowledgingRef.current.delete(selectedSession.id);
        });
    };

    acknowledgeIfVisible();
    window.addEventListener("focus", acknowledgeIfVisible);
    document.addEventListener("visibilitychange", acknowledgeIfVisible);
    return () => {
      window.removeEventListener("focus", acknowledgeIfVisible);
      document.removeEventListener("visibilitychange", acknowledgeIfVisible);
    };
  }, [attentionRoutingToken, session?.id, session?.needsAttention, view]);
}
