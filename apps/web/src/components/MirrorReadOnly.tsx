import { createContext, useContext } from "react";
import type { AskUserCell, QuestionCell, SupervisorQuestionCell } from "@agent-deck/domain";
import { Button } from "@/design-system/components/Button";

/**
 * SRV-12c2: the transcript shows cells mirrored from a shared server. Nothing in
 * them acts on this device: no answers, history actions, editors, images or
 * child transcripts from the local backend (it does not have them); each points
 * to the server instead.
 */
export interface MirrorReadOnly {
  host: string;
  openOnServer(): void;
}

export const MirrorReadOnlyContext = createContext<MirrorReadOnly | null>(null);
export const useMirrorReadOnly = (): MirrorReadOnly | null => useContext(MirrorReadOnlyContext);

/** "(on <host>)" with Open on server, in place of something only the server has. */
export function OnServer({ text }: { text: (host: string) => string }) {
  const mirror = useMirrorReadOnly();
  if (!mirror) return null;
  return (
    <div
      className="flex flex-wrap items-center gap-2 text-detail text-text-muted"
      data-testid="mirror-on-server"
    >
      <span>{text(mirror.host)}</span>
      <Button size="sm" variant="ghost" onClick={mirror.openOnServer}>
        Open on server
      </Button>
    </div>
  );
}

/** A question, ask-user or supervisor card from the server: shown, answered there. */
export function MirroredQuestion({
  cell,
}: {
  cell: QuestionCell | AskUserCell | SupervisorQuestionCell;
}) {
  const mirror = useMirrorReadOnly();
  const title = cell.kind === "ask_user" ? cell.question : cell.title;
  const open =
    cell.kind === "ask_user"
      ? cell.status === "pending"
      : cell.kind === "supervisor_question"
        ? !cell.answered && cell.closed !== true
        : !cell.answered;
  return (
    <div className="rounded-xl border border-border px-4 py-3" data-testid="mirrored-question">
      <div className="font-medium text-text-primary">{title}</div>
      {"message" in cell && cell.message ? (
        <div className="mt-1 text-body text-text-secondary">{cell.message}</div>
      ) : null}
      {open && mirror ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-body text-text-muted">
          <span>Answer on {mirror.host}</span>
          <Button size="sm" onClick={mirror.openOnServer}>
            Open on server
          </Button>
        </div>
      ) : (
        <div className="mt-2 text-body text-text-muted">
          {cell.kind === "ask_user" && cell.status !== "answered" ? "Closed." : "Answered."}
        </div>
      )}
    </div>
  );
}
