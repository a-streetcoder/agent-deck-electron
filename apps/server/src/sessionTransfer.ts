// SRV-12c1 session move: the envelope a device sends to a shared server, and the
// Pi transcript checks both sides share. The envelope crosses a trust boundary
// (the server imports what any member's device sends), so the server validates
// it strictly: closed shapes, bounded sizes, UUID ids, and no device path except
// `meta.localCwd`, which is only ever shown, never used.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { composerDraftSchema } from "./composerDrafts.ts";
import { validTransferRef } from "./git.ts";

/** The whole envelope, as JSON, never exceeds this (the transcript is most of it). */
export const MAX_TRANSFER_BYTES = 16 * 1024 * 1024;

/** What a move never carries: device-local state, named in the import summary. */
export const ALWAYS_DROPPED = [
  "checkpoints",
  "subagent runs",
  "Loop cells",
  "plan history",
  "event history",
] as const;

const uuid = z.string().uuid();
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const text = (max: number) => z.string().min(1).max(max);
const launchId = z
  .string()
  .max(200)
  .regex(/^[A-Za-z0-9_.@/][A-Za-z0-9_.:@/-]*$/);

const planItem = z
  .object({
    id: text(200),
    title: z.string().max(2000),
    status: z.enum(["todo", "in_progress", "done", "blocked", "skipped"]),
    dependsOn: z.array(text(200)).max(200).optional(),
    assignee: text(200).optional(),
    verifiedBy: text(200).optional(),
    task: z.string().max(20_000).optional(),
    isolated: z.boolean().optional(),
  })
  .strict();

const authorTurn = z
  .object({
    signature: z.string().regex(/^[0-9a-f]{64}$/),
    author: z.object({ id: text(320), name: z.string().max(200).optional() }).strict(),
    entryId: text(500),
    claimed: z.boolean().optional(),
  })
  .strict();

// The unsent composer text travels; attached file and folder references are
// device paths, so they never do.
const draft = composerDraftSchema
  .extend({ files: z.array(z.never()).max(0), folders: z.array(z.never()).max(0) })
  .strict();

export const transferEnvelopeSchema = z
  .object({
    version: z.literal(1),
    localSessionId: uuid,
    /** The device's host name, shown and written into the conversation notice. */
    device: z.string().regex(/^[A-Za-z0-9._-]{1,200}$/),
    meta: z
      .object({
        title: z.string().max(200).optional(),
        titleUserEdited: z.boolean().optional(),
        // A Loop session never moves; a Loop-named agent would read as one here.
        agentName: text(200)
          .refine((name) => !name.startsWith("Loop ·"), "a Loop session cannot move")
          .optional(),
        // Become Pi launch arguments: a plain id, never something flag-like.
        provider: launchId.optional(),
        model: launchId.optional(),
        subagentsEnabled: z.boolean().optional(),
        plan: z.array(planItem).max(200).optional(),
      })
      .strict(),
    transcript: z.string().min(1).max(MAX_TRANSFER_BYTES),
    authors: z.array(authorTurn).max(10_000),
    /** Paste turns; each one is re-checked by the paste store on import. */
    pastes: z.array(z.unknown()).max(10_000),
    draft: draft.nullable(),
    transfer: z.discriminatedUnion("mode", [
      z
        .object({
          mode: z.literal("snapshot"),
          ref: z.string().refine(validTransferRef, "invalid transfer ref"),
          commit: oid,
          baseHead: oid,
        })
        .strict(),
      z.object({ mode: z.literal("conversation") }).strict(),
    ]),
    dropped: z.array(text(100)).max(50),
  })
  .strict()
  .refine(
    (envelope) =>
      envelope.transfer.mode !== "snapshot" ||
      envelope.transfer.ref.endsWith(`/${envelope.localSessionId}`),
    "the transfer ref must name the moved session",
  );

export type TransferEnvelope = z.infer<typeof transferEnvelopeSchema>;

/**
 * Check a Pi session file: JSON objects, one per line, the first one Pi's
 * `session` header (Pi resumes in the header's cwd, so it must be there).
 * Every entry has a unique id and a parent written before it (Pi appends, so
 * the ancestry walk can never loop or dangle); a message entry has its message.
 * Throws with a short reason.
 */
