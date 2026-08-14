import { randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  emptyTranscript,
  type ChildTranscriptSnapshot,
  type SubagentCell,
  type TranscriptCell,
  type TranscriptState,
} from "@agent-deck/domain";
import {
  SessionWorktreeStore,
  SubagentArtifactCapabilityError,
  SubagentArtifactStore,
  type SubagentArtifactAllocation,
} from "@agent-deck/loop-catalog-native";
import { z } from "zod";
import {
  MAX_DECLARED_READS_TOTAL_BYTES,
  normalizeDeclaredReads,
  renderSubagentArtifactInput,
} from "./declaredReads.ts";
import {
  gitDetachedWorktreeAdd,
  gitDetachedWorktreeRegistrationMatches,
  gitRepositoryIdentity,
  gitWorktreePrune,
  gitWorktreeRegistrationAtPath,
  gitWorktreeSource,
} from "./git.ts";
import { syncDirectoryStrict } from "./sessionImages.ts";

const MAX_RUNS = 2_000;
const MAX_STORE_BYTES = 8_000_000;
const MAX_TASK_BYTES = 50_000;
const MAX_RESULT_BYTES = 256_000;
const MAX_ERROR_BYTES = 50_000;
const MAX_SESSION_FILE_BYTES = 16_384;
const MAX_DECLARED_READS = 32;
const MAX_DECLARED_READ_LENGTH = 512;

export type SubagentRunSource = "single" | "parallel";

export type SubagentRunStatus =
  | "starting"
  | "running"
  | "completed"
  | "failed"
  | "stopped"
  | "interrupted";

export interface SubagentRunRecord {
  id: string;
  parentSessionId: string;
  task: string;
  agent?: string;
  status: SubagentRunStatus;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  summary?: string;
  error?: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  /** Additive v1 fields: absent legacy records remain readable but cannot resume. */
  source?: SubagentRunSource;
  /** Pi canonical resume handle. Ownership controls whether parent deletion may remove it. */
  sessionFile?: string;
  /** Additive v2 app-owned artifact identity. Paths are never persisted or exposed. */
  artifactRootId?: string;
  artifactRootToken?: string;
  currentTurnId?: string;
  sessionOwnership?: "owned" | "external";
  /** Additive v3 detached-worktree ownership proof. Never crosses public APIs. */
  worktreePath?: string;
  worktreeIdentity?: string;
  worktreeParentRepository?: string;
  worktreeRepositoryIdentity?: string;
  worktreeBaseCommit?: string;
  worktreeState?: "reserved" | "registered";
  worktreeCleanup?: "physical_removed";
  /** Additive v4 validated project-relative read-first hints for the latest turn. */
  declaredReads?: string[];
}

