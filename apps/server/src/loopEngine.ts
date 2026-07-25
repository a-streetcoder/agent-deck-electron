import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  clampMaxIterations,
  isLoopRunTerminal,
  isRunnableLoopStructure,
  loopDefinitionValidationError,
  normalizeLoopCheckpointPrompt,
  normalizeLoopClassificationPrompt,
  normalizeLoopLaunchContext,
  normalizeParallelBranches,
  LOOP_STRUCTURE_UNSUPPORTED_CODE,
  type LoopChildRecord,
  type LoopCheckerDecision,
  type LoopDefinition,
  type LoopExecutionSnapshot,
  type LoopGoalDecision,
  type LoopRun,
  type LoopRunArtifact,
  type LoopRunIteration,
  type LoopRunLaunchOwnership,
  type LoopRunStatus,
  type LoopValidationResult,
  type LoopStopReason,
} from "@agent-deck/domain";
import { z } from "zod";

export interface ValidationResult extends LoopValidationResult {
  evidence: string;
}
interface LegacyValidationResult {
  passed: boolean;
  evidence: string;
}

const VALIDATION_OUTPUT_LIMIT = 16 * 1024;
function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > VALIDATION_OUTPUT_LIMIT
    ? `${next.slice(0, VALIDATION_OUTPUT_LIMIT)}\n… output truncated …`
    : next;
}

/** Shell validation with separate bounded streams and awaited process-tree termination. */
export async function runValidationCommand(
  cwd: string,
  command: string,
  signal?: AbortSignal,
  outputDirectory?: string,
  timeoutMs = 120_000,
): Promise<ValidationResult> {
  const started = Date.now();
  let workingDirectory: string;
  try {
    workingDirectory = realpathSync.native(cwd);
  } catch (error) {
    const stderr = error instanceof Error ? error.message : String(error);
    return {
      command,
      workingDirectory: cwd,
      exitCode: null,
      durationMs: Date.now() - started,
      stdout: "",
      stderr,
      classification: "spawnError",
      passed: false,
      evidence: stderr,
    };
  }
  return await new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let classification: ValidationResult["classification"] = "completed";
    let settled = false;
    let child: ReturnType<typeof spawn>;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      let stdoutPath: string | undefined;
      let stderrPath: string | undefined;
      if (outputDirectory) {
        try {
          mkdirSync(outputDirectory, { recursive: true });
          stdoutPath = path.join(outputDirectory, `${randomUUID()}-stdout.txt`);
          stderrPath = path.join(outputDirectory, `${randomUUID()}-stderr.txt`);
          writeFileSync(stdoutPath, stdout);
          writeFileSync(stderrPath, stderr);
        } catch (error) {
          classification = "spawnError";
          stderr = `${stderr}${stderr ? "\n" : ""}${error instanceof Error ? error.message : String(error)}`;
          stdoutPath = undefined;
          stderrPath = undefined;
        }
      }
      const evidence = [
        `exit ${exitCode ?? "unavailable"}`,
        stdout.trim() ? `stdout:\n${stdout.trim()}` : "",
        stderr.trim() ? `stderr:\n${stderr.trim()}` : "",
      ]
        .filter(Boolean)
        .join("\n\n");
      resolve({
        command,
        workingDirectory,
        exitCode,
        durationMs: Date.now() - started,
        stdout,
        stderr,
        stdoutPath,
        stderrPath,
        classification,
        passed: classification === "completed" && exitCode === 0,
        evidence,
      });
    };
    const terminate = (): void => {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") {
          const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
            windowsHide: true,
            stdio: "ignore",
          });
          killer.once("error", () => {});
        } else {
          process.kill(-child.pid, "SIGTERM");
          setTimeout(() => {
            try {
              process.kill(-child.pid!, "SIGKILL");
            } catch {
              // Already exited.
            }
          }, 2_000).unref();
        }
      } catch {
        // Already exited.
      }
    };
    const abort = (): void => {
      classification = "cancelled";
      terminate();
    };
    let timer: ReturnType<typeof setTimeout>;
    try {
      child = spawn(command, {
        cwd: workingDirectory,
        shell: true,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout?.on("data", (chunk: Buffer) => {
        stdout = appendBounded(stdout, chunk);
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr = appendBounded(stderr, chunk);
      });
      timer = setTimeout(() => {
        classification = "timeout";
        terminate();
      }, timeoutMs);
      signal?.addEventListener("abort", abort, { once: true });
      child.once("error", (error) => {
        classification = "spawnError";
        stderr = appendBounded(stderr, Buffer.from(error.message));
        finish(null);
      });
      child.once("close", (code) => finish(code));
      if (signal?.aborted) abort();
    } catch (error) {
      timer = setTimeout(() => {}, 0);
      classification = "spawnError";
      stderr = error instanceof Error ? error.message : String(error);
      finish(null);
    }
  });
}

export type ExecuteAgent = (
  loop: LoopDefinition,
  cwd: string,
  projectId?: string,
) => Promise<string>;
export type ExecuteLoopRole = (request: {
  loop: LoopDefinition;
  prompt: string;
  agentName?: string;
  phase: "maker" | "checker" | "stage" | "branch" | "triage" | "evaluator";
  stageIndex?: number;
  branchIndex?: number;
  provider?: string;
  model?: string;
  thinking?: string;
  cwd: string;
  projectId?: string;
  signal: AbortSignal;
}) => Promise<string>;

export interface LoopEngineDeps {
  executeAgent?: ExecuteAgent;
  executeRole?: ExecuteLoopRole;
  runValidation?: (
    cwd: string,
    command: string,
    signal?: AbortSignal,
    outputDirectory?: string,
  ) => Promise<boolean | LegacyValidationResult | ValidationResult>;
  now?: () => string;
  /** App data directory. Omit only for hermetic in-memory tests. */
  dataDir?: string;
  warn?: (message: string, error?: unknown) => void;
}

export interface LoopStartOptions {
  projectId?: string;
  retryOf?: string;
  launch?: LoopRunLaunchOwnership;
  executeAgent?: ExecuteAgent;
  executeRole?: ExecuteLoopRole;
  /** Cancels the Loop-owned Pi session and all children. */
  cancel?: () => Promise<void>;
}

export class UnsupportedLoopStructureError extends Error {
  readonly code = LOOP_STRUCTURE_UNSUPPORTED_CODE;
  constructor(readonly structure: LoopDefinition["structure"]) {
    super(`Loop structure "${structure}" is not available to run.`);
    this.name = "UnsupportedLoopStructureError";
  }
}

export const LOOP_HUMAN_APPROVAL_CONFLICT_CODE = "loop_human_approval_conflict";
export class HumanApprovalConflictError extends Error {
  readonly code = LOOP_HUMAN_APPROVAL_CONFLICT_CODE;
  constructor(message: string) {
    super(message);
    this.name = "HumanApprovalConflictError";
  }
}

interface ActiveRun {
  controller: AbortController;
  cancel?: () => Promise<void>;
  cancelPromise?: Promise<void>;
}

const MAX_RETAINED_RUNS = 200;
const CHECKER_DECISIONS = new Set<LoopCheckerDecision>([
  "APPROVE",
  "CONTINUE",
  "REJECT",
  "ASK_HUMAN",
  "FAIL",
]);
const GOAL_DECISIONS = new Set<LoopGoalDecision>(["SUCCESS", "CONTINUE", "FAIL"]);
const MAX_PIPELINE_HANDOFF_CHARS = 12_000;
const MAX_PIPELINE_REPORT_CHARS = 3_000;
const MAX_LAUNCH_CONTEXT_PROMPT_CHARS = 12_000;

