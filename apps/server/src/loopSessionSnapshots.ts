import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SubagentCell } from "@agent-deck/domain";
import { z } from "zod";

const MAX_CELLS = 200;
const MAX_TEXT_BYTES = 256_000;
const MAX_PROGRESS = 100;
const MAX_FIELD_BYTES = 50_000;
export const MAX_LOOP_SNAPSHOT_SESSIONS = 64;
export const MAX_LOOP_SNAPSHOT_SESSION_BYTES = 512_000;
export const MAX_LOOP_SNAPSHOT_STORE_BYTES = 4_000_000;

const serializedBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value), "utf8");

/** Retain the newest UTF-8 suffix without cutting a code point. */
function utf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length <= maxBytes) return value;
  return bytes
    .subarray(bytes.length - maxBytes)
    .toString("utf8")
    .replace(/^\uFFFD/, "");
}

const subagentCellSchema = z.object({
  kind: z.literal("subagent"),
  id: z.string().min(1).max(500),
  task: z.string().max(MAX_FIELD_BYTES),
  status: z.enum(["running", "done", "error", "stopped", "interrupted"]),
  agentName: z.string().max(500).optional(),
  text: z.string(),
  error: z.string().max(MAX_FIELD_BYTES).optional(),
  progress: z.array(z.string()).max(MAX_PROGRESS),
  model: z.string().max(500).optional(),
  inputTokens: z.number().nonnegative().optional(),
  outputTokens: z.number().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
});

const sessionSchema = z
  .object({
    revision: z.number().int().nonnegative().default(0),
    updatedAt: z.string().datetime(),
    cells: z.array(subagentCellSchema).max(MAX_CELLS),
  })
  .superRefine((session, context) => {
    if (serializedBytes(session) > MAX_LOOP_SNAPSHOT_SESSION_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Loop snapshot session is oversized",
      });
    }
  });

const storeSchema = z
  .object({
    version: z.literal(1),
    nextRevision: z.number().int().nonnegative().default(0),
    sessions: z.record(sessionSchema),
  })
  .superRefine((store, context) => {
    const ids = Object.keys(store.sessions);
    if (ids.length > MAX_LOOP_SNAPSHOT_SESSIONS) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "Too many Loop snapshot sessions" });
    }
    if (ids.some((id) => id.length < 1 || id.length > 500)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Invalid Loop snapshot session ID",
      });
    }
    if (serializedBytes(store) > MAX_LOOP_SNAPSHOT_STORE_BYTES) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Loop snapshot store is oversized",
      });
    }
  });

type SnapshotStore = z.infer<typeof storeSchema>;
type SnapshotSession = z.infer<typeof sessionSchema>;

function normalizedCell(source: SubagentCell): SubagentCell {
  return {
    ...source,
    id: utf8Suffix(source.id, 500),
    task: utf8Suffix(source.task, MAX_FIELD_BYTES),
    text: utf8Suffix(source.text, MAX_TEXT_BYTES),
    progress: source.progress.slice(-MAX_PROGRESS).map((item) => utf8Suffix(item, MAX_FIELD_BYTES)),
    ...(source.agentName ? { agentName: utf8Suffix(source.agentName, 500) } : {}),
    ...(source.error ? { error: utf8Suffix(source.error, MAX_FIELD_BYTES) } : {}),
    ...(source.model ? { model: utf8Suffix(source.model, 500) } : {}),
  };
}

