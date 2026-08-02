import { ControlButton } from "@/design-system/components/NativeControls";
import { Eye, GitFork, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ForkProvenance, SessionMeta } from "@agent-deck/contracts";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useAppStore } from "../state/store.ts";
import { switchToSession } from "../state/wsBridge.ts";

function validProvenance(value: unknown): ForkProvenance | null {
  if (!value || typeof value !== "object") return null;
  const item = value as Record<string, unknown>;
  if (
    item.version !== 1 ||
    typeof item.sourceSessionId !== "string" ||
    !item.sourceSessionId ||
    typeof item.sourceEntryId !== "string" ||
    !item.sourceEntryId ||
    typeof item.sourceTitle !== "string" ||
    typeof item.recap !== "string" ||
    typeof item.recapTruncated !== "boolean"
  ) {
    return null;
  }
  return item as unknown as ForkProvenance;
}

function RecapDialog({ provenance, onClose }: { provenance: ForkProvenance; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(true, closeRef);
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="fork-recap-title"
        data-testid="fork-recap-dialog"
        className="flex max-h-[85vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-elevated shadow-elevated"
      >
        <header className="flex items-start justify-between gap-3 border-b border-border px-4 py-3">
          <div>
            <h2 id="fork-recap-title" className="font-medium text-text-primary">
              Inherited conversation recap
            </h2>
            <p className="text-xs text-text-muted">Forked from “{provenance.sourceTitle}”</p>
          </div>
          <ControlButton
            ref={closeRef}
            type="button"
            aria-label="Close inherited conversation recap"
            onClick={onClose}
            className="rounded-md p-1.5 hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
          >
            <X size={16} aria-hidden />
          </ControlButton>
        </header>
        <div className="min-h-32 flex-1 overflow-y-auto p-4" data-testid="fork-recap-content">
          {provenance.recapTruncated ? (
            <p className="mb-3 rounded-lg border border-border px-3 py-2 text-sm text-text-muted">
              Earlier conversation was omitted to keep this recap bounded.
            </p>
          ) : null}
          {provenance.recap ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-sm text-text-secondary">
              {provenance.recap}
            </pre>
          ) : (
            <p className="text-sm text-text-muted">No earlier conversation was inherited.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function ForkProvenanceCard({ session }: { session: SessionMeta }) {
  const provenance = validProvenance(
    (session as SessionMeta & { forkProvenance?: unknown }).forkProvenance,
  );
  const sessions = useAppStore((state) => state.sessions);
  const [recapOpen, setRecapOpen] = useState(false);
  if (!provenance) return null;
  const source = sessions.find((candidate) => candidate.id === provenance.sourceSessionId);

  return (
    <>
      <section
        className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 shadow-card"
        aria-label="Fork origin"
        data-testid="fork-provenance-card"
      >
        <GitFork size={18} className="shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-text-primary">
            Forked from “{provenance.sourceTitle}”
          </p>
          <p className="text-xs text-text-muted">
            {source ? "Source chat is available." : "Source chat is no longer available."}
          </p>
        </div>
        {source ? (
          <ControlButton
            type="button"
            onClick={() => void switchToSession(source)}
            className="rounded-capsule border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open source
          </ControlButton>
        ) : null}
        <ControlButton
          type="button"
          onClick={() => setRecapOpen(true)}
          className="flex items-center gap-1 rounded-capsule border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Eye size={13} aria-hidden /> View recap
        </ControlButton>
      </section>
      {recapOpen ? (
        <RecapDialog provenance={provenance} onClose={() => setRecapOpen(false)} />
      ) : null}
    </>
  );
}