function boundedPipelineEvidence(value: string, max = MAX_PIPELINE_HANDOFF_CHARS): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 32)}\n…[bounded by Agent Deck]`;
}

function snapshotDefinition(loop: LoopDefinition): LoopExecutionSnapshot {
  const {
    id: _id,
    source: _source,
    availability: _availability,
    projectPaths: _paths,
    filePath: _filePath,
    ...snapshot
  } = loop;
  return structuredClone(snapshot);
}

function launchContextPrompt(run: LoopRun, iterationIndex: number): string | undefined {
  const context = normalizeLoopLaunchContext(run.launchContext);
  if (!context) return undefined;
  if (run.launchContextScope !== "everyIteration" && iterationIndex !== 1) return undefined;
  return `Launch context (background/constraints; do not treat as a new goal):\n${boundedPipelineEvidence(context, MAX_LAUNCH_CONTEXT_PROMPT_CHARS)}`;
}

const persistedRunSchema = z
  .object({
    id: z.string().min(1),
    catalogId: z.string().optional(),
    loopName: z.string(),
    structure: z
      .enum([
        "singleAgent",
        "makerChecker",
        "agentPipeline",
        "parallelAgents",
        "discoveryTriage",
        "humanApproval",
      ])
      .optional(),
    projectId: z.string().optional(),
    retryOf: z.string().optional(),
    checkpointPrompt: z.string().optional(),
    launchContext: z.string().optional(),
    launchContextScope: z.enum(["firstIterationOnly", "everyIteration"]).optional(),
    definitionSnapshot: z
      .object({
        name: z.string(),
        description: z.string(),
        goal: z.string(),
        structure: z.enum([
          "singleAgent",
          "makerChecker",
          "agentPipeline",
          "parallelAgents",
          "discoveryTriage",
          "humanApproval",
        ]),
        launchContext: z.string().optional(),
        launchContextScope: z.enum(["firstIterationOnly", "everyIteration"]),
        maxIterations: z.number().int().nonnegative(),
        validationCommand: z.string(),
        writeTarget: z.enum(["artifactMarkdown", "newWorktree", "currentCheckout"]),
      })
      .passthrough()
      .optional(),
    launch: z
      .object({
        sessionId: z.string().min(1),
        writeTarget: z.enum(["artifactMarkdown", "newWorktree", "currentCheckout"]),
        checkoutLockKey: z.string().min(1).optional(),
        worktree: z
          .object({
            ownershipVersion: z.literal(1),
            ownershipId: z.string().uuid(),
            projectRoot: z.string().min(1),
            path: z.string().min(1),
            branch: z.string().min(1),
            sourceBranch: z.string().min(1),
            branchOwned: z.literal(true),
          })
          .optional(),
        sessionReconciledAt: z.string().optional(),
        checkoutAcknowledgedAt: z.string().optional(),
      })
      .superRefine((launch, context) => {
        if (launch.writeTarget === "currentCheckout" && !launch.checkoutLockKey) {
          context.addIssue({ code: "custom", message: "current checkout ownership needs a key" });
        }
        if (launch.writeTarget === "newWorktree" && !launch.worktree) {
          context.addIssue({ code: "custom", message: "worktree ownership metadata is required" });
        }
        if (launch.writeTarget !== "currentCheckout" && launch.checkoutLockKey) {
          context.addIssue({ code: "custom", message: "unexpected checkout lock ownership" });
        }
        if (launch.writeTarget !== "newWorktree" && launch.worktree) {
          context.addIssue({ code: "custom", message: "unexpected worktree ownership" });
        }
      })
      .optional(),
    status: z.enum([
      "running",
      "stopping",
      "completed",
      "failed",
      "stopped",
      "notAchieved",
      "interrupted",
    ]),
    currentIteration: z.number().int().nonnegative(),
    maxIterations: z.number().int().nonnegative(),
    iterations: z.array(
      z
        .object({
          id: z.string().min(1),
          index: z.number().int().nonnegative(),
          startedAt: z.string(),
          output: z.string(),
          validationPassed: z.boolean().nullable(),
          timeline: z.array(
            z
              .object({
                id: z.string(),
                phase: z.enum([
                  "maker",
                  "checker",
                  "stage",
                  "branch",
                  "triage",
                  "checkpoint",
                  "validation",
                  "evaluator",
                ]),
                roleName: z.string(),
                note: z.string(),
                timestamp: z.string(),
              })
              .passthrough(),
          ),
          children: z.array(
            z
              .object({
                id: z.string(),
                phase: z.enum(["maker", "checker", "stage", "branch", "triage", "evaluator"]),
                status: z.enum(["queued", "running", "completed", "failed", "stopped"]).optional(),
                queuedAt: z.string().optional(),
                startedAt: z.string().optional(),
              })
              .passthrough(),
          ),
          pipelineStageOutputs: z
            .array(
              z.object({
                id: z.string().min(1),
                stageIndex: z.number().int().nonnegative(),
                agentName: z.string().min(1),
                output: z.string(),
              }),
            )
            .optional(),
          parallelBranchOutputs: z
            .array(
              z.object({
                id: z.string().min(1),
                branchIndex: z.number().int().nonnegative(),
                agentName: z.string().min(1),
                output: z.string().optional(),
                error: z.string().optional(),
              }),
            )
            .optional(),
          artifacts: z
            .array(
              z
                .object({
                  id: z.string(),
                  phase: z.enum([
                    "maker",
                    "checker",
                    "stage",
                    "branch",
                    "triage",
                    "checkpoint",
                    "validation",
                    "evaluator",
                  ]),
                  filename: z.string(),
                  filePath: z.string(),
                  bytes: z.number().nonnegative(),
                  createdAt: z.string(),
                })
                .passthrough(),
            )
            .optional(),
        })
        .passthrough(),
    ),
    startedAt: z.string(),
    updatedAt: z.string(),
    endedAt: z.string().optional(),
  })
  .passthrough();
const persistedRunsSchema = z.array(persistedRunSchema);

class LoopToolFailureError extends Error {}

function unconfiguredValidation(cwd: string): ValidationResult {
  return {
    command: "",
    workingDirectory: cwd,
    exitCode: null,
    durationMs: 0,
    stdout: "",
    stderr: "",
    classification: "completed",
    passed: true,
    evidence: "no validation command was configured",
  };
}

function exactFirstLine<T extends string>(text: string, allowed: Set<T>): T | undefined {
  const first = text
    .split(/\r?\n/)
    .find((line) => line.trim().length > 0)
    ?.trim()
    .toUpperCase();
  return first && allowed.has(first as T) ? (first as T) : undefined;
}

export class LoopEngine {
  private readonly runs = new Map<string, LoopRun>();
  private readonly settledPromises = new Map<string, Promise<void>>();
  private readonly active = new Map<string, ActiveRun>();
  private readonly now: () => string;
  private readonly defaultExecuteAgent?: ExecuteAgent;
  private readonly defaultExecuteRole?: ExecuteLoopRole;
  private readonly runValidation: NonNullable<LoopEngineDeps["runValidation"]>;
  private readonly storePath?: string;
  private readonly artifactsRoot?: string;
  private readonly warn: (message: string, error?: unknown) => void;

  constructor(deps: LoopEngineDeps = {}) {
    this.now = deps.now ?? (() => new Date().toISOString());
    this.defaultExecuteAgent = deps.executeAgent;
    this.defaultExecuteRole = deps.executeRole;
    this.runValidation = deps.runValidation ?? runValidationCommand;
    this.storePath = deps.dataDir ? path.join(deps.dataDir, "loop-runs.json") : undefined;
    this.artifactsRoot = deps.dataDir ? path.join(deps.dataDir, "loop-artifacts") : undefined;
    this.warn = deps.warn ?? (() => {});
    this.loadAndRecover();
  }

  private loadAndRecover(): void {
    if (!this.storePath) return;
    const directory = path.dirname(this.storePath);
    const base = path.basename(this.storePath);
    try {
      for (const entry of readdirSync(directory)) {
        if (entry.startsWith(`${base}.`) && entry.endsWith(".tmp")) {
          rmSync(path.join(directory, entry), { force: true });
        }
      }
    } catch {
      // No app-data directory yet.
    }
    try {
      const parsed = persistedRunsSchema.parse(JSON.parse(readFileSync(this.storePath, "utf8")));
      for (const persisted of parsed) {
        const run = persisted as unknown as LoopRun;
        for (const iteration of run.iterations) iteration.artifacts ??= [];
        if (run.status === "running" || run.status === "stopping") {
          run.status = "interrupted";
          run.stopReason = "appInterrupted";
          run.endedAt = this.now();
          run.updatedAt = run.endedAt;
          for (const iteration of run.iterations) {
            for (const child of iteration.children) {
              if (child.status === "queued" || child.status === "running") {
                child.status = "stopped";
                child.endedAt ??= run.endedAt;
              }
            }
          }
        }
        this.runs.set(run.id, run);
      }
      this.persist();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      try {
        const quarantine = path.join(
          directory,
          `loop-runs.corrupt-${Date.now()}-${randomUUID()}.json`,
        );
        renameSync(this.storePath, quarantine);
        this.warn(`Quarantined invalid Loop run store at ${quarantine}`, error);
      } catch (quarantineError) {
        this.warn("Loop run store is invalid and could not be quarantined", quarantineError);
      }
      this.runs.clear();
    }
  }

  private persist(): void {
    if (!this.storePath) return;
    mkdirSync(path.dirname(this.storePath), { recursive: true });
    const temp = `${this.storePath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, JSON.stringify([...this.runs.values()], null, 2));
      renameSync(temp, this.storePath);
    } finally {
      rmSync(temp, { force: true });
    }
  }

  private changed(run: LoopRun): void {
    if (isLoopRunTerminal(run.status)) return;
    run.updatedAt = this.now();
    this.persist();
  }

  get(id: string): LoopRun | undefined {
    return this.runs.get(id);
  }
  list(): LoopRun[] {
    return [...this.runs.values()];
  }
  settled(id: string): Promise<void> {
    return this.settledPromises.get(id) ?? Promise.resolve();
  }

  /** Runs whose transient parent session still requires reconciliation. */
  pendingResourceReconciliations(): LoopRun[] {
    return this.list().filter((run) => run.launch && !run.launch.sessionReconciledAt);
  }

  /** Interrupted destructive checkouts stay locked until explicit acknowledgement. */
  recoveryCheckoutLocks(): Map<string, string> {
    const locks = new Map<string, string>();
    for (const run of this.runs.values()) {
      if (
        run.status === "interrupted" &&
        run.launch?.writeTarget === "currentCheckout" &&
        run.launch.checkoutLockKey &&
        !run.launch.checkoutAcknowledgedAt
      ) {
        locks.set(run.launch.checkoutLockKey, run.id);
      }
    }
    return locks;
  }

  markSessionReconciled(id: string): void {
    const launch = this.runs.get(id)?.launch;
    if (!launch || launch.sessionReconciledAt) return;
    launch.sessionReconciledAt = this.now();
    this.persist();
  }

  acknowledgeCheckoutRecovery(id: string): LoopRun | undefined {
    const run = this.runs.get(id);
    if (
      !run ||
      run.status !== "interrupted" ||
      run.launch?.writeTarget !== "currentCheckout" ||
      !run.launch.checkoutLockKey
    ) {
      return undefined;
    }
    run.launch.checkoutAcknowledgedAt ??= this.now();
    run.updatedAt = this.now();
    this.persist();
    return run;
  }

  /** Persist a pre-allocation failure after definition/project validation. */
  recordFailedStart(
    loop: LoopDefinition,
    cwd: string,
    reason: Extract<LoopStopReason, "unsafeWriteTarget" | "toolFailed">,
    summary: string,
    projectId?: string,
    launch?: LoopRunLaunchOwnership,
  ): LoopRun {
    this.evictOldRuns();
    const now = this.now();
    const run: LoopRun = {
      id: randomUUID(),
      catalogId: loop.id,
      loopName: loop.name,
      structure: loop.structure,
      projectId,
      definitionSnapshot: snapshotDefinition(loop),
      launch,
      launchContext: normalizeLoopLaunchContext(loop.launchContext),
      launchContextScope: loop.launchContextScope,
      status: "failed",
      stopReason: reason,
      currentIteration: 0,
      maxIterations: clampMaxIterations(loop.maxIterations),
      iterations: [
        {
          id: randomUUID(),
          index: 0,
          startedAt: now,
          endedAt: now,
          output: summary,
          validationPassed: null,
          timeline: [],
          children: [],
          artifacts: [],
        },
      ],
      startedAt: now,
      updatedAt: now,
      endedAt: now,
    };
    void cwd;
    this.runs.set(run.id, run);
    this.persist();
    this.settledPromises.set(run.id, Promise.resolve());
    return run;
  }

  /** Remove a never-committed launch after its resources have fully settled. */
  rollbackStart(id: string): void {
    if (this.active.has(id)) throw new Error("cannot roll back an active Loop run");
    this.runs.delete(id);
    this.settledPromises.delete(id);
    this.persist();
  }

  resolveHumanApproval(
    id: string,
    decision: "approve" | "reject",
    expectedUpdatedAt: string,
  ): LoopRun {
    const run = this.runs.get(id);
    if (!run || run.structure !== "humanApproval" || !run.checkpointPrompt) {
      throw new HumanApprovalConflictError("This is not a dedicated Human Approval checkpoint.");
    }
    const resolvedReason = decision === "approve" ? "humanApproved" : "humanRejected";
    if (run.stopReason === resolvedReason) return run;
    if (run.stopReason !== "humanInputRequired" || run.status !== "stopped") {
      throw new HumanApprovalConflictError("This checkpoint is no longer awaiting a decision.");
    }
    if (run.updatedAt !== expectedUpdatedAt) {
      throw new HumanApprovalConflictError("The checkpoint changed; reload before deciding.");
    }
    const now = this.now();
    const index = run.currentIteration + 1;
    const summary =
      decision === "approve"
        ? "Human approval recorded. Start a new attempt for follow-up work."
        : "Human rejected checkpoint.";
    const iteration: LoopRunIteration = {
      id: randomUUID(),
      index,
      startedAt: now,
      endedAt: now,
      output: summary,
      validationPassed: null,
      timeline: [
        {
          id: randomUUID(),
          phase: "checkpoint",
          roleName: "Human Approval",
          note: decision === "approve" ? "Approval recorded" : "Rejected",
          timestamp: now,
        },
      ],
      children: [],
      artifacts: [],
    };
    run.iterations.push(iteration);
    run.currentIteration = index;
    run.stopReason = resolvedReason;
    run.endedAt = now;
    run.updatedAt = now;
    this.persist();
    return run;
  }

  async stop(id: string): Promise<void> {
    const run = this.runs.get(id);
    if (!run || isLoopRunTerminal(run.status)) return;
    if (run.status === "running") {
      run.status = "stopping";
      run.updatedAt = this.now();
      this.persist();
    }
    const active = this.active.get(id);
    active?.controller.abort();
    if (active?.cancel && !active.cancelPromise) active.cancelPromise = active.cancel();
    await active?.cancelPromise?.catch(() => {});
    await this.settled(id);
  }

  private evictOldRuns(): void {
    if (this.runs.size < MAX_RETAINED_RUNS) return;
    for (const [id, run] of this.runs) {
      if (this.runs.size < MAX_RETAINED_RUNS) break;
      if (isLoopRunTerminal(run.status)) this.runs.delete(id);
    }
  }

  start(loop: LoopDefinition, cwd: string, options: LoopStartOptions = {}): LoopRun {
    if (!isRunnableLoopStructure(loop.structure))
      throw new UnsupportedLoopStructureError(loop.structure);
    const invalid = loopDefinitionValidationError(loop);
    if (invalid) throw new Error(invalid);
    this.evictOldRuns();
    const now = this.now();
    const definitionSnapshot = snapshotDefinition(loop);
    const launchContext = normalizeLoopLaunchContext(loop.launchContext);
    if (loop.structure === "humanApproval") {
      const prompt = normalizeLoopCheckpointPrompt(loop.checkpointPrompt);
      const run: LoopRun = {
        id: randomUUID(),
        catalogId: loop.id,
        loopName: loop.name,
        structure: "humanApproval",
        projectId: options.projectId,
        retryOf: options.retryOf,
        checkpointPrompt: prompt,
        definitionSnapshot,
        launchContext,
        launchContextScope: loop.launchContextScope,
        status: "running",
        currentIteration: 1,
        maxIterations: clampMaxIterations(loop.maxIterations),
        iterations: [],
        startedAt: now,
        updatedAt: now,
      };
      const iteration: LoopRunIteration = {
        id: randomUUID(),
        index: 1,
        startedAt: now,
        endedAt: now,
        output: "Stopped at human approval checkpoint.",
        validationPassed: null,
        timeline: [
          {
            id: randomUUID(),
            phase: "checkpoint",
            roleName: "Human Approval",
            note: prompt,
            timestamp: now,
          },
        ],
        children: [],
        artifacts: [],
      };
      run.iterations.push(iteration);
      this.runs.set(run.id, run);
      try {
        this.writeHumanApprovalArtifact(
          run,
          iteration,
          "human-approval-checkpoint.md",
          `# Human Approval Checkpoint\n\nGoal: ${loop.goal}${launchContext ? `\n\nLaunch context:\n${boundedPipelineEvidence(launchContext, MAX_LAUNCH_CONTEXT_PROMPT_CHARS)}` : ""}\n\nContext scope: ${loop.launchContextScope}\n\nCheckpoint: ${prompt}\n\nStatus: Waiting for human input.`,
        );
        this.finalize(run, "stopped", "humanInputRequired");
      } catch (error) {
        this.runs.delete(run.id);
        throw error;
      }
      this.settledPromises.set(run.id, Promise.resolve());
      return run;
    }
    const executeRole = options.executeRole ?? this.defaultExecuteRole;
    const executeAgent = options.executeAgent ?? this.defaultExecuteAgent;
    if (!executeRole && !executeAgent)
      throw new Error("no agent executor configured for this loop run");
    const run: LoopRun = {
      id: randomUUID(),
      catalogId: loop.id,
      loopName: loop.name,
      structure: loop.structure,
      projectId: options.projectId,
      retryOf: options.retryOf,
      launch: options.launch,
      definitionSnapshot,
      launchContext,
      launchContextScope: loop.launchContextScope,
      status: "running",
      currentIteration: 0,
      maxIterations: clampMaxIterations(loop.maxIterations),
      iterations: [],
      startedAt: now,
      updatedAt: now,
    };
    const active = { controller: new AbortController(), cancel: options.cancel };
    this.runs.set(run.id, run);
    this.active.set(run.id, active);
    try {
      this.persist();
    } catch (error) {
      this.runs.delete(run.id);
      this.active.delete(run.id);
      throw error;
    }
    const task = this.execute(run, loop, cwd, executeRole, executeAgent, active.controller.signal)
      .catch(() => {
        if (!isLoopRunTerminal(run.status)) this.finalize(run, "failed", "agentFailed");
      })
      .finally(() => this.active.delete(run.id));
    this.settledPromises.set(run.id, task);
    return run;
  }

  private finalize(run: LoopRun, status: LoopRunStatus, reason: LoopStopReason): void {
    if (isLoopRunTerminal(run.status)) return;
    run.status = status;
    run.stopReason = reason;
    run.endedAt = this.now();
    run.updatedAt = run.endedAt;
    this.persist();
  }

  private stopped(run: LoopRun, signal: AbortSignal): boolean {
    if (!signal.aborted && run.status !== "stopping") return false;
    this.finalize(run, "stopped", "userStopped");
    return true;
  }

  private async role(
    run: LoopRun,
    iteration: LoopRunIteration,
    loop: LoopDefinition,
    phase: "maker" | "checker" | "stage" | "branch" | "triage" | "evaluator",
    prompt: string,
    agentName: string | undefined,
    cwd: string,
    projectId: string | undefined,
    signal: AbortSignal,
    executeRole: ExecuteLoopRole | undefined,
    executeAgent: ExecuteAgent | undefined,
    stageIndex?: number,
    branchIndex?: number,
  ): Promise<string> {
    const startedAt = this.now();
    const child: LoopChildRecord = {
      id: randomUUID(),
      phase,
      stageIndex,
      branchIndex,
      agentName,
      status: "running",
      startedAt,
    };
    iteration.children.push(child);
    iteration.timeline.push({
      id: randomUUID(),
      phase,
      roleName: agentName ?? "Goal evaluator",
      note:
        phase === "stage"
          ? `stage ${(stageIndex ?? 0) + 1} started`
          : phase === "branch"
            ? `branch ${(branchIndex ?? 0) + 1} started`
            : `${phase} started`,
      timestamp: startedAt,
      stageIndex,
      branchIndex,
    });
    this.changed(run);
    try {
      const effectivePrompt = [launchContextPrompt(run, iteration.index), prompt]
        .filter(Boolean)
        .join("\n\n");
      const output = executeRole
        ? await executeRole({
            loop,
            prompt: effectivePrompt,
            agentName,
            phase,
            stageIndex,
            branchIndex,
            provider: phase === "evaluator" ? loop.evaluatorProvider : undefined,
            model: phase === "evaluator" ? loop.evaluatorModel : undefined,
            thinking: phase === "evaluator" ? loop.evaluatorThinkingLevel : undefined,
            cwd,
            projectId,
            signal,
          })
        : await executeAgent!({ ...loop, goal: effectivePrompt, agentName }, cwd, projectId);
      if (signal.aborted || run.status === "stopping") {
        child.status = "stopped";
        child.endedAt = this.now();
        this.changed(run);
        return output;
      }
      if (isLoopRunTerminal(run.status)) return output;
      child.output = output;
      child.status = "completed";
      child.endedAt = this.now();
      iteration.timeline.push({
        id: randomUUID(),
        phase,
        roleName: agentName ?? "Goal evaluator",
        note:
          phase === "stage"
            ? `stage ${(stageIndex ?? 0) + 1} completed`
            : phase === "branch"
              ? `branch ${(branchIndex ?? 0) + 1} completed`
              : `${phase} completed`,
        timestamp: child.endedAt,
        stageIndex,
        branchIndex,
      });
      this.changed(run);
      return output;
    } catch (error) {
      child.error = error instanceof Error ? error.message : String(error);
      child.status = signal.aborted ? "stopped" : "failed";
      child.endedAt = this.now();
      if (!isLoopRunTerminal(run.status)) this.changed(run);
      throw error;
    }
  }

  private async parallelBranchRole(
    run: LoopRun,
    iteration: LoopRunIteration,
    loop: LoopDefinition,
    child: LoopChildRecord,
    prompt: string,
    cwd: string,
    projectId: string | undefined,
    signal: AbortSignal,
    executeRole: ExecuteLoopRole | undefined,
    executeAgent: ExecuteAgent | undefined,
  ): Promise<string> {
    child.status = "running";
    child.startedAt = this.now();
    iteration.timeline.push({
      id: randomUUID(),
      phase: "branch",
      roleName: child.agentName!,
      note: `branch ${(child.branchIndex ?? 0) + 1} started`,
      timestamp: child.startedAt,
      branchIndex: child.branchIndex,
    });
    this.changed(run);
    try {
      const effectivePrompt = [launchContextPrompt(run, iteration.index), prompt]
        .filter(Boolean)
        .join("\n\n");
      const output = executeRole
        ? await executeRole({
            loop,
            prompt: effectivePrompt,
            agentName: child.agentName,
            phase: "branch",
            branchIndex: child.branchIndex,
            cwd,
            projectId,
            signal,
          })
        : await executeAgent!(
            { ...loop, goal: effectivePrompt, agentName: child.agentName },
            cwd,
            projectId,
          );
      child.endedAt = this.now();
      if (signal.aborted || isLoopRunTerminal(run.status)) {
        child.status = "stopped";
        return output;
      }
      child.output = output;
      child.status = "completed";
      iteration.timeline.push({
        id: randomUUID(),
        phase: "branch",
        roleName: child.agentName!,
        note: `branch ${(child.branchIndex ?? 0) + 1} completed`,
        timestamp: child.endedAt,
        branchIndex: child.branchIndex,
      });
      this.changed(run);
      return output;
    } catch (error) {
      child.endedAt = this.now();
      if (signal.aborted || isLoopRunTerminal(run.status)) {
        child.status = "stopped";
      } else {
        child.status = "failed";
        child.error = error instanceof Error ? error.message : String(error);
        this.changed(run);
      }
      throw error;
    }
  }

  private writeHumanApprovalArtifact(
    run: LoopRun,
    iteration: LoopRunIteration,
    filename: string,
    markdown: string,
  ): void {
    if (!this.artifactsRoot) return;
    const directory = path.join(this.artifactsRoot, run.id);
    mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, filename);
    const temp = `${filePath}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temp, markdown, "utf8");
      renameSync(temp, filePath);
    } finally {
      rmSync(temp, { force: true });
    }
    const createdAt = this.now();
    iteration.artifacts.push({
      id: randomUUID(),
      phase: "checkpoint",
      filename,
      filePath,
      bytes: Buffer.byteLength(markdown),
      createdAt,
    });
    iteration.timeline.push({
      id: randomUUID(),
      phase: "checkpoint",
      roleName: "Human Approval",
      note: `Saved approval artifact: ${filename}`,
      timestamp: createdAt,
    });
  }

  private persistArtifact(
    run: LoopRun,
    iteration: LoopRunIteration,
    phase: "maker" | "checker" | "stage" | "branch" | "triage" | "evaluator",
    output: string,
    stageIndex?: number,
    agentName?: string,
    branchIndex?: number,
  ): void {
    if (!this.artifactsRoot || isLoopRunTerminal(run.status)) return;
    const directory = path.join(this.artifactsRoot, run.id);
    const filename =
      phase === "stage"
        ? `iteration-${iteration.index}-stage-${(stageIndex ?? 0) + 1}.md`
        : phase === "branch"
          ? `iteration-${iteration.index}-branch-${(branchIndex ?? 0) + 1}.md`
          : `iteration-${iteration.index}-${phase}.md`;
    const filePath = path.join(directory, filename);
    const temp = `${filePath}.${randomUUID()}.tmp`;
    try {
      mkdirSync(directory, { recursive: true });
      writeFileSync(temp, output, "utf8");
      renameSync(temp, filePath);
    } catch (error) {
      throw new LoopToolFailureError(
        `Loop artifact persistence failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      try {
        rmSync(temp, { force: true });
      } catch {
        // The primary persistence error above remains authoritative.
      }
    }
    const artifact: LoopRunArtifact = {
      id: randomUUID(),
      phase,
      stageIndex,
      branchIndex,
      agentName,
      filename,
      filePath,
      bytes: Buffer.byteLength(output),
      createdAt: this.now(),
    };
    iteration.artifacts.push(artifact);
    iteration.timeline.push({
      id: randomUUID(),
      phase,
      roleName: phase === "evaluator" ? "Goal evaluator" : (agentName ?? phase),
      note: `Saved report artifact: ${filename}`,
      timestamp: artifact.createdAt,
      stageIndex,
      branchIndex,
    });
    this.changed(run);
  }

  private async validation(
    run: LoopRun,
    iteration: LoopRunIteration,
    cwd: string,
    command: string,
    signal: AbortSignal,
  ): Promise<ValidationResult> {
    const timestamp = this.now();
    iteration.timeline.push({
      id: randomUUID(),
      phase: "validation",
      roleName: "Validation",
      note: "validation started",
      timestamp,
    });
    this.changed(run);
    try {
      const result = await this.runValidation(
        cwd,
        command,
        signal,
        this.artifactsRoot ? path.join(this.artifactsRoot, run.id, "validation") : undefined,
      );
      const normalized: ValidationResult =
        typeof result === "boolean" || !("classification" in result)
          ? {
              command,
              workingDirectory: cwd,
              exitCode: (typeof result === "boolean" ? result : result.passed) ? 0 : 1,
              durationMs: 0,
              stdout: "",
              stderr: "",
              classification: "completed",
              passed: typeof result === "boolean" ? result : result.passed,
              evidence:
                typeof result === "boolean" ? (result ? "passed" : "failed") : result.evidence,
            }
          : result;
      iteration.validationResult = normalized;
      for (const [stream, filePath] of [
        ["stdout", normalized.stdoutPath],
        ["stderr", normalized.stderrPath],
      ] as const) {
        if (!filePath) continue;
        iteration.artifacts.push({
          id: randomUUID(),
          phase: "validation",
          filename: path.basename(filePath),
          filePath,
          bytes: Buffer.byteLength(stream === "stdout" ? normalized.stdout : normalized.stderr),
          createdAt: this.now(),
        });
      }
      if (!signal.aborted && !isLoopRunTerminal(run.status)) {
        iteration.timeline.push({
          id: randomUUID(),
          phase: "validation",
          roleName: "Validation",
          note: normalized.passed ? "validation passed" : "validation failed",
          timestamp: this.now(),
        });
        this.changed(run);
      }
      return normalized;
    } catch (error) {
      const stderr = error instanceof Error ? error.message : String(error);
      const failed: ValidationResult = {
        command,
        workingDirectory: cwd,
        exitCode: null,
        durationMs: 0,
        stdout: "",
        stderr,
        classification: "spawnError",
        passed: false,
        evidence: stderr,
      };
      iteration.validationResult = failed;
      return failed;
    }
  }

  private async execute(
    run: LoopRun,
    loop: LoopDefinition,
    cwd: string,
    executeRole: ExecuteLoopRole | undefined,
    executeAgent: ExecuteAgent | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    let feedback = "";
    for (let index = 1; run.maxIterations === 0 || index <= run.maxIterations; index += 1) {
      // Unlimited runs must yield to timers/I/O so Stop can always abort even
      // when a test/dummy executor resolves synchronously.
      if (run.maxIterations === 0 && index > 1) await new Promise<void>(setImmediate);
      if (this.stopped(run, signal)) return;
      run.currentIteration = index;
      const iteration: LoopRunIteration = {
        id: randomUUID(),
        index,
        startedAt: this.now(),
        output: "",
        validationPassed: null,
        timeline: [],
        children: [],
        artifacts: [],
      };
      run.iterations.push(iteration);
      this.changed(run);
      try {
        if (loop.structure === "parallelAgents") {
          const branches = normalizeParallelBranches(loop.parallelBranches);
          const branchChildren = branches.map<LoopChildRecord>((agentName, branchIndex) => ({
            id: randomUUID(),
            phase: "branch",
            branchIndex,
            agentName,
            status: "queued",
            queuedAt: this.now(),
          }));
          iteration.children.push(...branchChildren);
          this.changed(run);
          const results: Array<{
            id: string;
            branchIndex: number;
            agentName: string;
            output?: string;
            error?: string;
          }> = new Array(branches.length);
          let nextBranchIndex = 0;
          const worker = async (): Promise<void> => {
            while (!signal.aborted) {
              const branchIndex = nextBranchIndex;
              if (branchIndex >= branches.length) return;
              nextBranchIndex += 1;
              const agentName = branches[branchIndex]!;
              const prompt = [
                "Agent Deck controls this loop iteration. Complete only this assigned step.",
                `Goal: ${loop.goal}`,
                `Iteration: ${index}`,
                "You are working as one explicitly selected agent in a report-only parallel investigation.",
                `Parallel branch: ${branchIndex + 1} of ${branches.length}`,
                `Assigned agent: ${agentName}`,
                "Work independently. Do not edit project files or coordinate with sibling agents. End with a concise Markdown summary of findings, evidence, risks, and recommended next action.",
                feedback
                  ? `Prior-iteration evaluator and validation evidence:\n${boundedPipelineEvidence(feedback)}`
                  : "",
              ]
                .filter(Boolean)
                .join("\n\n");
              try {
                const child = branchChildren[branchIndex]!;
                const output = await this.parallelBranchRole(
                  run,
                  iteration,
                  loop,
                  child,
                  prompt,
                  cwd,
                  run.projectId,
                  signal,
                  executeRole,
                  executeAgent,
                );
                if (!signal.aborted) {
                  results[branchIndex] = {
                    id: child.id,
                    branchIndex,
                    agentName,
                    output,
                  };
                }
              } catch (error) {
                if (!signal.aborted) {
                  results[branchIndex] = {
                    id: branchChildren[branchIndex]!.id,
                    branchIndex,
                    agentName,
                    error: error instanceof Error ? error.message : String(error),
                  };
                }
              }
            }
          };
          await Promise.all(
            Array.from({ length: Math.min(2, branches.length) }, async () => await worker()),
          );
          if (signal.aborted || run.status === "stopping") {
            const stoppedAt = this.now();
            for (const child of branchChildren) {
              if (child.status === "queued") {
                child.status = "stopped";
                child.endedAt = stoppedAt;
              }
            }
          }
          if (this.stopped(run, signal)) return;

          // Native waits for every configured branch and renders its graph
          // summary in configured order, regardless of completion order. A
          // partial failure still proceeds through validation/evaluation, then
          // fails the run after that evidence is recorded.
          iteration.parallelBranchOutputs = results;
          const aggregate = results
            .map((branch) => `- ${branch.agentName}: ${branch.output ?? branch.error ?? "failed"}`)
            .join("\n");
          iteration.output = aggregate;
          this.changed(run);
          for (const branch of results) {
            this.persistArtifact(
              run,
              iteration,
              "branch",
              branch.output ?? `# ${branch.agentName}\n\nError: ${branch.error ?? "failed"}`,
              undefined,
              branch.agentName,
              branch.branchIndex,
            );
          }

          let validation: ValidationResult = unconfiguredValidation(cwd);
          if (loop.validationCommand) {
            validation = await this.validation(run, iteration, cwd, loop.validationCommand, signal);
          }
          if (this.stopped(run, signal)) return;
          iteration.validationPassed = loop.validationCommand ? validation.passed : null;
          iteration.validationEvidence = validation.evidence;

          const evaluatorPrompt = [
            `Goal: ${loop.goal}`,
            `Success condition: ${loop.successCondition || loop.goal}`,
            `Iteration: ${index}`,
            "Evaluate the completed report-only parallel investigation; do not edit project files.",
            `Parallel branch reports in configured order:\n${boundedPipelineEvidence(aggregate)}`,
            `Validation evidence:\n${boundedPipelineEvidence(validation.evidence)}`,
            "The exact first non-empty line must be SUCCESS, CONTINUE, or FAIL. Then give rationale and concrete evidence.",
          ].join("\n\n");
          iteration.evaluatorOutput = await this.role(
            run,
            iteration,
            loop,
            "evaluator",
            evaluatorPrompt,
            undefined,
            cwd,
            run.projectId,
            signal,
            executeRole,
            executeAgent,
          );
          if (this.stopped(run, signal)) return;
          this.persistArtifact(run, iteration, "evaluator", iteration.evaluatorOutput);
          const goalDecision =
            exactFirstLine(iteration.evaluatorOutput, GOAL_DECISIONS) ?? "CONTINUE";
          iteration.goalDecision = goalDecision;
          iteration.endedAt = this.now();
          this.changed(run);
          if (results.some((branch) => branch.error)) {
            this.finalize(run, "failed", "agentFailed");
            return;
          }
          if (goalDecision === "FAIL") {
            this.finalize(run, "failed", "agentFailed");
            return;
          }
          if (
            validation.classification === "spawnError" ||
            validation.classification === "timeout"
          ) {
            this.finalize(run, "failed", "toolFailed");
            return;
          }
          if (goalDecision === "SUCCESS" && validation.passed) {
            this.finalize(run, "completed", "success");
            return;
          }
          feedback = boundedPipelineEvidence(
            [iteration.evaluatorOutput, validation.evidence].join("\n\n"),
          );
          continue;
        }

        if (loop.structure === "discoveryTriage") {
          const triageAgent = loop.triageAgent!;
          const classificationPrompt = normalizeLoopClassificationPrompt(loop.classificationPrompt);
          const artifactPath = this.artifactsRoot
            ? path.join(this.artifactsRoot, run.id, `iteration-${index}-triage.md`)
            : "Agent Deck's durable in-memory run artifact";
          const targetInstructions =
            loop.writeTarget === "artifactMarkdown"
              ? "This is report-only discovery. Do not edit project files. Return the complete Markdown classification report; Agent Deck will persist it as the artifact."
              : loop.writeTarget === "newWorktree"
                ? "Work only in the selected isolated worktree. You may edit files only when the loop goal explicitly requests implementation; discovery alone must not change files."
                : "Work only in the selected current checkout. You may edit files only when the loop goal explicitly requests implementation; discovery alone must not change files.";
          const prompt = [
            "Agent Deck is running this loop. Agent Deck controls iteration count, retries, stopping, artifacts, and validation. Do not run your own open-ended loop; complete only this assigned step.",
            `Loop goal: ${loop.goal}`,
            `Iteration: ${index}${run.maxIterations === 0 ? " (no limit)" : ` of ${run.maxIterations}`}`,
            `Write target: ${loop.writeTarget}`,
            `Artifact path: ${artifactPath}`,
            "You are performing discovery and triage for this loop step.",
            `Classification prompt: ${classificationPrompt}`,
            targetInstructions,
            "Inspect the requested signals and repository context. Group findings by severity/category, cite evidence, and recommend the safest next action. Do not implement fixes unless the loop goal explicitly asks you to. Produce a concise Markdown triage artifact.",
            feedback
              ? `Bounded prior iteration classification, evaluation, and validation evidence:\n${boundedPipelineEvidence(feedback)}`
              : "",
          ]
            .filter(Boolean)
            .join("\n\n");
          const classificationOutput = await this.role(
            run,
            iteration,
            loop,
            "triage",
            prompt,
            triageAgent,
            cwd,
            run.projectId,
            signal,
            executeRole,
            executeAgent,
          );
          if (this.stopped(run, signal)) return;
          iteration.classificationOutput = classificationOutput;
          iteration.output = classificationOutput;
          this.persistArtifact(
            run,
            iteration,
            "triage",
            iteration.classificationOutput,
            undefined,
            triageAgent,
          );

          let validation: ValidationResult = unconfiguredValidation(cwd);
          if (loop.validationCommand) {
            validation = await this.validation(run, iteration, cwd, loop.validationCommand, signal);
          }
          if (this.stopped(run, signal)) return;
          iteration.validationPassed = loop.validationCommand ? validation.passed : null;
          iteration.validationEvidence = validation.evidence;

          const evaluatorPrompt = [
            `Goal: ${loop.goal}`,
            `Success condition: ${loop.successCondition || loop.goal}`,
            `Iteration: ${index}`,
            "Evaluate the discovery and classification report only; do not edit project files.",
            `Classification prompt: ${classificationPrompt}`,
            `Triage report:\n${boundedPipelineEvidence(iteration.classificationOutput)}`,
            `Validation evidence:\n${boundedPipelineEvidence(validation.evidence)}`,
            "The exact first non-empty line must be SUCCESS, CONTINUE, or FAIL. Then give rationale and concrete evidence.",
          ].join("\n\n");
          const evaluatorOutput = await this.role(
            run,
            iteration,
            loop,
            "evaluator",
            evaluatorPrompt,
            undefined,
            cwd,
            run.projectId,
            signal,
            executeRole,
            executeAgent,
          );
          if (this.stopped(run, signal)) return;
          iteration.evaluatorOutput = evaluatorOutput;
          if (loop.writeTarget === "artifactMarkdown") {
            this.persistArtifact(run, iteration, "evaluator", evaluatorOutput);
          }
          const goalDecision = exactFirstLine(evaluatorOutput, GOAL_DECISIONS) ?? "CONTINUE";
          iteration.goalDecision = goalDecision;
          iteration.endedAt = this.now();
          this.changed(run);
          if (goalDecision === "FAIL") {
            this.finalize(run, "failed", "agentFailed");
            return;
          }
          if (
            validation.classification === "spawnError" ||
            validation.classification === "timeout"
          ) {
            this.finalize(run, "failed", "toolFailed");
            return;
          }
          if (goalDecision === "SUCCESS" && validation.passed) {
            this.finalize(run, "completed", "success");
            return;
          }
          feedback = [
            `Prior classification:\n${boundedPipelineEvidence(iteration.classificationOutput, 5_500)}`,
            `Prior evaluation:\n${boundedPipelineEvidence(iteration.evaluatorOutput, 2_800)}`,
            `Prior validation:\n${boundedPipelineEvidence(validation.evidence, 2_800)}`,
          ].join("\n\n");
          continue;
        }

        if (loop.structure === "agentPipeline") {
          const stageOutputs = (iteration.pipelineStageOutputs ??= []);
          const stages = loop.pipelineStages!;
          for (const [stageIndex, agentName] of stages.entries()) {
            if (this.stopped(run, signal)) return;
            const handoff = stageOutputs
              .map(
                (stage) =>
                  `Stage ${stage.stageIndex + 1} (${stage.agentName}) report:\n${boundedPipelineEvidence(stage.output, MAX_PIPELINE_REPORT_CHARS)}`,
              )
              .join("\n\n");
            const prompt = [
              `Goal: ${loop.goal}`,
              `Iteration: ${index}`,
              `Pipeline stage: ${stageIndex + 1} of ${stages.length}`,
              `You are the configured pipeline agent "${agentName}". Complete only this stage and provide a concise handoff report for later stages.`,
              feedback
                ? `Prior-iteration evaluator and validation evidence:\n${boundedPipelineEvidence(feedback)}`
                : "",
              handoff
                ? `Bounded reports from completed stages in this iteration:\n${boundedPipelineEvidence(handoff)}`
                : "",
            ]
              .filter(Boolean)
              .join("\n\n");
            const output = await this.role(
              run,
              iteration,
              loop,
              "stage",
              prompt,
              agentName,
              cwd,
              run.projectId,
              signal,
              executeRole,
              executeAgent,
              stageIndex,
            );
            if (this.stopped(run, signal)) return;
            stageOutputs.push({ id: randomUUID(), stageIndex, agentName, output });
            iteration.output = output;
            this.changed(run);
            if (loop.writeTarget === "artifactMarkdown") {
              this.persistArtifact(run, iteration, "stage", output, stageIndex, agentName);
            }
          }

          let validation: ValidationResult = unconfiguredValidation(cwd);
          if (loop.validationCommand) {
            validation = await this.validation(run, iteration, cwd, loop.validationCommand, signal);
          }
          if (this.stopped(run, signal)) return;
          iteration.validationPassed = loop.validationCommand ? validation.passed : null;
          iteration.validationEvidence = validation.evidence;

          const reports = stageOutputs
            .map(
              (stage) =>
                `Stage ${stage.stageIndex + 1} (${stage.agentName}) report:\n${boundedPipelineEvidence(stage.output, MAX_PIPELINE_REPORT_CHARS)}`,
            )
            .join("\n\n");
          const evaluatorPrompt = [
            `Goal: ${loop.goal}`,
            `Success condition: ${loop.successCondition || loop.goal}`,
            `Iteration: ${index}`,
            "Evaluate the completed pipeline only; do not edit project files.",
            `Ordered pipeline reports:\n${boundedPipelineEvidence(reports)}`,
            `Validation evidence:\n${boundedPipelineEvidence(validation.evidence)}`,
            "The exact first non-empty line must be SUCCESS, CONTINUE, or FAIL. Then give rationale and concrete evidence.",
          ].join("\n\n");
          iteration.evaluatorOutput = await this.role(
            run,
            iteration,
            loop,
            "evaluator",
            evaluatorPrompt,
            undefined,
            cwd,
            run.projectId,
            signal,
            executeRole,
            executeAgent,
          );
          if (this.stopped(run, signal)) return;
          if (loop.writeTarget === "artifactMarkdown") {
            this.persistArtifact(run, iteration, "evaluator", iteration.evaluatorOutput);
          }
          const goalDecision =
            exactFirstLine(iteration.evaluatorOutput, GOAL_DECISIONS) ?? "CONTINUE";
          iteration.goalDecision = goalDecision;
          iteration.endedAt = this.now();
          this.changed(run);
          if (goalDecision === "FAIL") {
            this.finalize(run, "failed", "agentFailed");
            return;
          }
          if (
            validation.classification === "spawnError" ||
            validation.classification === "timeout"
          ) {
            this.finalize(run, "failed", "toolFailed");
            return;
          }
          if (goalDecision === "SUCCESS" && validation.passed) {
            this.finalize(run, "completed", "success");
            return;
          }
          feedback = boundedPipelineEvidence(
            [iteration.evaluatorOutput, validation.evidence].join("\n\n"),
          );
          continue;
        }

        const makerName = loop.makerName || loop.agentName;
        const makerPrompt = [
          `Goal: ${loop.goal}`,
          `Success condition: ${loop.successCondition || loop.goal}`,
          `Iteration: ${index}`,
          loop.structure === "makerChecker"
            ? "You are the maker. Perform one implementation pass."
            : "Perform one implementation pass.",
          feedback ? `Evidence from the previous iteration to address:\n${feedback}` : "",
        ]
          .filter(Boolean)
          .join("\n\n");
        iteration.output = await this.role(
          run,
          iteration,
          loop,
          "maker",
          makerPrompt,
          makerName,
          cwd,
          run.projectId,
          signal,
          executeRole,
          executeAgent,
        );
        if (this.stopped(run, signal)) return;
        if (loop.writeTarget === "artifactMarkdown") {
          this.persistArtifact(run, iteration, "maker", iteration.output);
        }

        if (loop.structure === "singleAgent") {
          let validation = unconfiguredValidation(cwd);
          if (loop.validationCommand) {
            validation = await this.validation(run, iteration, cwd, loop.validationCommand, signal);
          }
          if (this.stopped(run, signal)) return;
          iteration.validationPassed = loop.validationCommand ? validation.passed : null;
          iteration.validationEvidence = validation.evidence;
          const evaluatorPrompt = [
            "You are Agent Deck's report-only natural-language goal evaluator. Review only; do not edit project files.",
            `Loop goal: ${loop.goal}`,
            `Success condition: ${loop.successCondition || loop.goal}`,
            `Iteration: ${index}${run.maxIterations === 0 ? " (no limit)" : ` of ${run.maxIterations}`}`,
            `Iteration summary:\n${boundedPipelineEvidence(iteration.output)}`,
            `Validation evidence:\n${boundedPipelineEvidence(validation.evidence)}`,
            "Decide whether the success condition is met from the available evidence. Start your final response with exactly one decision line: SUCCESS, CONTINUE, or FAIL. Use SUCCESS only when the success condition is satisfied, CONTINUE when more iterations should try again, and FAIL when the loop should stop as agent failed. Then provide concise Markdown rationale.",
          ].join("\n\n");
          iteration.evaluatorOutput = await this.role(
            run,
            iteration,
            loop,
            "evaluator",
            evaluatorPrompt,
            undefined,
            cwd,
            run.projectId,
            signal,
            executeRole,
            executeAgent,
          );
          if (this.stopped(run, signal)) return;
          this.persistArtifact(run, iteration, "evaluator", iteration.evaluatorOutput);
          const goalDecision =
            exactFirstLine(iteration.evaluatorOutput, GOAL_DECISIONS) ?? "CONTINUE";
          iteration.goalDecision = goalDecision;
          iteration.endedAt = this.now();
          this.changed(run);
          if (goalDecision === "FAIL") {
            this.finalize(run, "failed", "agentFailed");
            return;
          }
          if (
            validation.classification === "spawnError" ||
            validation.classification === "timeout"
          ) {
            this.finalize(run, "failed", "toolFailed");
            return;
          }
          if (goalDecision === "SUCCESS" && validation.passed) {
            this.finalize(run, "completed", "success");
            return;
          }
          feedback = [iteration.evaluatorOutput, validation.evidence].join("\n\n");
          continue;
        }

        const checkerPrompt = [
          `Goal: ${loop.goal}`,
          `Success condition: ${loop.successCondition || loop.goal}`,
          `Iteration: ${index}`,
          "Review only; do not edit project files.",
          `Review criteria: ${loop.checkerRubric}`,
          `Maker report:\n${iteration.output}`,
          "The exact first non-empty line must be APPROVE, CONTINUE, REJECT, ASK_HUMAN, or FAIL. Then give concise rationale and concrete evidence.",
        ].join("\n\n");
        iteration.checkerOutput = await this.role(
          run,
          iteration,
          loop,
          "checker",
          checkerPrompt,
          loop.checkerName,
          cwd,
          run.projectId,
          signal,
          executeRole,
          executeAgent,
        );
        if (this.stopped(run, signal)) return;
        if (loop.writeTarget === "artifactMarkdown") {
          this.persistArtifact(run, iteration, "checker", iteration.checkerOutput);
        }
        const checkerDecision = exactFirstLine(iteration.checkerOutput, CHECKER_DECISIONS);
        if (!checkerDecision) {
          iteration.endedAt = this.now();
          this.changed(run);
          this.finalize(run, "failed", "agentFailed");
          return;
        }
        iteration.checkerDecision = checkerDecision;
        if (checkerDecision === "FAIL") {
          iteration.endedAt = this.now();
          this.changed(run);
          this.finalize(run, "failed", "agentFailed");
          return;
        }

        let validation: ValidationResult = unconfiguredValidation(cwd);
        if (loop.validationCommand)
          validation = await this.validation(run, iteration, cwd, loop.validationCommand, signal);
        if (this.stopped(run, signal)) return;
        iteration.validationPassed = loop.validationCommand ? validation.passed : null;
        iteration.validationEvidence = validation.evidence;

        const evaluatorPrompt = [
          `Goal: ${loop.goal}`,
          `Success condition: ${loop.successCondition || loop.goal}`,
          `Iteration: ${index}`,
          "Evaluate only; do not edit project files.",
          `Maker report:\n${iteration.output}`,
          `Checker report:\n${iteration.checkerOutput}`,
          `Validation evidence:\n${validation.evidence}`,
          "The exact first non-empty line must be SUCCESS, CONTINUE, or FAIL. Then give rationale and concrete evidence.",
        ].join("\n\n");
        iteration.evaluatorOutput = await this.role(
          run,
          iteration,
          loop,
          "evaluator",
          evaluatorPrompt,
          undefined,
          cwd,
          run.projectId,
          signal,
          executeRole,
          executeAgent,
        );
        if (this.stopped(run, signal)) return;
        if (loop.writeTarget === "artifactMarkdown") {
          this.persistArtifact(run, iteration, "evaluator", iteration.evaluatorOutput);
        }
        const goalDecision =
          exactFirstLine(iteration.evaluatorOutput, GOAL_DECISIONS) ?? "CONTINUE";
        iteration.goalDecision = goalDecision;
        iteration.endedAt = this.now();
        this.changed(run);
        if (goalDecision === "FAIL") {
          this.finalize(run, "failed", "agentFailed");
          return;
        }
        if (validation.classification === "spawnError" || validation.classification === "timeout") {
          this.finalize(run, "failed", "toolFailed");
          return;
        }
        if (goalDecision === "SUCCESS" && validation.passed) {
          this.finalize(run, "completed", "success");
          return;
        }
        // Native PiAgentSessionStore.swift applies goal evaluation before
        // handling the checker decision: SUCCESS completes even after
        // ASK_HUMAN; only a continuing evaluator turns ASK_HUMAN into a stop.
        // See the paired ASK_HUMAN policy tests in loopEngine.test.ts.
        if (checkerDecision === "ASK_HUMAN") {
          this.finalize(run, "stopped", "humanInputRequired");
          return;
        }
        feedback = [iteration.checkerOutput, iteration.evaluatorOutput, validation.evidence].join(
          "\n\n",
        );
      } catch (error) {
        if (this.stopped(run, signal)) return;
        if (!iteration.output)
          iteration.output = error instanceof Error ? error.message : String(error);
        iteration.endedAt = this.now();
        this.changed(run);
        this.finalize(
          run,
          "failed",
          error instanceof LoopToolFailureError ? "toolFailed" : "agentFailed",
        );
        return;
      }
    }
    this.finalize(
      run,
      "notAchieved",
      loop.validationCommand && run.iterations.at(-1)?.validationPassed === false
        ? "validationFailedAfterFinalIteration"
        : "maxIterationsReached",
    );
  }
}
