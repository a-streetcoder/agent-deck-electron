import {
  ControlButton,
  ControlInput,
  ControlTextArea,
  ControlSelect,
} from "@/design-system/components/NativeControls";
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Archive, Brain, Pin, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import type { SemanticRecallStatus } from "@agent-deck/contracts";
import { groupMemoriesByStatus, type MemoryStatus } from "@agent-deck/domain";
import { cn } from "@/lib/cn";
import { useAppStore } from "../state/store.ts";

/**
 * Memory screen (native Memory sidebar): browse and manage a project's stored
 * memories — the visible half of the memory subsystem. Agents write memories
 * during sessions via the bridge tools; here you inspect, pin, retire (stale),
 * archive, edit, delete, and manually add them. Project-scoped: no project, no
 * memory.
 */

/** Native's detail rows read abbreviated date + short time
 * (AgentMemoryViews.swift:464-465). A record written before the routes reported
 * a field — or an unparseable one — shows a dash rather than "Invalid Date". */
function formatMemoryTime(iso: string | undefined): string {
  if (!iso) return "—";
  const at = new Date(iso);
  return Number.isNaN(at.getTime())
    ? "—"
    : at.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** The read-only half of a record, lifted onto a draft in one place so the two
 * paths that open an existing memory (the list and memory navigation) cannot
 * disagree about what the detail rows show. */
function recordMetadata(
  memory: MemoryItem,
): Pick<Draft, "createdAt" | "updatedAt" | "scope" | "filePath" | "sourceAgentName"> {
  return {
    createdAt: memory.createdAt,
    updatedAt: memory.updatedAt,
    scope: memory.scope,
    filePath: memory.filePath,
    sourceAgentName: memory.sourceAgentName,
  };
}

const MEMORY_TYPES = ["context", "decision", "runbook", "failure", "preference"] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

interface MemoryItem {
  id: string;
  type: MemoryType;
  status: MemoryStatus;
  title: string;
  summary: string;
  body: string;
  tags: string[];
  createdAt?: string;
  updatedAt: string;
  /** Only project scope exists today (memory/types.ts), but the record carries
   * it, so the detail row reports what the server said rather than a guess. */
  scope?: string;
  /** Where the memory lives on disk; derived by the routes, not stored. */
  filePath?: string;
  /** The delegated agent that authored it, when a child run did (MEM-11). */
  sourceAgentName?: string;
}

interface Draft {
  id?: string; // set when editing
  type: MemoryType;
  title: string;
  summary: string;
  body: string;
  projectId: string;
  /** Comma-separated tag text, native's own editor shape (MEM-12): the raw
   * string is what the user types, parsed only on save. */
  tags: string;
  /** What the field held when the editor opened. Tags are sent ONLY when this
   * differs, so an untouched field cannot overwrite what changed underneath it
   * (an agent may retag while the editor is open) and cannot re-split a tag
   * that contains a comma, which this flat representation cannot express
   * (Codex). An untouched save omits tags and the store preserves them. */
  tagsInitial: string;
  /** Read-only record metadata, shown as native's detail rows (MEM-13). Carried
   * on the draft rather than in a second state so it cannot drift from the
   * record being edited: every draft constructor sets it in one go. */
  createdAt?: string;
  updatedAt?: string;
  scope?: string;
  filePath?: string;
  /** Read-only provenance shown while editing (MEM-11): native surfaces a
   * "Source" row in the memory detail, and it is set once at creation, so the
   * editor displays it rather than offering it as a field. */
  sourceAgentName?: string;
}

const memoryMissingMessage = (titleSnapshot: string): string =>
  `Memory “${titleSnapshot}” no longer exists`;
const MEMORY_OPEN_FAILED_MESSAGE = "Couldn’t open memory. Try again.";

const STATUS_STYLE: Record<MemoryStatus, string> = {
  active: "border-border-subtle text-text-muted",
  pinned: "border-accent text-accent",
  stale: "border-warning text-warning",
  archived: "border-border-subtle text-text-muted opacity-70",
};

type SemanticPreferenceState = "loading" | "ready" | "error";

function AgentMemoryPreference() {
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const [enabled, setEnabled] = useState(true);
  const [budget, setBudget] = useState("6000");
  const [subagentsEnabled, setSubagentsEnabled] = useState(true);
  const [capabilityAvailable, setCapabilityAvailable] = useState(true);
  const [state, setState] = useState<SemanticPreferenceState>("loading");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const saveSeq = useRef(0);
  const savedBudget = useRef(6000);
  const loaded = useRef(false);
  const saveInFlight = useRef(false);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    const seq = ++loadSeq.current;
    if (!loaded.current) {
      setState("loading");
      setMessage(null);
    } else if (!saveInFlight.current) {
      setMessage(null);
    }
    try {
      const response = await fetch("/settings", { signal });
      if (!response.ok) throw new Error("We couldn’t load the memory automation preference.");
      const data = (await response.json()) as {
        settings: {
          agentMemoryEnabled?: boolean;
          agentMemoryInjectionCharacterBudget?: number;
          agentMemorySubagentsEnabled?: boolean;
        };
        capabilities?: { agentMemory?: boolean };
      };
      if (seq !== loadSeq.current || signal?.aborted) return;
      setEnabled(data.settings.agentMemoryEnabled !== false);
      const loadedBudget = data.settings.agentMemoryInjectionCharacterBudget ?? 6000;
      savedBudget.current = loadedBudget;
      setBudget(String(loadedBudget));
      setSubagentsEnabled(data.settings.agentMemorySubagentsEnabled !== false);
      setCapabilityAvailable(data.capabilities?.agentMemory !== false);
      loaded.current = true;
      setState("ready");
    } catch (cause) {
      if (seq !== loadSeq.current || signal?.aborted) return;
      const error = cause instanceof Error ? cause.message : String(cause);
      if (!loaded.current) setState("error");
      setMessage(error);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      loadSeq.current += 1;
      controller.abort();
    };
  }, [load, resourcesVersion]);

  useEffect(
    () => () => {
      saveSeq.current += 1;
    },
    [],
  );

  const toggle = async (): Promise<void> => {
    if (state !== "ready" || saving || !capabilityAvailable) return;
    const previous = enabled;
    const next = !previous;
    // A pre-save GET must not roll back the optimistic state. Resource-change
    // reloads use their own sequence and may safely run during this save.
    loadSeq.current += 1;
    const seq = ++saveSeq.current;
    saveInFlight.current = true;
    setEnabled(next);
    setSaving(true);
    setMessage("Saving…");
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentMemoryEnabled: next }),
      });
      if (!response.ok) throw new Error("We couldn’t save the memory automation preference.");
      const data = (await response.json()) as {
        settings: { agentMemoryEnabled: boolean };
        capabilities?: { agentMemory?: boolean };
      };
      if (seq !== saveSeq.current) return;
      setEnabled(data.settings.agentMemoryEnabled);
      setCapabilityAvailable(data.capabilities?.agentMemory !== false);
      setMessage("Saved");
    } catch (cause) {
      if (seq !== saveSeq.current) return;
      setEnabled(previous);
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === saveSeq.current) {
        saveInFlight.current = false;
        setSaving(false);
      }
    }
  };

  const toggleSubagents = async (): Promise<void> => {
    if (state !== "ready" || saving || !capabilityAvailable || !enabled) return;
    const previous = subagentsEnabled;
    const next = !previous;
    loadSeq.current += 1;
    const seq = ++saveSeq.current;
    saveInFlight.current = true;
    setSubagentsEnabled(next);
    setSaving(true);
    setMessage("Saving…");
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentMemorySubagentsEnabled: next }),
      });
      if (!response.ok) throw new Error("We couldn’t save the delegated-agent preference.");
      const data = (await response.json()) as {
        settings: { agentMemorySubagentsEnabled: boolean };
      };
      if (seq !== saveSeq.current) return;
      setSubagentsEnabled(data.settings.agentMemorySubagentsEnabled);
      setMessage("Saved");
    } catch (cause) {
      if (seq !== saveSeq.current) return;
      setSubagentsEnabled(previous);
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === saveSeq.current) {
        saveInFlight.current = false;
        setSaving(false);
      }
    }
  };

  const saveBudget = async (raw: string): Promise<void> => {
    if (state !== "ready" || saving) return;
    const next = Number(raw);
    if (!raw.trim() || !Number.isInteger(next) || next < 1000 || next > 20000) {
      setBudget(String(savedBudget.current));
      setMessage("Enter a whole-number memory context limit from 1,000 to 20,000.");
      return;
    }
    const previous = savedBudget.current;
    loadSeq.current += 1;
    const seq = ++saveSeq.current;
    saveInFlight.current = true;
    setBudget(String(next));
    setSaving(true);
    setMessage("Saving…");
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentMemoryInjectionCharacterBudget: next }),
      });
      if (!response.ok) throw new Error("We couldn’t save the memory context limit.");
      const data = (await response.json()) as {
        settings: { agentMemoryInjectionCharacterBudget: number };
      };
      if (seq !== saveSeq.current) return;
      savedBudget.current = data.settings.agentMemoryInjectionCharacterBudget;
      setBudget(String(data.settings.agentMemoryInjectionCharacterBudget));
      setMessage("Saved");
    } catch (cause) {
      if (seq !== saveSeq.current) return;
      setBudget(String(previous));
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === saveSeq.current) {
        saveInFlight.current = false;
        setSaving(false);
      }
    }
  };

  return (
    <div
      className="mb-4 rounded-xl border border-border-subtle bg-surface-elevated p-3"
      data-testid="agent-memory-preference"
    >
      {state === "loading" ? (
        <p className="text-sm text-text-muted" role="status">
          Loading memory automation preference…
        </p>
      ) : state === "error" ? (
        <div>
          <p className="text-sm text-danger" role="alert">
            {message}
          </p>
          <ControlButton
            className="mt-2 flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs text-text-primary"
            onClick={() => void load()}
          >
            <RefreshCw size={13} aria-hidden="true" /> Retry memory automation
          </ControlButton>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                Memory automation
                <span
                  className="rounded-capsule border border-border-subtle px-1.5 text-micro uppercase tracking-wider text-text-muted"
                  data-testid="agent-memory-state"
                >
                  {capabilityAvailable ? (enabled ? "On" : "Paused") : "Unavailable"}
                </span>
              </div>
              <p id="agent-memory-description" className="mt-1 text-xs text-text-muted">
                {capabilityAvailable
                  ? "Across all projects, pausing stops automatic recall and agent memory tools. Stored memories remain available."
                  : "Memory automation is unavailable because it is disabled by this server’s configuration."}
              </p>
            </div>
            <ControlButton
              role="switch"
              aria-label="Memory automation"
              aria-describedby="agent-memory-description"
              aria-checked={capabilityAvailable && enabled}
              data-testid="agent-memory-toggle"
              disabled={saving || !capabilityAvailable}
              onClick={() => void toggle()}
              className={cn(
                "relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                capabilityAvailable && enabled
                  ? "border-accent bg-accent"
                  : "border-border-strong bg-surface-muted",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                  capabilityAvailable && enabled ? "translate-x-5" : "translate-x-0.5",
                )}
              />
            </ControlButton>
          </div>
          <div className="mt-3 grid gap-3 border-t border-border-subtle pt-3 sm:grid-cols-2">
            <label className="text-xs text-text-muted" htmlFor="agent-memory-budget">
              Memory context limit (characters)
              <ControlInput
                id="agent-memory-budget"
                data-testid="agent-memory-budget"
                type="number"
                min={1000}
                max={20000}
                step={500}
                value={budget}
                disabled={saving}
                aria-describedby="agent-memory-budget-help"
                aria-invalid={
                  Boolean(budget.trim()) &&
                  (!Number.isInteger(Number(budget)) ||
                    Number(budget) < 1000 ||
                    Number(budget) > 20000)
                }
                onChange={(event) => setBudget(event.target.value)}
                onBlur={(event) => void saveBudget(event.target.value)}
                className="mt-1 w-full rounded-lg border border-border-strong bg-surface px-2 py-1 text-sm text-text-primary"
              />
              <span id="agent-memory-budget-help" className="mt-1 block text-micro">
                Whole-number grapheme limit from 1,000 to 20,000.
              </span>
            </label>
            <div>
              <div className="flex items-center justify-between gap-2 text-xs text-text-muted">
                <span id="agent-memory-subagents-description">
                  Control automatic child policy, index, and task recall. Child memory tools
                  separately follow the master Memory automation switch.
                </span>
                <ControlButton
                  role="switch"
                  aria-label="Delegated agent memory context"
                  aria-describedby="agent-memory-subagents-description"
                  aria-checked={capabilityAvailable && enabled && subagentsEnabled}
                  data-testid="agent-memory-subagents-toggle"
                  disabled={saving || !capabilityAvailable || !enabled}
                  onClick={() => void toggleSubagents()}
                  className={cn(
                    "relative h-6 w-11 shrink-0 rounded-full border",
                    capabilityAvailable && enabled && subagentsEnabled
                      ? "border-accent bg-accent"
                      : "border-border-strong bg-surface-muted",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow",
                      capabilityAvailable && enabled && subagentsEnabled
                        ? "translate-x-5"
                        : "translate-x-0.5",
                    )}
                  />
                </ControlButton>
              </div>
              <p
                className="mt-1 text-micro text-text-muted"
                data-testid="agent-memory-subagents-state"
              >
                {!capabilityAvailable
                  ? "Inactive: memory capability unavailable."
                  : !enabled
                    ? "Inactive while memory automation is paused; your choice is retained."
                    : subagentsEnabled
                      ? "Automatic context is active for the next fresh or continued named managed child launch."
                      : "Automatic context is off; child memory tools remain available while Memory automation is on."}
              </p>
            </div>
          </div>
          {message ? (
            <p
              className={cn(
                "mt-2 text-xs",
                message === "Saving…" || message === "Saved" ? "text-text-muted" : "text-danger",
              )}
              role={message === "Saving…" || message === "Saved" ? "status" : "alert"}
              data-testid="agent-memory-save-status"
            >
              {message}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function SemanticMemoryPreference({
  onChanged,
  recall,
  setRecall,
}: {
  onChanged: () => void;
  recall: SemanticRecallStatus | null;
  setRecall: (status: SemanticRecallStatus) => void;
}) {
  const [enabled, setEnabled] = useState(false);
  const [state, setState] = useState<SemanticPreferenceState>("loading");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const checkSeq = useRef(0);
  const toggleSeq = useRef(0);
  const authoritativeRecall = useRef<SemanticRecallStatus | null>(null);

  const load = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const seq = ++loadSeq.current;
      setState("loading");
      setMessage(null);
      try {
        const [settingsResponse, statusResponse] = await Promise.all([
          fetch("/settings", { signal }),
          fetch("/memory/semantic-status", { signal }),
        ]);
        if (!settingsResponse.ok || !statusResponse.ok) {
          throw new Error("We couldn’t load semantic memory status.");
        }
        const settingsData = (await settingsResponse.json()) as {
          settings: { semanticMemoryEnabled: boolean };
        };
        const statusData = (await statusResponse.json()) as { recall: SemanticRecallStatus };
        if (seq !== loadSeq.current || signal?.aborted) return;
        setEnabled(settingsData.settings.semanticMemoryEnabled);
        authoritativeRecall.current = statusData.recall;
        setRecall(statusData.recall);
        setState("ready");
      } catch (cause) {
        if (seq !== loadSeq.current || signal?.aborted) return;
        setState("error");
        setMessage(cause instanceof Error ? cause.message : String(cause));
      }
    },
    [setRecall],
  );

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => {
      loadSeq.current += 1;
      checkSeq.current += 1;
      toggleSeq.current += 1;
      controller.abort();
    };
  }, [load]);

  useEffect(() => {
    if (recall && recall.readiness !== "checking") authoritativeRecall.current = recall;
  }, [recall]);

  const toggle = async (): Promise<void> => {
    if (state !== "ready" || saving) return;
    const previous = enabled;
    const next = !previous;
    const seq = ++toggleSeq.current;
    const recallBeforeToggle = authoritativeRecall.current;
    checkSeq.current += 1;
    setEnabled(next);
    setSaving(true);
    setMessage("Saving…");
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ semanticMemoryEnabled: next }),
      });
      if (!response.ok) throw new Error("We couldn’t save the semantic memory preference.");
      const data = (await response.json()) as {
        settings: { semanticMemoryEnabled: boolean };
      };
      if (seq !== toggleSeq.current) return;
      setEnabled(data.settings.semanticMemoryEnabled);
      const statusResponse = await fetch("/memory/semantic-status");
      if (seq !== toggleSeq.current) return;
      if (statusResponse.ok) {
        const statusData = (await statusResponse.json()) as { recall: SemanticRecallStatus };
        authoritativeRecall.current = statusData.recall;
        setRecall(statusData.recall);
      }
      setMessage("Saved");
      onChanged();
    } catch (cause) {
      if (seq !== toggleSeq.current) return;
      setEnabled(previous);
      let recoveredRecall = recallBeforeToggle;
      try {
        const statusResponse = await fetch("/memory/semantic-status");
        if (statusResponse.ok) {
          const statusData = (await statusResponse.json()) as { recall: SemanticRecallStatus };
          recoveredRecall = statusData.recall;
        }
      } catch {
        // The last authoritative snapshot is safer than retaining the
        // optimistic checking state after the preference mutation failed.
      }
      if (seq !== toggleSeq.current) return;
      if (recoveredRecall) {
        authoritativeRecall.current = recoveredRecall;
        setRecall(recoveredRecall);
      }
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (seq === toggleSeq.current) setSaving(false);
    }
  };

  const runtimeFailure =
    recall?.reason === "embedding_failed" || recall?.reason === "invalid_embedding";
  const canCheck =
    recall?.readiness === "not_checked" ||
    recall?.readiness === "checking" ||
    recall?.readiness === "unavailable" ||
    recall?.reason === "initialization_failed";

  const check = async (): Promise<void> => {
    if (!enabled || !recall || !canCheck || recall.readiness === "checking") return;
    const seq = ++checkSeq.current;
    const previousRecall = recall;
    authoritativeRecall.current = previousRecall;
    setMessage(null);
    setRecall({
      readiness: "checking",
      mode: "lexical",
      reason: null,
      message:
        "Checking semantic ranking readiness. Recall remains available with lexical ranking.",
    });
    try {
      const response = await fetch("/memory/semantic-status/check", { method: "POST" });
      if (!response.ok) throw new Error("We couldn’t check semantic ranking readiness.");
      const data = (await response.json()) as { recall: SemanticRecallStatus };
      if (seq !== checkSeq.current) return;
      authoritativeRecall.current = data.recall;
      setRecall(data.recall);
    } catch (cause) {
      if (seq !== checkSeq.current) return;
      setRecall(previousRecall);
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const readinessLabel =
    recall?.readiness === "ready"
      ? "Ready · Semantic"
      : recall?.readiness === "unavailable"
        ? "Unavailable · Lexical fallback"
        : recall?.readiness === "error"
          ? "Error · Lexical fallback"
          : recall?.readiness === "checking"
            ? "Checking"
            : recall?.readiness === "not_checked"
              ? "Not checked · Lexical"
              : "Not requested · Lexical";

  return (
    <div
      className="mb-4 rounded-xl border border-border-subtle bg-surface-elevated p-3"
      data-testid="semantic-memory-preference"
    >
      {state === "loading" ? (
        <p className="text-sm text-text-muted" role="status" data-testid="semantic-memory-loading">
          Loading semantic memory preference…
        </p>
      ) : state === "error" ? (
        <div data-testid="semantic-memory-load-error">
          <p className="text-sm text-danger" role="alert">
            {message}
          </p>
          <ControlButton
            className="mt-2 flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs text-text-primary"
            onClick={() => void load()}
          >
            <RefreshCw size={13} aria-hidden="true" /> Try again
          </ControlButton>
        </div>
      ) : (
        <>
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium text-text-primary">
                Semantic ranking
                <span
                  className="rounded-capsule border border-border-subtle px-1.5 text-micro uppercase tracking-wider text-text-muted"
                  data-testid="semantic-memory-mode"
                >
                  {enabled ? "Requested" : "Not requested"}
                </span>
              </div>
              <p id="semantic-memory-description" className="mt-1 text-xs text-text-muted">
                Request semantic ranking for memory search and agent recall when it is available.
              </p>
              {recall ? (
                <p
                  className="mt-1 text-xs text-text-muted"
                  role="status"
                  data-testid="semantic-memory-readiness"
                >
                  <span className="font-medium" data-testid="semantic-memory-readiness-mode">
                    {readinessLabel}
                  </span>
                  {" — "}
                  {recall.message}
                </p>
              ) : null}
            </div>
            <ControlButton
              role="switch"
              aria-label="Semantic ranking"
              aria-describedby="semantic-memory-description"
              aria-checked={enabled}
              data-testid="semantic-memory-toggle"
              disabled={saving}
              onClick={() => void toggle()}
              className={cn(
                "relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                enabled ? "border-accent bg-accent" : "border-border-strong bg-surface-muted",
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                  enabled ? "translate-x-5" : "translate-x-0.5",
                )}
              />
            </ControlButton>
          </div>
          {enabled && recall && canCheck ? (
            <ControlButton
              className="mt-2 flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-xs text-text-primary disabled:opacity-50"
              disabled={recall.readiness === "checking"}
              onClick={() => void check()}
              data-testid="semantic-memory-check"
            >
              <RefreshCw size={13} aria-hidden="true" />
              {recall.readiness === "not_checked" ? "Check readiness" : "Try again"}
            </ControlButton>
          ) : null}
          {enabled && runtimeFailure ? (
            <p className="mt-2 text-xs text-text-muted" data-testid="semantic-memory-runtime-retry">
              The next memory search or agent recall will retry semantic ranking automatically.
            </p>
          ) : null}
          {message ? (
            <p
              className={cn(
                "mt-2 text-xs",
                message === "Saving…" || message === "Saved" ? "text-text-muted" : "text-danger",
              )}
              role={message === "Saving…" || message === "Saved" ? "status" : "alert"}
              data-testid="semantic-memory-save-status"
            >
              {message}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

export function MemoryScreen() {
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const projects = useAppStore((state) => state.projects);
  const projectsLoaded = useAppStore((state) => state.projectsLoaded);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const setError = useAppStore((state) => state.setError);
  const navigationRequest = useAppStore((state) => state.memoryNavigationRequest);
  const clearNavigationRequest = useAppStore((state) => state.clearMemoryNavigationRequest);
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  /** A bulk stale sweep is in flight. The REF is the lock — React state is
   * asynchronous, so two clicks in one tick would both read `false` and fire two
   * destructive sweeps (Codex). The state exists only to drive the label. */
  const sweepingStaleRef = useRef(false);
  const [sweepingStale, setSweepingStale] = useState(false);
  /** Honest partial outcome: the server skips ids that stopped being stale, and
   * silently reloading would hide that from someone who confirmed N deletions. */
  const [staleSweepNotice, setStaleSweepNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [navigationAlert, setNavigationAlert] = useState<string | null>(null);
  // Monotonic request id: a slow response for a previously-selected project must
  // not clobber the list once a newer load (e.g. after switching projects) began.
  const loadSeq = useRef(0);
  // Recall search (native 11.8): runs the same recall engine the agent uses.
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MemoryItem[] | null>(null);
  const searchSeq = useRef(0);
  const [semanticPreferenceVersion, setSemanticPreferenceVersion] = useState(0);
  const [semanticRecall, setSemanticRecall] = useState<SemanticRecallStatus | null>(null);
  const semanticPreferenceChanged = useCallback((): void => {
    // Invalidate the old ranking immediately, then rerun a non-empty current
    // search under the newly persisted preference without a global resource
    // broadcast (which would incorrectly request Pi process replacement).
    searchSeq.current += 1;
    setSemanticPreferenceVersion((version) => version + 1);
  }, []);

  // Clearing the search or switching projects must invalidate any in-flight
  // request synchronously (bump the token) so a late response from the previous
  // query/project can't land and re-enter the recall-results branch — otherwise
  // an older fetch could clobber `null` back to `[]` or show stale hits.
  useEffect(() => {
    const q = searchQuery.trim();
    if (!q || !currentProjectId) {
      searchSeq.current += 1;
      setSearchResults(null);
      return;
    }
    const seq = ++searchSeq.current;
    void fetch(
      `/memory/search?projectId=${encodeURIComponent(currentProjectId)}&q=${encodeURIComponent(q)}`,
    )
      .then(async (response) => {
        if (!response.ok) throw new Error("Memory search failed.");
        const data = (await response.json()) as {
          memories?: MemoryItem[];
          recall?: SemanticRecallStatus;
        };
        if (!data.recall) throw new Error("Memory search returned no recall status.");
        return data;
      })
      .then((data) => {
        if (seq === searchSeq.current) {
          setSearchResults(data.memories ?? []);
          setSemanticRecall(data.recall!);
        }
      })
      .catch(() => {
        if (seq === searchSeq.current) setSearchResults([]);
      });
  }, [searchQuery, currentProjectId, resourcesVersion, semanticPreferenceVersion]);

  const load = useCallback(async (): Promise<void> => {
    if (
      !currentProjectId ||
      (projectsLoaded && !projects.some((project) => project.id === currentProjectId))
    ) {
      loadSeq.current += 1;
      setMemories([]);
      return;
    }
    const seq = ++loadSeq.current;
    try {
      const response = await fetch(`/memory?projectId=${encodeURIComponent(currentProjectId)}`);
      if (!response.ok) throw new Error(await response.text());
      const data = (await response.json()) as { memories: MemoryItem[] };
      if (seq === loadSeq.current) setMemories(data.memories);
    } catch (err) {
      if (seq === loadSeq.current) setError(String(err));
    }
  }, [currentProjectId, projects, projectsLoaded, setError]);

  useEffect(() => {
    void load();
  }, [load, resourcesVersion]);

  // useLayoutEffect (not useEffect) so the reset commits before paint — the
  // previous project's recall hits never flash under the new project.
  useLayoutEffect(() => {
    setDraft(null);
    setNavigationAlert(null);
    // Drop the previous project's search so its recall hits can't render under
    // the new project before the re-keyed search effect resolves (native 11.8).
    searchSeq.current += 1;
    setSearchQuery("");
    setSearchResults(null);
  }, [currentProjectId]);

  useLayoutEffect(() => {
    if (!navigationRequest) return;
    const { requestId, projectId, memoryId, titleSnapshot } = navigationRequest;
    if (projectId !== currentProjectId) {
      clearNavigationRequest(requestId);
      return;
    }
    if (!projectsLoaded) return;
    if (!projects.some((project) => project.id === projectId)) {
      setDraft(null);
      setNavigationAlert(memoryMissingMessage(titleSnapshot));
      clearNavigationRequest(requestId);
      return;
    }

    const controller = new AbortController();
    // Admission is synchronous before paint: a prior editor can never flash
    // while the exact-ID request is in flight.
    setDraft(null);
    setNavigationAlert(null);
    // Defer admission by one microtask so React StrictMode's setup/cleanup probe
    // aborts the probe without issuing a duplicate one-shot GET.
    void Promise.resolve()
      .then(async () => {
        if (controller.signal.aborted) return null;
        const response = await fetch(
          `/memory/${encodeURIComponent(memoryId)}?projectId=${encodeURIComponent(projectId)}`,
          { signal: controller.signal },
        );
        if (!response.ok) {
          throw new Error(
            response.status === 400 || response.status === 404
              ? memoryMissingMessage(titleSnapshot)
              : MEMORY_OPEN_FAILED_MESSAGE,
          );
        }
        const data = (await response.json()) as { memory?: MemoryItem };
        if (!data.memory || data.memory.id !== memoryId) {
          throw new Error(memoryMissingMessage(titleSnapshot));
        }
        return data.memory;
      })
      .then((memory) => {
        if (!memory) return;
        if (useAppStore.getState().memoryNavigationRequest?.requestId !== requestId) return;
        setDraft({
          id: memory.id,
          type: memory.type,
          tags: (memory.tags ?? []).join(", "),
          tagsInitial: (memory.tags ?? []).join(", "),
          title: memory.title,
          summary: memory.summary,
          body: memory.body,
          projectId,
          ...recordMetadata(memory),
        });
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        if (useAppStore.getState().memoryNavigationRequest?.requestId !== requestId) return;
        setDraft(null);
        setNavigationAlert(
          cause instanceof Error &&
            (cause.message === memoryMissingMessage(titleSnapshot) ||
              cause.message === MEMORY_OPEN_FAILED_MESSAGE)
            ? cause.message
            : MEMORY_OPEN_FAILED_MESSAGE,
        );
      })
      .finally(() => {
        if (!controller.signal.aborted) clearNavigationRequest(requestId);
      });

    return () => controller.abort();
  }, [clearNavigationRequest, currentProjectId, navigationRequest, projects, projectsLoaded]);

  const setStatus = async (id: string, status: MemoryStatus): Promise<void> => {
    if (!currentProjectId) return;
    try {
      const response = await fetch(`/memory/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: currentProjectId, status }),
      });
      if (!response.ok) throw new Error(await response.text());
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  // Native's detail pane is bound to the stored record (AgentMemoryViews.swift:274),
  // so its rows follow the record and its selection clears when the record is
  // deleted (:298). Electron reloads the list after every write, which is the
  // same moment: refresh the read-only rows from the reloaded record, and close
  // an editor whose record has gone — whichever path deleted it, the row button
  // or the stale sweep. The "was it ever there" guard is what keeps a deep-linked
  // memory open while the list for its project is still loading.
  const openRecordSeen = useRef<string | null>(null);
  useEffect(() => {
    const open = draft;
    if (!open || open.id === undefined) {
      openRecordSeen.current = null;
      return;
    }
    const record = memories.find((memory) => memory.id === open.id);
    if (!record) {
      if (openRecordSeen.current === open.id) setDraft(null);
      return;
    }
    openRecordSeen.current = open.id;
    const fresh = recordMetadata(record);
    const changed = (Object.keys(fresh) as (keyof typeof fresh)[]).some(
      (key) => open[key] !== fresh[key],
    );
    if (changed) setDraft({ ...open, ...fresh });
  }, [memories, draft]);

  const remove = async (id: string): Promise<void> => {
    if (!currentProjectId) return;
    try {
      const response = await fetch(
        `/memory/${id}?projectId=${encodeURIComponent(currentProjectId)}`,
        {
          method: "DELETE",
        },
      );
      if (!response.ok) throw new Error(await response.text());
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  /** MEM-14 (native AgentMemoryViews.deleteStaleMemories): retire the whole
   * visible stale group in one action. ONE request, not a loop of deletes: the
   * server re-proves staleness per id at delete time, so a memory an agent
   * reactivated between the click and the sweep survives, an already-deleted id
   * is skipped instead of abandoning the rest of the cleanup, and there is no
   * half-finished traversal to explain (Codex). The reload is skipped when the
   * project changed under us, so a slow sweep can never repopulate project A's
   * memories while project B is on screen. */
  const removeStale = async (ids: readonly string[]): Promise<void> => {
    const projectId = currentProjectId;
    if (!projectId || ids.length === 0 || sweepingStaleRef.current) return;
    sweepingStaleRef.current = true;
    setSweepingStale(true);
    setStaleSweepNotice(null);
    try {
      const response = await fetch("/memory/delete-stale", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId, ids }),
      });
      if (!response.ok) throw new Error(await response.text());
      const result = (await response.json()) as { deleted?: number; skipped?: number };
      if ((result.skipped ?? 0) > 0) {
        setStaleSweepNotice(
          `Deleted ${result.deleted ?? 0}. Skipped ${result.skipped} that were no longer stale.`,
        );
      }
    } catch (err) {
      setError(String(err));
    } finally {
      sweepingStaleRef.current = false;
      setSweepingStale(false);
      if (useAppStore.getState().currentProjectId === projectId) await load();
    }
  };

  // Native deletes the stale memories that are VISIBLE, so an active recall
  // search narrows the sweep to its results (AgentMemoryViews: it walks
  // `cachedLayout.visible`). Same rule here: search results when searching,
  // otherwise the loaded list.
  const visibleStaleIds = (searchResults ?? memories)
    .filter((entry) => entry.status === "stale")
    .map((entry) => entry.id);

  const save = async (): Promise<void> => {
    if (!draft || !draft.title.trim() || !draft.summary.trim() || !draft.body.trim()) return;
    const fields = {
      type: draft.type,
      title: draft.title.trim(),
      summary: draft.summary.trim(),
      body: draft.body.trim(),
      // Native's parse: split on comma, trim, drop empties
      // (AgentMemoryViews.swift:579-582). Sent only when the field was actually
      // touched (or on create): an untouched save omits tags entirely and the
      // store keeps what is on disk, so editing a body never silently drops a
      // tag an agent added meanwhile, nor re-splits a tag containing a comma
      // that this flat field cannot represent.
      ...(draft.id === undefined || draft.tags !== draft.tagsInitial
        ? {
            tags: draft.tags
              .split(",")
              .map((tag) => tag.trim())
              .filter((tag) => tag.length > 0),
          }
        : {}),
    };
    try {
      const response = draft.id
        ? await fetch(`/memory/${draft.id}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId: draft.projectId, edit: fields }),
          })
        : await fetch("/memory", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ projectId: draft.projectId, ...fields }),
          });
      if (!response.ok) throw new Error(await response.text());
      setDraft(null);
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  if (!currentProjectId) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="memory-screen">
        <div className="mx-auto max-w-3xl">
          <div className="flex items-center gap-2 pb-1">
            <Brain size={16} className="text-text-secondary" aria-hidden />
            <h2 className="text-base font-semibold text-text-primary">Memory</h2>
          </div>
          <p className="pb-2 text-xs text-text-muted">
            Durable project knowledge agents recall across sessions.
          </p>
          <AgentMemoryPreference />
          <SemanticMemoryPreference
            onChanged={semanticPreferenceChanged}
            recall={semanticRecall}
            setRecall={setSemanticRecall}
          />
          <div
            className="py-10 text-center text-sm text-text-muted"
            data-testid="memory-no-project"
          >
            Memory is project-scoped. Open a project to see and manage its memories.
          </div>
        </div>
      </div>
    );
  }

  const startNew = (): void =>
    setDraft({
      type: "context",
      title: "",
      summary: "",
      body: "",
      tags: "",
      tagsInitial: "",
      projectId: currentProjectId,
    });

  const startEdit = (memory: MemoryItem): void =>
    setDraft({
      id: memory.id,
      type: memory.type,
      title: memory.title,
      summary: memory.summary,
      body: memory.body,
      projectId: currentProjectId,
      tags: memory.tags.join(", "),
      tagsInitial: memory.tags.join(", "),
      ...recordMetadata(memory),
    });

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="memory-screen">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between pb-1">
          <div className="flex items-center gap-2">
            <Brain size={16} className="text-text-secondary" aria-hidden />
            <h2
              className="text-base font-semibold text-text-primary"
              style={{ fontStretch: "expanded" }}
            >
              Memory
            </h2>
          </div>
          <div className="flex items-center gap-2">
            {visibleStaleIds.length > 0 ? (
              <ControlButton
                data-testid="memory-delete-stale"
                className="rounded-capsule border border-border-subtle px-3 py-1 text-xs font-medium text-text-muted hover:text-danger disabled:cursor-not-allowed disabled:opacity-40"
                title="Delete every stale memory shown"
                disabled={sweepingStale}
                onClick={() => {
                  const count = visibleStaleIds.length;
                  if (
                    confirm(
                      `Delete ${count} stale ${count === 1 ? "memory" : "memories"}? Their files are removed from disk.`,
                    )
                  ) {
                    void removeStale(visibleStaleIds);
                  }
                }}
              >
                {sweepingStale ? "Deleting…" : `Delete stale (${visibleStaleIds.length})`}
              </ControlButton>
            ) : null}
            <ControlButton
              data-testid="memory-new"
              className="rounded-capsule px-3 py-1 text-xs font-medium shadow-capsule"
              style={{
                background:
                  "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                color: "var(--color-accent-foreground)",
              }}
              onClick={startNew}
            >
              New memory
            </ControlButton>
          </div>
        </div>
        <p className="pb-2 text-xs text-text-muted">
          Durable project knowledge agents recall across sessions. Active and pinned memories are
          injected; stale and archived are kept but not injected.
        </p>
        <AgentMemoryPreference />
        <SemanticMemoryPreference
          onChanged={semanticPreferenceChanged}
          recall={semanticRecall}
          setRecall={setSemanticRecall}
        />
        {navigationAlert ? (
          <div
            className="mb-3 rounded-lg border border-danger bg-danger-subtle px-3 py-2 text-sm text-danger"
            role="alert"
            data-testid="memory-navigation-alert"
          >
            {navigationAlert}
          </div>
        ) : null}
        <ControlInput
          data-testid="memory-search"
          className="mb-3 w-full rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
          placeholder="Search memories (recall ranking)…"
          value={searchQuery}
          onChange={(event) => setSearchQuery(event.target.value)}
        />

        {draft ? (
          <div
            className="mb-4 space-y-2 rounded-2xl border border-border-strong bg-surface-elevated p-4"
            data-testid="memory-editor"
          >
            <div className="flex gap-2">
              <ControlSelect
                data-testid="memory-type"
                className="rounded-lg border border-border-strong bg-surface px-2 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
                value={draft.type}
                onChange={(e) => setDraft({ ...draft, type: e.target.value as MemoryType })}
              >
                {MEMORY_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </ControlSelect>
              <ControlInput
                data-testid="memory-title"
                className="flex-1 rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
                placeholder="title"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
            </div>
            <ControlInput
              data-testid="memory-summary"
              className="w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
              placeholder="summary (a retrieval key)"
              value={draft.summary}
              onChange={(e) => setDraft({ ...draft, summary: e.target.value })}
            />
            <ControlInput
              data-testid="memory-tags"
              className="w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
              placeholder="comma-separated tags"
              value={draft.tags}
              onChange={(e) => setDraft({ ...draft, tags: e.target.value })}
            />
            {draft.id !== undefined ? (
              <dl
                data-testid="memory-meta"
                className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs text-text-muted"
              >
                {[
                  // Native's detail rows, in its order (AgentMemoryViews.swift:461-471).
                  // Type mirrors the select above rather than a stored snapshot, so the
                  // row can never contradict what a save would write.
                  ["Type", draft.type],
                  ["Scope", draft.scope ?? "project"],
                  ["Created", formatMemoryTime(draft.createdAt)],
                  ["Updated", formatMemoryTime(draft.updatedAt)],
                  ...(draft.sourceAgentName ? [["Source", draft.sourceAgentName]] : []),
                  ["File", draft.filePath ?? "—"],
                ].map(([label, value]) => (
                  <Fragment key={label}>
                    <dt className="font-medium text-text-secondary">{label}</dt>
                    <dd className="truncate" title={value}>
                      {value}
                    </dd>
                  </Fragment>
                ))}
              </dl>
            ) : null}
            <ControlTextArea
              data-testid="memory-body"
              className="h-40 w-full resize-none rounded-lg border border-border-strong bg-surface p-3 font-mono text-sm text-text-primary outline-none focus:border-accent"
              placeholder="the durable content"
              spellCheck={false}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
            />
            <div className="flex items-center justify-end gap-2">
              <ControlButton
                className="rounded-capsule px-3 py-1 text-xs text-text-secondary hover:text-text-primary"
                onClick={() => setDraft(null)}
              >
                Cancel
              </ControlButton>
              <ControlButton
                data-testid="memory-save"
                className="rounded-capsule px-3 py-1 text-xs font-medium shadow-capsule disabled:opacity-40"
                style={{
                  background:
                    "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                  color: "var(--color-accent-foreground)",
                }}
                disabled={!draft.title.trim() || !draft.summary.trim() || !draft.body.trim()}
                onClick={() => void save()}
              >
                Save
              </ControlButton>
            </div>
          </div>
        ) : null}

        {staleSweepNotice ? (
          <p
            className="pb-2 text-xs text-warning"
            role="status"
            data-testid="memory-stale-sweep-notice"
          >
            {staleSweepNotice}
          </p>
        ) : null}

        <div className="space-y-4" data-testid="memory-list">
          {(searchResults !== null
            ? searchResults.length
              ? [{ status: "recall", label: "Recall results", memories: searchResults }]
              : []
            : groupMemoriesByStatus(memories)
          ).map((group) => (
            <section key={group.status} data-testid={`memory-section-${group.status}`}>
              <div className="flex items-center gap-1.5 px-1 pb-1 text-micro font-semibold uppercase tracking-wider text-text-muted">
                {group.label}
                <span className="rounded-capsule border border-border-subtle px-1 tabular-nums normal-case">
                  {group.memories.length}
                </span>
              </div>
              <div className="space-y-1.5">
                {group.memories.map((memory) => (
                  <div
                    key={memory.id}
                    data-testid={`memory-${memory.id}`}
                    data-status={memory.status}
                    className="group flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5"
                  >
                    <ControlButton
                      className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                      onClick={() => startEdit(memory)}
                    >
                      <span className="rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted">
                        {memory.type}
                      </span>
                      <span
                        data-testid="memory-status-chip"
                        className={cn(
                          "rounded-capsule border px-1.5 text-micro",
                          STATUS_STYLE[memory.status],
                        )}
                      >
                        {memory.status}
                      </span>
                      <span className="truncate text-sm font-medium text-text-primary">
                        {memory.title}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-xs text-text-muted">
                        {memory.summary}
                      </span>
                      {memory.sourceAgentName ? (
                        <span
                          data-testid={`memory-source-${memory.id}`}
                          className="shrink-0 rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted"
                          title={`Written by the ${memory.sourceAgentName} agent`}
                        >
                          {memory.sourceAgentName}
                        </span>
                      ) : null}
                    </ControlButton>
                    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                      <ControlButton
                        data-testid={`memory-pin-${memory.id}`}
                        className={cn(
                          "rounded p-1 hover:text-accent",
                          memory.status === "pinned" ? "text-accent" : "text-text-muted",
                        )}
                        title={memory.status === "pinned" ? "Unpin" : "Pin"}
                        onClick={() =>
                          void setStatus(
                            memory.id,
                            memory.status === "pinned" ? "active" : "pinned",
                          )
                        }
                      >
                        <Pin size={13} />
                      </ControlButton>
                      {memory.status === "stale" || memory.status === "archived" ? (
                        <ControlButton
                          data-testid={`memory-activate-${memory.id}`}
                          className="rounded p-1 text-text-muted hover:text-accent"
                          title="Re-activate"
                          onClick={() => void setStatus(memory.id, "active")}
                        >
                          <RotateCcw size={13} />
                        </ControlButton>
                      ) : (
                        <ControlButton
                          data-testid={`memory-archive-${memory.id}`}
                          className="rounded p-1 text-text-muted hover:text-text-secondary"
                          title="Archive"
                          onClick={() => void setStatus(memory.id, "archived")}
                        >
                          <Archive size={13} />
                        </ControlButton>
                      )}
                      <ControlButton
                        data-testid={`memory-delete-${memory.id}`}
                        className="rounded p-1 text-text-muted hover:text-danger"
                        title="Delete"
                        onClick={() => {
                          if (confirm("Delete this memory? This removes its file from disk.")) {
                            void remove(memory.id);
                          }
                        }}
                      >
                        <Trash2 size={13} />
                      </ControlButton>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          ))}
          {searchResults !== null ? (
            searchResults.length === 0 ? (
              <div
                className="py-8 text-center text-sm text-text-muted"
                data-testid="memory-search-empty"
              >
                No memories recalled for this query.
              </div>
            ) : null
          ) : memories.length === 0 && !draft ? (
            <div className="py-8 text-center text-sm text-text-muted" data-testid="memory-empty">
              No memories yet. Agents add them as they work, or create one manually.
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