const runSchema = z
  .object({
    id: z.string().uuid(),
    parentSessionId: z.string().uuid(),
    task: z.string().max(MAX_TASK_BYTES),
    agent: z.string().max(500).optional(),
    status: z.enum(["starting", "running", "completed", "failed", "stopped", "interrupted"]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    completedAt: z.string().datetime().optional(),
    summary: z.string().max(MAX_RESULT_BYTES).optional(),
    error: z.string().max(MAX_ERROR_BYTES).optional(),
    model: z.string().max(500).optional(),
    inputTokens: z.number().nonnegative().optional(),
    outputTokens: z.number().nonnegative().optional(),
    durationMs: z.number().nonnegative().optional(),
    source: z.enum(["single", "parallel"]).optional(),
    sessionFile: z
      .string()
      .min(1)
      .max(MAX_SESSION_FILE_BYTES)
      .refine((value) => value.trim().length > 0, "sessionFile cannot be blank")
      .optional(),
    artifactRootId: z.string().uuid().optional(),
    artifactRootToken: z.string().min(1).max(200).optional(),
    currentTurnId: z.string().uuid().optional(),
    sessionOwnership: z.enum(["owned", "external"]).optional(),
    worktreePath: z.string().min(1).max(MAX_SESSION_FILE_BYTES).optional(),
    worktreeIdentity: z.string().min(1).max(500).optional(),
    worktreeParentRepository: z.string().min(1).max(MAX_SESSION_FILE_BYTES).optional(),
    worktreeRepositoryIdentity: z.string().min(1).max(MAX_SESSION_FILE_BYTES).optional(),
    worktreeBaseCommit: z
      .string()
      .regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/)
      .optional(),
    worktreeState: z.enum(["reserved", "registered"]).optional(),
    worktreeCleanup: z.literal("physical_removed").optional(),
    declaredReads: z
      .array(z.string().min(1).max(MAX_DECLARED_READ_LENGTH))
      .max(MAX_DECLARED_READS)
      .optional(),
  })
  .superRefine((run, context) => {
    if (!active(run.status) && run.completedAt === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Terminal subagent run is missing completedAt",
      });
    }
    if (active(run.status) && run.completedAt !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Active subagent run cannot have completedAt",
      });
    }
    const artifactFields = [run.artifactRootId, run.artifactRootToken, run.currentTurnId];
    if (artifactFields.some(Boolean) && !artifactFields.every(Boolean)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Incomplete artifact ownership" });
    }
    if (run.sessionOwnership === "owned" && !artifactFields.every(Boolean)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Owned session lacks artifact proof",
      });
    }
    const worktreeFields = [
      run.worktreePath,
      run.worktreeIdentity,
      run.worktreeParentRepository,
      run.worktreeRepositoryIdentity,
      run.worktreeBaseCommit,
    ];
    if (worktreeFields.some(Boolean) && !worktreeFields.every(Boolean)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Incomplete worktree ownership" });
    }
    if ((run.worktreeState || run.worktreeCleanup) && !worktreeFields.every(Boolean)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Worktree lifecycle lacks ownership",
      });
    }
    if (run.declaredReads !== undefined) {
      try {
        const normalized = normalizeDeclaredReads(run.declaredReads) ?? [];
        if (
          normalized.length !== run.declaredReads.length ||
          normalized.some((value, index) => value !== run.declaredReads?.[index])
        ) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Declared reads are not normalized effective paths",
          });
        }
      } catch (error) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message:
            error instanceof Error
              ? error.message
              : `Declared reads exceed ${MAX_DECLARED_READS_TOTAL_BYTES} bytes`,
        });
      }
    }
  });

const storeSchema = z.object({
  version: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  runs: z.array(runSchema).max(MAX_RUNS),
});

type StoreState = z.infer<typeof storeSchema>;

const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");

function utf8Suffix(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  return encoded
    .subarray(encoded.length - maxBytes)
    .toString("utf8")
    .replace(/^\uFFFD/, "");
}

const active = (status: SubagentRunStatus): boolean =>
  status === "starting" || status === "running";

const CAPABILITY_FIELDS = new Set([
  "artifactRootId",
  "artifactRootToken",
  "identityToken",
  "sessionFile",
  "sessionOwnership",
  "currentTurnId",
  "turnDirectory",
  "sessionsDirectory",
  "worktreePath",
  "worktreeIdentity",
  "worktreeParentRepository",
  "worktreeRepositoryIdentity",
  "worktreeBaseCommit",
  "worktreeState",
  "worktreeCleanup",
]);

function sanitizeCapabilityFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeCapabilityFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !CAPABILITY_FIELDS.has(key))
      .map(([key, nested]) => [key, sanitizeCapabilityFields(nested)]),
  );
}

function sanitizeTranscriptCells(cells: readonly TranscriptCell[]): TranscriptCell[] {
  return cells.map((cell) => sanitizeCapabilityFields(cell) as TranscriptCell);
}

export interface SubagentRunDurabilityOps {
  syncFile(fd: number): void;
  syncDirectory(directory: string): void;
}

export interface SubagentWorktreeTestHooks {
  /** Tests only: pauses after durable reservation proof and before Git mutation. */
  beforeGitWorktreeAdd?: () => Promise<void>;
}

const DEFAULT_DURABILITY_OPS: SubagentRunDurabilityOps = {
  syncFile: fsyncSync,
  syncDirectory: syncDirectoryStrict,
};

/** Versioned app-data persistence for generic managed_subagent/managed_parallel runs. */
export class SubagentRunStore {
  private readonly filePath: string;
  private readonly artifacts: SubagentArtifactStore;
  private readonly worktrees: SessionWorktreeStore;
  private readonly deletedParents = new Set<string>();
  private readonly inFlightWorktrees = new Map<string, Set<Promise<unknown>>>();
  private storeQuarantined = false;
  private state: StoreState = { version: 4, runs: [] };
  /** Runtime-only projections. Pi's existing child event consumer is the sole writer. */
  private readonly liveTranscripts = new Map<string, TranscriptState>();

