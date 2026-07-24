import {
  ControlButton,
  ControlInput,
  ControlTextArea,
  ControlSelect,
} from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useRef, useState } from "react";
import { Copy, Play, Plus, Repeat, Square, Trash2 } from "lucide-react";
import {
  isLoopRunTerminal,
  isRunnableLoopStructure,
  LOOP_DEFAULT_MAX_ITERATIONS,
  LOOP_MAX_ITERATIONS_LIMIT,
  LOOP_STRUCTURE_LABEL,
  RUNNABLE_LOOP_STRUCTURES,
  LOOP_WRITE_TARGET_LABEL,
  LOOP_WRITE_TARGETS,
  type LoopDefinition,
  type LoopRun,
} from "@agent-deck/domain";
import { SkeletonRows } from "../components/Skeleton.tsx";
import { useAppStore } from "../state/store.ts";

/**
 * Loop Bank (native LoopBankScreen): the library of saved loop definitions —
 * create, edit, delete, and RUN. Running a loop iterates its agent (via the
 * server's run engine) until the validation command exits 0; a live panel polls
 * the run state and can stop it.
 */
const RUN_STATUS_LABEL: Record<LoopRun["status"], string> = {
  running: "Running",
  stopping: "Stopping…",
  completed: "Completed",
  failed: "Failed",
  stopped: "Stopped",
};
const inputClass =
  "w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent";

