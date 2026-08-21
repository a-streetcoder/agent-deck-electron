import {
  ControlButton,
  ControlInput,
  ControlSelect,
} from "@/design-system/components/NativeControls";
import { SectionHero, SectionHeroButton } from "@/design-system/components/SectionHero";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  CheckCircle2,
  Copy,
  Pencil,
  Plus,
  TriangleAlert,
  Trash2,
  XCircle,
  SquareTerminal,
} from "lucide-react";
import { cn } from "@/lib/cn";
import { useAppStore } from "../state/store.ts";
import { ScopeChip } from "../components/ScopeChip.tsx";

/**
 * Runtime screens (native Runtime section): a read-only Environment inspector
 * (masked .env values) and a Doctor health probe. Both are diagnostic and
 * never expose secrets.
 */

interface EnvEntry {
  key: string;
  masked: string;
  scope: "global" | "project";
  overridden: boolean;
  source: string;
}

type EnvScope = "global" | "project";

export function EnvironmentScreen() {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const setError = useAppStore((state) => state.setError);
  const [entries, setEntries] = useState<EnvEntry[]>([]);
  const [editing, setEditing] = useState<{ scope: EnvScope; key: string } | null>(null);
  const [draftValue, setDraftValue] = useState("");
  const [adding, setAdding] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newScope, setNewScope] = useState<EnvScope>("global");

  const refresh = useCallback(async (): Promise<void> => {
    const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";
    const response = await fetch(`/runtime/env${query}`);
    if (response.ok) setEntries(((await response.json()) as { entries: EnvEntry[] }).entries);
  }, [currentProjectId]);

  useEffect(() => {
    void refresh();
  }, [refresh, resourcesVersion]);

  const writeVar = async (scope: EnvScope, key: string, value: string): Promise<void> => {
    const response = await fetch("/runtime/env", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: currentProjectId ?? undefined, scope, key, value }),
    });
    if (!response.ok) setError(await response.text());
    await refresh();
  };

  const deleteVar = async (scope: EnvScope, key: string): Promise<void> => {
    const response = await fetch("/runtime/env", {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId: currentProjectId ?? undefined, scope, key }),
    });
    if (!response.ok) setError(await response.text());
    await refresh();
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="environment-screen">
      <SectionHero
        imageSrc="/screen-art/screen-art-environment.jpg"
        title="Environment"
        actions={
          <SectionHeroButton
            data-testid="env-add"
            variant="primary"
            title="Add variable"
            onClick={() => {
              setAdding((v) => !v);
              setNewScope(currentProjectId ? "project" : "global");
            }}
          >
            <Plus size={14} />
          </SectionHeroButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="rounded-2xl border border-border-subtle bg-surface-elevated p-4">
          <p className="pb-3 text-xs text-text-muted">
            Variables from ~/.pi/agent/.env and this project's .pi/.env. Values are masked; editing
            replaces the whole value.
          </p>

          {adding ? (
            <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-border-strong bg-surface p-2">
              <ControlInput
                data-testid="env-new-key"
                className="min-w-[10ch] flex-1 rounded border border-border-strong bg-surface px-2 py-1 font-mono text-xs text-text-primary outline-none focus:border-accent"
                placeholder="KEY"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
              />
              <ControlInput
                data-testid="env-new-value"
                className="min-w-[12ch] flex-1 rounded border border-border-strong bg-surface px-2 py-1 font-mono text-xs text-text-primary outline-none focus:border-accent"
                placeholder="value"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
              />
              <ControlSelect
                data-testid="env-new-scope"
                className="rounded border border-border-strong bg-surface px-2 py-1 text-xs text-text-primary"
                value={newScope}
                onChange={(e) => setNewScope(e.target.value as EnvScope)}
              >
                <option value="global">global</option>
                {currentProjectId ? <option value="project">project</option> : null}
              </ControlSelect>
              <ControlButton
                data-testid="env-new-save"
                className="rounded-capsule px-3 py-1 text-xs font-medium shadow-capsule disabled:opacity-40"
                style={{
                  background:
                    "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                  color: "var(--color-accent-foreground)",
                }}
                disabled={!/^[A-Za-z_][A-Za-z0-9_]*$/.test(newKey)}
                onClick={() =>
                  void writeVar(newScope, newKey, newValue).then(() => {
                    setNewKey("");
                    setNewValue("");
                    setAdding(false);
                  })
                }
              >
                Add
              </ControlButton>
            </div>
          ) : null}

          <div className="space-y-1">
            {entries.map((entry) => {
              const isEditing = editing?.scope === entry.scope && editing.key === entry.key;
              return (
                <div
                  key={`${entry.scope}:${entry.key}`}
                  className={cn(
                    "flex items-center gap-3 rounded-lg border border-border-subtle bg-surface px-3 py-1.5",
                    entry.overridden && "opacity-55",
                  )}
                  data-testid="env-row"
                  data-env-key={entry.key}
                  data-env-scope={entry.scope}
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm text-text-primary">{entry.key}</div>
                    <div
                      className="truncate font-mono text-micro text-text-muted"
                      data-testid="env-source"
                      title={entry.source}
                    >
                      {entry.source}
                    </div>
                  </div>
                  {isEditing ? (
                    <ControlInput
                      autoFocus
                      data-testid={`env-edit-input-${entry.key}`}
                      className="w-40 rounded border border-border-strong bg-surface px-2 py-0.5 font-mono text-xs text-text-primary outline-none focus:border-accent"
                      placeholder="new value"
                      value={draftValue}
                      onChange={(e) => setDraftValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          void writeVar(entry.scope, entry.key, draftValue).then(() =>
                            setEditing(null),
                          );
                        }
                        if (e.key === "Escape") setEditing(null);
                      }}
                      onBlur={() => setEditing(null)}
                    />
                  ) : (
                    <span className="font-mono text-xs text-text-muted">
                      {entry.masked || "(empty)"}
                    </span>
                  )}
                  <ScopeChip scope={entry.scope} />
                  {entry.overridden ? (
                    <span className="text-micro text-text-muted">overridden</span>
                  ) : null}
                  <ControlButton
                    data-testid={`env-edit-${entry.key}`}
                    className="rounded p-1 text-text-muted hover:text-text-primary"
                    title="Set value"
                    onClick={() => {
                      setDraftValue("");
                      setEditing({ scope: entry.scope, key: entry.key });
                    }}
                  >
                    <Pencil size={12} />
                  </ControlButton>
                  <ControlButton
                    data-testid={`env-delete-${entry.key}`}
                    className="rounded p-1 text-text-muted hover:text-danger"
                    title="Delete"
                    onClick={() => {
                      if (confirm(`Delete environment key "${entry.key}"?`)) {
                        void deleteVar(entry.scope, entry.key);
                      }
                    }}
                  >
                    <Trash2 size={12} />
                  </ControlButton>
                </div>
              );
            })}
            {entries.length === 0 ? (
              <div className="py-6 text-center text-sm text-text-muted">
                No environment variables found.
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

interface HealthCheck {
  id: string;
  label: string;
  status: "ok" | "warn" | "error";
  detail: string;
  fixCommand?: string;
  /** Server-decided: the fix is runnable one-shot in a terminal (DOC-01). */
  runnableFix?: boolean;
}

/** DOC-01 (native openPiInstallInTerminal): run the fix in the user's own
 * terminal — the wire carries ONLY the check id; the server re-resolves its
 * own fixCommand constant and opens a one-shot script with a real TTY. */
function RunFixButton({ checkId, projectId }: { checkId: string; projectId?: string }) {
  const [state, setState] = useState<"idle" | "busy" | "opened" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const run = (): void => {
    setState("busy");
    void fetch("/runtime/doctor/fix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ checkId, projectId }),
    })
      .then((response) => {
        setState(response.ok ? "opened" : "failed");
      })
      .catch(() => setState("failed"))
      .finally(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 2000);
      });
  };

  return (
    <ControlButton
      data-testid="doctor-fix-run"
      title="Run this fix in your terminal"
      className="flex shrink-0 items-center gap-1 rounded-capsule border border-border-strong px-2 py-0.5 font-mono text-micro text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
      disabled={state === "busy"}
      onClick={run}
    >
      <SquareTerminal size={11} />
      {state === "opened" ? "Opened" : state === "failed" ? "Failed" : "Run fix"}
    </ControlButton>
  );
}