  constructor(
    dataDir: string,
    private readonly warn: (message: string, error?: unknown) => void,
    private readonly durability: SubagentRunDurabilityOps = DEFAULT_DURABILITY_OPS,
    private readonly worktreeTestHooks: SubagentWorktreeTestHooks = {},
  ) {
    this.filePath = path.join(dataDir, "subagent-runs.json");
    mkdirSync(dataDir, { recursive: true });
    this.artifacts = new SubagentArtifactStore(dataDir);
    this.worktrees = new SessionWorktreeStore(dataDir);
    this.load();
    this.interruptActiveRuns();
    this.reconcileArtifacts();
  }

  close(): void {
    const errors: unknown[] = [];
    try {
      this.artifacts.close();
    } catch (error) {
      errors.push(error);
    }
    try {
      this.worktrees.close();
    } catch (error) {
      errors.push(error);
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "subagent run store close failed");
  }

  list(parentSessionId: string): SubagentRunRecord[] {
    return this.state.runs
      .filter((run) => run.parentSessionId === parentSessionId)
      .map((run) => ({ ...run }));
  }

  get(id: string): SubagentRunRecord | undefined {
    const run = this.state.runs.find((candidate) => candidate.id === id);
    return run ? { ...run } : undefined;
  }

  registerLiveTranscript(id: string): void {
    if (!this.get(id)) throw new Error(`Unknown subagent run: ${id}`);
    if (this.liveTranscripts.has(id))
      throw new Error(`Subagent transcript already registered: ${id}`);
    this.liveTranscripts.set(id, emptyTranscript());
  }

  updateLiveTranscript(id: string, transcript: TranscriptState): void {
    if (!this.liveTranscripts.has(id)) return;
    this.liveTranscripts.set(id, transcript);
  }

  unregisterLiveTranscript(id: string): void {
    this.liveTranscripts.delete(id);
  }

  liveTranscript(parentSessionId: string, id: string): ChildTranscriptSnapshot | undefined {
    const run = this.get(id);
    const transcript = this.liveTranscripts.get(id);
    if (!run || run.parentSessionId !== parentSessionId || !transcript) return undefined;
    return this.snapshot(run, "live", transcript);
  }

  summaryTranscript(run: SubagentRunRecord): ChildTranscriptSnapshot {
    const cells: TranscriptCell[] = [
      { kind: "user", id: `${run.id}-summary-user`, text: run.task },
    ];
    if (run.summary) {
      cells.push({
        kind: "assistant",
        id: `${run.id}-summary-assistant`,
        blocks: [{ kind: "text", contentIndex: 0, text: run.summary, done: true }],
        streaming: false,
        ...(run.error ? { errorMessage: run.error } : {}),
      });
    } else if (run.error) {
      cells.push({
        kind: "assistant",
        id: `${run.id}-summary-error`,
        blocks: [],
        streaming: false,
        errorMessage: run.error,
      });
    }
    return this.snapshot(
      run,
      "summary_only",
      cells,
      "Full canonical child history is unavailable. Showing retained task and result evidence only.",
    );
  }

  snapshot(
    run: SubagentRunRecord,
    source: ChildTranscriptSnapshot["source"],
    transcriptOrCells: TranscriptState | readonly TranscriptCell[],
    notice?: string,
  ): ChildTranscriptSnapshot {
    const cells = Array.isArray(transcriptOrCells)
      ? (transcriptOrCells as readonly TranscriptCell[])
      : (transcriptOrCells as TranscriptState).cells;
    return {
      runId: run.id,
      parentSessionId: run.parentSessionId,
      status:
        run.status === "completed"
          ? "done"
          : run.status === "failed"
            ? "error"
            : run.status === "starting" || run.status === "running"
              ? "running"
              : run.status,
      task: run.task,
      ...(run.agent ? { agentName: run.agent } : {}),
      source,
      cells: sanitizeTranscriptCells(cells),
      ...(notice ? { notice } : {}),
    };
  }

  create(record: SubagentRunRecord): void {
    if (this.deletedParents.has(record.parentSessionId)) {
      throw new Error("Parent session was deleted during subagent allocation");
    }
    if (this.state.runs.some((run) => run.id === record.id)) {
      throw new Error(`Subagent run already exists: ${record.id}`);
    }
    this.commit({ version: 4, runs: [...this.state.runs, this.normalized(record)] });
  }