export function checkPiTranscript(transcript: string): void {
  const lines = transcript.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) throw new Error("the transcript is empty");
  const ids = new Set<string>();
  lines.forEach((line, index) => {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      throw new Error(`transcript line ${index + 1} is not JSON`);
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`transcript line ${index + 1} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    if (index === 0) {
      if (
        record.type !== "session" ||
        typeof record.id !== "string" ||
        typeof record.cwd !== "string"
      ) {
        throw new Error("the transcript does not start with a Pi session header");
      }
    } else if (typeof record.type !== "string" || record.type === "session") {
      throw new Error(`transcript line ${index + 1} is not a Pi entry`);
    } else {
      const where = `transcript line ${index + 1}`;
      if (typeof record.id !== "string" || record.id === "") throw new Error(`${where} has no id`);
      if (ids.has(record.id)) throw new Error(`${where} repeats the id ${record.id}`);
      const parent = record.parentId;
      if (parent !== null && (typeof parent !== "string" || !ids.has(parent)))
        throw new Error(`${where} has a parent that is not before it`);
      if (
        record.targetId !== undefined &&
        (typeof record.targetId !== "string" || !ids.has(record.targetId))
      )
        throw new Error(`${where} points at an unknown entry`);
      const message = record.message as { role?: unknown } | null | undefined;
      if (
        record.type === "message" &&
        (!message || typeof message !== "object" || typeof message.role !== "string")
      )
        throw new Error(`${where} is a message without its message`);
      ids.add(record.id);
    }
  });
}

/** The thinking level of the transcript's active chain (its last
 * thinking_level_change from the leaf back), or undefined when it never set one. */
export function transcriptThinkingLevel(
  transcript: string,
): "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  const byId = new Map<string, Record<string, unknown>>();
  let leaf: string | undefined;
  for (const line of transcript.split("\n").slice(1)) {
    if (!line.trim()) continue;
    const entry = JSON.parse(line) as Record<string, unknown>;
    if (typeof entry.id === "string") {
      byId.set(entry.id, entry);
      leaf = entry.id;
    }
  }
  // checkPiTranscript proved every parent is written before its child: no loop.
  for (let id = leaf; id; ) {
    const entry = byId.get(id);
    if (!entry) break;
    if (entry.type === "thinking_level_change") {
      const level = entry.thinkingLevel;
      return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level as string)
        ? (level as "off")
        : undefined;
    }
    id = typeof entry.parentId === "string" ? entry.parentId : undefined;
  }
  return undefined;
}

/**
 * Point the transcript at `cwd`. Only the header line changes: its `cwd`, and
 * its `parentSession` (a device path to a file that is not here) is dropped.
 * Every other byte is kept.
 */
export function rewriteTranscriptCwd(transcript: string, cwd: string): string {
  const end = transcript.indexOf("\n");
  const first = end === -1 ? transcript : transcript.slice(0, end);
  const header = JSON.parse(first) as Record<string, unknown>;
  delete header.parentSession;
  return `${JSON.stringify({ ...header, cwd })}${end === -1 ? "\n" : transcript.slice(end)}`;
}

/**
 * Conversation-only move: tell the model (and anyone reading the file) that the
 * device's edits did not come along. Appended as a Pi `custom_message` on the
 * current leaf, which Pi includes in the model context of the next turn.
 */
export function appendImportNotice(transcript: string, notice: string): string {
  const lines = transcript.split("\n").filter((line) => line.trim() !== "");
  let leaf: string | null = null;
  const ids = new Set<string>();
  for (const line of lines.slice(1)) {
    const id = (JSON.parse(line) as { id?: unknown }).id;
    if (typeof id === "string") {
      leaf = id;
      ids.add(id);
    }
  }
  let id = randomUUID().slice(0, 8);
  while (ids.has(id)) id = randomUUID().slice(0, 8);
  const entry = {
    type: "custom_message",
    customType: "agent-deck-import",
    content: notice,
    display: true,
    id,
    parentId: leaf,
    timestamp: new Date().toISOString(),
  };
  return `${lines.join("\n")}\n${JSON.stringify(entry)}\n`;
}
