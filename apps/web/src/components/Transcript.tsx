import type { TranscriptVisibilitySettings } from "@agent-deck/contracts";
import {
  isPendingQuestionNavigationCell,
  isQuestionNavigationCell,
  questionNavigationTarget,
  type QuestionNavigationCell,
} from "@agent-deck/domain";
import { useEffect, useMemo, useRef, useState } from "react";
import { isTranscriptCellVisible } from "../lib/transcriptVisibility.ts";
import { useAppStore } from "../state/store.ts";
import { CellView } from "./cells.tsx";
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
  const cells = useAppStore((state) => state.transcript.cells);
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
              <CellView
                cell={cell}
                editorController={editorController}
                transcriptVisibility={effectiveVisibility}
              />
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
