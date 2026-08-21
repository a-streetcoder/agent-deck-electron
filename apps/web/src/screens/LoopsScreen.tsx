import {
  ControlButton,
  ControlInput,
  ControlTextArea,
  ControlSelect,
} from "@/design-system/components/NativeControls";
import { SectionHero } from "@/design-system/components/SectionHero";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Copy, Play, Plus, ShieldCheck, Square, Trash2, X } from "lucide-react";
import {
  canRetryLoopRun,
  isLoopRunTerminal,
  isRunnableLoopStructure,
  loopAgentRoleLabel,
  loopRequiredAgentRoles,
  loopDefinitionValidationError,
  isLoopAvailableInProject,
  normalizeLoopCheckpointPrompt,
  normalizeLoopClassificationPrompt,
  normalizeLoopLaunchContext,
  normalizeLoopProjectPaths,
  normalizeParallelBranches,
  LOOP_DEFAULT_CHECKPOINT_PROMPT,
  LOOP_DEFAULT_CLASSIFICATION_PROMPT,
  LOOP_DEFAULT_MAX_ITERATIONS,
  LOOP_EVALUATOR_THINKING_LEVELS,
  LOOP_MAX_ITERATIONS_LIMIT,
  LOOP_STRUCTURE_LABEL,
  RUNNABLE_LOOP_STRUCTURES,
  LOOP_WRITE_TARGET_LABEL,
  LOOP_WRITE_TARGETS,
  type AgentInfo,
  type LoopChangedFile,
  type LoopDefinition,
  type LoopRequiredAgentRole,
  type LoopRun,
} from "@agent-deck/domain";
import { SkeletonRows } from "../components/Skeleton.tsx";
import { useAppStore } from "../state/store.ts";
import { useAgents } from "../state/useAgents.ts";
import { revealLoopArtifacts, revealLoopWorktree } from "../lib/native.ts";
import { switchToSession } from "../state/wsBridge.ts";

