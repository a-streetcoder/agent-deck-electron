import type { TranscriptVisibilitySettings } from "@agent-deck/contracts";
import {
  isPendingQuestionNavigationCell,
  isQuestionNavigationCell,
  questionNavigationTarget,
  serverCopy,
  type QuestionNavigationCell,
} from "@agent-deck/domain";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTranscriptCellVisible } from "../lib/transcriptVisibility.ts";
import { mirroredTranscript, useAppStore } from "../state/store.ts";
import { openExternal } from "../lib/native.ts";
import { MirrorReadOnlyContext, OnServer, type MirrorReadOnly } from "./MirrorReadOnly.tsx";
import { hostOf } from "./SessionShare.tsx";
import { CellView } from "./cells.tsx";
import { ForkProvenanceCard } from "./ForkProvenanceCard.tsx";
import { SessionPlanPanel } from "./SessionPlanPanel.tsx";
import { SessionStartupCard } from "./SessionStartupCard.tsx";
import { useOpenInEditor } from "./diff/OpenInPicker.tsx";

const HIDDEN_OPTIONAL_CATEGORIES: TranscriptVisibilitySettings = {
  showThinking: false,
  showWebActivity: false,
  showDiffs: false,
  showImages: false,
  showMemoryCards: false,
  showMCPCards: false,
};

function questionNavigationLabel(
  cell: QuestionNavigationCell,
  index: number,
  total: number,
): string {
  const type =
    cell.kind === "ask_user"
      ? "agent question"
      : cell.kind === "supervisor_question"
        ? "supervisor question"
        : "question";
  return `${isPendingQuestionNavigationCell(cell) ? "Pending" : "Resolved"} ${type}, ${index + 1} of ${total}`;
}

