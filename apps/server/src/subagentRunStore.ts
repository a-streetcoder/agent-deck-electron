import { randomUUID } from "node:crypto";
import {
  closeSync,
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
import type { SubagentCell } from "@agent-deck/domain";
import { z } from "zod";
import { syncDirectoryStrict } from "./sessionImages.ts";

const MAX_RUNS = 2_000;
const MAX_STORE_BYTES = 8_000_000;
const MAX_TASK_BYTES = 50_000;
const MAX_RESULT_BYTES = 256_000;
const MAX_ERROR_BYTES = 50_000;
const MAX_SESSION_FILE_BYTES = 16_384;

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
  /** Pi-owned canonical resume handle returned by get_state; Agent Deck never deletes it. */
  sessionFile?: string;
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
  });

const storeSchema = z.object({
  version: z.literal(1),
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

export interface SubagentRunDurabilityOps {
  syncFile(fd: number): void;
  syncDirectory(directory: string): void;
}

const DEFAULT_DURABILITY_OPS: SubagentRunDurabilityOps = {
  syncFile: fsyncSync,
  syncDirectory: syncDirectoryStrict,
};

/** Versioned app-data persistence for generic managed_subagent/managed_parallel runs. */
export class SubagentRunStore {
  private readonly filePath: string;
  private state: StoreState = { version: 1, runs: [] };

  constructor(
    dataDir: string,
    private readonly warn: (message: string, error?: unknown) => void,
    private readonly durability: SubagentRunDurabilityOps = DEFAULT_DURABILITY_OPS,
  ) {
    this.filePath = path.join(dataDir, "subagent-runs.json");
    mkdirSync(dataDir, { recursive: true });
    this.load();
    this.interruptActiveRuns();
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

  create(record: SubagentRunRecord): void {
    if (this.state.runs.some((run) => run.id === record.id)) {
      throw new Error(`Subagent run already exists: ${record.id}`);
    }
    this.commit({ version: 1, runs: [...this.state.runs, this.normalized(record)] });
  }

  update(
    id: string,
    patch: Partial<Omit<SubagentRunRecord, "id" | "parentSessionId" | "createdAt">>,
  ): void {
    const index = this.state.runs.findIndex((run) => run.id === id);
    if (index < 0) throw new Error(`Unknown subagent run: ${id}`);
    const runs = this.state.runs.slice();
    runs[index] = this.normalized({ ...runs[index]!, ...patch, id });
    this.commit({ version: 1, runs });
  }

  removeParent(parentSessionId: string): void {
    const runs = this.state.runs.filter((run) => run.parentSessionId !== parentSessionId);
    if (runs.length !== this.state.runs.length) this.commit({ version: 1, runs });
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
    const runs = this.state.runs.map((run) =>
      active(run.status)
        ? {
            ...run,
            status: "interrupted" as const,
            updatedAt: now,
            completedAt: now,
            error: "Subagent run was interrupted by an app or server restart.",
          }
        : run,
    );
    this.commit({ version: 1, runs });
  }

  private commit(candidate: StoreState): void {
    let runs = candidate.runs;
    const oldestTerminalIndex = (): number =>
      runs
        .map((run, index) => ({ run, index }))
        .filter(({ run }) => !active(run.status))
        .sort((a, b) =>
          a.run.updatedAt === b.run.updatedAt
            ? a.run.id.localeCompare(b.run.id)
            : a.run.updatedAt.localeCompare(b.run.updatedAt),
        )[0]?.index ?? -1;
    while (runs.length > MAX_RUNS || bytes({ version: 1, runs }) + 1 > MAX_STORE_BYTES) {
      const index = oldestTerminalIndex();
      if (index < 0) throw new Error("Active subagent runs exceed the persistence budget");
      runs = [...runs.slice(0, index), ...runs.slice(index + 1)];
    }
    const next = storeSchema.parse({ version: 1, runs });
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
      this.state = storeSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt-${Date.now()}`);
      } catch {
        // Invalid state is never used even if quarantine cannot be written.
      }
      this.state = { version: 1, runs: [] };
      this.warn("quarantined invalid subagent run store", error);
    }
  }
}
