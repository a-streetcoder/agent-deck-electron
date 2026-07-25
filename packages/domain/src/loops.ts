/**
 * Loop definitions (native LoopModels.swift LoopDefinition + LoopDefinitionStore):
 * a saved template that repeats an agent run up to `maxIterations` until a
 * validation command succeeds. This is the shared definition/run contract used
 * by the Bank and server coordinator. Persisted definitions are one-file-per-loop
 * under ~/.pi/agent/loops as `.loop.md`
 * (frontmatter + the goal as the markdown body), mirroring the agent catalog.
 */

/** The per-iteration orchestration shape (native LoopStructureKind). */
export type LoopStructure =
  | "singleAgent"
  | "makerChecker"
  | "agentPipeline"
  | "parallelAgents"
  | "discoveryTriage"
  | "humanApproval";

export const LOOP_STRUCTURES: LoopStructure[] = [
  "singleAgent",
  "makerChecker",
  "agentPipeline",
  "parallelAgents",
  "discoveryTriage",
  "humanApproval",
];

/** Structures with an implemented execution engine in this application. */
export const RUNNABLE_LOOP_STRUCTURES = [
  "singleAgent",
  "makerChecker",
  "agentPipeline",
  "parallelAgents",
  "discoveryTriage",
  "humanApproval",
] as const satisfies readonly LoopStructure[];

export function isRunnableLoopStructure(structure: LoopStructure): boolean {
  return (RUNNABLE_LOOP_STRUCTURES as readonly LoopStructure[]).includes(structure);
}

export const LOOP_DEFAULT_CLASSIFICATION_PROMPT =
  "Classify findings by severity and summarize recommended next action.";
export const LOOP_DEFAULT_CHECKPOINT_PROMPT = "Review the proposal before continuing.";
export const LOOP_EVALUATOR_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
] as const;

/** Native LoopDiscoveryTriageConfig normalization, including CR-only input. */
export function normalizeLoopClassificationPrompt(value: string | undefined): string {
  const normalized = (value ?? "").replace(/\r\n|\r|\n/g, " ").trim();
  return normalized || LOOP_DEFAULT_CLASSIFICATION_PROMPT;
}

/** Native LoopHumanApprovalConfig and LoopDefinitionStore.oneLine normalization. */
export function normalizeLoopCheckpointPrompt(value: string | undefined): string {
  const normalized = (value ?? "").replace(/\r\n|\r|\n/g, " ").trim();
  return normalized || LOOP_DEFAULT_CHECKPOINT_PROMPT;
}

/** Structure-specific authoring/run validity; unsupported structures always fail closed. */
export function loopDefinitionValidationError(
  loop: Pick<
    LoopDefinition,
    | "name"
    | "goal"
    | "structure"
    | "agentName"
    | "makerName"
    | "checkerName"
    | "checkerRubric"
    | "pipelineStages"
    | "parallelBranches"
    | "triageAgent"
    | "classificationPrompt"
    | "checkpointPrompt"
    | "writeTarget"
  >,
): string | undefined {
  if (!isRunnableLoopStructure(loop.structure)) return "This Loop structure is unavailable.";
  if (!loop.name.trim()) return "A name is required.";
  if (loop.structure === "singleAgent") {
    if (!loop.agentName?.trim()) return "An agent is required.";
  }
  if (loop.structure === "makerChecker") {
    if (!loop.goal.trim()) return "A goal is required.";
    if (!(loop.makerName ?? loop.agentName ?? "").trim()) return "A maker agent is required.";
    if (!(loop.checkerName ?? "").trim()) return "A checker agent is required.";
    if (!(loop.checkerRubric ?? "").trim()) return "A checker rubric is required.";
  }
  if (loop.structure === "agentPipeline") {
    if (!loop.goal.trim()) return "A goal is required.";
    if (!loop.pipelineStages?.length) return "At least one pipeline stage is required.";
    if (loop.pipelineStages.some((stage) => !stage.trim())) {
      return "Pipeline stage agent names cannot be blank.";
    }
  }
  if (loop.structure === "parallelAgents") {
    if (!loop.goal.trim()) return "A goal is required.";
    if (!normalizeParallelBranches(loop.parallelBranches).length) {
      return "At least one parallel branch agent is required.";
    }
    if (loop.writeTarget !== "artifactMarkdown") {
      return "Parallel agents are report-only and require the Artifact (markdown) write target.";
    }
  }
  if (loop.structure === "discoveryTriage") {
    if (!loop.goal.trim()) return "A goal is required.";
    if (!(loop.triageAgent ?? "").trim()) return "A triage agent is required.";
  }
  return undefined;
}