interface LoopDraft {
  original: string | null; // the name at open time (null = new); edit keeps the name fixed
  name: string;
  description: string;
  goal: string;
  structure: LoopDefinition["structure"];
  agentName: string;
  maxIterations: number;
  validationCommand: string;
  writeTarget: LoopDefinition["writeTarget"];
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status})`;
}

function draftFrom(loop: LoopDefinition | null): LoopDraft {
  return {
    original: loop?.name ?? null,
    name: loop?.name ?? "",
    description: loop?.description ?? "",
    goal: loop?.goal ?? "",
    structure: loop?.structure ?? "singleAgent",
    agentName: loop?.agentName ?? "",
    maxIterations: loop?.maxIterations ?? LOOP_DEFAULT_MAX_ITERATIONS,
    validationCommand: loop?.validationCommand ?? "",
    writeTarget: loop?.writeTarget ?? "artifactMarkdown",
  };
}

export function LoopsScreen() {
  const setError = useAppStore((state) => state.setError);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const pushToast = useAppStore((state) => state.pushToast);
  const [loops, setLoops] = useState<LoopDefinition[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<LoopDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [activeRun, setActiveRun] = useState<LoopRun | null>(null);
  const runIdRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Runs we've already toasted on completion, so a terminal state toasts once.
  const toastedRef = useRef<Set<string>>(new Set());

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/loops");
      if (!response.ok) throw new Error(await responseError(response));
      const data = (await response.json()) as { loops: LoopDefinition[] };
      setLoops(data.loops);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoaded(true);
    }
  }, [setError]);

  useEffect(() => {
    void load();
  }, [load, resourcesVersion]);

  const openEditor = (loop: LoopDefinition | null): void => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSaveError(null);
    setDraft(draftFrom(loop));
  };

  const closeEditor = useCallback((): void => {
    setSaveError(null);
    setDraft(null);
    requestAnimationFrame(() => returnFocusRef.current?.focus());
  }, []);

  const editorOpen = draft !== null;
  useEffect(() => {
    if (!editorOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusables = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter(
        (element) => !element.hasAttribute("disabled"),
      );
    const frame = requestAnimationFrame(() => focusables()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        closeEditor();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    dialog.addEventListener("keydown", onKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      dialog.removeEventListener("keydown", onKeyDown);
    };
  }, [closeEditor, editorOpen]);

  const save = async (): Promise<void> => {
    if (!draft || !draft.name.trim()) return;
    const focusBeforeSave =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSaving(true);
    setSaveError(null);
    setError(null);
    try {
      const response = await fetch("/loops", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: draft.name.trim(),
          description: draft.description,
          goal: draft.goal,
          structure: draft.structure,
          agentName: draft.agentName.trim(),
          maxIterations: draft.maxIterations,
          validationCommand: draft.validationCommand,
          writeTarget: draft.writeTarget,
        }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      closeEditor();
      await load();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
      requestAnimationFrame(() => focusBeforeSave?.focus());
    } finally {
      setSaving(false);
    }
  };

  const remove = async (loop: LoopDefinition): Promise<void> => {
    if (!confirm(`Delete the loop "${loop.name}"?`)) return;
    try {
      const response = await fetch("/loops", {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: loop.name }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const duplicate = async (loop: LoopDefinition): Promise<void> => {
    try {
      const response = await fetch(`/loops/${encodeURIComponent(loop.name)}/duplicate`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await responseError(response));
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const startRun = async (loop: LoopDefinition): Promise<void> => {
    if (!currentProjectId) return;
    setError(null);
    try {
      const response = await fetch(`/loops/${encodeURIComponent(loop.name)}/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ projectId: currentProjectId }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const { run } = (await response.json()) as { run: LoopRun };
      runIdRef.current = run.id;
      setActiveRun(run);
    } catch (err) {
      setError(String(err));
    }
  };

  const stopRun = async (): Promise<void> => {
    const id = runIdRef.current;
    if (!id) return;
    await fetch(`/loops/runs/${id}/stop`, { method: "POST" }).catch(() => {});
  };

  // Poll the active run until it reaches a terminal state.
  useEffect(() => {
    if (!activeRun || isLoopRunTerminal(activeRun.status)) return;
    const id = activeRun.id;
    const timer = setInterval(() => {
      void (async () => {
        try {
          const response = await fetch(`/loops/runs/${id}`);
          if (!response.ok) return;
          const { run } = (await response.json()) as { run: LoopRun };
          // Ignore a stale poll if a newer run was started, and never let an
          // out-of-order older snapshot regress a run that already finished.
          if (runIdRef.current === run.id) {
            setActiveRun((prev) =>
              prev && prev.id === run.id && isLoopRunTerminal(prev.status) ? prev : run,
            );
            // Toast once when a run reaches a terminal state.
            if (isLoopRunTerminal(run.status) && !toastedRef.current.has(run.id)) {
              toastedRef.current.add(run.id);
              pushToast({
                kind: run.status === "completed" ? "success" : "error",
                message: `Loop "${run.loopName}" ${run.status}`,
              });
            }
          }
        } catch {
          // Transient — the next tick retries.
        }
      })();
    }, 500);
    return () => clearInterval(timer);
  }, [activeRun]);

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5" data-testid="loops-screen">
      <div className="mx-auto max-w-3xl">
        <div className="flex items-center justify-between pb-1">
          <div className="flex items-center gap-2">
            <Repeat size={16} className="text-text-secondary" aria-hidden />
            <h2
              className="text-base font-semibold text-text-primary"
              style={{ fontStretch: "expanded" }}
            >
              Loop Bank
            </h2>
          </div>
          <ControlButton
            data-testid="new-loop"
            className="flex items-center gap-1.5 rounded-capsule px-3 py-1 text-xs font-medium shadow-capsule"
            style={{
              background:
                "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
              color: "var(--color-accent-foreground)",
            }}
            onClick={() => openEditor(null)}
          >
            <Plus size={13} /> New loop
          </ControlButton>
        </div>
        <p className="pb-3 text-xs text-text-muted">
          Saved loops repeat an agent run until the validation command passes.
          {currentProjectId ? " Run one in the current project." : " Open a project to run one."}
        </p>

        {activeRun ? (
          <div
            className="mb-3 rounded-xl border border-border-strong bg-surface-elevated px-3.5 py-3"
            data-testid="loop-run-panel"
          >
            <div className="flex items-center justify-between">
              <div
                className="text-sm font-medium text-text-primary"
                style={{ fontStretch: "expanded" }}
              >
                {activeRun.loopName}
              </div>
              <div className="flex items-center gap-2">
                <span
                  data-testid="loop-run-status"
                  data-status={activeRun.status}
                  className="rounded-capsule border border-border-strong px-2 py-0.5 text-detail text-text-secondary"
                >
                  {RUN_STATUS_LABEL[activeRun.status]}
                </span>
                {isLoopRunTerminal(activeRun.status) ? (
                  <ControlButton
                    data-testid="loop-run-dismiss"
                    className="rounded p-1 text-text-muted hover:text-text-primary"
                    title="Dismiss"
                    onClick={() => {
                      runIdRef.current = null;
                      setActiveRun(null);
                    }}
                  >
                    <Trash2 size={13} />
                  </ControlButton>
                ) : (
                  <ControlButton
                    data-testid="loop-run-stop"
                    className="flex items-center gap-1 rounded-capsule border border-border-strong px-2 py-0.5 text-detail text-text-secondary hover:text-danger"
                    onClick={() => void stopRun()}
                  >
                    <Square size={11} /> Stop
                  </ControlButton>
                )}
              </div>
            </div>
            <div className="mt-1 text-detail text-text-muted">
              Iteration {activeRun.currentIteration} / {activeRun.maxIterations}
              {activeRun.stopReason ? ` · ${activeRun.stopReason}` : ""}
            </div>
            {activeRun.iterations.length > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1" data-testid="loop-run-iterations">
                {activeRun.iterations.map((it) => (
                  <span
                    key={it.index}
                    className="rounded-capsule border px-1.5 py-0.5 text-micro"
                    style={{
                      borderColor:
                        it.validationPassed === true
                          ? "var(--color-success)"
                          : it.validationPassed === false
                            ? "var(--color-warning)"
                            : "var(--color-border-strong)",
                      color:
                        it.validationPassed === true
                          ? "var(--color-success)"
                          : "var(--color-text-secondary)",
                    }}
                  >
                    #{it.index}{" "}
                    {it.validationPassed === true ? "✓" : it.validationPassed === false ? "✗" : "·"}
                  </span>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}

        <div className="space-y-1.5" data-testid="loop-list">
          {!loaded ? <SkeletonRows count={3} /> : null}
          {loops.map((loop, index) => {
            const runnable = isRunnableLoopStructure(loop.structure);
            const unavailableId = `loop-structure-unavailable-${index}`;
            return (
              <div
                key={loop.id}
                data-loop-name={loop.name}
                className="flex items-center gap-3 rounded-xl border border-border-subtle bg-surface px-3.5 py-2.5"
              >
                <ControlButton
                  className="min-w-0 flex-1 text-left"
                  onClick={() => openEditor(loop)}
                  data-testid={`loop-open-${loop.name}`}
                >
                  <div
                    className="truncate text-sm font-medium text-text-primary"
                    style={{ fontStretch: "expanded" }}
                  >
                    {loop.name}
                  </div>
                  <div className="truncate text-detail text-text-muted">
                    {LOOP_STRUCTURE_LABEL[loop.structure]} · {loop.maxIterations}× ·{" "}
                    {loop.description || "No description"}
                  </div>
                  {!runnable ? (
                    <div
                      id={unavailableId}
                      data-testid={`loop-unavailable-${loop.name}`}
                      className="mt-1 text-detail text-text-secondary"
                    >
                      This structure is unavailable. Convert it to Single agent before saving or
                      running.
                    </div>
                  ) : null}
                </ControlButton>
                <ControlButton
                  data-testid={`loop-run-${loop.name}`}
                  className="flex items-center gap-1 rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
                  title={
                    !runnable
                      ? "Unavailable until converted to Single agent"
                      : currentProjectId
                        ? "Run loop"
                        : "Open a project to run"
                  }
                  aria-describedby={!runnable ? unavailableId : undefined}
                  disabled={!runnable || !currentProjectId}
                  onClick={() => void startRun(loop)}
                >
                  <Play size={12} /> Run
                </ControlButton>
                <ControlButton
                  data-testid={`loop-duplicate-${loop.name}`}
                  className="rounded p-1 text-text-muted hover:text-text-primary disabled:opacity-40"
                  title={
                    runnable ? "Duplicate loop" : "Unavailable until converted to Single agent"
                  }
                  aria-describedby={!runnable ? unavailableId : undefined}
                  disabled={!runnable}
                  onClick={() => void duplicate(loop)}
                >
                  <Copy size={13} />
                </ControlButton>
                <ControlButton
                  data-testid={`loop-delete-${loop.name}`}
                  className="rounded p-1 text-text-muted hover:text-danger"
                  title="Delete loop"
                  onClick={() => void remove(loop)}
                >
                  <Trash2 size={13} />
                </ControlButton>
              </div>
            );
          })}
          {loaded && loops.length === 0 ? (
            <div className="py-8 text-center text-sm text-text-muted" data-testid="loop-empty">
              No loops yet. Create one to iterate an agent toward a checked goal.
            </div>
          ) : null}
        </div>
      </div>

      {draft ? (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-overlay p-3 sm:p-8"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closeEditor();
          }}
        >
          <div
            ref={dialogRef}
            className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-[560px] flex-col gap-3 overflow-y-auto rounded-2xl border border-border-strong bg-surface-elevated p-4 shadow-elevated sm:max-h-[85vh]"
            data-testid="loop-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="loop-editor-title"
          >
            <h3
              id="loop-editor-title"
              className="break-all text-sm font-semibold text-text-primary"
              style={{ fontStretch: "expanded" }}
            >
              {draft.original ? `Edit ${draft.original}` : "New Loop"}
            </h3>
            <label className="block text-xs text-text-muted">
              Name
              <ControlInput
                data-testid="loop-name"
                className={inputClass}
                value={draft.name}
                disabled={draft.original !== null}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </label>
            <label className="block text-xs text-text-muted">
              Description
              <ControlInput
                className={inputClass}
                value={draft.description}
                onChange={(e) => setDraft({ ...draft, description: e.target.value })}
              />
            </label>
            <label className="block text-xs text-text-muted">
              Goal (what each iteration should accomplish)
              <ControlTextArea
                data-testid="loop-goal"
                className={`${inputClass} min-h-[100px] font-mono text-caption`}
                value={draft.goal}
                onChange={(e) => setDraft({ ...draft, goal: e.target.value })}
              />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-text-muted">
                Structure
                <ControlSelect
                  data-testid="loop-structure"
                  className={inputClass}
                  value={draft.structure}
                  onChange={(e) =>
                    setDraft({ ...draft, structure: e.target.value as LoopDraft["structure"] })
                  }
                  aria-describedby={
                    isRunnableLoopStructure(draft.structure)
                      ? undefined
                      : "loop-editor-structure-unavailable"
                  }
                >
                  {!isRunnableLoopStructure(draft.structure) ? (
                    <option value={draft.structure} disabled>
                      {LOOP_STRUCTURE_LABEL[draft.structure]} (unavailable)
                    </option>
                  ) : null}
                  {RUNNABLE_LOOP_STRUCTURES.map((s) => (
                    <option key={s} value={s}>
                      {LOOP_STRUCTURE_LABEL[s]}
                    </option>
                  ))}
                </ControlSelect>
                {!isRunnableLoopStructure(draft.structure) ? (
                  <span
                    id="loop-editor-structure-unavailable"
                    data-testid="loop-editor-structure-unavailable"
                    className="mt-1 block text-detail text-text-secondary"
                  >
                    This structure cannot run here. Choose Single agent to explicitly convert it.
                  </span>
                ) : null}
              </label>
              <label className="text-xs text-text-muted">
                Agent
                <ControlInput
                  className={inputClass}
                  placeholder="agent name"
                  value={draft.agentName}
                  onChange={(e) => setDraft({ ...draft, agentName: e.target.value })}
                />
              </label>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <label className="text-xs text-text-muted">
                Max iterations
                <ControlInput
                  data-testid="loop-max-iterations"
                  type="number"
                  min={1}
                  max={LOOP_MAX_ITERATIONS_LIMIT}
                  className={inputClass}
                  value={draft.maxIterations}
                  onChange={(e) =>
                    setDraft({ ...draft, maxIterations: Number(e.target.value) || 1 })
                  }
                />
              </label>
              <label className="text-xs text-text-muted">
                Write target
                <ControlSelect
                  className={inputClass}
                  value={draft.writeTarget}
                  onChange={(e) =>
                    setDraft({ ...draft, writeTarget: e.target.value as LoopDraft["writeTarget"] })
                  }
                >
                  {LOOP_WRITE_TARGETS.map((t) => (
                    <option key={t} value={t}>
                      {LOOP_WRITE_TARGET_LABEL[t]}
                    </option>
                  ))}
                </ControlSelect>
              </label>
            </div>
            <label className="block text-xs text-text-muted">
              Validation command (exit 0 stops the loop early)
              <ControlInput
                data-testid="loop-validation"
                className={`${inputClass} font-mono text-caption`}
                placeholder="pnpm test"
                value={draft.validationCommand}
                onChange={(e) => setDraft({ ...draft, validationCommand: e.target.value })}
              />
            </label>
            {saveError ? (
              <div
                data-testid="loop-save-error"
                role="alert"
                aria-live="assertive"
                className="rounded-lg bg-danger-subtle px-3 py-2 text-xs text-text-primary"
              >
                {saveError}
              </div>
            ) : null}
            <div className="flex justify-end gap-2 pt-1">
              <ControlButton
                data-testid="loop-cancel"
                className="rounded-capsule border border-border-strong px-4 py-1.5 text-sm text-text-secondary hover:text-text-primary"
                onClick={closeEditor}
              >
                Cancel
              </ControlButton>
              <ControlButton
                data-testid="loop-save"
                className="rounded-capsule px-4 py-1.5 text-sm font-medium shadow-capsule disabled:opacity-40"
                style={{
                  background:
                    "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
                  color: "var(--color-accent-foreground)",
                }}
                disabled={saving || !draft.name.trim() || !isRunnableLoopStructure(draft.structure)}
                aria-describedby={
                  !isRunnableLoopStructure(draft.structure)
                    ? "loop-editor-structure-unavailable"
                    : undefined
                }
                onClick={() => void save()}
              >
                {saving ? "Saving…" : "Save"}
              </ControlButton>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