  /** Allocate a branchless checkout only after proving the parent's exact repo
   * and HEAD. Ownership is persisted before Git writes into the reserved leaf.
   *
   * SessionWorktreeStore gives the target a held native identity. It cannot
   * capture an arbitrary project checkout outside its managed root, so parent
   * replacement is bounded with repeated Git/canonical proofs rather than an
   * invented generic inode token. */
  async prepareWorktree(id: string, parentCwd: string): Promise<string> {
    const run = this.get(id);
    if (!run) throw new Error(`Unknown subagent run: ${id}`);
    const allocation = this.prepareWorktreeAllocation(run, parentCwd);
    let owned = this.inFlightWorktrees.get(run.parentSessionId);
    if (!owned) {
      owned = new Set();
      this.inFlightWorktrees.set(run.parentSessionId, owned);
    }
    owned.add(allocation);
    try {
      return await allocation;
    } finally {
      owned.delete(allocation);
      if (owned.size === 0) this.inFlightWorktrees.delete(run.parentSessionId);
    }
  }

  private async prepareWorktreeAllocation(
    run: SubagentRunRecord,
    parentCwd: string,
  ): Promise<string> {
    const id = run.id;
    if (this.deletedParents.has(run.parentSessionId)) {
      throw new Error("Parent session was deleted before worktree allocation");
    }
    if (run.worktreePath) throw new Error("Subagent worktree is already allocated");
    const source = await gitWorktreeSource(parentCwd);
    let target = "";
    let identity = "";
    for (let attempt = 0; attempt < 8; attempt += 1) {
      target = path.join(this.worktrees.rootPath, randomUUID().replaceAll("-", "").slice(0, 8));
      try {
        identity = this.worktrees.reserveWorktree(target);
        break;
      } catch (error) {
        if (attempt === 7) throw error;
      }
    }
    try {
      this.update(id, {
        worktreePath: target,
        worktreeIdentity: identity,
        worktreeParentRepository: source.repositoryRoot,
        worktreeRepositoryIdentity: source.repositoryIdentity,
        worktreeBaseCommit: source.baseCommit,
        worktreeState: "reserved",
      });
    } catch (persistError) {
      const persisted = this.get(id);
      const reservationRecorded =
        persisted?.worktreePath === target &&
        persisted.worktreeIdentity === identity &&
        persisted.worktreeState === "reserved";
      try {
        await this.worktrees.deleteWorktree(target, identity);
        if (reservationRecorded) {
          this.update(id, { worktreeCleanup: "physical_removed" });
          this.update(id, {
            worktreePath: undefined,
            worktreeIdentity: undefined,
            worktreeParentRepository: undefined,
            worktreeRepositoryIdentity: undefined,
            worktreeBaseCommit: undefined,
            worktreeState: undefined,
            worktreeCleanup: undefined,
          });
        }
      } catch (cleanupError) {
        throw new AggregateError(
          [persistError, cleanupError],
          "Subagent worktree reservation metadata and rollback both failed",
        );
      }
      throw persistError;
    }
    try {
      // Repeat immediately before Git mutation. This bounds replacement of an
      // ambient parent checkout; the app-owned target itself has held identity.
      const currentSource = await gitWorktreeSource(parentCwd);
      if (
        currentSource.repositoryRoot !== source.repositoryRoot ||
        currentSource.repositoryIdentity !== source.repositoryIdentity ||
        currentSource.baseCommit !== source.baseCommit
      ) {
        throw new Error("subagent worktree source changed during allocation");
      }
      await this.worktreeTestHooks.beforeGitWorktreeAdd?.();
      if (this.deletedParents.has(run.parentSessionId)) {
        throw new Error("Parent session was deleted during worktree allocation");
      }
      await gitDetachedWorktreeAdd(source.repositoryRoot, target, source.baseCommit);
      if (
        !(await gitDetachedWorktreeRegistrationMatches(
          source.repositoryRoot,
          target,
          source.baseCommit,
        )) ||
        (await gitRepositoryIdentity(target)) !== source.repositoryIdentity
      ) {
        throw new Error("isolated child worktree ownership proof failed");
      }
      if (this.deletedParents.has(run.parentSessionId)) {
        throw new Error("Parent session was deleted during worktree allocation");
      }
      this.update(id, { worktreeState: "registered" });
      return target;
    } catch (error) {
      try {
        const registration = await gitWorktreeRegistrationAtPath(source.repositoryRoot, target);
        if (
          registration &&
          (!registration.detached ||
            registration.branch !== undefined ||
            registration.commit !== source.baseCommit)
        ) {
          throw new Error("failed allocation has unexpected Git registration");
        }
        await this.worktrees.deleteWorktree(target, identity);
        // Commit the physical-removal state before pruning. A crash now has
        // either an exact stale registration or an idempotent durable marker.
        this.update(id, { worktreeCleanup: "physical_removed" });
        await gitWorktreePrune(source.repositoryRoot);
        this.update(id, {
          worktreePath: undefined,
          worktreeIdentity: undefined,
          worktreeParentRepository: undefined,
          worktreeRepositoryIdentity: undefined,
          worktreeBaseCommit: undefined,
          worktreeState: undefined,
          worktreeCleanup: undefined,
        });
      } catch {
        // Retain complete ownership/cleanup metadata for parent-deletion retry.
      }
      throw error;
    }
  }

