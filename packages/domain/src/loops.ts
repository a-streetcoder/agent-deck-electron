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
    | "graph"
  >,
): string | undefined {
  if (!isRunnableLoopStructure(loop.structure)) return "This Loop structure is unavailable.";
  if (!loop.name.trim()) return "A name is required.";
  if (loop.graph) {
    if (!loop.goal.trim()) return "A goal is required.";
    // A checkpoint is parked and resolved through the Human approval structure only.
    if (
      loop.structure === "humanApproval" ||
      loop.graph.nodes.some((node) => node.kind === "human")
    ) {
      return "Hand-written graphs cannot hold a human checkpoint; use the Human approval structure.";
    }
    const checked = loopGraphColumns(loop.graph);
    if ("error" in checked) return checked.error;
    for (const node of loop.graph.nodes) {
      if (node.kind !== "evaluator" && !node.agentName?.trim()) {
        return `Graph node "${node.id}" needs an agent.`;
      }
      if (node.kind === "checker" && !(loop.checkerRubric ?? "").trim()) {
        return "A checker rubric is required.";
      }
      if (node.kind === "branch" && loop.writeTarget !== "artifactMarkdown") {
        return "Parallel agents are report-only and require the Artifact (markdown) write target.";
      }
    }
    return undefined;
  }
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
    | "graph"
  >,
): LoopRequiredAgentRole[] {
  if (loop.graph) {
    const positions = new Map<string, number>();
    // Positions follow execution order (depth columns) when the graph is valid.
    const checked = loopGraphColumns(loop.graph);
    const ordered = "columns" in checked ? checked.columns.flat() : loop.graph.nodes;
    return ordered.flatMap((node): LoopRequiredAgentRole[] => {
      if (node.kind === "evaluator" || node.kind === "human") return [];
      const position = (positions.get(node.kind) ?? 0) + 1;
      positions.set(node.kind, position);
      return [
        {
          role: node.kind,
          ...(node.kind === "stage" || node.kind === "branch" ? { position } : {}),
          agentName: node.agentName?.trim() ?? "",
        },
      ];
    });
  }
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
  /** A9: a hand-written graph (`nodes`/`edges` frontmatter). Absent: the structure's
   * builtin template (`loopGraph`); the flat fields above stay the native format. */
  graph?: LoopGraph;
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
  /** A9: the evaluator continued but the graph has no budgeted edge to repeat on. */
  | "graphHasNoRepeatEdge"
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
  /** A6: the child's model and summed Pi usage, recorded at settle when Pi reported them. */
  model?: string;
  tokens?: { input?: number; output?: number };
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

export interface LoopChangedFile {
  path: string;
  status: "staged" | "unstaged" | "untracked" | "deleted" | "renamed" | "binary";
  oldPath?: string;
}

/** How a role's decision line was read: the exact first non-empty line
 * (`strict`), a decision line after a short preamble or with markdown emphasis
 * (`lenient`), or not found (`missing`). */
export type LoopVerdictParse = "strict" | "lenient" | "missing";

export interface LoopRunIteration {
  id: string;
  index: number;
  startedAt: string;
  endedAt?: string;
  /** Maker output (legacy name retained for clients). */
  output: string;
  checkerOutput?: string;
  checkerDecision?: LoopCheckerDecision;
  checkerVerdictParse?: LoopVerdictParse;
  evaluatorOutput?: string;
  goalDecision?: LoopGoalDecision;
  /** How the evaluator's goal decision was parsed; `missing` falls back to CONTINUE. */
  goalVerdictParse?: LoopVerdictParse;
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
  changedFiles?: LoopChangedFile[];
  manifestPath?: string;
}

export interface LoopOwnedWorktree {
  ownershipVersion: 1;
  /** Unpredictable generated child id; target basename must be `loop-${ownershipId}`. */
  ownershipId: string;
  projectRoot: string;
  path: string;
  branch: string;
  sourceBranch: string;
  /** Immutable commit captured before the owned branch/worktree was created. */
  baseCommit?: string;
  /** Persisted proof that Agent Deck created this exact worktree/branch pair. */
  branchOwned: true;
}

export type LoopWorktreeReviewStatus =
  | "available"
  | "applying"
  | "applied"
  | "discarding"
  | "discarded"
  | "applyUncertain"
  | "discardUncertain";

/** Durable, honest lifecycle for an owned retained worktree. */
export interface LoopWorktreeReview {
  status: LoopWorktreeReviewStatus;
  updatedAt: string;
  availableAt: string;
  applyingAt?: string;
  appliedAt?: string;
  discardingAt?: string;
  discardedAt?: string;
  uncertainAt?: string;
  patchArtifact?: string;
  patchHash?: string;
  patchBytes?: number;
  patchTruncated?: boolean;
  changedFiles?: LoopChangedFile[];
  archivedPath?: string;
  error?: string;
}

export interface LoopRunLaunchOwnership {
  /** Visible Loop parent session; runtime ownership ends while its index remains durable. */
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
  /** Durable visible parent session containing synthetic Loop role cards. */
  sessionId?: string;
  /** Private app-owned run artifact identity and canonical directory. */
  artifactDirectoryId?: string;
  artifactDirectory?: string;
  manifestPath?: string;
  progressPath?: string;
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
  /** Present for retained worktrees once their explicit review lifecycle is available. */
  review?: LoopWorktreeReview;
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

/**
 * A9: a loop as a graph. Node kinds are the loop's roles (plus the human checkpoint);
 * the six structures are builtin templates of it (`loopGraph`), and the engine runs one
 * interpreter over the depth columns `loopGraphColumns` returns. Forward edges are
 * unconditional; a budgeted edge leads back to the entry on a decision and starts the
 * next iteration, so `maxIterations` is the cycle budget.
 */
export type LoopNodeKind =
  | "maker"
  | "checker"
  | "evaluator"
  | "stage"
  | "branch"
  | "triage"
  | "human";

export const LOOP_NODE_KINDS: readonly LoopNodeKind[] = [
  "maker",
  "checker",
  "evaluator",
  "stage",
  "branch",
  "triage",
  "human",
];

export interface LoopGraphNode {
  id: string;
  kind: LoopNodeKind;
  agentName?: string;
}

export interface LoopGraphEdge {
  from: string;
  to: string;
  /** The decision a budgeted edge is taken on: the evaluator's CONTINUE or the checker's FAIL. */
  when?: LoopCheckerDecision;
  /** Back to the entry: the next iteration, spending one unit of the cycle budget. */
  budgeted?: boolean;
}

export interface LoopGraph {
  nodes: LoopGraphNode[];
  edges: LoopGraphEdge[];
}

const LOOP_GRAPH_DECISIONS: readonly LoopCheckerDecision[] = [
  "APPROVE",
  "CONTINUE",
  "REJECT",
  "ASK_HUMAN",
  "FAIL",
];

/** The definition's hand-written graph, else its structure normalised to the builtin template. */
export function loopGraph(
  loop: Pick<
    LoopDefinition,
    | "graph"
    | "structure"
    | "agentName"
    | "makerName"
    | "checkerName"
    | "pipelineStages"
    | "parallelBranches"
    | "triageAgent"
  >,
): LoopGraph {
  if (loop.graph) return loop.graph;
  const evaluator: LoopGraphNode = { id: "evaluator", kind: "evaluator" };
  const back = (from: string, to: string, when: LoopCheckerDecision = "CONTINUE") => ({
    from,
    to,
    when,
    budgeted: true,
  });
  // Agent names stay as authored (untrimmed): they reach the executor unchanged.
  switch (loop.structure) {
    case "singleAgent":
      return {
        nodes: [
          { id: "maker", kind: "maker", agentName: loop.makerName || loop.agentName },
          evaluator,
        ],
        edges: [{ from: "maker", to: "evaluator" }, back("evaluator", "maker")],
      };
    case "makerChecker":
      return {
        nodes: [
          { id: "maker", kind: "maker", agentName: loop.makerName || loop.agentName },
          { id: "checker", kind: "checker", agentName: loop.checkerName },
          evaluator,
        ],
        edges: [
          { from: "maker", to: "checker" },
          { from: "checker", to: "evaluator" },
          back("checker", "maker", "FAIL"),
          back("evaluator", "maker"),
        ],
      };
    case "agentPipeline": {
      const stages = (loop.pipelineStages ?? []).map<LoopGraphNode>((agentName, index) => ({
        id: `stage-${index + 1}`,
        kind: "stage",
        agentName,
      }));
      const chain = [...stages, evaluator];
      return {
        nodes: chain,
        edges: [
          ...chain.slice(1).map((node, index) => ({ from: chain[index]!.id, to: node.id })),
          back("evaluator", chain[0]!.id),
        ],
      };
    }
    case "parallelAgents": {
      const branches = normalizeParallelBranches(loop.parallelBranches).map<LoopGraphNode>(
        (agentName, index) => ({ id: `branch-${index + 1}`, kind: "branch", agentName }),
      );
      return {
        nodes: [...branches, evaluator],
        edges: [
          ...branches.map((branch) => ({ from: branch.id, to: "evaluator" })),
          ...branches.map((branch) => back("evaluator", branch.id)),
        ],
      };
    }
    case "discoveryTriage":
      return {
        nodes: [{ id: "triage", kind: "triage", agentName: loop.triageAgent }, evaluator],
        edges: [{ from: "triage", to: "evaluator" }, back("evaluator", "triage")],
      };
    case "humanApproval":
      return { nodes: [{ id: "human", kind: "human" }], edges: [] };
  }
}

/**
 * Validate a graph and return its depth columns (longest path from the entry over the
 * forward edges): the order the engine runs and the Loops screen draws. Rules: unique
 * ids and known kinds; cycles only through budgeted edges, which lead back to the entry;
 * exactly one entry node (or one set of parallel branches, which start together), so
 * every node is reachable from it; one evaluator, ending the iteration; at most one
 * maker, checker and triage; a human checkpoint only on its own (Human approval).
 */
export function loopGraphColumns(
  graph: LoopGraph,
): { columns: LoopGraphNode[][] } | { error: string } {
  const { nodes, edges } = graph;
  if (!nodes.length) return { error: "A loop graph needs at least one node." };
  const byId = new Map<string, LoopGraphNode>();
  for (const node of nodes) {
    if (typeof node.id !== "string" || !node.id.trim() || byId.has(node.id)) {
      return { error: `Graph node ids must be unique and non-empty ("${String(node.id)}").` };
    }
    if (!LOOP_NODE_KINDS.includes(node.kind)) {
      return { error: `Graph node "${node.id}" has an unknown kind "${String(node.kind)}".` };
    }
    byId.set(node.id, node);
  }
  const count = (kind: LoopNodeKind) => nodes.filter((node) => node.kind === kind).length;
  if (count("human")) {
    return nodes.length === 1 && !edges.length
      ? { columns: [nodes] }
      : { error: "A human checkpoint runs only on its own (the Human approval structure)." };
  }
  if (count("evaluator") !== 1) return { error: "A loop graph needs exactly one evaluator." };
  for (const kind of ["maker", "checker", "triage"] as const) {
    if (count(kind) > 1) return { error: `A loop graph has at most one ${kind}.` };
  }
  const forward = new Map(nodes.map((node) => [node.id, [] as string[]]));
  const indegree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    const from = byId.get(edge.from);
    if (!from || !byId.has(edge.to)) {
      return { error: `Graph edge ${edge.from} -> ${edge.to} names an unknown node.` };
    }
    if (edge.when !== undefined && !LOOP_GRAPH_DECISIONS.includes(edge.when)) {
      return { error: `Graph edge ${edge.from} -> ${edge.to} has an unknown condition.` };
    }
    if (!edge.budgeted) {
      if (edge.when !== undefined) {
        return { error: "Only budgeted edges carry a condition; forward edges always run." };
      }
      forward.get(edge.from)!.push(edge.to);
      indegree.set(edge.to, indegree.get(edge.to)! + 1);
    } else if (
      !(from.kind === "evaluator" && (edge.when ?? "CONTINUE") === "CONTINUE") &&
      !(from.kind === "checker" && edge.when === "FAIL")
    ) {
      return { error: "A budgeted edge leaves the evaluator on CONTINUE or the checker on FAIL." };
    }
  }
  const entries = nodes.filter((node) => indegree.get(node.id) === 0);
  if (!entries.length || (entries.length > 1 && entries.some((node) => node.kind !== "branch"))) {
    return {
      error: "A loop graph needs exactly one entry node; every node must be reachable from it.",
    };
  }
  if (nodes.some((node) => node.kind === "branch" && !entries.includes(node))) {
    return { error: "Parallel branches start the iteration: no edge may lead into a branch." };
  }
  if (edges.some((edge) => edge.budgeted && !entries.some((node) => node.id === edge.to))) {
    return { error: "A budgeted edge must lead back to the entry." };
  }
  const columns: LoopGraphNode[][] = [];
  let frontier = entries;
  let placed = 0;
  while (frontier.length) {
    columns.push(frontier);
    placed += frontier.length;
    const next: LoopGraphNode[] = [];
    for (const node of frontier) {
      for (const to of forward.get(node.id)!) {
        const remaining = indegree.get(to)! - 1;
        indegree.set(to, remaining);
        if (remaining === 0) next.push(byId.get(to)!);
      }
    }
    frontier = next;
  }
  if (placed < nodes.length)
    return { error: "A loop graph may cycle only through budgeted edges." };
  const last = columns.at(-1)!;
  if (last.length !== 1 || last[0]!.kind !== "evaluator") {
    return { error: "The evaluator must end the iteration, after every other node." };
  }
  // The interpreter runs the six template shapes plus stages followed by one checker.
  // Validation runs once, before the first judge, so nothing but the evaluator may
  // follow a checker; triage and branches keep their templates' shape.
  const body = columns.slice(0, -1).map((column) => column.map((node) => node.kind));
  const checker = body.at(-1)?.join() === "checker";
  const work = checker ? body.slice(0, -1) : body;
  const single = (kind: LoopNodeKind) => work.length === 1 && work[0]!.join() === kind;
  const shape = checker
    ? single("maker") || (work.length > 0 && work.every((column) => column.join() === "stage"))
    : single("maker") ||
      single("triage") ||
      (work.length === 1 && work[0]!.every((kind) => kind === "branch")) ||
      (work.length > 0 && work.every((column) => column.join() === "stage"));
  if (!shape) {
    return {
      error:
        "Unsupported graph shape: use a maker, a triage, parallel branches, or a chain of stages (a maker or the stages may be followed by one checker), then the evaluator.",
    };
  }
  return { columns };
}
