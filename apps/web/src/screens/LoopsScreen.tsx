import {
  ControlButton,
  ControlInput,
  ControlTextArea,
  ControlSelect,
} from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Play,
  Plus,
  Repeat,
  ShieldCheck,
  Square,
  Trash2,
  X,
} from "lucide-react";
import {
  isLoopRunTerminal,
  isRunnableLoopStructure,
  loopDefinitionValidationError,
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
import { useAgents } from "../state/useAgents.ts";

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
  notAchieved: "Not achieved",
  interrupted: "Interrupted",
};
const STOP_REASON_LABEL: Partial<Record<NonNullable<LoopRun["stopReason"]>, string>> = {
  success: "Success",
  maxIterationsReached: "Maximum iterations reached",
  validationFailedAfterFinalIteration: "Validation failed after final iteration",
  validationUnavailable: "Validation unavailable",
  agentFailed: "Agent failed",
  humanInputRequired: "Human input required",
  userStopped: "Stopped by user",
  appInterrupted: "Interrupted by application restart",
};
const PHASE_LABEL = {
  maker: "Maker",
  checker: "Checker",
  stage: "Pipeline stage",
  validation: "Validation",
  evaluator: "Goal evaluator",
} as const;
const rationale = (value?: string): string | undefined => {
  const text = value?.split(/\r?\n/).slice(1).join("\n").trim();
  return text || undefined;
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
  makerName: string;
  checkerName: string;
  checkerRubric: string;
  pipelineStages: string[];
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
    makerName: loop?.makerName ?? loop?.agentName ?? "",
    checkerName: loop?.checkerName ?? "",
    checkerRubric: loop?.checkerRubric ?? "",
    pipelineStages: loop?.pipelineStages ? [...loop.pipelineStages] : [],
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
  const agents = useAgents().filter((agent) => !agent.shadowed && !agent.disabled);
  const [loops, setLoops] = useState<LoopDefinition[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<LoopDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [activeRun, setActiveRun] = useState<LoopRun | null>(null);
  const [runPending, setRunPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [acknowledgePending, setAcknowledgePending] = useState(false);
  const runIdRef = useRef<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const focusRetryAfterStopRef = useRef(false);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  // Runs we've already toasted on completion, so a terminal state toasts once.
  const toastedRef = useRef<Set<string>>(new Set());

  const load = useCallback(async (): Promise<void> => {
    try {
      const response = await fetch("/loops");
      if (!response.ok) throw new Error(await responseError(response));
      const data = (await response.json()) as { loops: LoopDefinition[] };
      setLoops(data.loops);
      const runsResponse = await fetch("/loops/runs");
      if (runsResponse.ok) {
        const runData = (await runsResponse.json()) as { runs: LoopRun[] };
        setRuns(runData.runs);
        if (runIdRef.current) {
          const tracked = runData.runs.find((run) => run.id === runIdRef.current);
          if (tracked) setActiveRun(tracked);
        } else {
          const latestActive = [...runData.runs]
            .reverse()
            .find((run) => !isLoopRunTerminal(run.status));
          const latest = latestActive ?? runData.runs.at(-1);
          if (latest) {
            runIdRef.current = latest.id;
            setActiveRun(latest);
          }
        }
      }
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
          agentName: draft.structure === "singleAgent" ? draft.agentName.trim() : undefined,
          makerName: draft.structure === "makerChecker" ? draft.makerName.trim() : undefined,
          checkerName: draft.structure === "makerChecker" ? draft.checkerName.trim() : undefined,
          checkerRubric:
            draft.structure === "makerChecker" ? draft.checkerRubric.trim() : undefined,
          pipelineStages:
            draft.structure === "agentPipeline"
              ? draft.pipelineStages.map((stage) => stage.trim())
              : undefined,
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
    if (!currentProjectId || runPending) return;
    setError(null);
    setRunPending(true);
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
      setRuns((previous) => [...previous, run]);
    } catch (err) {
      setError(String(err));
    } finally {
      setRunPending(false);
    }
  };

  const stopRun = async (): Promise<void> => {
    const id = runIdRef.current;
    if (!id || stopPending) return;
    focusRetryAfterStopRef.current = true;
    setStopPending(true);
    try {
      const response = await fetch(`/loops/runs/${id}/stop`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
    } catch (error) {
      focusRetryAfterStopRef.current = false;
      setError(String(error));
      requestAnimationFrame(() => stopButtonRef.current?.focus());
    } finally {
      setStopPending(false);
    }
  };

  const acknowledgeRecovery = async (): Promise<void> => {
    if (!activeRun || acknowledgePending) return;
    setAcknowledgePending(true);
    try {
      const response = await fetch(`/loops/runs/${activeRun.id}/acknowledge`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      const { run } = (await response.json()) as { run: LoopRun };
      setActiveRun(run);
      setRuns((previous) => previous.map((item) => (item.id === run.id ? run : item)));
    } catch (error) {
      setError(String(error));
    } finally {
      setAcknowledgePending(false);
    }
  };

  const retryRun = async (): Promise<void> => {
    if (!activeRun || runPending) return;
    setRunPending(true);
    try {
      const response = await fetch(`/loops/runs/${activeRun.id}/retry`, { method: "POST" });
      if (!response.ok) throw new Error(await responseError(response));
      const { run } = (await response.json()) as { run: LoopRun };
      runIdRef.current = run.id;
      setActiveRun(run);
      setRuns((previous) => [...previous, run]);
    } catch (error) {
      setError(String(error));
    } finally {
      setRunPending(false);
    }
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
            setRuns((previous) => previous.map((item) => (item.id === run.id ? run : item)));
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

  useEffect(() => {
    if (!activeRun || !isLoopRunTerminal(activeRun.status) || !focusRetryAfterStopRef.current)
      return;
    focusRetryAfterStopRef.current = false;
    requestAnimationFrame(() => retryButtonRef.current?.focus());
  }, [activeRun]);

  const draftError = draft ? loopDefinitionValidationError(draft) : undefined;
  const anyRunActive =
    runs.some((run) => run.status === "running" || run.status === "stopping") ||
    activeRun?.status === "running" ||
    activeRun?.status === "stopping";
  const recoveryAcknowledgementRequired = Boolean(
    activeRun?.status === "interrupted" &&
      activeRun.launch?.writeTarget === "currentCheckout" &&
      activeRun.launch.checkoutLockKey &&
      !activeRun.launch.checkoutAcknowledgedAt,
  );

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
                  <>
                    <ControlButton
                      ref={retryButtonRef}
                      data-testid="loop-run-retry"
                      className="rounded-capsule border border-border-strong px-2 py-0.5 text-detail"
                      disabled={runPending || recoveryAcknowledgementRequired}
                      aria-describedby={
                        recoveryAcknowledgementRequired
                          ? "loop-checkout-recovery-notice"
                          : undefined
                      }
                      onClick={() => void retryRun()}
                    >
                      Retry
                    </ControlButton>
                    <ControlButton
                      data-testid="loop-run-dismiss"
                      className="rounded p-1 text-text-muted hover:text-text-primary"
                      title="Dismiss"
                      aria-label="Dismiss run"
                      onClick={() => {
                        runIdRef.current = null;
                        setActiveRun(null);
                      }}
                    >
                      <Trash2 size={13} />
                    </ControlButton>
                  </>
                ) : (
                  <ControlButton
                    ref={stopButtonRef}
                    data-testid="loop-run-stop"
                    className="flex items-center gap-1 rounded-capsule border border-border-strong px-2 py-0.5 text-detail text-text-secondary hover:text-danger"
                    aria-disabled={stopPending}
                    data-pending={stopPending ? "true" : "false"}
                    onClick={() => void stopRun()}
                  >
                    <Square size={11} /> {stopPending ? "Stopping…" : "Stop"}
                  </ControlButton>
                )}
              </div>
            </div>
            <div
              className="mt-1 text-detail text-text-muted"
              data-testid="loop-run-live-status"
              role="status"
              aria-live="polite"
              aria-atomic="true"
            >
              {RUN_STATUS_LABEL[activeRun.status]} · Iteration {activeRun.currentIteration} /{" "}
              {activeRun.maxIterations}
            </div>
            {activeRun.stopReason ? (
              <div className="text-detail text-text-muted">
                {STOP_REASON_LABEL[activeRun.stopReason] ?? "Run ended"}
              </div>
            ) : null}
            {activeRun.stopReason === "humanInputRequired" ? (
              <div className="mt-2 rounded-lg border border-warning px-2 py-1 text-xs" role="alert">
                <strong>Human input required.</strong>{" "}
                {rationale(activeRun.iterations.at(-1)?.checkerOutput) ??
                  "Review the checker report, then Retry when ready."}
              </div>
            ) : null}
            {activeRun.status === "interrupted" &&
            activeRun.launch?.writeTarget === "currentCheckout" &&
            activeRun.launch.checkoutLockKey &&
            !activeRun.launch.checkoutAcknowledgedAt ? (
              <div
                id="loop-checkout-recovery-notice"
                className="mt-2 rounded-lg border border-warning px-2 py-1 text-xs"
                role="alert"
              >
                <strong>Checkout locked after interruption.</strong> Ensure no old agent process
                remains before unlocking this project checkout.
                <ControlButton
                  className="ml-2 rounded-capsule border border-border-strong px-2 py-0.5"
                  data-testid="loop-recovery-acknowledge"
                  disabled={acknowledgePending}
                  onClick={() => void acknowledgeRecovery()}
                >
                  <ShieldCheck size={11} aria-hidden />
                  {acknowledgePending ? "Unlocking…" : "I checked — unlock checkout"}
                </ControlButton>
              </div>
            ) : null}
            {activeRun.iterations.length > 0 ? (
              <ol
                className="mt-2 space-y-2"
                data-testid="loop-run-iterations"
                aria-label="Run timeline"
              >
                {activeRun.iterations.map((iteration) => (
                  <li
                    key={iteration.id}
                    className="rounded-lg border border-border-subtle p-2 text-detail"
                  >
                    <div className="font-medium text-text-primary">
                      Iteration {iteration.index} · Validation{" "}
                      {iteration.validationPassed === true
                        ? "✓ passed"
                        : iteration.validationPassed === false
                          ? "✗ failed"
                          : "not run"}
                    </div>
                    <ol className="mt-1 space-y-1">
                      {iteration.timeline.map((event) => (
                        <li key={event.id} data-phase={event.phase} className="text-text-secondary">
                          <span className="font-medium">{PHASE_LABEL[event.phase]}:</span>{" "}
                          {event.note}
                        </li>
                      ))}
                    </ol>
                    {iteration.checkerDecision ? (
                      <div data-testid="loop-checker-decision">
                        Checker decision: {iteration.checkerDecision}
                        {rationale(iteration.checkerOutput)
                          ? ` — ${rationale(iteration.checkerOutput)}`
                          : ""}
                      </div>
                    ) : null}
                    {iteration.pipelineStageOutputs?.length ? (
                      <ol className="mt-1" data-testid="loop-pipeline-stage-outputs">
                        {iteration.pipelineStageOutputs.map((stage) => (
                          <li key={stage.id} data-stage-index={stage.stageIndex}>
                            Stage {stage.stageIndex + 1}: {stage.agentName} — {stage.output}
                          </li>
                        ))}
                      </ol>
                    ) : null}
                    {iteration.goalDecision ? (
                      <div data-testid="loop-evaluator-decision">
                        Goal evaluator: {iteration.goalDecision}
                        {rationale(iteration.evaluatorOutput)
                          ? ` — ${rationale(iteration.evaluatorOutput)}`
                          : ""}
                      </div>
                    ) : null}
                    {iteration.validationEvidence ? (
                      <div data-testid="loop-validation-evidence">
                        Validation evidence: {iteration.validationEvidence}
                      </div>
                    ) : null}
                    {iteration.artifacts?.length ? (
                      <div>
                        Report artifacts:{" "}
                        {iteration.artifacts.map((artifact) => artifact.filename).join(", ")}
                      </div>
                    ) : null}
                    {iteration.children
                      .filter((child) => child.error)
                      .map((child) => (
                        <div key={child.id} role="alert" className="text-danger">
                          {PHASE_LABEL[child.phase]} error: {child.error}
                        </div>
                      ))}
                  </li>
                ))}
              </ol>
            ) : null}
          </div>
        ) : null}

        {runs.length > 1 ? (
          <div className="mb-3" data-testid="loop-run-history">
            <h3 className="mb-1 text-xs font-medium text-text-secondary">Recent runs</h3>
            <div className="flex flex-wrap gap-1">
              {[...runs]
                .reverse()
                .slice(0, 8)
                .map((run) => (
                  <ControlButton
                    key={run.id}
                    data-loop-name={run.loopName}
                    data-run-id={run.id}
                    className="rounded-capsule border border-border-strong px-2 py-0.5 text-detail"
                    disabled={Boolean(anyRunActive) && run.id !== activeRun?.id}
                    aria-pressed={run.id === activeRun?.id}
                    onClick={() => {
                      runIdRef.current = run.id;
                      setActiveRun(run);
                    }}
                  >
                    {run.loopName} · {RUN_STATUS_LABEL[run.status]}
                  </ControlButton>
                ))}
            </div>
          </div>
        ) : null}

        <div className="space-y-1.5" data-testid="loop-list">
          {!loaded ? <SkeletonRows count={3} /> : null}
          {loops.map((loop, index) => {
            const runnable = !loopDefinitionValidationError(loop);
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
                  disabled={!runnable || !currentProjectId || runPending || Boolean(anyRunActive)}
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
              {draft.structure === "singleAgent" ? (
                <label className="text-xs text-text-muted">
                  Agent
                  <ControlInput
                    data-testid="loop-agent"
                    className={inputClass}
                    list="loop-agent-choices"
                    placeholder="agent name"
                    value={draft.agentName}
                    onChange={(e) => setDraft({ ...draft, agentName: e.target.value })}
                  />
                </label>
              ) : null}
            </div>
            {draft.structure === "makerChecker" ? (
              <div className="space-y-3" data-testid="loop-maker-checker-config">
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-text-muted">
                    Maker agent
                    <ControlInput
                      data-testid="loop-maker"
                      className={inputClass}
                      list="loop-agent-choices"
                      value={draft.makerName}
                      onChange={(e) => setDraft({ ...draft, makerName: e.target.value })}
                    />
                  </label>
                  <label className="text-xs text-text-muted">
                    Checker agent
                    <ControlInput
                      data-testid="loop-checker"
                      className={inputClass}
                      list="loop-agent-choices"
                      value={draft.checkerName}
                      onChange={(e) => setDraft({ ...draft, checkerName: e.target.value })}
                    />
                  </label>
                </div>
                <label className="block text-xs text-text-muted">
                  Checker rubric
                  <ControlTextArea
                    data-testid="loop-checker-rubric"
                    className={`${inputClass} min-h-[80px]`}
                    value={draft.checkerRubric}
                    onChange={(e) => setDraft({ ...draft, checkerRubric: e.target.value })}
                  />
                </label>
              </div>
            ) : null}
            {draft.structure === "agentPipeline" ? (
              <fieldset
                className="space-y-2 rounded-lg border border-border-subtle p-2"
                data-testid="loop-pipeline-config"
                aria-describedby="loop-pipeline-help"
              >
                <legend className="px-1 text-xs font-medium text-text-secondary">
                  Ordered pipeline stages
                </legend>
                <p id="loop-pipeline-help" className="text-detail text-text-muted">
                  Stages run strictly from top to bottom each iteration. Repeated agent names are
                  allowed; later stages receive bounded handoff reports.
                </p>
                {draft.pipelineStages.map((stage, index) => (
                  <div
                    key={index}
                    className="flex items-center gap-1"
                    data-testid={`loop-pipeline-stage-${index}`}
                  >
                    <span className="w-5 text-detail text-text-muted">{index + 1}.</span>
                    <ControlInput
                      className={inputClass}
                      data-testid={`loop-pipeline-stage-agent-${index}`}
                      aria-label={`Pipeline stage ${index + 1} agent`}
                      list="loop-agent-choices"
                      disabled={saving}
                      value={stage}
                      onChange={(event) => {
                        const pipelineStages = [...draft.pipelineStages];
                        pipelineStages[index] = event.target.value;
                        setDraft({ ...draft, pipelineStages });
                      }}
                    />
                    <ControlButton
                      type="button"
                      title="Move stage up"
                      aria-label={`Move pipeline stage ${index + 1} up`}
                      disabled={saving || index === 0}
                      onClick={() => {
                        const pipelineStages = [...draft.pipelineStages];
                        [pipelineStages[index - 1], pipelineStages[index]] = [
                          pipelineStages[index]!,
                          pipelineStages[index - 1]!,
                        ];
                        setDraft({ ...draft, pipelineStages });
                      }}
                    >
                      <ArrowUp size={13} aria-hidden />
                    </ControlButton>
                    <ControlButton
                      type="button"
                      title="Move stage down"
                      aria-label={`Move pipeline stage ${index + 1} down`}
                      disabled={saving || index === draft.pipelineStages.length - 1}
                      onClick={() => {
                        const pipelineStages = [...draft.pipelineStages];
                        [pipelineStages[index], pipelineStages[index + 1]] = [
                          pipelineStages[index + 1]!,
                          pipelineStages[index]!,
                        ];
                        setDraft({ ...draft, pipelineStages });
                      }}
                    >
                      <ArrowDown size={13} aria-hidden />
                    </ControlButton>
                    <ControlButton
                      type="button"
                      title="Remove stage"
                      aria-label={`Remove pipeline stage ${index + 1}`}
                      disabled={saving}
                      onClick={() =>
                        setDraft({
                          ...draft,
                          pipelineStages: draft.pipelineStages.filter(
                            (_stage, stageIndex) => stageIndex !== index,
                          ),
                        })
                      }
                    >
                      <X size={13} aria-hidden />
                    </ControlButton>
                  </div>
                ))}
                <ControlButton
                  type="button"
                  data-testid="loop-pipeline-add-stage"
                  className="flex items-center gap-1 rounded-capsule border border-border-strong px-2 py-1 text-xs"
                  disabled={saving}
                  onClick={() =>
                    setDraft({ ...draft, pipelineStages: [...draft.pipelineStages, ""] })
                  }
                >
                  <Plus size={12} aria-hidden /> Add stage
                </ControlButton>
              </fieldset>
            ) : null}
            <datalist id="loop-agent-choices">
              {agents.map((agent) => (
                <option key={`${agent.scope}-${agent.name}`} value={agent.name} />
              ))}
            </datalist>
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
                {draft.writeTarget === "artifactMarkdown" ? (
                  <span className="mt-1 block text-detail">
                    Report-only: agents cannot modify the project. Reports are saved in Loop-owned
                    app data.
                  </span>
                ) : null}
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
            {draftError && !saveError ? (
              <div
                id="loop-draft-error"
                role="alert"
                aria-live="polite"
                className="text-xs text-warning"
              >
                {draftError}
              </div>
            ) : null}
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
                disabled={saving || Boolean(draftError)}
                aria-describedby={
                  !isRunnableLoopStructure(draft.structure)
                    ? "loop-editor-structure-unavailable"
                    : draftError
                      ? "loop-draft-error"
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
