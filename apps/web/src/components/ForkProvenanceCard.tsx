import { ControlButton } from "@/design-system/components/NativeControls";
import { Eye, GitFork, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ProvenanceFrom, SessionMeta, UserIdentity } from "@agent-deck/contracts";
import { lineage } from "@agent-deck/domain";
import { userDisplayName } from "@/lib/userIdentity";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useAppStore } from "../state/store.ts";
import { switchToSession } from "../state/wsBridge.ts";

type ForkSource = Extract<ProvenanceFrom, { sessionId: string }>;
type Recap = { text: string; truncated: boolean };

/** ADR 0006: the session a fork was made from, from its provenance (a future or
 * malformed record shows no origin rather than a wrong one). */
export function forkSourceOf(session: SessionMeta | undefined): ForkSource | undefined {
  const provenance = session?.provenance;
  if (!provenance || provenance.kind !== "forked") return undefined;
  const from = provenance.from as Partial<ForkSource> | undefined;
  return from && typeof from.sessionId === "string" && from.sessionId
    ? (from as ForkSource)
    : undefined;
}

/** The inherited-conversation recap of a fork made at a message. */
function messageForkRecap(session: SessionMeta, from: ForkSource): Recap | null {
  const recap = session.provenance?.recap as Partial<Recap> | undefined;
  return typeof from.entryId === "string" &&
    from.entryId &&
    typeof recap?.text === "string" &&
    typeof recap.truncated === "boolean"
    ? { text: recap.text, truncated: recap.truncated }
    : null;
}

/** SRV-15b: "Forked from Alice's session “Title”" (whose, when the server knows). */
export function forkOriginText(
  title: string | undefined,
  owner: UserIdentity | undefined,
  me: { id: string } | null,
): string {
  const quoted = `“${title?.trim() || "Untitled session"}”`;
  if (!owner) return `Forked from ${quoted}`;
  const whose = me?.id === owner.id ? "your" : `${userDisplayName(owner)}'s`;
  return `Forked from ${whose} session ${quoted}`;
}

function RecapDialog({
  title,
  recap,
  onClose,
}: {
  title: string | undefined;
  recap: Recap;
  onClose: () => void;
}) {
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
            <p className="text-caption text-text-muted">Forked from “{title ?? ""}”</p>
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
          {recap.truncated ? (
            <p className="mb-3 rounded-lg border border-border px-3 py-2 text-body text-text-muted">
              Earlier conversation was omitted to keep this recap bounded.
            </p>
          ) : null}
          {recap.text ? (
            <pre className="whitespace-pre-wrap break-words font-sans text-body text-text-secondary">
              {recap.text}
            </pre>
          ) : (
            <p className="text-body text-text-muted">No earlier conversation was inherited.</p>
          )}
        </div>
      </div>
    </div>
  );
}

export function ForkProvenanceCard({ session }: { session: SessionMeta }) {
  // ADR 0006: the source record, when this side holds it (lineage over provenance).
  const source = useAppStore(
    (state) =>
      lineage([...state.sessions.filter((item) => item.id !== session.id), session], session.id)
        .ancestors[0],
  );
  const me = useAppStore((state) => state.me);
  const [recapOpen, setRecapOpen] = useState(false);
  const from = forkSourceOf(session);
  const recap = from ? messageForkRecap(session, from) : null;
  if (!from || !recap) {
    // SRV-12c1: a session moved here from a member's device.
    const provenance = session.provenance;
    // Read defensively: a future or malformed origin shows nothing.
    const origin = (provenance?.kind === "imported" ? provenance.from : undefined) as
      | { device?: unknown }
      | null
      | undefined;
    const moved =
      typeof origin === "object" && origin !== null && typeof origin.device === "string"
        ? origin.device
        : undefined;
    if (!from && moved) {
      return (
        <section
          className="flex items-center gap-2 px-1 text-caption text-text-muted"
          aria-label="Session origin"
          data-testid="shared-from-line"
        >
          <span className="min-w-0 truncate">
            Moved from {moved}.
            {provenance?.mode === "conversation"
              ? ` Earlier edits from ${moved} are not in this workspace.`
              : ""}
          </span>
        </section>
      );
    }
    // SRV-15b: a plain fork (a full duplicate) has no recap, only its origin.
    if (!from) return null;
    return (
      <section
        className="flex items-center gap-2 px-1 text-caption text-text-muted"
        aria-label="Fork origin"
        data-testid="fork-origin-line"
      >
        <GitFork size={13} className="shrink-0 text-accent" aria-hidden />
        <span className="min-w-0 truncate">{forkOriginText(from.title, from.owner, me)}</span>
        {source ? (
          <ControlButton
            type="button"
            onClick={() => void switchToSession(source)}
            className="shrink-0 text-accent hover:underline focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open source
          </ControlButton>
        ) : null}
      </section>
    );
  }

  return (
    <>
      <section
        className="flex items-center gap-3 rounded-xl border border-border bg-surface px-3 py-2 shadow-card"
        aria-label="Fork origin"
        data-testid="fork-provenance-card"
      >
        <GitFork size={18} className="shrink-0 text-accent" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="truncate text-label font-medium text-text-primary">
            {forkOriginText(from.title, source?.createdBy, me)}
          </p>
          <p className="text-caption text-text-muted">
            {source ? "Source chat is available." : "Source chat is no longer available."}
          </p>
        </div>
        {source ? (
          <ControlButton
            type="button"
            onClick={() => void switchToSession(source)}
            className="rounded-capsule border border-border px-2.5 py-1 text-detail font-medium text-text-secondary hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
          >
            Open source
          </ControlButton>
        ) : null}
        <ControlButton
          type="button"
          onClick={() => setRecapOpen(true)}
          className="flex items-center gap-1 rounded-capsule border border-border px-2.5 py-1 text-detail font-medium text-text-secondary hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent"
        >
          <Eye size={13} aria-hidden /> View recap
        </ControlButton>
      </section>
      {recapOpen ? (
        <RecapDialog title={from.title} recap={recap} onClose={() => setRecapOpen(false)} />
      ) : null}
    </>
  );
}