  /** Re-prove the app-owned checkout immediately before child Pi spawn. The
   * detached HEAD may advance later as the child commits; baseCommit remains
   * allocation evidence, not a deletion-time HEAD invariant. */
  async validateWorktreeForSpawn(id: string): Promise<string> {
    const run = this.get(id);
    if (
      !run?.worktreePath ||
      !run.worktreeIdentity ||
      !run.worktreeParentRepository ||
      !run.worktreeRepositoryIdentity ||
      !run.worktreeBaseCommit ||
      run.worktreeCleanup ||
      run.worktreeState === "reserved"
    ) {
      throw new Error("Subagent worktree ownership proof is unavailable");
    }
    if (this.worktrees.captureWorktreeIdentity(run.worktreePath) !== run.worktreeIdentity) {
      throw new Error("Subagent worktree native identity changed before spawn");
    }
    if (
      (await gitRepositoryIdentity(run.worktreeParentRepository)) !==
        run.worktreeRepositoryIdentity ||
      (await gitRepositoryIdentity(run.worktreePath)) !== run.worktreeRepositoryIdentity ||
      !(await gitDetachedWorktreeRegistrationMatches(
        run.worktreeParentRepository,
        run.worktreePath,
        run.worktreeBaseCommit,
      ))
    ) {
      throw new Error("Subagent worktree Git ownership changed before spawn");
    }
    return run.worktreePath;
  }

  prepareTurn(
    record: SubagentRunRecord,
    systemPrompt: string,
    continuation?: Pick<SubagentRunRecord, "artifactRootId" | "artifactRootToken">,
  ): SubagentArtifactAllocation {
    if (this.deletedParents.has(record.parentSessionId)) {
      throw new Error("Parent session was deleted before subagent allocation");
    }
    const turnId = continuation ? randomUUID() : record.id;
    return this.artifacts.allocateTurn({
      runId: record.id,
      identityToken: continuation?.artifactRootToken,
      turnId,
      rootManifest: `${JSON.stringify({ schemaVersion: 1, runId: record.id, createdAt: record.createdAt })}\n`,
      turnManifest: `${JSON.stringify({ schemaVersion: 1, runId: record.id, turnId, createdAt: record.createdAt, source: record.source ?? "single" })}\n`,
      input: renderSubagentArtifactInput(record.task, record.declaredReads),
      systemPrompt,
    });
  }

  writeOutput(id: string, output: string, error?: string): void {
    const run = this.get(id);
    if (!run?.artifactRootId || !run.artifactRootToken || !run.currentTurnId) {
      throw new Error("Subagent artifact ownership is unavailable");
    }
    const content = utf8Suffix(
      error ? `${output}${output ? "\n\n" : ""}Error:\n${error}` : output,
      MAX_RESULT_BYTES,
    );
    this.artifacts.writeTurnOutput(
      run.artifactRootId,
      run.artifactRootToken,
      run.currentTurnId,
      content,
    );
  }

  markOwnedSession(id: string, sessionFile: string): string {
    const run = this.get(id);
    if (!run?.artifactRootId || !run.artifactRootToken)
      throw new Error("Subagent artifact ownership is unavailable");
    const validated = this.artifacts.validateSessionFile(
      run.artifactRootId,
      run.artifactRootToken,
      sessionFile,
    );
    this.update(id, { sessionFile: validated, sessionOwnership: "owned" });
    return validated;
  }

  artifactDirectoryForReveal(id: string): string | undefined {
    const run = this.get(id);
    if (!run?.artifactRootId || !run.artifactRootToken) return undefined;
    return this.artifacts.revealDirectory(run.artifactRootId, run.artifactRootToken);
  }

  validateOwnedSession(id: string, sessionFile: string): string {
    const run = this.get(id);
    if (!run?.artifactRootId || !run.artifactRootToken || run.sessionOwnership !== "owned") {
      throw new Error("Subagent owned session proof is unavailable");
    }
    return this.artifacts.validateSessionFile(
      run.artifactRootId,
      run.artifactRootToken,
      sessionFile,
    );
  }

