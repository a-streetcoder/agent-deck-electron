import { ControlButton } from "@/design-system/components/NativeControls";
import { RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ChildTranscriptSnapshot, SubagentCell, TranscriptCell } from "@agent-deck/domain";
import { useFocusTrap } from "../lib/useFocusTrap.ts";

const active = (status: SubagentCell["status"]): boolean => status === "running";

const titleCase = (value: string): string => `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;

function snapshotLabel(snapshot: ChildTranscriptSnapshot): string {
  const source =
    snapshot.source === "live"
      ? "Live"
      : snapshot.source === "canonical"
        ? "Canonical"
        : "Final report only";
  return `${source} · ${titleCase(snapshot.status)}`;
}

export function ChildTranscriptDialog({
  parentSessionId,
  runId,
  expectedStatus,
  renderCell,
  onClose,
}: {
  parentSessionId: string;
  runId: string;
  expectedStatus: SubagentCell["status"];
  renderCell: (cell: TranscriptCell) => ReactNode;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<ChildTranscriptSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrySequence, setRetrySequence] = useState(0);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(true, closeRef);

  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    const load = async (): Promise<void> => {
      try {
        const response = await fetch(
          `/sessions/${encodeURIComponent(parentSessionId)}/subagent-runs/${encodeURIComponent(runId)}/transcript`,
          { signal: controller.signal },
        );
        const body = (await response.json()) as {
          transcript?: ChildTranscriptSnapshot;
          error?: string;
        };
        if (!response.ok || !body.transcript)
          throw new Error(body.error ?? "Child transcript is unavailable.");
        setSnapshot(body.transcript);
        setError(null);
        // The parent card is the continuation authority. During terminal→running
        // transition the endpoint can briefly return the old canonical snapshot;
        // keep polling until the parent itself becomes terminal again. A live
        // projection can briefly outlast that terminal card transition, so it
        // also polls until canonical/summary evidence replaces `Live · Done`.
        if (active(expectedStatus) || body.transcript.source === "live") {
          timer = window.setTimeout(() => void load(), 750);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : "Child transcript is unavailable.");
        }
      }
    };
    void load();
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [expectedStatus, parentSessionId, retrySequence, runId]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-media-overlay-strong p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`child-transcript-title-${runId}`}
        className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-card"
        data-testid="child-transcript-dialog"
      >
        <header className="flex min-w-0 items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            <h2 id={`child-transcript-title-${runId}`} className="font-medium text-text-primary">
              Child transcript
            </h2>
            {snapshot ? (
              <>
                <p
                  className="break-words text-detail text-text-muted"
                  data-testid="child-transcript-task"
                >
                  {snapshot.task}
                </p>
                <p
                  className="mt-1 text-caption font-medium text-text-secondary"
                  role="status"
                  aria-live="polite"
                  data-testid="child-transcript-source-status"
                >
                  {snapshotLabel(snapshot)}
                </p>
              </>
            ) : null}
          </div>
          <ControlButton
            ref={closeRef}
            type="button"
            aria-label="Close child transcript"
            onClick={onClose}
            className="shrink-0 rounded-md p-1.5 hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X size={16} aria-hidden />
          </ControlButton>
        </header>
        <div
          className="min-h-32 flex-1 space-y-4 overflow-auto p-4"
          data-testid="child-transcript-content"
        >
          {!snapshot && !error ? (
            <p role="status" aria-live="polite" className="text-body text-text-muted">
              Loading child transcript…
            </p>
          ) : null}
          {error ? (
            <div className="space-y-2">
              <p role="alert" className="text-body text-danger">
                {error}
              </p>
              <ControlButton
                type="button"
                className="flex items-center gap-1.5 rounded-capsule border border-border px-2.5 py-1 text-detail font-medium text-text-secondary hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => {
                  setError(null);
                  setRetrySequence((value) => value + 1);
                }}
              >
                <RotateCw size={13} aria-hidden />
                Retry
              </ControlButton>
            </div>
          ) : null}
          {snapshot?.notice ? (
            <p
              role="status"
              className="rounded-lg border border-border px-3 py-2 text-label text-text-muted"
            >
              {snapshot.notice}
            </p>
          ) : null}
          {snapshot && snapshot.cells.length === 0 ? (
            <p role="status" className="text-body text-text-muted">
              No child messages yet.
            </p>
          ) : null}
          {snapshot?.cells.map((cell) => (
            <div key={cell.id}>{renderCell(cell)}</div>
          ))}
        </div>
      </div>
    </div>
  );
}