/**
 * Loop Bank (native LoopBankScreen): the library of saved loop definitions —
 * create, edit, delete, and RUN. Running a loop iterates its agent (via the
 * server's run engine) until its evaluator reports SUCCESS and any configured
 * validation passes; a live panel polls the run state and can stop it.
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
  unsafeWriteTarget: "Unsafe write target",
  toolFailed: "Tool or validation process failed",
  agentFailed: "Agent failed",
  humanInputRequired: "Human input required",
  humanApproved: "Approval recorded",
  humanRejected: "Human rejected",
  userStopped: "Stopped by user",
  appInterrupted: "Interrupted by application restart",
};
const PHASE_LABEL = {
  maker: "Maker",
  checker: "Checker",
  stage: "Pipeline stage",
  branch: "Parallel branch",
  triage: "Discovery / triage",
  checkpoint: "Human approval",
  validation: "Validation",
  evaluator: "Goal evaluator",
} as const;
const childStatus = (child: LoopRun["iterations"][number]["children"][number]): string =>
  child.status ?? (child.error ? "failed" : child.endedAt ? "completed" : "running");
const childStatusLabel = (child: LoopRun["iterations"][number]["children"][number]): string => {
  const status = childStatus(child);
  return `${status[0]!.toUpperCase()}${status.slice(1)}`;
};

const parallelStatusAnnouncement = (run: LoopRun): string | undefined => {
  const branches = run.iterations
    .at(-1)
    ?.children.filter((child) => child.phase === "branch")
    .sort((a, b) => (a.branchIndex ?? 0) - (b.branchIndex ?? 0));
  if (!branches?.length) return undefined;
  const visible = branches
    .slice(0, 4)
    .map((child) => `Branch ${(child.branchIndex ?? 0) + 1} ${childStatus(child)}`);
  if (branches.length > visible.length) visible.push(`${branches.length - visible.length} more`);
  return `Parallel status: ${visible.join("; ")}.`;
};

const rationale = (value?: string): string | undefined => {
  const text = value?.split(/\r?\n/).slice(1).join("\n").trim();
  return text || undefined;
};
const inputClass =
  "w-full rounded-lg border border-border-strong bg-surface px-2.5 py-1.5 text-sm text-text-primary outline-none focus:border-accent";

interface LoopDraft {
  id?: string;
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
  parallelBranches: string[];
  triageAgent: string;
  classificationPrompt: string;
  checkpointPrompt: string;
  launchContext: string;
  launchContextScope: LoopDefinition["launchContextScope"];
  maxIterations: number;
  validationCommand: string;
  successCondition: string;
  successConditionSource: "goal" | "custom";
  evaluatorProvider: string;
  evaluatorModel: string;
  evaluatorThinkingLevel: string;
  writeTarget: LoopDefinition["writeTarget"];
  availability: LoopDefinition["availability"];
  projectPaths: string[];
}

interface LoopLaunchDraft {
  loop: LoopDefinition;
  retryOf?: string;
  goal: string;
  launchContext: string;
  launchContextScope: LoopDefinition["launchContextScope"];
  successCondition: string;
  successConditionSource: "goal" | "custom";
  evaluatorProvider: string;
  evaluatorModel: string;
  evaluatorThinkingLevel: string;
  currentCheckoutConfirmed: boolean;
}

function unavailableAgentRoles(
  loop: Parameters<typeof loopRequiredAgentRoles>[0],
  availableNames: ReadonlySet<string>,
): LoopRequiredAgentRole[] {
  return loopRequiredAgentRoles(loop).filter(
    (role) => !role.agentName || !availableNames.has(role.agentName),
  );
}

function agentUnavailableText(role: LoopRequiredAgentRole): string {
  return `${loopAgentRoleLabel(role)}: ${role.agentName ? `“${role.agentName}” is unavailable` : "select an agent"}.`;
}

async function responseError(response: Response): Promise<string> {
  const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
  return typeof body?.error === "string" ? body.error : `Request failed (${response.status})`;
}

function draftFrom(loop: LoopDefinition | null): LoopDraft {
  return {
    id: loop?.id,
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
    parallelBranches: loop?.parallelBranches ? [...loop.parallelBranches] : [],
    triageAgent: loop?.triageAgent ?? "",
    classificationPrompt: loop?.classificationPrompt ?? LOOP_DEFAULT_CLASSIFICATION_PROMPT,
    checkpointPrompt: loop?.checkpointPrompt ?? LOOP_DEFAULT_CHECKPOINT_PROMPT,
    launchContext: loop?.launchContext ?? "",
    launchContextScope: loop?.launchContextScope ?? "firstIterationOnly",
    maxIterations: loop?.maxIterations ?? LOOP_DEFAULT_MAX_ITERATIONS,
    validationCommand: loop?.validationCommand ?? "",
    successCondition: loop?.successCondition ?? loop?.goal ?? "",
    successConditionSource: loop?.successConditionSource ?? "goal",
    evaluatorProvider: loop?.evaluatorProvider ?? "",
    evaluatorModel: loop?.evaluatorModel ?? "",
    evaluatorThinkingLevel: loop?.evaluatorThinkingLevel ?? "",
    writeTarget:
      loop?.structure === "parallelAgents"
        ? "artifactMarkdown"
        : (loop?.writeTarget ?? "artifactMarkdown"),
    availability: loop?.availability ?? "allProjects",
    projectPaths: loop?.projectPaths ? [...loop.projectPaths] : [],
  };
}

export function LoopsScreen() {
  const setError = useAppStore((state) => state.setError);
  const resourcesVersion = useAppStore((state) => state.resourcesVersion);
  const currentProjectId = useAppStore((state) => state.currentProjectId);
  const currentSessionId = useAppStore((state) => state.session?.id);
  const sessions = useAppStore((state) => state.sessions);
  const setView = useAppStore((state) => state.setView);
  const loopCommandRequest = useAppStore((state) => state.loopCommandRequest);
  const projects = useAppStore((state) => state.projects);
  const currentProject = projects.find((project) => project.id === currentProjectId);
  const pushToast = useAppStore((state) => state.pushToast);
  const allAgents = useAgents();
  const agents = allAgents.filter((agent) => !agent.shadowed && !agent.disabled);
  const availableAgentNames = new Set(agents.map((agent) => agent.name));
  const [loops, setLoops] = useState<LoopDefinition[]>([]);
  const [evaluatorModels, setEvaluatorModels] = useState<
    Array<{ provider: string; id: string; name?: string }>
  >([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState<LoopDraft | null>(null);
  const [launchDraft, setLaunchDraft] = useState<LoopLaunchDraft | null>(null);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [runs, setRuns] = useState<LoopRun[]>([]);
  const [activeRun, setActiveRun] = useState<LoopRun | null>(null);
  const [runPending, setRunPending] = useState(false);
  const [stopPending, setStopPending] = useState(false);
  const [approvalPending, setApprovalPending] = useState<"approve" | "reject" | null>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [acknowledgePending, setAcknowledgePending] = useState(false);
  const [revealPending, setRevealPending] = useState(false);
  const [artifactActionMessage, setArtifactActionMessage] = useState<string | null>(null);
  const [worktreeRevealPending, setWorktreeRevealPending] = useState(false);
  const [reviewPending, setReviewPending] = useState(false);
  const [reviewDialog, setReviewDialog] = useState<{
    run: LoopRun;
    patch: string;
    patchTruncated: boolean;
    changedFiles: LoopChangedFile[];
  } | null>(null);
  const [reviewConfirmed, setReviewConfirmed] = useState(false);
  const [discardName, setDiscardName] = useState("");
  const [reviewActionPending, setReviewActionPending] = useState<"apply" | "discard" | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [worktreeActionMessage, setWorktreeActionMessage] = useState<string | null>(null);
  const runIdRef = useRef<string | null>(null);
  const runPendingRef = useRef(false);
  runPendingRef.current = runPending;
  const dialogRef = useRef<HTMLDivElement>(null);
  const launchDialogRef = useRef<HTMLDivElement>(null);
  const reviewDialogRef = useRef<HTMLDivElement>(null);
  const reviewStatusPanelRef = useRef<HTMLDivElement>(null);
  const reviewReturnFocusRef = useRef<HTMLElement | null>(null);
  const launchReturnFocusRef = useRef<HTMLElement | null>(null);
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  const retryButtonRef = useRef<HTMLButtonElement>(null);
  const approveButtonRef = useRef<HTMLButtonElement>(null);
  const rejectButtonRef = useRef<HTMLButtonElement>(null);
  const dismissButtonRef = useRef<HTMLButtonElement>(null);
  const checkpointPromptRef = useRef<HTMLTextAreaElement>(null);
  const triageAgentRef = useRef<HTMLSelectElement>(null);
  const focusRetryAfterStopRef = useRef(false);
  const approvalErrorFocusRef = useRef<"approve" | "reject" | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    setEvaluatorModels([]);
    if (!currentSessionId) return () => undefined;
    void (async () => {
      try {
        const response = await fetch(`/sessions/${encodeURIComponent(currentSessionId)}/models`);
        if (!response.ok) return;
        const data = (await response.json()) as {
          models: Array<{ provider: string; id: string; name?: string; disabled?: boolean }>;
        };
        if (!cancelled) setEvaluatorModels(data.models.filter((model) => !model.disabled));
      } catch {
        // Launch validates against the newly allocated parent session's own catalog.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [currentSessionId]);

  const openEditor = (loop: LoopDefinition | null): void => {
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSaveError(null);
    setDraft(draftFrom(loop));
  };

  const saveLoopFromRun = (run: LoopRun): void => {
    if (!isLoopRunTerminal(run.status) || !run.definitionSnapshot) return;
    const firstGoalLine = run.definitionSnapshot.goal
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean);
    const project = projects.find((candidate) => candidate.id === run.projectId);
    const definition: LoopDefinition = {
      id: "",
      source: "user",
      filePath: "",
      availability: project ? "projectPaths" : "allProjects",
      projectPaths: project ? [project.path] : [],
      ...run.definitionSnapshot,
      name: (firstGoalLine || "Saved Loop").slice(0, 64),
      description: "Saved from completed loop run.",
    };
    returnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setSaveError(null);
    const next = draftFrom(definition);
    next.id = undefined;
    next.original = null;
    setDraft(next);
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

  const closeLaunch = useCallback((): void => {
    setLaunchDraft(null);
    setLaunchError(null);
    requestAnimationFrame(() => launchReturnFocusRef.current?.focus());
  }, []);

  const openLaunch = (loop: LoopDefinition): void => {
    launchReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLaunchError(null);
    setLaunchDraft({
      loop,
      goal: loop.goal,
      launchContext: loop.launchContext ?? "",
      launchContextScope: loop.launchContextScope,
      successCondition: loop.successCondition ?? loop.goal,
      successConditionSource: loop.successConditionSource ?? "goal",
      evaluatorProvider: loop.evaluatorProvider ?? "",
      evaluatorModel: loop.evaluatorModel ?? "",
      evaluatorThinkingLevel: loop.evaluatorThinkingLevel ?? "",
      currentCheckoutConfirmed: false,
    });
  };

  useEffect(() => {
    if (!loopCommandRequest || !loaded) return;
    const store = useAppStore.getState();
    if (loopCommandRequest.action === "loop.create") {
      store.clearLoopCommandRequest(loopCommandRequest.token);
      openEditor(null);
      return;
    }
    const target = loops.find((loop) => loop.id === loopCommandRequest.loopId);
    store.clearLoopCommandRequest(loopCommandRequest.token);
    if (target) openLaunch(target);
  }, [loaded, loopCommandRequest, loops]);

  const launchOpen = launchDraft !== null;
  useEffect(() => {
    if (!launchOpen) return;
    const dialog = launchDialogRef.current;
    if (!dialog) return;
    const focusables = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>("button, input, select, textarea")].filter(
        (element) => !element.hasAttribute("disabled"),
      );
    const frame = requestAnimationFrame(() => focusables()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        event.preventDefault();
        if (!runPendingRef.current) closeLaunch();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items.at(-1);
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
  }, [closeLaunch, launchOpen]);

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
          id: draft.id,
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
          parallelBranches:
            draft.structure === "parallelAgents"
              ? normalizeParallelBranches(draft.parallelBranches)
              : undefined,
          triageAgent: draft.structure === "discoveryTriage" ? draft.triageAgent.trim() : undefined,
          classificationPrompt:
            draft.structure === "discoveryTriage"
              ? normalizeLoopClassificationPrompt(draft.classificationPrompt)
              : undefined,
          checkpointPrompt:
            draft.structure === "humanApproval"
              ? normalizeLoopCheckpointPrompt(draft.checkpointPrompt)
              : undefined,
          launchContext: normalizeLoopLaunchContext(draft.launchContext) ?? "",
          launchContextScope: draft.launchContextScope,
          maxIterations: draft.maxIterations,
          validationCommand: draft.validationCommand,
          successCondition: draft.successCondition,
          successConditionSource: draft.successConditionSource,
          evaluatorProvider: draft.evaluatorProvider,
          evaluatorModel: draft.evaluatorModel,
          evaluatorThinkingLevel: draft.evaluatorThinkingLevel,
          writeTarget: draft.writeTarget,
          availability: draft.availability,
          projectPaths:
            draft.availability === "projectPaths"
              ? normalizeLoopProjectPaths(draft.projectPaths)
              : [],
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
        body: JSON.stringify({ id: loop.id }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const duplicate = async (loop: LoopDefinition): Promise<void> => {
    try {
      const response = await fetch(`/loops/${encodeURIComponent(loop.id)}/duplicate`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await responseError(response));
      await load();
    } catch (err) {
      setError(String(err));
    }
  };

  const startRun = async (): Promise<void> => {
    if (!currentProjectId || !launchDraft || runPending) return;
    const {
      loop,
      retryOf,
      goal,
      launchContext,
      launchContextScope,
      successCondition,
      successConditionSource,
      evaluatorProvider,
      evaluatorModel,
      evaluatorThinkingLevel,
      currentCheckoutConfirmed,
    } = launchDraft;
    setError(null);
    setLaunchError(null);
    setRunPending(true);
    try {
      const response = await fetch(
        retryOf
          ? `/loops/runs/${encodeURIComponent(retryOf)}/retry`
          : `/loops/${encodeURIComponent(loop.id)}/run`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            retryOf
              ? { currentCheckoutConfirmed }
              : {
                  projectId: currentProjectId,
                  goal,
                  launchContext,
                  launchContextScope,
                  successCondition,
                  successConditionSource,
                  evaluatorProvider,
                  evaluatorModel,
                  evaluatorThinkingLevel,
                  currentCheckoutConfirmed,
                },
          ),
        },
      );
      if (!response.ok) throw new Error(await responseError(response));
      const { run } = (await response.json()) as { run: LoopRun };
      runIdRef.current = run.id;
      setActiveRun(run);
      setRuns((previous) => [...previous, run]);
      closeLaunch();
    } catch (err) {
      setLaunchError(err instanceof Error ? err.message : String(err));
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

  const resolveHumanApproval = async (decision: "approve" | "reject"): Promise<void> => {
    if (!activeRun || approvalPending) return;
    setApprovalPending(decision);
    setApprovalError(null);
    try {
      const response = await fetch(`/loops/runs/${activeRun.id}/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, expectedUpdatedAt: activeRun.updatedAt }),
      });
      if (!response.ok) throw new Error(await responseError(response));
      const { run } = (await response.json()) as { run: LoopRun };
      setActiveRun(run);
      setRuns((previous) => previous.map((item) => (item.id === run.id ? run : item)));
      requestAnimationFrame(() =>
        (canRetryLoopRun(run) ? retryButtonRef.current : dismissButtonRef.current)?.focus(),
      );
    } catch (error) {
      setApprovalError(error instanceof Error ? error.message : String(error));
      approvalErrorFocusRef.current = decision;
    } finally {
      setApprovalPending(null);
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

  const revealArtifacts = async (run: LoopRun): Promise<void> => {
    if (revealPending || !run.artifactDirectory) return;
    setRevealPending(true);
    setArtifactActionMessage(null);
    try {
      const revealed = await revealLoopArtifacts(run.id);
      setArtifactActionMessage(
        revealed
          ? "Artifacts revealed in the file manager."
          : `Desktop reveal is unavailable. Artifacts: ${run.artifactDirectory}`,
      );
    } catch (error) {
      setArtifactActionMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setRevealPending(false);
    }
  };

  const revealWorktree = async (run: LoopRun): Promise<void> => {
    if (worktreeRevealPending || !isLoopRunTerminal(run.status) || !run.launch?.worktree) return;
    setWorktreeRevealPending(true);
    setWorktreeActionMessage(null);
    try {
      const revealed = await revealLoopWorktree(run.id);
      setWorktreeActionMessage(
        revealed
          ? "Worktree revealed in the file manager."
          : "Reveal Worktree is available in the desktop app.",
      );
    } catch (error) {
      setWorktreeActionMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setWorktreeRevealPending(false);
    }
  };

  const openLoopSession = async (run: LoopRun): Promise<void> => {
    const session = sessions.find((candidate) => candidate.id === run.sessionId);
    if (!session) {
      setError("The durable Loop session is unavailable.");
      return;
    }
    setView("chat");
    await switchToSession(session);
  };

  const reviewWorktree = async (run: LoopRun): Promise<void> => {
    if (reviewPending) return;
    reviewReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setReviewPending(true);
    setReviewError(null);
    try {
      const response = await fetch(`/loops/runs/${encodeURIComponent(run.id)}/review`);
      if (!response.ok) throw new Error(await responseError(response));
      const result = (await response.json()) as {
        run: LoopRun;
        patch: string;
        patchTruncated: boolean;
        changedFiles: LoopChangedFile[];
      };
      setActiveRun(result.run);
      setRuns((items) => items.map((item) => (item.id === result.run.id ? result.run : item)));
      setReviewConfirmed(false);
      setDiscardName("");
      setReviewDialog(result);
    } catch (error) {
      setWorktreeActionMessage(error instanceof Error ? error.message : String(error));
      requestAnimationFrame(() => reviewReturnFocusRef.current?.focus());
    } finally {
      setReviewPending(false);
    }
  };

  const closeReview = useCallback((): void => {
    if (reviewActionPending) return;
    setReviewDialog(null);
    setReviewError(null);
    requestAnimationFrame(() => reviewReturnFocusRef.current?.focus());
  }, [reviewActionPending]);

  useEffect(() => {
    const dialog = reviewDialogRef.current;
    if (!reviewDialog || !dialog) return;
    const focusables = (): HTMLElement[] =>
      [...dialog.querySelectorAll<HTMLElement>("button, input")].filter(
        (element) => !element.hasAttribute("disabled"),
      );
    const frame = requestAnimationFrame(() => focusables()[0]?.focus());
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !reviewActionPending) {
        event.preventDefault();
        closeReview();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items.at(-1);
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
  }, [closeReview, reviewActionPending, reviewDialog]);

  const decideWorktree = async (action: "apply" | "discard"): Promise<void> => {
    if (!reviewDialog || reviewActionPending) return;
    setReviewActionPending(action);
    setReviewError(null);
    try {
      const response = await fetch(
        `/loops/runs/${encodeURIComponent(reviewDialog.run.id)}/${action}`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            confirmed: true,
            expectedUpdatedAt: reviewDialog.run.updatedAt,
            ...(action === "discard" ? { loopName: discardName } : {}),
          }),
        },
      );
      const body = (await response.json().catch(() => null)) as {
        run?: LoopRun;
        error?: string;
      } | null;
      if (!response.ok) {
        if (body?.run) {
          setActiveRun(body.run);
          setRuns((items) => items.map((item) => (item.id === body.run!.id ? body.run! : item)));
          setReviewDialog((current) => (current ? { ...current, run: body.run! } : current));
        }
        throw new Error(body?.error ?? `Request failed (${response.status})`);
      }
      if (!body?.run) throw new Error("The server returned an invalid Loop decision.");
      setActiveRun(body.run);
      setRuns((items) => items.map((item) => (item.id === body.run!.id ? body.run! : item)));
      setReviewDialog(null);
      setWorktreeActionMessage(
        action === "apply"
          ? "Loop changes applied. The worktree and branch were retained."
          : `Worktree safely archived${body.run.review?.archivedPath ? ` at ${body.run.review.archivedPath}` : ""}. Branch and artifacts were retained.`,
      );
      requestAnimationFrame(() => reviewStatusPanelRef.current?.focus());
    } catch (error) {
      setReviewError(error instanceof Error ? error.message : String(error));
    } finally {
      setReviewActionPending(null);
    }
  };

  const openRetry = (): void => {
    if (!activeRun?.definitionSnapshot || !activeRun.catalogId || runPending) return;
    launchReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const loop: LoopDefinition = {
      id: activeRun.catalogId,
      source: "user",
      availability: "allProjects",
      projectPaths: [],
      filePath: "",
      ...activeRun.definitionSnapshot,
    };
    setLaunchError(null);
    setLaunchDraft({
      loop,
      retryOf: activeRun.id,
      goal: loop.goal,
      launchContext: loop.launchContext ?? "",
      launchContextScope: loop.launchContextScope,
      successCondition: loop.successCondition ?? loop.goal,
      successConditionSource: loop.successConditionSource ?? "goal",
      evaluatorProvider: loop.evaluatorProvider ?? "",
      evaluatorModel: loop.evaluatorModel ?? "",
      evaluatorThinkingLevel: loop.evaluatorThinkingLevel ?? "",
      currentCheckoutConfirmed: false,
    });
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
    if (approvalPending || !approvalErrorFocusRef.current) return;
    const decision = approvalErrorFocusRef.current;
    approvalErrorFocusRef.current = null;
    requestAnimationFrame(() =>
      (decision === "approve" ? approveButtonRef.current : rejectButtonRef.current)?.focus(),
    );
  }, [approvalPending]);

  useEffect(() => {
    if (!activeRun || !isLoopRunTerminal(activeRun.status) || !focusRetryAfterStopRef.current)
      return;
    focusRetryAfterStopRef.current = false;
    requestAnimationFrame(() =>
      (canRetryLoopRun(activeRun) ? retryButtonRef.current : dismissButtonRef.current)?.focus(),
    );
  }, [activeRun]);

  const validThinkingLevels: readonly string[] = ["", ...LOOP_EVALUATOR_THINKING_LEVELS];
  const evaluatorModelValue = (provider: string, model: string): string =>
    model ? JSON.stringify([provider, model]) : "";
  const evaluatorModelPairs = new Set(
    evaluatorModels.map((model) => evaluatorModelValue(model.provider, model.id)),
  );
  const evaluatorModelAvailable = (provider: string, model: string): boolean =>
    provider
      ? evaluatorModelPairs.has(evaluatorModelValue(provider, model))
      : evaluatorModels.some((candidate) => candidate.id === model);
  const renderEvaluatorModelOptions = (provider: string, model: string) => {
    const selected = evaluatorModelValue(provider, model);
    return (
      <>
        <option value="">Inherited model</option>
        {selected && !evaluatorModelPairs.has(selected) ? (
          <option value={selected}>
            {provider
              ? `${provider}/${model} (unavailable)`
              : `${model} (launch provider${evaluatorModelAvailable(provider, model) ? "" : " unavailable"})`}
          </option>
        ) : null}
        {evaluatorModels.map((candidate) => (
          <option
            key={evaluatorModelValue(candidate.provider, candidate.id)}
            value={evaluatorModelValue(candidate.provider, candidate.id)}
          >
            {candidate.name ? `${candidate.name} · ` : ""}
            {candidate.provider}/{candidate.id}
          </option>
        ))}
      </>
    );
  };
  const parseEvaluatorModelValue = (value: string): [string, string] => {
    if (!value) return ["", ""];
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) && parsed.length === 2
        ? [String(parsed[0]), String(parsed[1])]
        : ["", ""];
    } catch {
      return ["", ""];
    }
  };
  const draftAgentIssues = draft ? unavailableAgentRoles(draft, availableAgentNames) : [];
  const draftEvaluatorModelInvalid = Boolean(
    draft?.evaluatorModel &&
      evaluatorModels.length > 0 &&
      !evaluatorModelAvailable(draft.evaluatorProvider, draft.evaluatorModel),
  );
  const draftError = draft
    ? draft.availability === "projectPaths" && !normalizeLoopProjectPaths(draft.projectPaths).length
      ? "Select at least one registered project."
      : draftEvaluatorModelInvalid
        ? `Evaluator model “${draft.evaluatorProvider ? `${draft.evaluatorProvider}/` : ""}${draft.evaluatorModel}” is unavailable. Choose an inherited or available model.`
        : !validThinkingLevels.includes(draft.evaluatorThinkingLevel)
          ? `Evaluator thinking “${draft.evaluatorThinkingLevel}” is unavailable. Choose a supported level.`
          : (loopDefinitionValidationError(draft) ??
            (draftAgentIssues.length
              ? `Repair unavailable agent roles: ${draftAgentIssues.map(agentUnavailableText).join(" ")}`
              : undefined))
    : undefined;
  const launchAgentIssues = launchDraft
    ? unavailableAgentRoles(launchDraft.loop, availableAgentNames)
    : [];
  const launchEvaluatorModelInvalid = Boolean(
    launchDraft?.evaluatorModel &&
      evaluatorModels.length > 0 &&
      !evaluatorModelAvailable(launchDraft.evaluatorProvider, launchDraft.evaluatorModel),
  );
  const launchEvaluatorInvalid = Boolean(
    launchDraft && !validThinkingLevels.includes(launchDraft.evaluatorThinkingLevel),
  );
  const launchNeedsCheckoutConfirmation = launchDraft?.loop.writeTarget === "currentCheckout";
  const renderAgentOptions = (selected: string) => (
    <>
      <option value="">Select an agent</option>
      {selected && !availableAgentNames.has(selected) ? (
        <option value={selected}>{selected} (unavailable)</option>
      ) : null}
      {agents.map((agent: AgentInfo) => (
        <option key={`${agent.scope}-${agent.name}`} value={agent.name}>
          {agent.name}
        </option>
      ))}
    </>
  );
  const anyRunActive =
    runs.some((run) => run.status === "running" || run.status === "stopping") ||
    activeRun?.status === "running" ||
    activeRun?.status === "stopping";
  const parallelAnnouncement = activeRun ? parallelStatusAnnouncement(activeRun) : undefined;
  const recoveryAcknowledgementRequired = Boolean(
    activeRun?.status === "interrupted" &&
      activeRun.launch?.writeTarget === "currentCheckout" &&
      activeRun.launch.checkoutLockKey &&
      !activeRun.launch.checkoutAcknowledgedAt,
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-testid="loops-screen">
      <SectionHero
        imageSrc="/screen-art/screen-art-loops.jpg"
        title="Loop Bank"
        subtitle={
          <>
            Saved loops repeat an agent run until the validation command passes.
            {currentProjectId ? " Run one in the current project." : " Open a project to run one."}
          </>
        }
        actions={
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
        }
      />
      <div className="min-h-0 min-w-0 flex-1 overflow-x-hidden overflow-y-auto px-6 py-5">
        <div className="mx-auto min-w-0 max-w-3xl">
          {activeRun ? (
            <div
              className="mb-3 min-w-0 overflow-hidden rounded-xl border border-border-strong bg-surface-elevated px-3.5 py-3"
              data-testid="loop-run-panel"
            >
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <div
                  className="min-w-0 max-w-full break-all text-sm font-medium text-text-primary"
                  style={{ fontStretch: "expanded" }}
                >
                  {activeRun.loopName}
                </div>
                <div className="flex max-w-full flex-wrap items-center gap-2">
                  <span
                    data-testid="loop-run-status"
                    data-status={activeRun.status}
                    className="rounded-capsule border border-border-strong px-2 py-0.5 text-detail text-text-secondary"
                  >
                    {RUN_STATUS_LABEL[activeRun.status]}
                  </span>
                  {isLoopRunTerminal(activeRun.status) ? (
                    <>
                      {canRetryLoopRun(activeRun) ? (
                        <ControlButton
                          ref={retryButtonRef}
                          data-testid="loop-run-retry"
                          className="rounded-capsule border border-border-strong px-2 py-0.5 text-detail"
                          disabled={
                            runPending ||
                            Boolean(approvalPending) ||
                            recoveryAcknowledgementRequired
                          }
                          aria-describedby={
                            recoveryAcknowledgementRequired
                              ? "loop-checkout-recovery-notice"
                              : undefined
                          }
                          onClick={openRetry}
                        >
                          Retry
                        </ControlButton>
                      ) : null}
                      {activeRun.definitionSnapshot ? (
                        <ControlButton
                          data-testid="loop-save-definition"
                          className="rounded-capsule border border-border-strong px-2 py-0.5 text-detail"
                          onClick={() => saveLoopFromRun(activeRun)}
                        >
                          Save Loop
                        </ControlButton>
                      ) : null}
                      <ControlButton
                        ref={dismissButtonRef}
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
                {RUN_STATUS_LABEL[activeRun.status]} · Iteration {activeRun.currentIteration}
                {activeRun.maxIterations === 0 ? " · No limit" : ` / ${activeRun.maxIterations}`}
              </div>
              {parallelAnnouncement ? (
                <div
                  className="text-detail text-text-muted"
                  data-testid="loop-parallel-live-status"
                  role="status"
                  aria-live="polite"
                  aria-atomic="true"
                >
                  {parallelAnnouncement}
                </div>
              ) : null}
              {activeRun.stopReason ? (
                <div className="text-detail text-text-muted">
                  {STOP_REASON_LABEL[activeRun.stopReason] ?? "Run ended"}
                </div>
              ) : null}
              {activeRun.launch?.worktree ? (
                <div
                  ref={reviewStatusPanelRef}
                  tabIndex={-1}
                  aria-label="Loop worktree review status"
                  className="mt-2 rounded-lg border border-border-strong px-2 py-1 text-xs text-text-muted"
                  data-testid="loop-retained-worktree"
                >
                  <strong className="text-text-secondary">
                    {activeRun.review?.status === "discarded"
                      ? "Worktree safely archived. Branch and artifacts retained."
                      : activeRun.review?.status === "discardUncertain"
                        ? "Worktree archive outcome needs inspection."
                        : activeRun.review?.status === "applied"
                          ? "Changes applied. Review worktree and branch retained."
                          : activeRun.review?.status === "applyUncertain"
                            ? "Apply outcome needs inspection."
                            : isLoopRunTerminal(activeRun.status)
                              ? "Review worktree retained."
                              : "Review worktree allocated."}
                  </strong>{" "}
                  <span className="break-all">
                    {activeRun.review?.archivedPath ?? activeRun.launch.worktree.path}
                  </span>
                  <span className="block break-all">
                    Branch: {activeRun.launch.worktree.branch}
                  </span>
                  {activeRun.review?.error ? (
                    <span className="block break-words text-danger">{activeRun.review.error}</span>
                  ) : null}
                  {isLoopRunTerminal(activeRun.status) ? (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      {!activeRun.review || activeRun.review.status === "available" ? (
                        <ControlButton
                          data-testid="loop-review-changes"
                          disabled={reviewPending || worktreeRevealPending}
                          onClick={() => void reviewWorktree(activeRun)}
                        >
                          {reviewPending ? "Preparing Review…" : "Review Changes"}
                        </ControlButton>
                      ) : null}
                      {activeRun.review?.status !== "discarded" &&
                      activeRun.review?.status !== "discardUncertain" ? (
                        <ControlButton
                          data-testid="loop-reveal-worktree"
                          disabled={worktreeRevealPending || reviewPending}
                          onClick={() => void revealWorktree(activeRun)}
                        >
                          {worktreeRevealPending ? "Revealing…" : "Reveal Worktree"}
                        </ControlButton>
                      ) : null}
                    </div>
                  ) : null}
                  {worktreeActionMessage ? (
                    <div
                      role="status"
                      className="mt-1 break-all"
                      data-testid="loop-worktree-action-status"
                    >
                      {worktreeActionMessage}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {activeRun.checkpointPrompt && activeRun.stopReason === "humanInputRequired" ? (
                <div
                  className="mt-2 rounded-lg border border-warning px-2 py-2 text-xs"
                  role="alert"
                  data-testid="loop-human-approval-checkpoint"
                >
                  <strong>Approval required.</strong>
                  <p className="mt-1 break-words" data-testid="loop-checkpoint-question">
                    {activeRun.checkpointPrompt}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <ControlButton
                      ref={approveButtonRef}
                      data-testid="loop-approval-approve"
                      className="rounded-capsule border border-border-strong px-2 py-1"
                      disabled={Boolean(approvalPending)}
                      onClick={() => void resolveHumanApproval("approve")}
                    >
                      {approvalPending === "approve" ? "Approving…" : "Approve"}
                    </ControlButton>
                    <ControlButton
                      ref={rejectButtonRef}
                      data-testid="loop-approval-reject"
                      className="rounded-capsule border border-border-strong px-2 py-1 text-danger"
                      disabled={Boolean(approvalPending)}
                      onClick={() => void resolveHumanApproval("reject")}
                    >
                      {approvalPending === "reject" ? "Rejecting…" : "Reject"}
                    </ControlButton>
                  </div>
                  {approvalError ? (
                    <p className="mt-2 text-danger" role="alert" data-testid="loop-approval-error">
                      {approvalError}
                    </p>
                  ) : null}
                  <p className="mt-2 text-text-muted">
                    A decision ends this checkpoint. Retry starts a new linked attempt; approval
                    does not resume this run.
                  </p>
                </div>
              ) : null}
              {activeRun.stopReason === "humanInputRequired" && !activeRun.checkpointPrompt ? (
                <div
                  className="mt-2 rounded-lg border border-warning px-2 py-1 text-xs"
                  role="alert"
                >
                  <strong>Human input required.</strong>{" "}
                  {rationale(activeRun.iterations.at(-1)?.checkerOutput) ??
                    "Review the checker report, then Retry when ready."}
                </div>
              ) : null}
              {activeRun.checkpointPrompt &&
              (activeRun.stopReason === "humanApproved" ||
                activeRun.stopReason === "humanRejected") ? (
                <div
                  className="mt-2 rounded-lg border border-border-strong px-2 py-2 text-xs"
                  role="status"
                  data-testid="loop-approval-resolution"
                >
                  {activeRun.stopReason === "humanApproved" ? (
                    <>
                      <strong>Approval recorded.</strong> This run remains terminal. Retry creates a
                      fresh linked checkpoint.
                    </>
                  ) : (
                    <>
                      <strong>Checkpoint rejected.</strong> Work was rejected and stopped. This
                      checkpoint is terminal and cannot continue.
                    </>
                  )}
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
              {activeRun.artifactDirectory ? (
                <div className="mt-2 space-y-1 text-detail" data-testid="loop-artifact-actions">
                  <ControlButton
                    data-testid="loop-reveal-artifacts"
                    disabled={revealPending}
                    onClick={() => void revealArtifacts(activeRun)}
                  >
                    {revealPending ? "Revealing…" : "Reveal Artifacts"}
                  </ControlButton>
                  {artifactActionMessage ? (
                    <div
                      role="status"
                      className="break-all"
                      data-testid="loop-artifact-action-status"
                    >
                      {artifactActionMessage}
                    </div>
                  ) : null}
                </div>
              ) : null}
              {activeRun.sessionId ? (
                <div className="mt-2 space-y-1 text-detail" data-testid="loop-session-evidence">
                  <div>Session: {activeRun.sessionId}</div>
                  <ControlButton
                    data-testid="loop-open-session"
                    aria-label={`Open session for ${activeRun.loopName}`}
                    onClick={() => void openLoopSession(activeRun)}
                  >
                    Open Session
                  </ControlButton>
                  {activeRun.manifestPath ? (
                    <div className="break-all">Run manifest: {activeRun.manifestPath}</div>
                  ) : null}
                  {activeRun.progressPath ? (
                    <div className="break-all">Progress report: {activeRun.progressPath}</div>
                  ) : null}
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
                      className="min-w-0 overflow-hidden break-words rounded-lg border border-border-subtle p-2 text-detail"
                    >
                      <div className="font-medium text-text-primary">
                        Iteration {iteration.index} · Validation{" "}
                        {iteration.validationPassed === true
                          ? "✓ passed"
                          : iteration.validationPassed === false
                            ? "✗ failed"
                            : "not run"}
                      </div>
                      <ol className="mt-1 min-w-0 max-w-full space-y-1 break-words">
                        {iteration.timeline.map((event) => (
                          <li
                            key={event.id}
                            data-phase={event.phase}
                            className="text-text-secondary"
                          >
                            <span className="font-medium">{PHASE_LABEL[event.phase]}:</span>{" "}
                            {event.note}
                          </li>
                        ))}
                      </ol>
                      {iteration.children
                        .filter((child) => child.phase === "triage")
                        .map((child) => (
                          <div key={child.id} data-testid="loop-triage-status">
                            Triage agent {child.agentName} — {childStatusLabel(child)}
                          </div>
                        ))}
                      {iteration.classificationOutput ? (
                        <div
                          className="mt-1 min-w-0 break-words"
                          data-testid="loop-classification-output"
                        >
                          <span className="font-medium">Classification report:</span>
                          <pre className="mt-1 max-w-full whitespace-pre-wrap break-words font-sans">
                            {iteration.classificationOutput}
                          </pre>
                        </div>
                      ) : null}
                      {iteration.checkerDecision ? (
                        <div data-testid="loop-checker-decision">
                          Checker decision: {iteration.checkerDecision}
                          {rationale(iteration.checkerOutput)
                            ? ` — ${rationale(iteration.checkerOutput)}`
                            : ""}
                        </div>
                      ) : null}
                      {iteration.children.some((child) => child.phase === "branch") ? (
                        <ol
                          className="mt-1 min-w-0 space-y-1 overflow-hidden break-words"
                          data-testid="loop-parallel-branch-statuses"
                          aria-label="Parallel branch statuses"
                        >
                          {iteration.children
                            .filter((child) => child.phase === "branch")
                            .sort((a, b) => (a.branchIndex ?? 0) - (b.branchIndex ?? 0))
                            .map((child) => (
                              <li key={child.id} data-branch-index={child.branchIndex}>
                                Branch {(child.branchIndex ?? 0) + 1}: {child.agentName} —{" "}
                                <span>{childStatusLabel(child)}</span>
                                {child.output ? ` — ${child.output}` : ""}
                                {child.error ? ` — ${child.error}` : ""}
                              </li>
                            ))}
                        </ol>
                      ) : null}
                      {iteration.parallelBranchOutputs?.length ? (
                        <ol
                          className="mt-1 min-w-0 max-w-full break-all"
                          data-testid="loop-parallel-branch-outputs"
                        >
                          {iteration.parallelBranchOutputs.map((branch) => (
                            <li key={branch.id} data-branch-index={branch.branchIndex}>
                              Configured branch {branch.branchIndex + 1}: {branch.agentName} —{" "}
                              {branch.output ?? `Failed: ${branch.error ?? "unknown error"}`}
                            </li>
                          ))}
                        </ol>
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
                      {iteration.validationResult ? (
                        <section
                          data-testid="loop-validation-evidence"
                          aria-label={`Validation for iteration ${iteration.index}`}
                          className="space-y-1"
                        >
                          <div>
                            Validation: {iteration.validationResult.command} · exit{" "}
                            {iteration.validationResult.exitCode ?? "unavailable"} ·{" "}
                            {iteration.validationResult.durationMs}ms ·{" "}
                            {iteration.validationResult.classification}
                          </div>
                          <div className="break-all">
                            Working directory: {iteration.validationResult.workingDirectory}
                          </div>
                          {iteration.artifacts.some(
                            (artifact) => artifact.phase === "validation",
                          ) ? (
                            <ul aria-label="Validation output artifacts">
                              {iteration.artifacts
                                .filter((artifact) => artifact.phase === "validation")
                                .map((artifact) => (
                                  <li key={artifact.id} className="break-all">
                                    {artifact.filename} · {artifact.bytes} bytes
                                  </li>
                                ))}
                            </ul>
                          ) : null}
                          {iteration.validationResult.stdout ? (
                            <pre
                              className="max-h-40 overflow-auto whitespace-pre-wrap break-words"
                              aria-label="Validation stdout"
                            >
                              {iteration.validationResult.stdout}
                            </pre>
                          ) : null}
                          {iteration.validationResult.stderr ? (
                            <pre
                              className="max-h-40 overflow-auto whitespace-pre-wrap break-words"
                              aria-label="Validation stderr"
                            >
                              {iteration.validationResult.stderr}
                            </pre>
                          ) : null}
                        </section>
                      ) : iteration.validationEvidence ? (
                        <div data-testid="loop-validation-evidence">
                          Validation evidence: {iteration.validationEvidence}
                        </div>
                      ) : null}
                      {iteration.manifestPath ? (
                        <div className="break-all">
                          Iteration manifest: {iteration.manifestPath}
                        </div>
                      ) : null}
                      {iteration.changedFiles?.length ? (
                        <ul aria-label={`Changed files for iteration ${iteration.index}`}>
                          {iteration.changedFiles.map((change, index) => (
                            <li
                              key={`${change.status}-${change.path}-${index}`}
                              className="break-all"
                            >
                              {change.status}: {change.oldPath ? `${change.oldPath} → ` : ""}
                              {change.path}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <div>Changed files: none</div>
                      )}
                      {iteration.artifacts?.length ? (
                        <div>
                          Report artifacts:{" "}
                          {iteration.artifacts.map((artifact) => artifact.filename).join(", ")}
                        </div>
                      ) : null}
                      {iteration.children
                        .filter((child) => child.error)
                        .map((child) => (
                          <div key={child.id} role="alert" className="break-words text-danger">
                            {child.phase === "branch"
                              ? `Parallel branch ${child.agentName ?? (child.branchIndex ?? 0) + 1} failed: ${child.error}`
                              : `${PHASE_LABEL[child.phase]} error: ${child.error}`}
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
                  .slice(0, 12)
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
                      {run.stopReason
                        ? ` · ${STOP_REASON_LABEL[run.stopReason] ?? "Run ended"}`
                        : ""}
                    </ControlButton>
                  ))}
              </div>
            </div>
          ) : null}

          <div className="space-y-1.5" data-testid="loop-list">
            {!loaded ? <SkeletonRows count={3} /> : null}
            {loops.map((loop, index) => {
              const runnable = !loopDefinitionValidationError(loop);
              const available = currentProject
                ? isLoopAvailableInProject(loop, currentProject.path)
                : false;
              const unavailableId = `loop-unavailable-${index}`;
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
                      {LOOP_STRUCTURE_LABEL[loop.structure]} ·{" "}
                      {loop.maxIterations === 0 ? "Unlimited" : `${loop.maxIterations}×`} ·{" "}
                      {loop.description || "No description"}
                    </div>
                    <div className="truncate text-detail text-text-muted">
                      {loop.availability === "allProjects"
                        ? "Available in all projects"
                        : `Assigned to ${loop.projectPaths.length} project${loop.projectPaths.length === 1 ? "" : "s"}`}
                    </div>
                    {!runnable || (currentProject && !available) ? (
                      <div
                        id={unavailableId}
                        data-testid={`loop-unavailable-${loop.name}`}
                        className="mt-1 text-detail text-text-secondary"
                      >
                        {!runnable
                          ? loop.structure === "parallelAgents"
                            ? "Parallel agents are report-only. Edit this definition to use Artifact (markdown) before saving or running."
                            : "This structure is unavailable. Convert it before saving or running."
                          : `Unavailable in ${currentProject?.name ?? "this project"}. Assign this Loop to the project to run it.`}
                      </div>
                    ) : null}
                  </ControlButton>
                  <ControlButton
                    data-testid={`loop-run-${loop.name}`}
                    className="flex items-center gap-1 rounded-capsule border border-border-strong px-2.5 py-1 text-xs text-text-secondary hover:text-text-primary disabled:opacity-40"
                    title={
                      !runnable
                        ? "Unavailable until its definition is valid"
                        : currentProject && !available
                          ? "Loop is not assigned to this project"
                          : currentProjectId
                            ? "Configure and run loop"
                            : "Open a project to run"
                    }
                    aria-describedby={
                      !runnable || (currentProject && !available) ? unavailableId : undefined
                    }
                    disabled={
                      !runnable ||
                      !available ||
                      !currentProjectId ||
                      runPending ||
                      Boolean(anyRunActive)
                    }
                    onClick={() => openLaunch(loop)}
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

        {reviewDialog ? (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-2 sm:p-6">
            <div
              ref={reviewDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="loop-review-title"
              data-testid="loop-review-dialog"
              className="flex max-h-[calc(100vh-1rem)] min-w-0 w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border-strong bg-surface-elevated shadow-elevated"
            >
              <div className="flex items-center justify-between gap-2 border-b border-border-subtle p-3">
                <h3 id="loop-review-title" className="min-w-0 break-words text-sm font-semibold">
                  Review changes · {reviewDialog.run.loopName}
                </h3>
                <ControlButton
                  aria-label="Close worktree review"
                  onClick={closeReview}
                  disabled={Boolean(reviewActionPending)}
                >
                  <X size={14} />
                </ControlButton>
              </div>
              <div className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3">
                <h4 className="text-xs font-semibold">Changed files</h4>
                {reviewDialog.changedFiles.length ? (
                  <ul
                    className="mt-1 max-h-36 overflow-auto rounded border border-border-subtle p-2 text-xs"
                    data-testid="loop-review-files"
                  >
                    {reviewDialog.changedFiles.map((file, index) => (
                      <li key={`${file.path}-${index}`} className="break-all">
                        {file.status}: {file.oldPath ? `${file.oldPath} → ` : ""}
                        {file.path}
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-xs text-text-muted">No changes.</p>
                )}
                <h4 className="mt-3 text-xs font-semibold">Patch</h4>
                <pre
                  className="mt-1 max-h-[38vh] min-w-0 overflow-auto whitespace-pre text-xs"
                  data-testid="loop-review-patch"
                >
                  {reviewDialog.patch || "No patch content."}
                </pre>
                {reviewDialog.patchTruncated ? (
                  <p className="text-xs text-warning">
                    Preview truncated; the complete bounded binary patch is stored in run artifacts.
                  </p>
                ) : null}
                <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border border-border-strong p-2 text-xs">
                    <label className="flex items-start gap-2">
                      <ControlInput
                        type="checkbox"
                        aria-label="Confirm applying the reviewed patch"
                        data-testid="loop-review-apply-confirmation"
                        checked={reviewConfirmed}
                        onChange={(event) => setReviewConfirmed(event.target.checked)}
                      />
                      Apply this reviewed patch to the clean project checkout. The worktree and
                      branch will be retained.
                    </label>
                    <ControlButton
                      data-testid="loop-review-apply"
                      className="mt-2"
                      disabled={
                        !reviewConfirmed ||
                        Boolean(reviewActionPending) ||
                        !reviewDialog.changedFiles.length
                      }
                      onClick={() => void decideWorktree("apply")}
                    >
                      {reviewActionPending === "apply" ? "Applying…" : "Apply Changes"}
                    </ControlButton>
                  </div>
                  <div className="rounded-lg border border-danger p-2 text-xs">
                    <p>
                      Safely archive this owned worktree under Agent Deck's private root. Nothing is
                      recursively deleted; the branch and artifacts remain.
                    </p>
                    <label className="mt-2 block">
                      Type <strong className="break-all">{reviewDialog.run.loopName}</strong>
                      <ControlInput
                        data-testid="loop-discard-name"
                        className="mt-1 w-full"
                        value={discardName}
                        onChange={(event) => setDiscardName(event.target.value)}
                      />
                    </label>
                    <ControlButton
                      data-testid="loop-review-discard"
                      className="mt-2 text-danger"
                      disabled={
                        discardName !== reviewDialog.run.loopName || Boolean(reviewActionPending)
                      }
                      onClick={() => void decideWorktree("discard")}
                    >
                      {reviewActionPending === "discard" ? "Archiving…" : "Safely Archive Worktree"}
                    </ControlButton>
                  </div>
                </div>
                {reviewError ? (
                  <p
                    role="alert"
                    data-testid="loop-review-error"
                    className="mt-2 text-xs text-danger"
                  >
                    {reviewError}
                  </p>
                ) : null}
              </div>
            </div>
          </div>
        ) : null}

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
                  onChange={(event) => {
                    const goal = event.target.value;
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            goal,
                            successCondition:
                              current.successConditionSource === "goal"
                                ? goal
                                : current.successCondition,
                          }
                        : current,
                    );
                  }}
                />
              </label>
              <label className="block text-xs text-text-muted">
                Launch context / arguments
                <ControlTextArea
                  data-testid="loop-launch-context"
                  className={`${inputClass} min-h-[76px]`}
                  value={draft.launchContext}
                  onChange={(event) => setDraft({ ...draft, launchContext: event.target.value })}
                />
                <span className="mt-1 block text-detail">
                  Optional background or constraints kept separate from the Loop goal.
                </span>
              </label>
              {draft.launchContext.trim() ? (
                <label className="block text-xs text-text-muted">
                  Context scope
                  <ControlSelect
                    data-testid="loop-launch-context-scope"
                    className={inputClass}
                    value={draft.launchContextScope}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        launchContextScope: event.target.value as LoopDraft["launchContextScope"],
                      })
                    }
                  >
                    <option value="firstIterationOnly">First iteration only</option>
                    <option value="everyIteration">Every iteration</option>
                  </ControlSelect>
                </label>
              ) : null}
              <fieldset className="space-y-2 rounded-lg border border-border-subtle p-2">
                <legend className="px-1 text-xs font-medium text-text-secondary">
                  Project availability
                </legend>
                <label className="flex items-center gap-2 text-xs text-text-primary">
                  <ControlInput
                    type="radio"
                    name="loop-availability"
                    value="allProjects"
                    checked={draft.availability === "allProjects"}
                    onChange={() => setDraft({ ...draft, availability: "allProjects" })}
                  />
                  All projects
                </label>
                <label className="flex items-center gap-2 text-xs text-text-primary">
                  <ControlInput
                    type="radio"
                    name="loop-availability"
                    value="projectPaths"
                    checked={draft.availability === "projectPaths"}
                    onChange={() =>
                      setDraft({
                        ...draft,
                        availability: "projectPaths",
                        projectPaths:
                          draft.projectPaths.length || !currentProject
                            ? draft.projectPaths
                            : [currentProject.path],
                      })
                    }
                  />
                  Selected registered projects
                </label>
                {draft.availability === "projectPaths" ? (
                  <div className="space-y-1 pl-5" data-testid="loop-project-assignments">
                    {projects.map((project) => (
                      <label key={project.id} className="flex items-center gap-2 text-xs">
                        <ControlInput
                          type="checkbox"
                          checked={draft.projectPaths.includes(project.path)}
                          onChange={(event) =>
                            setDraft({
                              ...draft,
                              projectPaths: event.target.checked
                                ? normalizeLoopProjectPaths([...draft.projectPaths, project.path])
                                : draft.projectPaths.filter((path) => path !== project.path),
                            })
                          }
                        />
                        <span>{project.name}</span>
                        {project.id === currentProjectId ? (
                          <span className="text-text-muted">Current project</span>
                        ) : null}
                      </label>
                    ))}
                    {!projects.length ? (
                      <p className="text-detail text-text-muted">No registered projects.</p>
                    ) : null}
                  </div>
                ) : null}
              </fieldset>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-xs text-text-muted">
                  Structure
                  <ControlSelect
                    data-testid="loop-structure"
                    className={inputClass}
                    value={draft.structure}
                    onChange={(e) => {
                      const structure = e.target.value as LoopDraft["structure"];
                      setDraft({
                        ...draft,
                        structure,
                        ...(structure === "parallelAgents"
                          ? { writeTarget: "artifactMarkdown" as const }
                          : {}),
                        ...(structure === "discoveryTriage"
                          ? {
                              classificationPrompt: normalizeLoopClassificationPrompt(
                                draft.classificationPrompt,
                              ),
                            }
                          : {}),
                        ...(structure === "humanApproval"
                          ? {
                              checkpointPrompt: normalizeLoopCheckpointPrompt(
                                draft.checkpointPrompt,
                              ),
                            }
                          : {}),
                      });
                      if (structure === "discoveryTriage") {
                        requestAnimationFrame(() => triageAgentRef.current?.focus());
                      } else if (structure === "humanApproval") {
                        requestAnimationFrame(() => checkpointPromptRef.current?.focus());
                      }
                    }}
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
                    <ControlSelect
                      data-testid="loop-agent"
                      className={inputClass}
                      value={draft.agentName}
                      aria-invalid={!availableAgentNames.has(draft.agentName)}
                      onChange={(e) => setDraft({ ...draft, agentName: e.target.value })}
                    >
                      {renderAgentOptions(draft.agentName)}
                    </ControlSelect>
                  </label>
                ) : null}
              </div>
              {draft.structure === "makerChecker" ? (
                <div className="space-y-3" data-testid="loop-maker-checker-config">
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <label className="text-xs text-text-muted">
                      Maker agent
                      <ControlSelect
                        data-testid="loop-maker"
                        className={inputClass}
                        value={draft.makerName}
                        aria-invalid={!availableAgentNames.has(draft.makerName)}
                        onChange={(e) => setDraft({ ...draft, makerName: e.target.value })}
                      >
                        {renderAgentOptions(draft.makerName)}
                      </ControlSelect>
                    </label>
                    <label className="text-xs text-text-muted">
                      Checker agent
                      <ControlSelect
                        data-testid="loop-checker"
                        className={inputClass}
                        value={draft.checkerName}
                        aria-invalid={!availableAgentNames.has(draft.checkerName)}
                        onChange={(e) => setDraft({ ...draft, checkerName: e.target.value })}
                      >
                        {renderAgentOptions(draft.checkerName)}
                      </ControlSelect>
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
                      <ControlSelect
                        className={inputClass}
                        data-testid={`loop-pipeline-stage-agent-${index}`}
                        aria-label={`Pipeline stage ${index + 1} agent`}
                        aria-invalid={!availableAgentNames.has(stage)}
                        disabled={saving}
                        value={stage}
                        onChange={(event) => {
                          const pipelineStages = [...draft.pipelineStages];
                          pipelineStages[index] = event.target.value;
                          setDraft({ ...draft, pipelineStages });
                        }}
                      >
                        {renderAgentOptions(stage)}
                      </ControlSelect>
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
              {draft.structure === "parallelAgents" ? (
                <fieldset
                  className="space-y-2 rounded-lg border border-border-subtle p-2"
                  data-testid="loop-parallel-config"
                  aria-describedby="loop-parallel-help loop-parallel-safety"
                >
                  <legend className="px-1 text-xs font-medium text-text-secondary">
                    Parallel branch agents
                  </legend>
                  <p id="loop-parallel-help" className="text-detail text-text-muted">
                    Branches investigate independently with at most two running concurrently. Blank
                    entries are removed and duplicate names keep their first position.
                  </p>
                  <p id="loop-parallel-safety" className="text-detail text-text-secondary">
                    Safety: Parallel agents are report-only, receive read-only tools, and always
                    save reports to Loop-owned app data—not the project checkout or a worktree.
                  </p>
                  {draft.parallelBranches.map((branch, index) => (
                    <div
                      key={index}
                      className="flex items-center gap-1"
                      data-testid={`loop-parallel-branch-${index}`}
                    >
                      <span className="w-5 text-detail text-text-muted">{index + 1}.</span>
                      <ControlSelect
                        className={inputClass}
                        data-testid={`loop-parallel-branch-agent-${index}`}
                        aria-label={`Parallel branch ${index + 1} agent`}
                        aria-invalid={!availableAgentNames.has(branch)}
                        disabled={saving}
                        value={branch}
                        onChange={(event) => {
                          const parallelBranches = [...draft.parallelBranches];
                          parallelBranches[index] = event.target.value;
                          setDraft({ ...draft, parallelBranches });
                        }}
                      >
                        {renderAgentOptions(branch)}
                      </ControlSelect>
                      <ControlButton
                        type="button"
                        title="Move branch up"
                        aria-label={`Move parallel branch ${index + 1} up`}
                        disabled={saving || index === 0}
                        onClick={() => {
                          const parallelBranches = [...draft.parallelBranches];
                          [parallelBranches[index - 1], parallelBranches[index]] = [
                            parallelBranches[index]!,
                            parallelBranches[index - 1]!,
                          ];
                          setDraft({ ...draft, parallelBranches });
                        }}
                      >
                        <ArrowUp size={13} aria-hidden />
                      </ControlButton>
                      <ControlButton
                        type="button"
                        title="Move branch down"
                        aria-label={`Move parallel branch ${index + 1} down`}
                        disabled={saving || index === draft.parallelBranches.length - 1}
                        onClick={() => {
                          const parallelBranches = [...draft.parallelBranches];
                          [parallelBranches[index], parallelBranches[index + 1]] = [
                            parallelBranches[index + 1]!,
                            parallelBranches[index]!,
                          ];
                          setDraft({ ...draft, parallelBranches });
                        }}
                      >
                        <ArrowDown size={13} aria-hidden />
                      </ControlButton>
                      <ControlButton
                        type="button"
                        title="Remove branch"
                        aria-label={`Remove parallel branch ${index + 1}`}
                        disabled={saving}
                        onClick={() =>
                          setDraft({
                            ...draft,
                            parallelBranches: draft.parallelBranches.filter(
                              (_branch, branchIndex) => branchIndex !== index,
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
                    data-testid="loop-parallel-add-branch"
                    className="flex items-center gap-1 rounded-capsule border border-border-strong px-2 py-1 text-xs"
                    disabled={saving}
                    onClick={() =>
                      setDraft({
                        ...draft,
                        parallelBranches: [...draft.parallelBranches, ""],
                      })
                    }
                  >
                    <Plus size={12} aria-hidden /> Add branch
                  </ControlButton>
                </fieldset>
              ) : null}
              {draft.structure === "discoveryTriage" ? (
                <fieldset
                  className="space-y-3 rounded-lg border border-border-subtle p-2"
                  data-testid="loop-triage-config"
                  aria-describedby="loop-triage-help"
                >
                  <legend className="px-1 text-xs font-medium text-text-secondary">
                    Discovery and classification
                  </legend>
                  <p id="loop-triage-help" className="text-detail text-text-muted">
                    The selected agent runs once per iteration. Artifact targets are report-only;
                    checkout and worktree targets permit edits only when the goal explicitly
                    requests implementation.
                  </p>
                  <label className="block text-xs text-text-muted">
                    Triage agent
                    <ControlSelect
                      ref={triageAgentRef}
                      data-testid="loop-triage-agent"
                      className={inputClass}
                      value={draft.triageAgent}
                      aria-invalid={!availableAgentNames.has(draft.triageAgent)}
                      onChange={(event) => setDraft({ ...draft, triageAgent: event.target.value })}
                    >
                      {renderAgentOptions(draft.triageAgent)}
                    </ControlSelect>
                  </label>
                  <label className="block text-xs text-text-muted">
                    Classification prompt
                    <ControlTextArea
                      data-testid="loop-classification-prompt"
                      className={`${inputClass} min-h-[100px]`}
                      value={draft.classificationPrompt}
                      onChange={(event) =>
                        setDraft({ ...draft, classificationPrompt: event.target.value })
                      }
                      onBlur={() => {
                        if (!draft.classificationPrompt.trim()) {
                          setDraft({
                            ...draft,
                            classificationPrompt: LOOP_DEFAULT_CLASSIFICATION_PROMPT,
                          });
                        }
                      }}
                    />
                  </label>
                </fieldset>
              ) : null}
              {draft.structure === "humanApproval" ? (
                <fieldset
                  className="space-y-3 rounded-lg border border-border-subtle p-2"
                  data-testid="loop-human-approval-config"
                  aria-describedby="loop-human-approval-help"
                >
                  <legend className="px-1 text-xs font-medium text-text-secondary">
                    Approval checkpoint
                  </legend>
                  <p id="loop-human-approval-help" className="text-detail text-text-muted">
                    Launch records a terminal checkpoint without running an agent or validation.
                    Approval records the decision; it does not resume this run. Retry starts a fresh
                    linked checkpoint.
                  </p>
                  <label className="block text-xs text-text-muted">
                    Checkpoint prompt
                    <ControlTextArea
                      ref={checkpointPromptRef}
                      data-testid="loop-checkpoint-prompt"
                      className={`${inputClass} min-h-[100px]`}
                      value={draft.checkpointPrompt}
                      onChange={(event) =>
                        setDraft({ ...draft, checkpointPrompt: event.target.value })
                      }
                      onBlur={() => {
                        if (!draft.checkpointPrompt.trim()) {
                          setDraft({ ...draft, checkpointPrompt: LOOP_DEFAULT_CHECKPOINT_PROMPT });
                        }
                      }}
                    />
                  </label>
                </fieldset>
              ) : null}
              {draftAgentIssues.length ? (
                <div
                  className="rounded-lg border border-danger px-2 py-1 text-xs text-danger"
                  role="status"
                  aria-live="polite"
                  data-testid="loop-agent-role-errors"
                >
                  <strong>Unavailable agent roles.</strong>
                  <ul className="list-disc pl-4">
                    {draftAgentIssues.map((issue) => (
                      <li key={`${issue.role}-${issue.position ?? 0}`}>
                        {agentUnavailableText(issue)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="text-xs text-text-muted">
                  Max iterations
                  <ControlInput
                    data-testid="loop-max-iterations"
                    type="number"
                    min={0}
                    max={LOOP_MAX_ITERATIONS_LIMIT}
                    step={1}
                    className={inputClass}
                    value={draft.maxIterations}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        maxIterations: Number.isFinite(Number(e.target.value))
                          ? Math.min(
                              LOOP_MAX_ITERATIONS_LIMIT,
                              Math.max(0, Math.trunc(Number(e.target.value))),
                            )
                          : LOOP_DEFAULT_MAX_ITERATIONS,
                      })
                    }
                  />
                  <span className="mt-1 block text-detail">
                    0 means no iteration limit; Stop remains available. Maximum 100.
                  </span>
                </label>
                <label className="text-xs text-text-muted">
                  Write target
                  <ControlSelect
                    data-testid="loop-write-target"
                    className={inputClass}
                    value={draft.writeTarget}
                    disabled={saving || draft.structure === "parallelAgents"}
                    aria-describedby={
                      draft.structure === "parallelAgents" ? "loop-parallel-safety" : undefined
                    }
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        writeTarget: e.target.value as LoopDraft["writeTarget"],
                      })
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
                Success condition
                <ControlTextArea
                  data-testid="loop-success-condition"
                  className={`${inputClass} min-h-[80px]`}
                  value={draft.successCondition}
                  placeholder="Defaults to the Loop goal"
                  onChange={(event) =>
                    setDraft((current) =>
                      current
                        ? {
                            ...current,
                            successCondition: event.target.value,
                            successConditionSource: "custom",
                          }
                        : current,
                    )
                  }
                />
                <span className="mt-1 flex items-center justify-between gap-2 text-detail">
                  <span>
                    {draft.successConditionSource === "goal"
                      ? "Tracks the Loop goal."
                      : "Uses an explicit custom condition."}
                  </span>
                  {draft.successConditionSource === "custom" ? (
                    <ControlButton
                      type="button"
                      data-testid="loop-success-condition-reset"
                      onClick={() =>
                        setDraft((current) =>
                          current
                            ? {
                                ...current,
                                successCondition: current.goal,
                                successConditionSource: "goal",
                              }
                            : current,
                        )
                      }
                    >
                      Reset to goal
                    </ControlButton>
                  ) : null}
                </span>
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-xs text-text-muted">
                  Evaluator model override
                  <ControlSelect
                    data-testid="loop-evaluator-model"
                    className={inputClass}
                    value={evaluatorModelValue(draft.evaluatorProvider, draft.evaluatorModel)}
                    onChange={(event) => {
                      const [evaluatorProvider, evaluatorModel] = parseEvaluatorModelValue(
                        event.target.value,
                      );
                      setDraft({ ...draft, evaluatorProvider, evaluatorModel });
                    }}
                  >
                    {renderEvaluatorModelOptions(draft.evaluatorProvider, draft.evaluatorModel)}
                  </ControlSelect>
                </label>
                <label className="block text-xs text-text-muted">
                  Evaluator thinking override
                  <ControlSelect
                    data-testid="loop-evaluator-thinking"
                    className={inputClass}
                    value={draft.evaluatorThinkingLevel}
                    onChange={(event) =>
                      setDraft({ ...draft, evaluatorThinkingLevel: event.target.value })
                    }
                  >
                    <option value="">Default</option>
                    {LOOP_EVALUATOR_THINKING_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                    {draft.evaluatorThinkingLevel &&
                    !LOOP_EVALUATOR_THINKING_LEVELS.includes(
                      draft.evaluatorThinkingLevel as (typeof LOOP_EVALUATOR_THINKING_LEVELS)[number],
                    ) ? (
                      <option value={draft.evaluatorThinkingLevel} disabled>
                        {draft.evaluatorThinkingLevel} (unavailable)
                      </option>
                    ) : null}
                  </ControlSelect>
                </label>
              </div>
              <label className="block text-xs text-text-muted">
                Validation command (optional; exit 0 satisfies validation)
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

        {launchDraft ? (
          <div
            className="fixed inset-0 z-50 flex items-center justify-center bg-overlay p-3 sm:p-8"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget && !runPending) closeLaunch();
            }}
          >
            <div
              ref={launchDialogRef}
              role="dialog"
              aria-modal="true"
              aria-labelledby="loop-launch-title"
              data-testid="loop-launch-dialog"
              className="flex max-h-[calc(100vh-1.5rem)] w-full max-w-[560px] flex-col gap-3 overflow-y-auto rounded-2xl border border-border-strong bg-surface-elevated p-4 shadow-elevated sm:max-h-[85vh]"
            >
              <h3 id="loop-launch-title" className="text-sm font-semibold text-text-primary">
                {launchDraft.retryOf ? "Retry" : "Run"} {launchDraft.loop.name}
              </h3>
              <p className="text-xs text-text-muted">
                {LOOP_STRUCTURE_LABEL[launchDraft.loop.structure]} ·{" "}
                {launchDraft.loop.maxIterations === 0
                  ? "No iteration limit"
                  : `Up to ${launchDraft.loop.maxIterations} iterations`}
              </p>
              <label className="block text-xs text-text-muted">
                Run goal
                <ControlTextArea
                  data-testid="loop-launch-goal"
                  className={`${inputClass} min-h-[100px]`}
                  value={launchDraft.goal}
                  disabled={runPending || Boolean(launchDraft.retryOf)}
                  onChange={(event) => {
                    const goal = event.target.value;
                    setLaunchDraft((current) =>
                      current
                        ? {
                            ...current,
                            goal,
                            successCondition:
                              current.successConditionSource === "goal"
                                ? goal
                                : current.successCondition,
                          }
                        : current,
                    );
                  }}
                />
              </label>
              <label className="block text-xs text-text-muted">
                Launch context / arguments
                <ControlTextArea
                  data-testid="loop-launch-context-override"
                  className={`${inputClass} min-h-[90px]`}
                  value={launchDraft.launchContext}
                  disabled={runPending || Boolean(launchDraft.retryOf)}
                  onChange={(event) => {
                    const launchContext = event.target.value;
                    setLaunchDraft((current) =>
                      current ? { ...current, launchContext } : current,
                    );
                  }}
                />
              </label>
              <label className="block text-xs text-text-muted">
                Context scope
                <ControlSelect
                  data-testid="loop-launch-scope-override"
                  className={inputClass}
                  value={launchDraft.launchContextScope}
                  disabled={runPending || Boolean(launchDraft.retryOf)}
                  onChange={(event) => {
                    const launchContextScope = event.target
                      .value as LoopLaunchDraft["launchContextScope"];
                    setLaunchDraft((current) =>
                      current ? { ...current, launchContextScope } : current,
                    );
                  }}
                >
                  <option value="firstIterationOnly">First iteration only</option>
                  <option value="everyIteration">Every iteration</option>
                </ControlSelect>
              </label>
              <label className="block text-xs text-text-muted">
                Success condition
                <ControlTextArea
                  data-testid="loop-launch-success-condition"
                  className={`${inputClass} min-h-[80px]`}
                  value={launchDraft.successCondition}
                  disabled={runPending || Boolean(launchDraft.retryOf)}
                  onChange={(event) => {
                    const successCondition = event.target.value;
                    setLaunchDraft((current) =>
                      current
                        ? { ...current, successCondition, successConditionSource: "custom" }
                        : current,
                    );
                  }}
                />
                <span className="mt-1 flex items-center justify-between gap-2 text-detail">
                  <span>
                    {launchDraft.successConditionSource === "goal"
                      ? "Tracks the effective launch goal."
                      : "Uses an explicit custom condition."}
                  </span>
                  {launchDraft.successConditionSource === "custom" && !launchDraft.retryOf ? (
                    <ControlButton
                      type="button"
                      data-testid="loop-launch-success-condition-reset"
                      disabled={runPending}
                      onClick={() =>
                        setLaunchDraft((current) =>
                          current
                            ? {
                                ...current,
                                successCondition: current.goal,
                                successConditionSource: "goal",
                              }
                            : current,
                        )
                      }
                    >
                      Reset to goal
                    </ControlButton>
                  ) : null}
                </span>
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="block text-xs text-text-muted">
                  Evaluator model
                  <ControlSelect
                    data-testid="loop-launch-evaluator-model"
                    className={inputClass}
                    value={evaluatorModelValue(
                      launchDraft.evaluatorProvider,
                      launchDraft.evaluatorModel,
                    )}
                    disabled={runPending || Boolean(launchDraft.retryOf)}
                    onChange={(event) => {
                      const [evaluatorProvider, evaluatorModel] = parseEvaluatorModelValue(
                        event.target.value,
                      );
                      setLaunchDraft((current) =>
                        current ? { ...current, evaluatorProvider, evaluatorModel } : current,
                      );
                    }}
                  >
                    {renderEvaluatorModelOptions(
                      launchDraft.evaluatorProvider,
                      launchDraft.evaluatorModel,
                    )}
                  </ControlSelect>
                </label>
                <label className="block text-xs text-text-muted">
                  Evaluator thinking
                  <ControlSelect
                    data-testid="loop-launch-evaluator-thinking"
                    className={inputClass}
                    value={launchDraft.evaluatorThinkingLevel}
                    disabled={runPending || Boolean(launchDraft.retryOf)}
                    onChange={(event) => {
                      const evaluatorThinkingLevel = event.target.value;
                      setLaunchDraft((current) =>
                        current ? { ...current, evaluatorThinkingLevel } : current,
                      );
                    }}
                  >
                    <option value="">Default</option>
                    {validThinkingLevels.slice(1).map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                    {launchEvaluatorInvalid ? (
                      <option value={launchDraft.evaluatorThinkingLevel} disabled>
                        {launchDraft.evaluatorThinkingLevel} (unavailable)
                      </option>
                    ) : null}
                  </ControlSelect>
                </label>
              </div>
              {launchEvaluatorModelInvalid || launchEvaluatorInvalid ? (
                <p role="alert" className="text-xs text-danger">
                  The saved evaluator {launchEvaluatorModelInvalid ? "model" : "thinking level"} is
                  unavailable. Repair it before launch.
                </p>
              ) : null}
              {launchAgentIssues.length ? (
                <div
                  id="loop-launch-agent-errors"
                  role="status"
                  aria-live="polite"
                  className="rounded-lg border border-danger p-2 text-xs text-danger"
                  data-testid="loop-launch-agent-errors"
                >
                  <strong>Required agents are unavailable in this project.</strong>
                  <ul className="list-disc pl-4">
                    {launchAgentIssues.map((issue) => (
                      <li key={`${issue.role}-${issue.position ?? 0}`}>
                        {agentUnavailableText(issue)}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}
              {launchNeedsCheckoutConfirmation ? (
                <label
                  id="loop-current-checkout-confirmation-label"
                  className="flex items-start gap-2 rounded-lg border border-warning p-2 text-xs text-text-secondary"
                >
                  <ControlInput
                    type="checkbox"
                    data-testid="loop-current-checkout-confirmation"
                    checked={launchDraft.currentCheckoutConfirmed}
                    disabled={runPending}
                    onChange={(event) => {
                      const currentCheckoutConfirmed = event.target.checked;
                      setLaunchDraft((current) =>
                        current ? { ...current, currentCheckoutConfirmed } : current,
                      );
                    }}
                  />
                  <span>
                    I confirm this Loop may run agents directly in the current project checkout.
                  </span>
                </label>
              ) : null}
              {launchError ? (
                <div
                  role="alert"
                  aria-live="assertive"
                  className="rounded-lg bg-danger-subtle p-2 text-xs"
                >
                  {launchError}
                </div>
              ) : null}
              <div className="flex justify-end gap-2">
                <ControlButton
                  data-testid="loop-launch-cancel"
                  className="rounded-capsule border border-border-strong px-4 py-1.5 text-sm"
                  disabled={runPending}
                  onClick={closeLaunch}
                >
                  Cancel
                </ControlButton>
                <ControlButton
                  data-testid="loop-launch-confirm"
                  className="rounded-capsule bg-accent px-4 py-1.5 text-sm font-medium text-accent-foreground disabled:opacity-40"
                  disabled={
                    runPending ||
                    launchAgentIssues.length > 0 ||
                    launchEvaluatorModelInvalid ||
                    launchEvaluatorInvalid ||
                    (launchDraft.loop.structure !== "humanApproval" && !launchDraft.goal.trim()) ||
                    (launchNeedsCheckoutConfirmation && !launchDraft.currentCheckoutConfirmed)
                  }
                  aria-describedby={
                    launchAgentIssues.length
                      ? "loop-launch-agent-errors"
                      : launchNeedsCheckoutConfirmation && !launchDraft.currentCheckoutConfirmed
                        ? "loop-current-checkout-confirmation-label"
                        : undefined
                  }
                  onClick={() => void startRun()}
                >
                  {runPending ? "Starting…" : launchDraft.retryOf ? "Start retry" : "Start run"}
                </ControlButton>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
