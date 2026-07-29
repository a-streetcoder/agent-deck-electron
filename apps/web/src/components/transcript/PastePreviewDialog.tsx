import { ControlButton } from "@/design-system/components/NativeControls";
import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import type { UserPasteRef } from "@agent-deck/domain";
import { useFocusTrap } from "../../lib/useFocusTrap.ts";

export function PastePreviewDialog({
  paste,
  onClose,
}: {
  paste: UserPasteRef;
  onClose: () => void;
}) {
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(true, closeButtonRef);

  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div
      ref={dialogRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-media-overlay-strong px-4 py-6"
      role="dialog"
      aria-modal="true"
      aria-label="Pasted text preview"
      data-testid="paste-preview-dialog"
    >
      <ControlButton
        type="button"
        tabIndex={-1}
        className="absolute inset-0 z-0"
        aria-label="Close pasted text preview"
        onClick={onClose}
      />
      <section className="relative z-10 flex max-h-[80vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface-elevated shadow-card">
        <header className="flex items-center justify-between gap-3 border-b border-border-subtle px-4 py-3">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Pasted text</h2>
            <p className="text-xs text-text-muted">{paste.marker}</p>
          </div>
          <ControlButton
            ref={closeButtonRef}
            type="button"
            className="rounded-lg p-1.5 text-text-muted hover:bg-hover hover:text-text-primary"
            aria-label="Close pasted text preview"
            onClick={onClose}
          >
            <X size={16} />
          </ControlButton>
        </header>
        <pre
          className="overflow-auto whitespace-pre-wrap break-words p-4 font-mono text-xs leading-relaxed text-text-secondary"
          tabIndex={0}
          data-testid="paste-preview-content"
        >
          {paste.text}
        </pre>
      </section>
    </div>
  );
}