  update(
    id: string,
    patch: Partial<Omit<SubagentRunRecord, "id" | "parentSessionId" | "createdAt">>,
  ): void {
    const index = this.state.runs.findIndex((run) => run.id === id);
    if (index < 0) throw new Error(`Unknown subagent run: ${id}`);
    const runs = this.state.runs.slice();
    runs[index] = this.normalized({ ...runs[index]!, ...patch, id });
    this.commit({ version: 4, runs });
  }

  async removeParent(parentSessionId: string): Promise<void> {
    // Invalidate reads before artifact deletion; child finalizers may race and
    // unregister again, which is deliberately idempotent.
    for (const run of this.state.runs) {
      if (run.parentSessionId === parentSessionId) this.liveTranscripts.delete(run.id);
    }
    // Synchronous claim serializes against prepareTurn/create. If deletion wins
    // between allocation and metadata commit, create fails and no Pi is prompted.
    this.deletedParents.add(parentSessionId);
    // Claim deletion before waiting. Every allocation re-checks the claim before
    // and after Git mutation, rolls back through its durable proof, and settles
    // before this method snapshots records for ownership preflight.
    const allocating = [...(this.inFlightWorktrees.get(parentSessionId) ?? [])];
    if (allocating.length > 0) await Promise.allSettled(allocating);
    const removed = this.state.runs.filter((run) => run.parentSessionId === parentSessionId);
    const worktreeRuns = removed.filter(
      (
        run,
      ): run is SubagentRunRecord &
        Required<
          Pick<
            SubagentRunRecord,
            | "worktreePath"
            | "worktreeIdentity"
            | "worktreeParentRepository"
            | "worktreeRepositoryIdentity"
            | "worktreeBaseCommit"
          >
        > =>
        Boolean(
          run.worktreePath &&
            run.worktreeIdentity &&
            run.worktreeParentRepository &&
            run.worktreeRepositoryIdentity &&
            run.worktreeBaseCommit,
        ),
    );

    // Recover the exact crash window after successful `git worktree add` but
    // before the registered-state commit. This promotion is non-destructive and
    // requires every proof the add was meant to establish.
    const promoted = new Set<string>();
    for (const run of worktreeRuns) {
      if (run.worktreeState !== "reserved" || run.worktreeCleanup) continue;
      const registration = await gitWorktreeRegistrationAtPath(
        run.worktreeParentRepository,
        run.worktreePath,
      );
      if (!registration) continue; // A legitimate pre-add reservation.
      if (
        !registration.detached ||
        registration.branch !== undefined ||
        registration.commit !== run.worktreeBaseCommit ||
        !existsSync(run.worktreePath) ||
        this.worktrees.captureWorktreeIdentity(run.worktreePath) !== run.worktreeIdentity ||
        (await gitRepositoryIdentity(run.worktreeParentRepository)) !==
          run.worktreeRepositoryIdentity ||
        (await gitRepositoryIdentity(run.worktreePath)) !== run.worktreeRepositoryIdentity
      ) {
        throw new Error("Reserved subagent worktree has unsafe post-add evidence");
      }
      this.update(run.id, { worktreeState: "registered" });
      promoted.add(run.id);
    }

    // Phase 1 is read-only across EVERY child after non-destructive recovery. A
    // later unsafe child cannot remove an earlier sibling's worktree.
    for (const run of worktreeRuns) {
      if (
        (await gitRepositoryIdentity(run.worktreeParentRepository)) !==
        run.worktreeRepositoryIdentity
      ) {
        throw new Error("Subagent parent repository ownership changed");
      }
      const registration = await gitWorktreeRegistrationAtPath(
        run.worktreeParentRepository,
        run.worktreePath,
      );
      const reservationOnly = run.worktreeState === "reserved" && !promoted.has(run.id);
      if (
        (reservationOnly && registration) ||
        (!reservationOnly &&
          registration &&
          (!registration.detached || registration.branch !== undefined))
      ) {
        throw new Error("Subagent worktree Git registration changed");
      }
      const physicallyPresent = existsSync(run.worktreePath);
      if (run.worktreeCleanup === "physical_removed") {
        if (physicallyPresent) throw new Error("Removed subagent worktree path was replaced");
      } else if (physicallyPresent) {
        if (this.worktrees.captureWorktreeIdentity(run.worktreePath) !== run.worktreeIdentity) {
          throw new Error("Subagent worktree native identity changed");
        }
        if (!reservationOnly) {
          if (!registration) throw new Error("Subagent worktree Git registration is missing");
          if ((await gitRepositoryIdentity(run.worktreePath)) !== run.worktreeRepositoryIdentity) {
            throw new Error("Subagent worktree repository changed");
          }
        }
      } else if (!reservationOnly && !registration) {
        throw new Error("Subagent worktree ownership evidence is missing");
      }
    }

    // Phase 2 removes only worktrees whose complete sibling set preflighted.
    // Re-check immediately before each mutation to bound ambient-parent TOCTOU.
    for (const run of worktreeRuns) {
      const registration = await gitWorktreeRegistrationAtPath(
        run.worktreeParentRepository,
        run.worktreePath,
      );
      const reservationOnly = run.worktreeState === "reserved" && !promoted.has(run.id);
      if (
        (reservationOnly && registration) ||
        (!reservationOnly &&
          registration &&
          (!registration.detached || registration.branch !== undefined)) ||
        (await gitRepositoryIdentity(run.worktreeParentRepository)) !==
          run.worktreeRepositoryIdentity
      ) {
        throw new Error("Subagent worktree ownership changed during cleanup");
      }
      if (run.worktreeCleanup !== "physical_removed") {
        const physicallyPresent = existsSync(run.worktreePath);
        if (
          (!reservationOnly && !registration) ||
          (physicallyPresent &&
            (this.worktrees.captureWorktreeIdentity(run.worktreePath) !== run.worktreeIdentity ||
              (!reservationOnly &&
                (await gitRepositoryIdentity(run.worktreePath)) !==
                  run.worktreeRepositoryIdentity)))
        ) {
          throw new Error("Subagent worktree ownership changed during cleanup");
        }
        // deleteWorktree is idempotent for a missing leaf. That covers a crash
        // after physical removal but before the marker write while the exact
        // stale registration still proves which checkout this record owned.
        await this.worktrees.deleteWorktree(run.worktreePath, run.worktreeIdentity);
        this.update(run.id, { worktreeCleanup: "physical_removed" });
      }
      await gitWorktreePrune(run.worktreeParentRepository);
    }

    // Only after every worktree is physically safe do artifacts/records enter
    // the deletion boundary. Each record commit remains independently retryable.
    for (const run of removed) {
      if (run.artifactRootId && run.artifactRootToken) {
        try {
          this.artifacts.deleteRun(run.artifactRootId, run.artifactRootToken);
        } catch (error) {
          if (
            !(error instanceof SubagentArtifactCapabilityError) ||
            error.code !== "SUBAGENT_ARTIFACT_NOT_FOUND"
          ) {
            throw error;
          }
        }
      }
      this.commit({ version: 4, runs: this.state.runs.filter((item) => item.id !== run.id) });
    }
  }