/** Native LoopParallelConfig normalization: trim, drop blanks, preserve first occurrence. */
export function normalizeParallelBranches(branches: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  return (branches ?? [])
    .map((branch) => branch.trim())
    .filter((branch) => {
      if (!branch || seen.has(branch)) return false;
      seen.add(branch);
      return true;
    });
}

export const LOOP_STRUCTURE_UNSUPPORTED_CODE = "loop_structure_unsupported";
export const LOOP_PARALLEL_WRITE_TARGET_CODE = "loop_parallel_write_target_unsafe";
export const LOOP_AGENT_PREFLIGHT_CODE = "loop_agent_preflight_failed";
export const LOOP_CURRENT_CHECKOUT_CONFIRMATION_CODE =
  "loop_current_checkout_confirmation_required";

export type LoopAgentRole = "agent" | "maker" | "checker" | "stage" | "branch" | "triage";

export interface LoopRequiredAgentRole {
  role: LoopAgentRole;
  /** One-based position for ordered stages and normalized branches. */
  position?: number;
  agentName: string;
}

export interface LoopAgentPreflightIssue extends LoopRequiredAgentRole {
  reason: "missing" | "disabled";
}

/** Required named-agent roles in deterministic execution order. */
export function loopRequiredAgentRoles(
  loop: Pick<
    LoopDefinition,
    | "structure"
    | "agentName"
    | "makerName"
    | "checkerName"
    | "pipelineStages"
    | "parallelBranches"
    | "triageAgent"
  >,
): LoopRequiredAgentRole[] {
  switch (loop.structure) {
    case "singleAgent":
      return [{ role: "agent", agentName: loop.agentName?.trim() ?? "" }];
    case "makerChecker":
      return [
        { role: "maker", agentName: (loop.makerName ?? loop.agentName ?? "").trim() },
        { role: "checker", agentName: loop.checkerName?.trim() ?? "" },
      ];
    case "agentPipeline":
      return (loop.pipelineStages ?? []).map((agentName, index) => ({
        role: "stage",
        position: index + 1,
        agentName: agentName.trim(),
      }));
    case "parallelAgents":
      return normalizeParallelBranches(loop.parallelBranches).map((agentName, index) => ({
        role: "branch",
        position: index + 1,
        agentName,
      }));
    case "discoveryTriage":
      return [{ role: "triage", agentName: loop.triageAgent?.trim() ?? "" }];
    case "humanApproval":
      return [];
  }
}

export function loopAgentRoleLabel(role: LoopRequiredAgentRole): string {
  switch (role.role) {
    case "agent":
      return "Single agent";
    case "maker":
      return "Maker";
    case "checker":
      return "Checker";
    case "stage":
      return `Pipeline stage ${role.position}`;
    case "branch":
      return `Parallel branch ${role.position}`;
    case "triage":
      return "Triage";
  }
}

export const LOOP_STRUCTURE_LABEL: Record<LoopStructure, string> = {
  singleAgent: "Single agent",
  makerChecker: "Maker / checker",
  agentPipeline: "Agent pipeline",
  parallelAgents: "Parallel agents",
  discoveryTriage: "Discovery + triage",
  humanApproval: "Human approval",
};

/** Where an iteration writes its work (native LoopWriteTarget). */
export type LoopWriteTarget = "artifactMarkdown" | "newWorktree" | "currentCheckout";

export const LOOP_WRITE_TARGETS: LoopWriteTarget[] = [
  "artifactMarkdown",
  "newWorktree",
  "currentCheckout",
];

export const LOOP_WRITE_TARGET_LABEL: Record<LoopWriteTarget, string> = {
  artifactMarkdown: "Artifact (markdown)",
  newWorktree: "New worktree",
  currentCheckout: "Current checkout",
};

/** `user` loops are editable; `builtin` loops are read-only (duplicate to edit). */
export type LoopSource = "user" | "builtin";

export type LoopLaunchContextScope = "firstIterationOnly" | "everyIteration";
export type LoopDefinitionAvailability = "allProjects" | "projectPaths";

export const LOOP_MAX_ITERATIONS_LIMIT = 100;
export const LOOP_DEFAULT_MAX_ITERATIONS = 3;