export function Transcript() {
  // SRV-12c2: a pointer shows its server session's transcript while it is mirrored.
  const cells = useAppStore((state) => mirroredTranscript(state).cells);
  const transcriptVisibility = useAppStore((state) => state.transcriptVisibility);
  const transcriptVisibilityLoaded = useAppStore((state) => state.transcriptVisibilityLoaded);
  const effectiveVisibility = transcriptVisibilityLoaded
    ? transcriptVisibility
    : HIDDEN_OPTIONAL_CATEGORIES;
  const session = useAppStore((state) => state.session);
  const navigationRequest = useAppStore((state) => state.questionNavigationRequest);
  const navigationAnchorId = useAppStore((state) => state.questionNavigationAnchorId);
  const completeQuestionNavigation = useAppStore((state) => state.completeQuestionNavigation);
  // One editor/settings discovery owner for the whole transcript. Individual
  // file rows retain only their local picker-menu state.
  const editorController = useOpenInEditor();
  // SRV-12c2: cells mirrored from a shared server act on nothing here.
  const mirror = useAppStore((state) =>
    state.sharedMirror?.sessionId === state.session?.id && state.sharedMirror?.state
      ? state.sharedMirror
      : null,
  );
  const link = session ? serverCopy(session) : undefined;
  const readOnly = useMemo<MirrorReadOnly | null>(() => {
    const origin = link?.serverOrigin;
    const serverId = link?.sessionId;
    return mirror && origin && serverId
      ? {
          host: hostOf(origin),
          openOnServer: () =>
            void openExternal(`${origin}/?session=${encodeURIComponent(serverId)}`),
        }
      : null;
  }, [mirror, link]);

  // Only a genuinely new session shows the startup card. An existing session
  // already has a piSessionFile (set on switch, before its history streams in),
  // so it never flashes the card during the brief empty-transcript load gap.
  const isNewSession = cells.length === 0 && !session?.piSessionFile;
  const visibleCells = useMemo(
    () => cells.filter((cell) => isTranscriptCellVisible(cell, effectiveVisibility)),
    [cells, effectiveVisibility],
  );
  const navigationCells = visibleCells.filter(isQuestionNavigationCell);
  const navigationPosition = new Map(navigationCells.map((cell, index) => [cell.id, index]));
  const bottomRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);
  const cellRefs = useRef(new Map<string, HTMLDivElement>());
  const consumedNavigationToken = useRef<number | null>(null);
  const [announcement, setAnnouncement] = useState<{ token: number; text: string } | null>(null);

  // Programmatic question navigation intentionally unpins the old transcript.
  // A session identity change starts a new scroll lifecycle and must restore
  // follow-to-bottom before that session's snapshot/stream begins arriving.
  useEffect(() => {
    pinnedToBottom.current = true;
  }, [session?.id]);

  useEffect(() => {
    if (pinnedToBottom.current) {
      bottomRef.current?.scrollIntoView({ block: "end" });
    }
  }, [visibleCells]);

  useEffect(() => {
    if (
      !navigationRequest ||
      navigationRequest.sessionId !== session?.id ||
      consumedNavigationToken.current === navigationRequest.token
    ) {
      return;
    }
    consumedNavigationToken.current = navigationRequest.token;
    if (navigationRequest.cellId !== undefined) {
      const cellId = navigationRequest.cellId;
      const element = visibleCells.some((cell) => cell.id === cellId)
        ? cellRefs.current.get(cellId)
        : undefined;
      completeQuestionNavigation(navigationRequest.token);
      if (!element) {
        useAppStore.getState().pushToast({
          kind: "info",
          message: "That run's card is not shown in the transcript (hidden or not loaded).",
        });
        return;
      }
      pinnedToBottom.current = false;
      element.scrollIntoView({ block: "start" });
      return;
    }
    const target = questionNavigationTarget(
      visibleCells,
      navigationRequest.direction,
      navigationAnchorId,
    );
    if (!target) {
      completeQuestionNavigation(navigationRequest.token);
      setAnnouncement({
        token: navigationRequest.token,
        text:
          navigationRequest.direction === "previous"
            ? "No previous question."
            : "No next question.",
      });
      return;
    }

    pinnedToBottom.current = false;
    const element = cellRefs.current.get(target.cell.id);
    element?.scrollIntoView({ block: "start" });
    element?.focus({ preventScroll: true });
    completeQuestionNavigation(navigationRequest.token, target.cell.id);
    setAnnouncement({
      token: navigationRequest.token,
      text: `${target.pending ? "Pending question" : "Question"} ${target.index + 1} of ${target.total}.`,
    });
  }, [
    completeQuestionNavigation,
    navigationAnchorId,
    navigationRequest,
    session?.id,
    visibleCells,
  ]);

  return (
    <div
      ref={containerRef}
      data-testid="transcript"
      className="flex-1 space-y-4 overflow-y-auto px-6 py-4"
      onScroll={() => {
        const el = containerRef.current;
        if (!el) return;
        pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      }}
    >
      {session ? <ForkProvenanceCard session={session} /> : null}
      {session?.status === "failed" ? (
        <section
          className="max-w-full rounded-md border border-danger bg-danger-subtle px-4 py-3 text-label text-danger"
          data-testid="session-failure-details"
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="font-medium">Session failed</div>
          {session.lastError ? (
            <div className="mt-1 whitespace-pre-wrap [overflow-wrap:anywhere]">
              {session.lastError}
            </div>
          ) : null}
        </section>
      ) : null}
      {readOnly && mirror?.truncated ? (
        <MirrorReadOnlyContext.Provider value={readOnly}>
          <OnServer text={(host) => `Earlier messages are on ${host}`} />
        </MirrorReadOnlyContext.Provider>
      ) : null}
      <SessionPlanPanel />
      {cells.length === 0 ? (
        isNewSession ? (
          <SessionStartupCard />
        ) : null
      ) : (
        visibleCells.map((cell) => {
          const navigable = isQuestionNavigationCell(cell);
          const position = navigationPosition.get(cell.id);
          return (
            <div
              key={cell.id}
              ref={(element) => {
                if (element) cellRefs.current.set(cell.id, element);
                else cellRefs.current.delete(cell.id);
              }}
              tabIndex={navigable ? -1 : undefined}
              role={navigable ? "group" : undefined}
              aria-label={
                navigable && position !== undefined
                  ? questionNavigationLabel(cell, position, navigationCells.length)
                  : undefined
              }
              data-question-navigation-cell={navigable ? cell.id : undefined}
              className={navigable ? "question-navigation-target" : undefined}
            >
              <MirrorReadOnlyContext.Provider value={readOnly}>
                <CellView
                  cell={cell}
                  editorController={readOnly ? undefined : editorController}
                  transcriptVisibility={effectiveVisibility}
                />
              </MirrorReadOnlyContext.Provider>
            </div>
          );
        })
      )}
      <div ref={bottomRef} />
      <div className="sr-only" role="status" aria-live="polite" aria-atomic="true">
        {announcement ? (
          <span key={announcement.token} data-announcement-token={announcement.token}>
            {announcement.text}
          </span>
        ) : null}
      </div>
    </div>
  );
}