  cells(parentSessionId: string): SubagentCell[] {
    return this.list(parentSessionId).map((run) => ({
      kind: "subagent",
      id: run.id,
      task: run.task,
      status:
        run.status === "completed"
          ? "done"
          : run.status === "stopped"
            ? "stopped"
            : run.status === "interrupted"
              ? "interrupted"
              : active(run.status)
                ? "running"
                : "error",
      text: run.summary ?? "",
      ...(run.error ? { error: run.error } : {}),
      progress: [],
      ...(run.agent ? { agentName: run.agent } : {}),
      ...(run.model ? { model: run.model } : {}),
      ...(run.inputTokens !== undefined ? { inputTokens: run.inputTokens } : {}),
      ...(run.outputTokens !== undefined ? { outputTokens: run.outputTokens } : {}),
      ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
      ...(run.artifactRootId ? { artifactRootId: run.artifactRootId } : {}),
    }));
  }

  private normalized(record: SubagentRunRecord): SubagentRunRecord {
    return {
      ...record,
      task: utf8Suffix(record.task, MAX_TASK_BYTES),
      ...(record.summary !== undefined
        ? { summary: utf8Suffix(record.summary, MAX_RESULT_BYTES) }
        : {}),
      ...(record.error !== undefined ? { error: utf8Suffix(record.error, MAX_ERROR_BYTES) } : {}),
    };
  }

