import { useRef, useState } from "react";
import { CloudUpload } from "lucide-react";
import type { SessionMeta } from "@agent-deck/contracts";
import { Button } from "@/design-system/components/Button";
import { ControlButton, ControlTextArea } from "@/design-system/components/NativeControls";
import { openExternal, sharedServer, type SharedServerResponse } from "@/lib/native";
import { useFocusTrap } from "../lib/useFocusTrap.ts";
import { useAppStore } from "../state/store.ts";
import { useSharedSessionMirror } from "../state/useSharedSessionMirror.ts";
import { forkSession, switchToSession } from "../state/wsBridge.ts";

/**
 * SRV-12c1: move a session to the shared server its project is linked to. The
 * local backend prepares the export (a snapshot of the working tree pushed with
 * this device's git login, or the conversation only) and freezes the session
 * until the move finishes; Electron main sends it to the server; the local copy
 * then becomes a read-only pointer to the server copy.
 */

export const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** The forwarded prompt's text at most (the server and Electron main check it too). */
const MAX_PROMPT_CHARS = 32_000;

/**
 * The pointer's composer: the session continues on the server. SRV-12c2: it
 * follows the server session (useSharedSessionMirror) and forwards a text
 * prompt there; everything else stays refused on this copy.
 */
export function SharedSessionPanel({ session }: { session: SessionMeta }) {
  // One composer per pointer: text typed in one never shows in another, and an
  // earlier pointer's submission never clears this one's.
  return <PointerPanel key={session.id} session={session} />;
}

/** "Returns to this device's copy from <date>": the copy Unlink and Continue locally keep. */
const copyNote = (sharedAt: string): string => {
  const at = new Date(sharedAt);
  const when = Number.isNaN(at.getTime()) ? sharedAt : at.toLocaleString();
  return `Returns to this device's copy from ${when}; turns run on the server are not brought back.`;
};