/** DOC-02 (native openPiSelfUpdateInTerminal): update pi in the user's own
 * terminal — no data crosses the wire; the server resolves its own binary. */
function UpdatePiButton() {
  const [state, setState] = useState<"idle" | "busy" | "opened" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const run = (): void => {
    setState("busy");
    void fetch("/runtime/doctor/update-pi", { method: "POST" })
      .then((response) => {
        setState(response.ok ? "opened" : "failed");
      })
      .catch(() => setState("failed"))
      .finally(() => {
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setState("idle"), 2000);
      });
  };

  return (
    <ControlButton
      data-testid="doctor-update-pi"
      title="Update pi in your terminal (pi update pi)"
      className="flex shrink-0 items-center gap-1 rounded-capsule border border-border-strong px-2 py-0.5 font-mono text-micro text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
      disabled={state === "busy"}
      onClick={run}
    >
      <SquareTerminal size={11} />
      {state === "opened" ? "Opened" : state === "failed" ? "Failed" : "Update pi"}
    </ControlButton>
  );
}

/** Copy a check's suggested fix command; flips to "Copied" briefly (native Doctor Fix). */
function CopyFixButton({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Clear a pending flip-back if the button unmounts (Doctor navigated away / refreshed).
  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const copy = (): void => {
    let promise: Promise<void> | undefined;
    try {
      promise = navigator.clipboard?.writeText(command);
    } catch {
      // A present-but-throwing clipboard implementation — treat as unavailable.
      return;
    }
    void promise?.then(
      () => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  return (
    <ControlButton
      data-testid="doctor-fix-copy"
      data-fix-command={command}
      title={`Copy: ${command}`}
      className="flex shrink-0 items-center gap-1 rounded-capsule border border-border-strong px-2 py-0.5 font-mono text-micro text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
      onClick={copy}
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? "Copied" : "Copy fix"}
    </ControlButton>
  );
}

const STATUS_ICON = {
  ok: { Icon: CheckCircle2, color: "var(--color-success)", label: "OK" },
  warn: { Icon: TriangleAlert, color: "var(--color-warning)", label: "Warning" },
  error: { Icon: XCircle, color: "var(--color-role-error)", label: "Error" },
} as const;

export function DoctorScreen() {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  // DOC-05: aggregated configuration warnings, shown together so a problem
  // is discoverable without opening the resource that owns it.
  const [warnings, setWarnings] = useState<Array<{ id: string; message: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const activeRequest = useRef<{ id: number; controller: AbortController } | null>(null);
  const nextRequestId = useRef(0);
  const refreshButton = useRef<HTMLButtonElement | null>(null);

  const cancelActiveRequest = useCallback((): void => {
    const active = activeRequest.current;
    if (!active) return;
    // Clear first so refresh/unmount can never abort this controller twice.
    activeRequest.current = null;
    active.controller.abort();
  }, []);

  const refresh = useCallback(
    (restoreFocus = false): void => {
      cancelActiveRequest();
      const controller = new AbortController();
      const id = ++nextRequestId.current;
      let succeeded = false;
      activeRequest.current = { id, controller };
      setLoading(true);
      setLoadError(null);
      const query = currentProjectId ? `?projectId=${encodeURIComponent(currentProjectId)}` : "";

      void fetch(`/runtime/doctor${query}`, { signal: controller.signal })
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Doctor diagnostics could not be loaded (HTTP ${response.status}).`);
          }
          const data: unknown = await response.json();
          const report =
            typeof data === "object" && data !== null
              ? (data as { report?: { checks?: unknown } }).report
              : undefined;
          if (!report || !Array.isArray(report.checks)) {
            throw new Error("Doctor diagnostics returned an unexpected response.");
          }
          // Absent or malformed warnings must not fail the page: an older
          // server, or one whose resource scan threw, still has useful checks.
          const rawWarnings = (data as { warnings?: unknown }).warnings;
          const parsedWarnings = Array.isArray(rawWarnings)
            ? rawWarnings.filter(
                (entry): entry is { id: string; message: string } =>
                  typeof entry === "object" &&
                  entry !== null &&
                  typeof (entry as { id?: unknown }).id === "string" &&
                  typeof (entry as { message?: unknown }).message === "string",
              )
            : [];
          if (activeRequest.current?.id === id) {
            succeeded = true;
            setChecks(report.checks as HealthCheck[]);
            setWarnings(parsedWarnings);
          }
        })
        .catch((error: unknown) => {
          if (controller.signal.aborted || activeRequest.current?.id !== id) return;
          setLoadError(
            error instanceof Error
              ? error.message
              : "Doctor diagnostics could not be loaded. Please try again.",
          );
        })
        .finally(() => {
          if (activeRequest.current?.id !== id) return;
          activeRequest.current = null;
          setLoading(false);
          if (restoreFocus && succeeded) {
            requestAnimationFrame(() => {
              // A newer request or unmount must not let this settled retry steal focus.
              if (nextRequestId.current === id && activeRequest.current === null) {
                refreshButton.current?.focus();
              }
            });
          }
        });
    },
    [cancelActiveRequest, currentProjectId],
  );

  useEffect(() => {
    refresh();
    return cancelActiveRequest;
  }, [cancelActiveRequest, refresh]);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="doctor-screen">
      <SectionHero
        imageSrc="/screen-art/screen-art-doctor.jpg"
        title="Doctor"
        subtitle="Environment health for the pi runtime this app drives."
        actions={
          <SectionHeroButton
            ref={refreshButton}
            type="button"
            data-testid="doctor-refresh"
            variant="ghost"
            disabled={loading}
            onClick={() => refresh()}
          >
            {loading ? "Checking…" : "Re-check"}
          </SectionHeroButton>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div
          className="rounded-2xl border border-border-subtle bg-surface-elevated p-4"
          aria-busy={loading}
        >
          <div className="sr-only" role="status" aria-live="polite" data-testid="doctor-status">
            {loading
              ? "Checking diagnostics…"
              : loadError
                ? "Diagnostics refresh failed."
                : "Diagnostics up to date."}
          </div>
          {loadError ? (
            <div
              className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-danger/40 bg-surface px-3 py-2 text-sm text-text-primary"
              role="alert"
              data-testid="doctor-error"
            >
              <span>{loadError}</span>
              <ControlButton
                type="button"
                className="shrink-0 rounded-capsule border border-border-strong px-3 py-1 text-xs text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface"
                onClick={() => refresh(true)}
              >
                Retry
              </ControlButton>
            </div>
          ) : null}
          <div className="space-y-2">
            {checks.map((check) => {
              const { Icon, color, label } = STATUS_ICON[check.status];
              return (
                <div
                  key={check.id}
                  className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface px-3 py-2.5"
                  data-testid="doctor-check"
                  data-check-id={check.id}
                  data-check-status={check.status}
                >
                  <Icon
                    aria-hidden="true"
                    size={16}
                    style={{ color }}
                    className="mt-0.5 shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <div className="text-sm font-medium text-text-primary">{check.label}</div>
                      <span className="text-micro font-medium uppercase text-text-secondary">
                        {label}
                      </span>
                    </div>
                    <div className="break-words font-mono text-xs text-text-muted">
                      {check.detail}
                    </div>
                  </div>
                  {check.id === "pi-version" ? <UpdatePiButton /> : null}
                  {check.fixCommand ? (
                    <div className="flex shrink-0 items-center gap-1">
                      {check.runnableFix ? (
                        <RunFixButton
                          checkId={check.id}
                          projectId={currentProjectId ?? undefined}
                        />
                      ) : null}
                      <CopyFixButton command={check.fixCommand} />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
          {/* Hidden entirely when clean, as native's card is — an empty
            "no problems" panel is noise on a page read for problems. */}
          {warnings.length > 0 ? (
            <section
              className="mt-4 border-t border-border-subtle pt-3"
              data-testid="doctor-warnings"
              aria-labelledby="doctor-warnings-heading"
            >
              <h3
                id="doctor-warnings-heading"
                className="pb-2 text-sm font-semibold text-text-primary"
              >
                Warnings
              </h3>
              <div className="space-y-2">
                {warnings.map((warning) => (
                  <div
                    key={warning.id}
                    data-testid="doctor-warning"
                    className="flex items-start gap-3 rounded-lg border border-border-subtle bg-surface px-3 py-2.5"
                  >
                    <TriangleAlert
                      aria-hidden="true"
                      size={16}
                      className="mt-0.5 shrink-0 text-warning"
                    />
                    <div className="min-w-0 flex-1 break-words text-xs text-text-secondary">
                      {warning.message}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  );
}