/** Bound a session by its actual serialized UTF-8 representation, retaining newest evidence. */
function boundedSession(
  cells: readonly SubagentCell[],
  updatedAt: string,
  revision: number,
): SnapshotSession {
  const session: SnapshotSession = { revision, updatedAt, cells: [] };
  for (const source of cells.slice(-MAX_CELLS).reverse()) {
    const next = normalizedCell(source);
    const single: SnapshotSession = { revision, updatedAt, cells: [next] };
    while (serializedBytes(single) > MAX_LOOP_SNAPSHOT_SESSION_BYTES && next.progress.length > 0) {
      next.progress.shift();
    }
    for (const field of ["task", "text", "error"] as const) {
      while (serializedBytes(single) > MAX_LOOP_SNAPSHOT_SESSION_BYTES && next[field]) {
        next[field] = utf8Suffix(
          next[field],
          Math.floor(Buffer.byteLength(next[field], "utf8") / 2),
        );
      }
    }
    session.cells.unshift(next);
    if (serializedBytes(session) > MAX_LOOP_SNAPSHOT_SESSION_BYTES) {
      session.cells.shift();
      break;
    }
  }
  return session;
}

/** Bounded app-owned synthetic Loop transcript cards. Pi's canonical history stays authoritative. */
export class LoopSessionSnapshotStore {
  private readonly filePath: string;
  private state: SnapshotStore = { version: 1, nextRevision: 0, sessions: {} };

  constructor(
    dataDir: string,
    private readonly warn: (message: string, error?: unknown) => void,
  ) {
    this.filePath = path.join(dataDir, "loop-session-snapshots.json");
    mkdirSync(dataDir, { recursive: true });
    this.load();
  }

  get(sessionId: string): SubagentCell[] {
    return (this.state.sessions[sessionId]?.cells ?? []).map((cell) => ({
      ...cell,
      progress: [...cell.progress],
    }));
  }

  save(sessionId: string, cells: readonly SubagentCell[]): void {
    if (sessionId.length < 1 || sessionId.length > 500) throw new Error("Invalid Loop session ID");
    this.state.nextRevision += 1;
    this.state.sessions[sessionId] = boundedSession(
      cells,
      new Date().toISOString(),
      this.state.nextRevision,
    );
    this.prune();
    this.flush();
  }

  remove(sessionId: string): void {
    if (!this.state.sessions[sessionId]) return;
    delete this.state.sessions[sessionId];
    this.flush();
  }

  private prune(): void {
    const oldestFirst = (): string[] =>
      Object.entries(this.state.sessions)
        .sort(([leftId, left], [rightId, right]) =>
          left.revision === right.revision
            ? left.updatedAt === right.updatedAt
              ? leftId.localeCompare(rightId)
              : left.updatedAt.localeCompare(right.updatedAt)
            : left.revision - right.revision,
        )
        .map(([id]) => id);
    while (
      Object.keys(this.state.sessions).length > MAX_LOOP_SNAPSHOT_SESSIONS ||
      serializedBytes(this.state) > MAX_LOOP_SNAPSHOT_STORE_BYTES
    ) {
      const oldest = oldestFirst()[0];
      if (!oldest) break;
      delete this.state.sessions[oldest];
    }
  }

  private load(): void {
    try {
      if (lstatSync(this.filePath).isSymbolicLink()) {
        throw new Error("Loop session snapshot store is a symlink");
      }
      const raw = readFileSync(this.filePath, "utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_LOOP_SNAPSHOT_STORE_BYTES) {
        throw new Error("Loop session snapshot store exceeds its byte budget");
      }
      this.state = storeSchema.parse(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      const quarantine = `${this.filePath}.corrupt-${Date.now()}`;
      try {
        renameSync(this.filePath, quarantine);
      } catch {
        // Refuse malformed state even when quarantine itself is unavailable.
      }
      this.state = { version: 1, nextRevision: 0, sessions: {} };
      this.warn("quarantined invalid Loop session snapshot store", error);
    }
  }

  private flush(): void {
    const serialized = `${JSON.stringify(storeSchema.parse(this.state))}\n`;
    if (Buffer.byteLength(serialized, "utf8") > MAX_LOOP_SNAPSHOT_STORE_BYTES) {
      throw new Error("Loop session snapshot store exceeds its byte budget");
    }
    const temp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      writeFileSync(temp, serialized, { encoding: "utf8", mode: 0o600 });
      renameSync(temp, this.filePath);
    } finally {
      rmSync(temp, { force: true });
    }
  }
}
