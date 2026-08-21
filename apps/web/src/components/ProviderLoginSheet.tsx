import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, ExternalLink, Loader2, XCircle } from "lucide-react";
import { openExternal } from "../lib/native.ts";
import { useAppStore } from "../state/store.ts";

/**
 * Interactive provider OAuth login (native PiProviderLoginService). Starts a
 * login session on the server and polls it, rendering each relayed step — an
 * auth URL / device code to open, a text prompt or a choice to answer, progress
 * lines — until it finishes. Threads prompt/select answers back to the server.
 */
type LoginEvent =
  | { type: "auth_url"; url: string; instructions?: string }
  | { type: "device_code"; userCode: string; verificationUri: string; expiresInSeconds?: number }
  | { type: "prompt"; message: string; placeholder?: string; secret?: boolean }
  | { type: "select"; message: string; options: Array<{ id: string; label: string }> }
  | { type: "progress"; message: string }
  | { type: "done"; ok: boolean; error?: string };

type LoginStatus = "running" | "done" | "error";

const inputClass =
  "w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-label text-text-primary outline-none focus:border-accent";

export function ProviderLoginSheet({
  provider,
  onClose,
  onDone,
  authType,
}: {
  provider: { id: string; name: string };
  authType: "api_key" | "oauth";
  onClose: () => void;
  onDone: () => void;
}) {
  const pushToast = useAppStore((state) => state.pushToast);
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [status, setStatus] = useState<LoginStatus>("running");
  const [promptValue, setPromptValue] = useState("");
  const [fatal, setFatal] = useState<string | null>(null);
  const [showManualEntry, setShowManualEntry] = useState(false);
  const loginIdRef = useRef<string | null>(null);
  const cursorRef = useRef(0);
  const notifiedRef = useRef(false);
  const openedAuthUrlRef = useRef<string | null>(null);

  const poll = useCallback(async (): Promise<void> => {
    const loginId = loginIdRef.current;
    if (!loginId) return;
    const response = await fetch(`/runtime/providers/login/${loginId}?since=${cursorRef.current}`);
    if (!response.ok) return;
    const data = (await response.json()) as {
      events: LoginEvent[];
      status: LoginStatus;
      nextCursor: number;
    };
    cursorRef.current = data.nextCursor;
    if (data.events.length > 0) {
      setEvents((prev) => [...prev, ...data.events]);
      setPromptValue("");
    }
    setStatus(data.status);
  }, []);

  // Start the login on mount; cancel it if the sheet closes before it finishes.
  useEffect(() => {
    let closed = false;
    void (async () => {
      try {
        const response = await fetch(
          `/runtime/providers/${encodeURIComponent(provider.id)}/login`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ authType }),
          },
        );
        if (!response.ok) throw new Error(await response.text());
        const { loginId } = (await response.json()) as { loginId: string };
        if (closed) {
          void fetch(`/runtime/providers/login/${loginId}/cancel`, { method: "POST" });
          return;
        }
        loginIdRef.current = loginId;
        void poll();
      } catch (err) {
        setFatal(String(err));
        setStatus("error");
      }
    })();
    return () => {
      closed = true;
      const loginId = loginIdRef.current;
      if (loginId) void fetch(`/runtime/providers/login/${loginId}/cancel`, { method: "POST" });
    };
  }, [authType, provider.id, poll]);

  // Poll while the flow is running.
  useEffect(() => {
    if (status !== "running") return;
    const timer = setInterval(() => void poll(), 1000);
    return () => clearInterval(timer);
  }, [status, poll]);

  // Match native Agent Deck: launch browser auth as soon as Pi advertises it.
  // The ref prevents poll re-renders from opening duplicate tabs.
  useEffect(() => {
    const auth = events.findLast((event) => event.type === "auth_url");
    if (!auth || openedAuthUrlRef.current === auth.url) return;
    openedAuthUrlRef.current = auth.url;
    void openExternal(auth.url);
  }, [events]);

  // On success (once), toast + let the parent refresh its list. The sheet stays
  // open showing "Signed in" until the user closes it.
  useEffect(() => {
    const last = events.at(-1);
    if (last?.type === "done" && last.ok && !notifiedRef.current) {
      notifiedRef.current = true;
      pushToast({ kind: "success", message: `${provider.name} connected` });
      onDone();
    }
  }, [events, provider.name, pushToast, onDone]);

  const respond = async (value: string): Promise<void> => {
    const loginId = loginIdRef.current;
    if (!loginId) return;
    await fetch(`/runtime/providers/login/${loginId}/respond`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ value }),
    }).catch(() => {});
    void poll();
  };

  const last = events.at(-1);
  const awaitingPrompt = status === "running" && last?.type === "prompt" ? last : null;
  const awaitingSelect = status === "running" && last?.type === "select" ? last : null;
  const doneEvent = last?.type === "done" ? last : null;
  const hasBrowserAuth = events.some((event) => event.type === "auth_url");

  const promptFormId = "provider-login-prompt-form";
  const promptInputId = "provider-login-prompt-input";
  const visiblePrompt =
    awaitingPrompt && (!hasBrowserAuth || showManualEntry) ? awaitingPrompt : null;

  return (
    <div
      className="app-modal-backdrop fixed inset-0 z-40 flex items-center justify-center bg-overlay p-4 sm:p-8"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="app-modal-panel flex max-h-[calc(100vh-2rem)] w-full max-w-[460px] flex-col gap-3 overflow-y-auto rounded-2xl border border-border-strong bg-surface-elevated p-4 shadow-elevated sm:max-h-[85vh]"
        data-testid="provider-login-sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="provider-login-title"
      >
        <div
          id="provider-login-title"
          className="text-label font-semibold text-text-primary"
          style={{ fontStretch: "expanded" }}
        >
          {authType === "api_key" ? "Add an API key for" : "Sign in to"} {provider.name}
        </div>

        <div className="flex flex-col gap-2" data-testid="login-events">
          {events.map((event, index) => (
            <LoginStep key={index} event={event} />
          ))}
          {fatal ? (
            <div className="text-label" style={{ color: "var(--color-role-error)" }}>
              {fatal}
            </div>
          ) : null}
          {status === "running" && !awaitingPrompt && !awaitingSelect ? (
            <div className="flex items-center gap-2 text-detail text-text-muted">
              <Loader2 size={13} className="animate-spin" /> Waiting for the provider…
            </div>
          ) : null}
        </div>

        {visiblePrompt ? (
          <form
            id={promptFormId}
            className="flex flex-col gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void respond(promptValue);
            }}
          >
            <label htmlFor={promptInputId} className="text-caption font-medium text-text-secondary">
              {visiblePrompt.message}
            </label>
            <ControlInput
              id={promptInputId}
              autoFocus
              data-testid="login-prompt-input"
              className={inputClass}
              type={visiblePrompt.secret ? "password" : "text"}
              placeholder={visiblePrompt.placeholder}
              value={promptValue}
              onChange={(event) => setPromptValue(event.target.value)}
            />
          </form>
        ) : null}

        {awaitingSelect ? (
          <div className="flex flex-wrap gap-2" data-testid="login-select">
            {awaitingSelect.options.map((option) => (
              <ControlButton
                key={option.id}
                data-testid={`login-select-${option.id}`}
                className="rounded-capsule border border-border-strong px-3 py-1.5 text-label text-text-primary hover:border-accent"
                onClick={() => void respond(option.id)}
              >
                {option.label}
              </ControlButton>
            ))}
          </div>
        ) : null}

        <div
          className="flex flex-wrap items-center justify-between gap-2 pt-1"
          data-testid="provider-login-actions"
        >
          {awaitingPrompt && hasBrowserAuth && !showManualEntry ? (
            <ControlButton
              type="button"
              className="text-detail text-text-muted hover:text-text-primary"
              onClick={() => setShowManualEntry(true)}
            >
              Enter a code manually
            </ControlButton>
          ) : (
            <span />
          )}
          <div className="ml-auto flex items-center gap-2">
            <ControlButton
              type="button"
              className="rounded-capsule border border-border-strong px-4 py-1.5 text-label text-text-secondary hover:text-text-primary"
              onClick={onClose}
            >
              {doneEvent || fatal ? "Close" : "Cancel"}
            </ControlButton>
            {visiblePrompt ? (
              <ControlButton
                type="submit"
                form={promptFormId}
                data-testid="login-prompt-submit"
                className="rounded-capsule px-4 py-1.5 text-label font-medium shadow-capsule"
                style={{
                  background:
                    "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                  color: "var(--color-accent-foreground)",
                }}
              >
                Submit
              </ControlButton>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function LoginStep({ event }: { event: LoginEvent }) {
  switch (event.type) {
    case "auth_url":
      return (
        <div className="rounded-xl border border-border-subtle bg-surface px-4 py-3 text-label">
          <div className="font-medium text-text-primary">Continue in your browser</div>
          <div className="mt-1 text-detail leading-relaxed text-text-muted">
            Sign in securely with the provider, then return to Agent Deck.
          </div>
          <ControlButton
            className="mt-3 inline-flex items-center gap-1.5 rounded-capsule border border-border-strong px-3 py-1.5 text-detail font-medium text-text-primary hover:border-accent"
            data-testid="login-auth-url"
            onClick={() => void openExternal(event.url)}
          >
            <ExternalLink size={12} /> Open browser again
          </ControlButton>
          {event.instructions ? (
            <div className="mt-2 text-detail text-text-muted">{event.instructions}</div>
          ) : null}
        </div>
      );
    case "device_code":
      return (
        <div className="rounded-lg border border-border-subtle bg-surface px-3 py-2 text-label">
          <div className="text-text-muted">
            Go to{" "}
            <a
              href={event.verificationUri}
              target="_blank"
              rel="noreferrer"
              className="text-accent"
            >
              {event.verificationUri}
            </a>{" "}
            and enter:
          </div>
          <div
            className="mt-1 font-mono text-title tracking-widest text-text-primary"
            data-testid="login-device-code"
          >
            {event.userCode}
          </div>
        </div>
      );
    case "progress":
      return <div className="text-detail text-text-muted">{event.message}</div>;
    case "prompt":
      return null;
    case "select":
      return <div className="text-label text-text-primary">{event.message}</div>;
    case "done":
      return event.ok ? (
        <div
          className="flex items-center gap-2 text-label"
          style={{ color: "var(--color-success)" }}
          data-testid="login-done"
        >
          <CheckCircle2 size={15} /> Connected.
        </div>
      ) : (
        <div
          className="flex items-center gap-2 text-label"
          style={{ color: "var(--color-role-error)" }}
          data-testid="login-done"
        >
          <XCircle size={15} /> {event.error ?? "Login failed."}
        </div>
      );
  }
}