function PointerPanel({ session }: { session: SessionMeta }) {
  const link = session.sharedTo!;
  const host = hostOf(link.serverOrigin);
  const { mirror, refresh, signIn, send } = useSharedSessionMirror(session);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const status = mirror?.status ?? "connecting";
  const owner = mirror?.server?.createdBy;
  const running = mirror?.server?.activity === "running";
  const waiting = mirror?.server?.activity === "needsInput";
  const ready = text.trim() !== "" && text.length <= MAX_PROMPT_CHARS;

  const submit = async (): Promise<void> => {
    if (!ready || sending || running || waiting) return;
    setSending(true);
    setError(null);
    try {
      const failure = await send(text);
      if (failure) setError(failure);
      else setText("");
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setSending(false);
    }
  };
  const unlink = async (): Promise<void> => {
    setError(null);
    try {
      const response = await post(
        `/sessions/${encodeURIComponent(session.id)}/shared-to`,
        { sharedTo: null },
        "PATCH",
      );
      const body = await json(response);
      if (!response.ok) return setError(String(body.error ?? "Unlink failed."));
      const next = body.session as SessionMeta;
      useAppStore.getState().upsertSessionMeta(next);
      // Open it again as an ordinary session: it resumes from its own Pi file.
      await switchToSession(next);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    }
  };

  const banner =
    status === "unreachable" ? (
      <>
        <span className="min-w-0 flex-1">Last local copy; {host} is unreachable.</span>
        <Button size="sm" variant="ghost" onClick={refresh}>
          Retry
        </Button>
      </>
    ) : status === "unavailable" ? (
      <span className="min-w-0 flex-1">Last local copy; this app cannot reach {host}.</span>
    ) : status === "signIn" ? (
      <>
        <span className="min-w-0 flex-1">Last local copy; sign in to follow it on {host}.</span>
        <Button size="sm" variant="ghost" onClick={() => void signIn()}>
          Sign in to {host}
        </Button>
      </>
    ) : status === "forbidden" ? (
      <span className="min-w-0 flex-1">
        Last local copy; {mirror?.error ?? `${host} refused this account.`}
      </span>
    ) : status === "gone" ? (
      <>
        <span className="min-w-0 flex-1">This session no longer exists on {host}.</span>
        <Button size="sm" variant="ghost" onClick={() => void unlink()}>
          Unlink
        </Button>
      </>
    ) : null;

  return (
    <div className="border-t border-border-subtle px-6 py-4" data-testid="shared-session-panel">
      {banner ? (
        <div
          className="mb-3 flex flex-wrap items-center gap-3 text-label text-text-secondary"
          role="status"
          data-testid="shared-mirror-banner"
        >
          {banner}
        </div>
      ) : null}
      {status === "live" ? (
        <form
          className="mb-3 flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label className="text-detail text-text-muted" htmlFor={`forward-${session.id}`}>
            Runs on {host}
            {owner ? ` as ${owner.name ?? owner.id}` : ""}
          </label>
          <ControlTextArea
            id={`forward-${session.id}`}
            className="min-h-16 w-full resize-y rounded-md border border-border-subtle bg-surface px-3 py-2 text-label"
            value={text}
            maxLength={MAX_PROMPT_CHARS}
            placeholder={
              running
                ? "Waiting for the reply on the server…"
                : waiting
                  ? `Answer the open question on ${host} first`
                  : "Message"
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void submit();
              }
            }}
          />
          <div className="flex items-center justify-end gap-3">
            {waiting ? (
              <span className="text-detail text-text-muted" data-testid="forward-needs-input">
                Answer on {host}: the server session is waiting for a reply.
              </span>
            ) : null}
            <Button size="sm" type="submit" disabled={!ready || sending || running || waiting}>
              Send
            </Button>
          </div>
        </form>
      ) : null}
      {error ? (
        <p className="mb-3 text-label text-danger" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-label text-text-secondary">This session continues on {host}.</p>
          {/* Unlink and Continue locally keep this device's copy, frozen at the move. */}
          <p className="text-detail text-text-muted" data-testid="pointer-copy-note">
            Unlink and Continue locally: {copyNote(link.sharedAt)}
          </p>
        </div>
        <Button
          size="sm"
          onClick={() =>
            void openExternal(
              `${link.serverOrigin}/?session=${encodeURIComponent(link.serverSessionId)}`,
            )
          }
        >
          Open on server
        </Button>
        <Button size="sm" variant="ghost" onClick={() => void forkSession(session.id)}>
          Continue locally
        </Button>
      </div>
    </div>
  );
}

interface SharePlan {
  branch: string;
  files: { tracked: number; untracked: string[] };
  localCommits?: number | null;
  dirtySubmodules?: string[];
}
interface Envelope {
  transfer: { mode: "snapshot"; ref: string } | { mode: "conversation" };
}
type Step =
  | { kind: "loading" }
  | { kind: "confirm"; plan: SharePlan; changed?: boolean }
  | { kind: "pushFailed"; text: string }
  | { kind: "signIn"; retry: () => Promise<void>; cancel: () => void }
  | { kind: "exportChanged"; text: string; cancel: () => void }
  | { kind: "working" }
  | { kind: "error"; text: string }
  | { kind: "done"; dropped: string[]; refLeft?: string };

/** Answers where the server may still finish the import: never abort on these. */
const MAYBE_IMPORTING = new Set([0, 502, 504, 524]);

async function json(response: Response): Promise<Record<string, unknown>> {
  return ((await response.json().catch(() => ({}))) ?? {}) as Record<string, unknown>;
}

