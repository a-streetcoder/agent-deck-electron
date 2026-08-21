import { useId, useState, type FormEvent } from "react";
import type { AskUserCell } from "@agent-deck/domain";
import {
  ControlButton,
  ControlInput,
  ControlTextArea,
} from "@/design-system/components/NativeControls";
import { sendAskUserAnswer, sendAskUserCancel } from "@/state/wsBridge";

/** One independent, accessible decision form for a parent ask_user call. */
export function AskUserDecisionCard({ cell }: { cell: AskUserCell }) {
  const groupId = useId();
  const [selections, setSelections] = useState<string[]>([]);
  const [freeform, setFreeform] = useState("");
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState<"answer" | "cancel" | null>(null);
  const [status, setStatus] = useState("");
  const resolved = cell.status !== "pending";

  const choose = (title: string, checked: boolean): void => {
    if (cell.allowMultiple) {
      setSelections((current) =>
        checked ? [...current, title] : current.filter((value) => value !== title),
      );
    } else {
      setSelections(checked ? [title] : []);
    }
    // Offered choices and the freeform alternative are mutually exclusive in
    // every mode. Keep this at the state boundary so submit can never construct
    // the combination the server intentionally rejects.
    if (checked) setFreeform("");
  };
  const canAnswer = selections.length > 0 || Boolean(freeform.trim());

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!canAnswer || busy || resolved) return;
    setBusy("answer");
    setStatus("Sending answer…");
    try {
      await sendAskUserAnswer(cell.sessionId, cell.requestId, {
        selections,
        ...(freeform.trim() ? { freeform: freeform.trim() } : {}),
        ...(comment.trim() ? { comment: comment.trim() } : {}),
      });
      setStatus("Answer sent.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not send the answer.");
      setBusy(null);
    }
  };

  const cancel = async (): Promise<void> => {
    if (busy || resolved) return;
    setBusy("cancel");
    setStatus("Cancelling…");
    try {
      await sendAskUserCancel(cell.sessionId, cell.requestId);
      setStatus("Request cancelled.");
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Could not cancel the request.");
      setBusy(null);
    }
  };

  return (
    <section
      className="rounded-xl border px-4 py-3"
      style={{
        borderColor: "var(--color-selection-stroke)",
        background: "var(--color-selection-fill)",
      }}
      data-testid="ask-user-cell"
      data-status={cell.status}
      aria-labelledby={`${groupId}-title`}
    >
      <div className="text-detail font-semibold text-text-muted">Agent needs your input</div>
      <h3 id={`${groupId}-title`} className="mt-1 font-medium text-text-primary">
        {cell.question}
      </h3>
      {cell.context ? (
        <div className="mt-2 whitespace-pre-wrap text-body text-text-secondary">{cell.context}</div>
      ) : null}

      {cell.status === "answered" ? (
        <div className="mt-3 text-body text-text-muted" data-testid="ask-user-audit">
          Answered
          {cell.answer?.selections.length ? `: ${cell.answer.selections.join(", ")}` : ""}
          {cell.answer?.freeform ? ` — ${cell.answer.freeform}` : ""}
          {cell.answer?.comment ? ` (${cell.answer.comment})` : ""}
        </div>
      ) : resolved ? (
        <div className="mt-3 text-body text-text-muted" data-testid="ask-user-audit">
          {cell.status === "timed_out" ? "Timed out" : "Cancelled"}: {cell.closedReason}
        </div>
      ) : (
        <form className="mt-3 space-y-3" onSubmit={(event) => void submit(event)}>
          {cell.options.length > 0 ? (
            <fieldset className="space-y-2">
              <legend className="sr-only">Answer choices</legend>
              {cell.options.map((option) => (
                <label
                  key={option.title}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border-subtle bg-surface px-3 py-2 text-label"
                >
                  <ControlInput
                    type={cell.allowMultiple ? "checkbox" : "radio"}
                    name={`${groupId}-choice`}
                    value={option.title}
                    checked={selections.includes(option.title)}
                    onChange={(event) => choose(option.title, event.currentTarget.checked)}
                  />
                  <span>
                    <span className="block font-medium text-text-primary">{option.title}</span>
                    {option.description ? (
                      <span className="mt-0.5 block text-text-secondary">{option.description}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </fieldset>
          ) : null}
          {cell.allowFreeform ? (
            <div>
              <label
                htmlFor={`${groupId}-freeform`}
                className="text-label font-medium text-text-primary"
              >
                {cell.options.length ? "Or write your own answer" : "Your answer"}
              </label>
              <ControlTextArea
                id={`${groupId}-freeform`}
                className="mt-1 min-h-20 w-full resize-y rounded-md border border-border-strong bg-surface px-2 py-1.5 text-body text-text-primary outline-none focus:border-accent"
                value={freeform}
                onChange={(event) => {
                  setFreeform(event.currentTarget.value);
                  if (event.currentTarget.value) setSelections([]);
                }}
              />
            </div>
          ) : null}
          {cell.allowComment ? (
            <div>
              <label
                htmlFor={`${groupId}-comment`}
                className="text-label font-medium text-text-primary"
              >
                Optional comment
              </label>
              <ControlInput
                id={`${groupId}-comment`}
                className="mt-1 w-full rounded-md border border-border-strong bg-surface px-2 py-1.5 text-label text-text-primary outline-none focus:border-accent"
                value={comment}
                onChange={(event) => setComment(event.currentTarget.value)}
              />
            </div>
          ) : null}
          <div className="flex justify-end gap-2">
            <ControlButton
              type="button"
              className="rounded-capsule border border-border-strong px-3 py-1.5 text-label disabled:opacity-50"
              disabled={busy !== null}
              onClick={() => void cancel()}
            >
              {busy === "cancel" ? "Cancelling…" : "Cancel"}
            </ControlButton>
            <ControlButton
              type="submit"
              className="rounded-capsule bg-primary px-3 py-1.5 text-label font-medium disabled:opacity-50"
              style={{ color: "var(--color-accent-foreground)" }}
              disabled={!canAnswer || busy !== null}
            >
              {busy === "answer" ? "Answering…" : "Answer"}
            </ControlButton>
          </div>
          <div className="min-h-5 text-body text-text-muted" role="status" aria-live="polite">
            {status}
          </div>
        </form>
      )}
    </section>
  );
}