  private interruptActiveRuns(): void {
    if (!this.state.runs.some((run) => active(run.status))) return;
    const now = new Date().toISOString();
    const runs = this.state.runs.map((run) => {
      if (!active(run.status)) return run;
      let sessionOwnership = run.sessionOwnership;
      if (
        run.sessionFile &&
        run.artifactRootId &&
        run.artifactRootToken &&
        sessionOwnership !== "owned"
      ) {
        try {
          this.artifacts.validateSessionFile(
            run.artifactRootId,
            run.artifactRootToken,
            run.sessionFile,
          );
          sessionOwnership = "owned";
        } catch (error) {
          if (
            !(error instanceof SubagentArtifactCapabilityError) ||
            error.code !== "SUBAGENT_ARTIFACT_NOT_FOUND"
          ) {
            this.warn("could not validate interrupted subagent session ownership", error);
          }
        }
      }
      return {
        ...run,
        ...(sessionOwnership ? { sessionOwnership } : {}),
        status: "interrupted" as const,
        updatedAt: now,
        completedAt: now,
        error: "Subagent run was interrupted by an app or server restart.",
      };
    });
    this.commit({ version: 4, runs });
  }

  private reconcileArtifacts(): void {
    // A corrupt metadata store cannot prove roots are orphaned. Retain all
    // evidence for repair instead of turning quarantine into data deletion.
    if (this.storeQuarantined) return;
    const owned = new Map(
      this.state.runs.flatMap((run) =>
        run.artifactRootId && run.artifactRootToken
          ? [[run.artifactRootId, run.artifactRootToken] as const]
          : [],
      ),
    );
    for (const root of this.artifacts.listRoots()) {
      const token = owned.get(root.artifactRootId);
      if (token === root.identityToken) continue;
      if (token) {
        this.warn("retained subagent artifact root with mismatched ownership proof");
        continue;
      }
      // Allocation intentionally precedes metadata commit. An unknown valid root
      // may therefore contain the only evidence of a crashed launch. Retain it
      // for explicit recovery instead of treating absence from the store as
      // proof that deletion is safe.
      this.warn(`retained unrecorded subagent artifact root ${root.artifactRootId}`);
    }
  }

  private commit(candidate: StoreState): void {
    let runs = candidate.runs;
    const oldestTerminalIndex = (): number =>
      runs
        .map((run, index) => ({ run, index }))
        // Artifact-bearing evidence is never silently pruned for capacity. Parent
        // deletion owns its explicit cleanup transaction.
        .filter(({ run }) => !active(run.status) && !run.artifactRootId)
        .sort((a, b) =>
          a.run.updatedAt === b.run.updatedAt
            ? a.run.id.localeCompare(b.run.id)
            : a.run.updatedAt.localeCompare(b.run.updatedAt),
        )[0]?.index ?? -1;
    while (runs.length > MAX_RUNS || bytes({ version: 4, runs }) + 1 > MAX_STORE_BYTES) {
      const index = oldestTerminalIndex();
      if (index < 0) throw new Error("Active subagent runs exceed the persistence budget");
      runs = [...runs.slice(0, index), ...runs.slice(index + 1)];
    }
    const next = storeSchema.parse({ version: 4, runs });
    const serialized = `${JSON.stringify(next)}\n`;
    const temp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temp, "wx", 0o600);
      writeFileSync(fd, serialized, "utf8");
      this.durability.syncFile(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temp, this.filePath);
      // The rename has already replaced the authoritative file. Retain that
      // candidate in memory even if the following directory fsync reports a
      // durability failure, so a later write cannot rebuild from stale state
      // and erase the successfully renamed record.
      this.state = next;
      // POSIX needs the containing directory synced for the rename itself to
      // survive power loss. The shared helper narrowly tolerates only the
      // directory-fsync operations Windows/libuv does not support.
      this.durability.syncDirectory(path.dirname(this.filePath));
    } finally {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          // Preserve the original write/fsync/rename failure.
        }
      }
      rmSync(temp, { force: true });
    }
  }

  private load(): void {
    try {
      if (lstatSync(this.filePath).isSymbolicLink())
        throw new Error("Subagent run store is a symlink");
      const raw = readFileSync(this.filePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_STORE_BYTES)
        throw new Error("Subagent run store is oversized");
      const loaded = storeSchema.parse(JSON.parse(raw));
      this.state = {
        version: 4,
        runs: loaded.runs.map((run) => ({
          ...run,
          ...(run.sessionFile && !run.sessionOwnership
            ? { sessionOwnership: "external" as const }
            : {}),
        })),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        // Invalid state is never used even if quarantine cannot be written.
      }
      this.storeQuarantined = true;
      this.state = { version: 4, runs: [] };
      this.warn("quarantined invalid subagent run store", error);
    }
  }
}