const post = (url: string, body: unknown, method = "POST") =>
  fetch(url, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

/** Chat toolbar action: shown in the desktop app for a session of a shared project. */
export function ShareSessionButton() {
  const session = useAppStore((state) => state.session);
  const projects = useAppStore((state) => state.projects);
  const [step, setStep] = useState<Step | null>(null);
  const server = sharedServer();
  const link = projects.find((project) => project.id === session?.projectId)?.sharedTo;
  if (!server || !session || !link) return null;
  const eligible =
    !session.sharedTo &&
    Boolean(session.piSessionFile) &&
    !session.loopReviewRunId &&
    !session.agentName?.startsWith("Loop ·");
  // The dialog outlives the button: a finished move turns this session into a pointer.
  if (!eligible && !step) return null;
  const id = session.id;
  const host = hostOf(link.serverOrigin);
  const base = `/sessions/${encodeURIComponent(id)}`;
  // Every failed local request ends in a closable error, never a stuck dialog.
  const guarded = (run: () => Promise<void>) => async (): Promise<void> => {
    try {
      await run();
    } catch (error) {
      setStep({ kind: "error", text: error instanceof Error ? error.message : String(error) });
    }
  };

  const open = guarded(async () => {
    setStep({ kind: "loading" });
    const response = await post(`${base}/share/preflight`, {});
    const body = await json(response);
    if (!response.ok) return setStep({ kind: "error", text: String(body.error ?? "Not now.") });
    setStep({ kind: "confirm", plan: body.plan as SharePlan });
  });

  const send = async (envelope: Envelope, projectId: string, handoff: string): Promise<void> => {
    setStep({ kind: "working" });
    const ref = envelope.transfer.mode === "snapshot" ? envelope.transfer.ref : undefined;
    // Unfreeze the session and remove the pushed ref: the import did not take it.
    const abort = () => void post(`${base}/share/abort`, { ...(ref ? { ref } : {}), handoff });
    const answer = await server
      .request("POST", `/projects/${projectId}/sessions/import`, envelope)
      .catch((error: unknown): SharedServerResponse => ({ status: 0, error: String(error) }));
    if (answer.signInRequired) {
      return setStep({
        kind: "signIn",
        retry: guarded(async () => {
          const result = await server.signIn();
          if (!result.ok) {
            abort();
            return setStep({ kind: "error", text: result.error ?? "Sign-in failed." });
          }
          await send(envelope, projectId, handoff);
        }),
        cancel: () => {
          abort();
          setStep(null);
        },
      });
    }
    if (MAYBE_IMPORTING.has(answer.status)) {
      // The server may still be importing: keep everything; a retry links the copy.
      return setStep({
        kind: "error",
        text: `${host} did not confirm the move; it may still be importing. Try again in a minute: a retry links to the copy if it arrived.`,
      });
    }
    const reply = (answer.body ?? {}) as {
      sessionId?: unknown;
      pending?: unknown;
      code?: unknown;
      error?: unknown;
      dropped?: unknown;
      transferRefDeleted?: unknown;
    };
    if (answer.status === 409 && reply.code === "session_already_imported" && reply.pending) {
      // The first attempt is still running there: keep the move, retry later.
      return setStep({
        kind: "error",
        text: `${host} is still importing this session. Retry later: the retry links to the copy.`,
      });
    }
    if (answer.status === 409 && reply.code === "export_changed") {
      // The server's earlier copy is not this export: never link to it.
      return setStep({
        kind: "exportChanged",
        text: `${host} already has an earlier copy of this session that differs from this one, so this copy was not linked to it. Cancel this move; open the earlier copy on ${host} or continue here.`,
        cancel: () => {
          abort();
          setStep(null);
        },
      });
    }
    let serverSessionId: string | undefined;
    if (answer.status === 201 && typeof reply.sessionId === "string")
      serverSessionId = reply.sessionId;
    else if (
      answer.status === 409 &&
      reply.code === "session_already_imported" &&
      typeof reply.sessionId === "string"
    ) {
      // An earlier move got there; its link was not recorded. Point at that copy.
      serverSessionId = reply.sessionId;
    } else {
      abort();
      return setStep({
        kind: "error",
        text:
          (typeof reply.error === "string" ? reply.error : undefined) ??
          answer.error ??
          `The shared server answered ${answer.status || "nothing"}.`,
      });
    }
    const linked = await post(
      `${base}/shared-to`,
      { serverOrigin: link.serverOrigin, serverSessionId, mode: envelope.transfer.mode, handoff },
      "PATCH",
    );
    const linkedBody = await json(linked);
    if (!linked.ok) {
      return setStep({
        kind: "error",
        text: `The session is on ${host}, but this copy could not be linked: ${String(linkedBody.error ?? linked.status)}`,
      });
    }
    // The device pushed the ref, so the device removes it too (the server may lack the rights).
    let refLeft: string | undefined;
    if (ref) {
      const removed = await post(`${base}/share/abort`, { ref }).catch(() => null);
      if (!removed?.ok && reply.transferRefDeleted !== true) refLeft = ref;
    }
    const pointer = linkedBody.session as SessionMeta;
    useAppStore.getState().upsertSessionMeta(pointer);
    setStep({
      kind: "done",
      dropped: Array.isArray(reply.dropped) ? reply.dropped.map(String) : [],
      ...(refLeft ? { refLeft } : {}),
    });
    void switchToSession(pointer);
  };

  const move = (mode: "snapshot" | "conversation", plan?: SharePlan) =>
    guarded(async () => {
      if (server.origin !== link.serverOrigin) {
        return setStep({
          kind: "error",
          text: `This project is shared on ${host}, but the app is set up for ${hostOf(server.origin)}.`,
        });
      }
      setStep({ kind: "working" });
      const response = await post(`${base}/share`, {
        mode,
        ...(mode === "snapshot" ? { untracked: plan?.files.untracked ?? [] } : {}),
      });
      const body = await json(response);
      if (!response.ok) {
        if (body.code === "share_plan_changed" && plan && Array.isArray(body.untracked)) {
          // Consent covers what travels: show the new list and ask again.
          return setStep({
            kind: "confirm",
            changed: true,
            plan: { ...plan, files: { ...plan.files, untracked: body.untracked.map(String) } },
          });
        }
        return setStep(
          body.fallback === "conversation"
            ? { kind: "pushFailed", text: String(body.error) }
            : {
                kind: "error",
                text: String(body.error ?? `The move failed (${response.status}).`),
              },
        );
      }
      await send(body.envelope as Envelope, String(body.projectId), String(body.handoff));
    })();

  return (
    <>
      {eligible ? (
        <ControlButton
          type="button"
          className="rounded-md p-1.5 text-text-muted transition-colors hover:bg-hover"
          title={`Share to ${host}`}
          aria-label="Share to server"
          data-testid="share-session"
          onClick={() => void open()}
        >
          <CloudUpload className="h-4 w-4" />
        </ControlButton>
      ) : null}
      {step ? (
        <ShareDialog
          host={host}
          step={step}
          onMove={(mode) => void move(mode, step.kind === "confirm" ? step.plan : undefined)}
          onClose={() => {
            if (step.kind === "signIn" || step.kind === "exportChanged") step.cancel();
            else setStep(null);
          }}
        />
      ) : null}
    </>
  );
}

function ShareDialog({
  host,
  step,
  onMove,
  onClose,
}: {
  host: string;
  step: Step;
  onMove: (mode: "snapshot" | "conversation") => void;
  onClose: () => void;
}) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(true, closeRef);
  const busy = step.kind === "loading" || step.kind === "working";
  const submodules = step.kind === "confirm" ? (step.plan.dirtySubmodules ?? []) : [];
  // null: no upstream to compare with, which is not the same as none.
  const localCommits = step.kind === "confirm" ? step.plan.localCommits : 0;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-4 [-webkit-app-region:no-drag]">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="share-session-title"
        data-testid="share-session-dialog"
        className="flex max-h-[85vh] w-full max-w-lg flex-col gap-3 overflow-hidden rounded-xl border border-border-strong bg-surface-elevated p-4 shadow-elevated"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
        }}
      >
        <h2 id="share-session-title" className="font-medium text-text-primary">
          Share to {host}
        </h2>
        {busy ? <p className="text-label text-text-secondary">Working…</p> : null}
        {step.kind === "confirm" ? (
          <>
            {step.changed ? (
              <p className="text-label text-text-primary" role="alert">
                The untracked files changed since you looked. Check the list again.
              </p>
            ) : null}
            <p className="text-label text-text-secondary">
              The session moves to {host} with its conversation and the uncommitted work on branch{" "}
              {step.plan.branch} ({step.plan.files.tracked} changed tracked files). It continues
              there; this copy stays as a read-only link. Ignored files (for example .env) do not
              travel.
            </p>
            {localCommits === null ? (
              <p className="text-label text-text-secondary" data-testid="share-local-commits">
                This branch has no upstream: every commit on it that is not on the remote travels
                too.
              </p>
            ) : localCommits !== undefined && localCommits > 0 ? (
              <p className="text-label text-text-secondary" data-testid="share-local-commits">
                {localCommits} local {localCommits === 1 ? "commit travels" : "commits travel"} too
                (not on the remote yet).
              </p>
            ) : null}
            {step.plan.files.untracked.length > 0 ? (
              <div data-testid="share-untracked" className="flex min-h-0 flex-col">
                <p className="text-label text-text-primary">
                  These untracked files travel too. Check them for secrets:
                </p>
                <ul className="mt-1 max-h-60 list-disc overflow-y-auto pl-5 text-detail text-text-secondary">
                  {step.plan.files.untracked.map((name) => (
                    <li key={name}>{name}</li>
                  ))}
                </ul>
              </div>
            ) : null}
            {submodules.length > 0 ? (
              <p className="text-label text-text-secondary" data-testid="share-submodules">
                Submodules with their own changes cannot travel ({submodules.join(", ")}): move the
                conversation only, or commit inside them first.
              </p>
            ) : null}
            <div className="flex flex-wrap justify-end gap-2">
              <Button size="sm" variant="ghost" ref={closeRef} onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onMove("conversation")}>
                Conversation only
              </Button>
              <Button size="sm" disabled={submodules.length > 0} onClick={() => onMove("snapshot")}>
                Move with my changes
              </Button>
            </div>
          </>
        ) : null}
        {step.kind === "pushFailed" ? (
          <>
            <p className="text-label text-text-secondary" role="alert">
              {step.text}
            </p>
            <p className="text-label text-text-secondary">
              Move the conversation only? Your edits stay on this device and the server copy is told
              they are not in its workspace.
            </p>
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" ref={closeRef} onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={() => onMove("conversation")}>
                Move the conversation only
              </Button>
            </div>
          </>
        ) : null}
        {step.kind === "exportChanged" ? (
          <>
            <p className="text-label text-text-secondary" role="alert">
              {step.text}
            </p>
            <div className="flex justify-end">
              <Button size="sm" ref={closeRef} onClick={step.cancel}>
                Cancel the move
              </Button>
            </div>
          </>
        ) : null}
        {step.kind === "signIn" ? (
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" ref={closeRef} onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" onClick={() => void step.retry()}>
              Sign in to {host}
            </Button>
          </div>
        ) : null}
        {step.kind === "error" || step.kind === "done" ? (
          <>
            <p className="text-label text-text-secondary" role="status">
              {step.kind === "error"
                ? step.text
                : `The session continues on ${host}.${step.dropped.length ? ` Not carried: ${step.dropped.join(", ")}.` : ""}`}
            </p>
            {step.kind === "done" && step.refLeft ? (
              <p className="text-label text-text-secondary" role="alert">
                The transfer ref could not be removed: run git push origin --delete {step.refLeft}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button size="sm" ref={closeRef} onClick={onClose}>
                Close
              </Button>
            </div>
          </>
        ) : null}
      </div>
    </div>
  );
}
