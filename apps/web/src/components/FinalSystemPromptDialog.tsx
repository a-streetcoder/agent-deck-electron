import { AppCopyButton } from "@/design-system/components/AppCopyButton";
import { ControlButton } from "@/design-system/components/NativeControls";
import type { FinalSystemPromptAudit } from "@agent-deck/contracts";
import { FileText, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useAppStore } from "../state/store.ts";

function PromptDialog({ audit, onClose }: { audit: FinalSystemPromptAudit; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(true, closeRef);
  const [copyError, setCopyError] = useState(false);
  const [captureAnnouncement, setCaptureAnnouncement] = useState("");
  const previousCapturedAt = useRef(audit.capturedAt);

  useEffect(() => {
    if (previousCapturedAt.current !== audit.capturedAt) {
      previousCapturedAt.current = audit.capturedAt;
      setCaptureAnnouncement("A newer final system prompt was captured.");
    }
  }, [audit.capturedAt]);

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

  const captured = new Date(audit.capturedAt);
  const timestamp = Number.isNaN(captured.getTime()) ? audit.capturedAt : captured.toLocaleString();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 [-webkit-app-region:no-drag]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="final-system-prompt-title"
        aria-describedby="final-system-prompt-privacy"
        data-testid="final-system-prompt-dialog"
        className="flex max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-elevated shadow-elevated"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 id="final-system-prompt-title" className="font-medium text-text-primary">
              Final system prompt
            </h2>
            <p className="text-caption text-text-muted">
              Captured <time dateTime={audit.capturedAt}>{timestamp}</time>
            </p>
          </div>
          <div className="flex items-center gap-2">
            <AppCopyButton
              text={audit.text}
              aria-label="Copy final system prompt"
              onCopySuccess={() => setCopyError(false)}
              onCopyError={() => setCopyError(true)}
            />
            <ControlButton
              ref={closeRef}
              type="button"
              aria-label="Close final system prompt"
              onClick={onClose}
              className="rounded-md p-1.5 hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
            >
              <X size={16} aria-hidden />
            </ControlButton>
          </div>
        </header>
        <p
          id="final-system-prompt-privacy"
          className="border-b border-border px-4 py-2 text-detail text-text-muted"
        >
          Private to this device. This may include project instructions or secrets and is not
          synced.
        </p>
        {captureAnnouncement ? (
          <p className="px-4 pt-3 text-caption text-text-muted" role="status" aria-live="polite">
            {captureAnnouncement}
          </p>
        ) : null}
        {copyError ? (
          <p className="px-4 pt-3 text-caption text-danger" role="status">
            Could not copy. Select the text manually.
          </p>
        ) : null}
        <div
          className="min-h-40 flex-1 overflow-auto p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
          data-testid="final-system-prompt-content"
          tabIndex={0}
          aria-label="Final system prompt content"
        >
          {audit.text.length > 0 ? (
            <pre className="whitespace-pre-wrap break-words font-mono text-code text-text-secondary">
              {audit.text}
            </pre>
          ) : (
            <p className="text-body text-text-muted">
              Pi used an empty system prompt for this turn.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Toolbar audit affordance. Absent until Pi has successfully captured a turn. */
export function FinalSystemPromptButton() {
  const audit = useAppStore((state) => state.session?.finalSystemPromptAudit);
  const sessionId = useAppStore((state) => state.session?.id);
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [sessionId]);

  if (!audit) return null;
  return (
    <>
      <ControlButton
        type="button"
        aria-label="View final system prompt"
        title="View final system prompt"
        data-testid="final-system-prompt-button"
        onClick={() => setOpen(true)}
        className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-hover hover:text-text-primary focus-visible:ring-2 focus-visible:ring-accent [-webkit-app-region:no-drag]"
      >
        <FileText className="h-4 w-4" aria-hidden />
      </ControlButton>
      {open ? <PromptDialog audit={audit} onClose={() => setOpen(false)} /> : null}
    </>
  );
}