export function normalizeLoopLaunchContext(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

export type LoopSuccessConditionSource = "goal" | "custom";

export function normalizeLoopSuccessCondition(value: string | undefined, goal: string): string {
  return value?.trim() || goal.trim();
}

/** Paths are opaque equality metadata. They are never resolved or used for filesystem access. */
export function normalizeLoopProjectPaths(paths: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  return (paths ?? [])
    .map((projectPath) => projectPath.trim())
    .filter((projectPath) => {
      if (!projectPath || seen.has(projectPath)) return false;
      seen.add(projectPath);
      return true;
    });
}

export function isLoopAvailableInProject(
  loop: Pick<LoopDefinition, "availability" | "projectPaths">,
  projectPath: string,
): boolean {
  return loop.availability === "allProjects" || loop.projectPaths.includes(projectPath);
}

export interface LoopDefinition {
  /** Opaque stable catalog identity derived from the securely scanned basename. */
  id: string;
  name: string;
  description: string;
  /** The goal / prompt template (stored as the markdown body). */
  goal: string;
  structure: LoopStructure;
  /** The primary agent this loop drives (legacy Electron key). */
  agentName?: string;
  /** Native flat Maker+Checker frontmatter. */
  makerName?: string;
  checkerName?: string;
  checkerRubric?: string;
  /** Native flat Pipeline frontmatter. Order and repeated agent names are significant. */
  pipelineStages?: string[];
  /** Native flat Parallel frontmatter. Blanks are dropped and first duplicate wins. */
  parallelBranches?: string[];
  /** Native flat Discovery/Triage frontmatter. */
  triageAgent?: string;
  classificationPrompt?: string;
  /** Native flat Human Approval frontmatter. */
  checkpointPrompt?: string;
  launchContext?: string;
  launchContextScope: LoopLaunchContextScope;
  /** 0 means unlimited; positive values are clamped to 1..LOOP_MAX_ITERATIONS_LIMIT. */
  maxIterations: number;
  /** Shell command whose exit 0 satisfies the optional validation requirement. */
  validationCommand: string;
  /** Natural-language outcome condition; defaults to the effective goal. */
  successCondition?: string;
  /** Whether the condition follows the launch goal or was explicitly authored. */
  successConditionSource?: LoopSuccessConditionSource;
  /** Optional report-only evaluator launch overrides. */
  evaluatorProvider?: string;
  evaluatorModel?: string;
  evaluatorThinkingLevel?: string;
  writeTarget: LoopWriteTarget;
  source: LoopSource;
  availability: LoopDefinitionAvailability;
  /** Opaque exact-match metadata only; never filesystem authority. */
  projectPaths: string[];
  /** Compatibility/display metadata only. Catalog operations use `id`. */
  filePath: string;
}

/** Native semantics: exactly 0 is unlimited; positive values clamp to 1..100. */
export function clampMaxIterations(value: number): number {
  if (!Number.isFinite(value)) return LOOP_DEFAULT_MAX_ITERATIONS;
  const integer = Math.floor(value);
  if (integer === 0) return 0;
  return Math.min(LOOP_MAX_ITERATIONS_LIMIT, Math.max(1, integer));
}

export type LoopExecutionSnapshot = Omit<
  LoopDefinition,
  "id" | "source" | "availability" | "projectPaths" | "filePath"
>;

/** A durable live/finished loop run. */
export type LoopRunStatus =
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped"
  | "notAchieved"
  | "interrupted";

export type LoopStopReason =
  | "success"
  | "maxIterationsReached"
  | "validationFailedAfterFinalIteration"
  | "validationUnavailable"
  | "unsafeWriteTarget"
  | "toolFailed"
  | "agentFailed"
  | "humanInputRequired"
  | "humanApproved"
  | "humanRejected"
  | "userStopped"
  | "appInterrupted";

export type LoopCheckerDecision = "APPROVE" | "CONTINUE" | "REJECT" | "ASK_HUMAN" | "FAIL";
export type LoopGoalDecision = "SUCCESS" | "CONTINUE" | "FAIL";
export type LoopRunPhase =
  | "maker"
  | "checker"
  | "stage"
  | "branch"
  | "triage"
  | "checkpoint"
  | "validation"
  | "evaluator";

export interface LoopTimelineEvent {
  id: string;
  phase: LoopRunPhase;
  roleName: string;
  note: string;
  timestamp: string;
  stageIndex?: number;
  branchIndex?: number;
}

export interface LoopRunArtifact {
  id: string;
  phase:
    | "maker"
    | "checker"
    | "stage"
    | "branch"
    | "triage"
    | "checkpoint"
    | "evaluator"
    | "validation";
  stageIndex?: number;
  branchIndex?: number;
  agentName?: string;
  filename: string;
  filePath: string;
  bytes: number;
  createdAt: string;
}

export type LoopChildStatus = "queued" | "running" | "completed" | "failed" | "stopped";

export interface LoopChildRecord {
  id: string;
  phase: "maker" | "checker" | "stage" | "branch" | "triage" | "evaluator";
  stageIndex?: number;
  branchIndex?: number;
  agentName?: string;
  /** Present for pre-created Parallel children before they begin execution. */
  status?: LoopChildStatus;
  queuedAt?: string;
  startedAt?: string;
  endedAt?: string;
  output?: string;
  error?: string;
}

export interface LoopPipelineStageOutput {
  id: string;
  stageIndex: number;
  agentName: string;
  output: string;
}

export interface LoopParallelBranchOutput {
  id: string;
  branchIndex: number;
  agentName: string;
  output?: string;
  error?: string;
}

export type LoopValidationClassification = "completed" | "timeout" | "spawnError" | "cancelled";

export interface LoopValidationResult {
  command: string;
  workingDirectory: string;
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  stdoutPath?: string;
  stderrPath?: string;
  classification: LoopValidationClassification;
  passed: boolean;
}

export interface LoopRunIteration {
  id: string;
  index: number;
  startedAt: string;
  endedAt?: string;
  /** Maker output (legacy name retained for clients). */
  output: string;
  checkerOutput?: string;
  checkerDecision?: LoopCheckerDecision;
  evaluatorOutput?: string;
  goalDecision?: LoopGoalDecision;
  pipelineStageOutputs?: LoopPipelineStageOutput[];
  parallelBranchOutputs?: LoopParallelBranchOutput[];
  /** Discovery/Triage agent's durable Markdown classification report. */
  classificationOutput?: string;
  validationPassed: boolean | null;
  validationEvidence?: string;
  validationResult?: LoopValidationResult;
  timeline: LoopTimelineEvent[];
  children: LoopChildRecord[];
  artifacts: LoopRunArtifact[];
}

export interface LoopOwnedWorktree {
  ownershipVersion: 1;
  /** Unpredictable generated child id; target basename must be `loop-${ownershipId}`. */
  ownershipId: string;
  projectRoot: string;
  path: string;
  branch: string;
  sourceBranch: string;
  /** Persisted proof that Agent Deck created this exact worktree/branch pair. */
  branchOwned: true;
}

export interface LoopRunLaunchOwnership {
  /** Transient Loop parent session. Never exposed as a reopenable conversation. */
  sessionId: string;
  writeTarget: LoopWriteTarget;
  /** Canonical, platform-normalized key for destructive current-checkout locking. */
  checkoutLockKey?: string;
  worktree?: LoopOwnedWorktree;
  sessionReconciledAt?: string;
  /** Explicit user acknowledgement that an interrupted checkout is safe to unlock. */
  checkoutAcknowledgedAt?: string;
}

export interface LoopRun {
  id: string;
  /** Opaque catalog identity captured at launch; retained even if the file is deleted. */
  catalogId?: string;
  loopName: string;
  /** Snapshotted orchestration shape; absent only on legacy persisted runs. */
  structure?: LoopStructure;
  /** Effective launch definition, including run-only overrides, for deterministic retry. */
  definitionSnapshot?: LoopExecutionSnapshot;
  launchContext?: string;
  launchContextScope?: LoopLaunchContextScope;
  projectId?: string;
  retryOf?: string;
  launch?: LoopRunLaunchOwnership;
  /** Snapshot shown by a dedicated Human Approval checkpoint. */
  checkpointPrompt?: string;
  status: LoopRunStatus;
  currentIteration: number;
  maxIterations: number;
  iterations: LoopRunIteration[];
  stopReason?: LoopStopReason;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
}

/** Native AppViewModel.retryLoopRun eligibility. A rejection is deliberately terminal. */
export function canRetryLoopRun(run: Pick<LoopRun, "status" | "stopReason">): boolean {
  return (
    run.status === "failed" ||
    run.status === "notAchieved" ||
    run.stopReason === "humanInputRequired" ||
    run.stopReason === "humanApproved"
  );
}

/** True once a run has reached a terminal state (no longer running/stopping). */
export function isLoopRunTerminal(status: LoopRunStatus): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "stopped" ||
    status === "notAchieved" ||
    status === "interrupted"
  );
}
