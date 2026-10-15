// Event log envelope (A1, VISION_ORCHESTRATION principle 1): the pure half.
// apps/server/src/eventLog.ts owns the files, the lock and seq assignment; this
// module owns the wire shape, line parsing and the size cap.
import { z } from "zod";

export const EVENT_ENVELOPE_VERSION = 1;
/**
 * One serialized event (one JSONL line, without its newline) never exceeds this.
 * Producers cap their own string fields; serializeEvent is only the last resort.
 */
export const MAX_EVENT_BYTES = 512_000;

export const NODE_REF_TYPES = [
  "server",
  "session",
  "turn",
  "toolCall",
  "plan",
  "checkpoint",
  "subagentRun",
  "supervisorRequest",
  "loopRun",
  "loopIteration",
  "loopChild",
] as const;

export type NodeRefType = (typeof NODE_REF_TYPES)[number];

/** A node reference as a producer writes it: only the types this build knows. */
export interface NodeRef {
  type: NodeRefType;
  id: string;
}

/** A node reference as read back: a newer build may have written a type this one does not know. */
export interface StoredNodeRef {
  type: string;
  id: string;
}

export type EventActor =
  | { type: "user"; id?: string; name?: string }
  | { type: "agent"; sessionId: string; agentName?: string }
  | { type: "system" };

export interface EventEnvelope {
  v: 1;
  /** Producer identity for dedupe only; never order by it. */
  id: string;
  /** Writer-assigned, strictly increasing per logId: THE cursor. */
  seq: number;
  /** Server time at append (ISO). */
  ts: string;
  /** Random per data dir; a change means the client must reset its cursor. */
  logId: string;
  /** Namespaced, e.g. "subagent.run.finished". Readers skip kinds they do not know. */
  kind: string;
  /** Explicit on the draft, else resolved by the writer from sessionId; null = project-less. */
  projectId: string | null;
  sessionId?: string;
  subject: StoredNodeRef;
  /** Tree edge for A2; only on *.created / *.started / *.opened. */
  parent?: StoredNodeRef;
  causationId?: string;
  actor: EventActor;
  origin?: "reconcile";
  /** Per-kind whitelisted public projection, validated by the producer. */
  payload: unknown;
}

/** What a producer hands to the writer; the writer fills the rest. */
export type EventDraft = Omit<
  EventEnvelope,
  "v" | "id" | "seq" | "ts" | "logId" | "projectId" | "subject" | "parent"
> & {
  /** Producer-generated (randomUUID) so a retry dedupes; the writer generates one if absent. */
  id?: string;
  /** Set when the event belongs to a project but has no session; otherwise resolved from sessionId. */
  projectId?: string | null;
  subject: NodeRef;
  parent?: NodeRef;
};

const ref = z.string().min(1).max(500);
const storedNodeRefSchema = z.object({ type: z.string().min(1).max(100), id: ref });

const storedEnvelopeSchema = z.object({
  v: z.literal(EVENT_ENVELOPE_VERSION),
  id: ref,
  seq: z.number().int().positive(),
  ts: z.string().datetime(),
  logId: ref,
  kind: z
    .string()
    .max(200)
    .regex(/^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)+$/, "kind must be namespaced"),
  projectId: ref.nullable(),
  sessionId: ref.optional(),
  subject: storedNodeRefSchema,
  parent: storedNodeRefSchema.optional(),
  causationId: ref.optional(),
  actor: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), id: ref.optional(), name: ref.optional() }),
    z.object({ type: z.literal("agent"), sessionId: ref, agentName: ref.optional() }),
    z.object({ type: z.literal("system") }),
  ]),
  origin: z.literal("reconcile").optional(),
  payload: z.unknown(),
});

const knownNodeRef = (node: StoredNodeRef | undefined): boolean =>
  node === undefined || (NODE_REF_TYPES as readonly string[]).includes(node.type);

// The node-type enum is closed on write only, so lines from a newer build stay readable.
const writeEnvelopeSchema = storedEnvelopeSchema.refine(
  (event) => knownNodeRef(event.subject) && knownNodeRef(event.parent),
  "unknown node type",
);

const withPayload = (data: z.infer<typeof storedEnvelopeSchema>): EventEnvelope =>
  ({ ...data, payload: data.payload ?? null }) as EventEnvelope;

/** Strict check for the writer: closed node-type enum. */
export function validateEnvelope(value: unknown): EventEnvelope | null {
  const result = writeEnvelopeSchema.safeParse(value);
  return result.success ? withPayload(result.data) : null;
}

/** One JSONL line to an envelope, or null when it is not JSON or not a v1 envelope. */
export function parseEventLine(line: string): EventEnvelope | null {
  try {
    const result = storedEnvelopeSchema.safeParse(JSON.parse(line));
    return result.success ? withPayload(result.data) : null;
  } catch {
    return null;
  }
}

/**
 * The seq of any JSON line with a positive integer seq, without the schema: cursor
 * recovery must count lines a newer build wrote, or seq numbers would be reused.
 */
export function seqOfLine(line: string): number | undefined {
  try {
    const seq = (JSON.parse(line) as { seq?: unknown } | null)?.seq;
    return typeof seq === "number" && Number.isInteger(seq) && seq > 0 ? seq : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Split JSONL text into complete non-blank lines and the unterminated rest (a torn
 * tail after a crash mid-append, or "" when the text ends with a newline).
 */
export function splitJsonl(text: string): { lines: string[]; rest: string } {
  const end = text.lastIndexOf("\n");
  const lines = text
    .slice(0, end + 1)
    .split("\n")
    .map((line) => line.replace(/\r$/, ""))
    .filter((line) => line.trim().length > 0);
  return { lines, rest: text.slice(end + 1) };
}

/**
 * Serialize one event as its JSONL line (without the newline). Over MAX_EVENT_BYTES
 * the payload is replaced by { truncated: true, originalBytes }, keeping every
 * identifying envelope field. Throws on an unserializable payload (BigInt, cycle).
 */
export function serializeEvent(event: EventEnvelope): string {
  const text = JSON.stringify(event);
  const originalBytes = new TextEncoder().encode(text).byteLength;
  if (originalBytes <= MAX_EVENT_BYTES) return text;
  return JSON.stringify({ ...event, payload: { truncated: true, originalBytes } });
}

/** A known absolute root and the placeholder that replaces it in event text. */
export interface PathPrefix {
  path: string;
  placeholder: string;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Generic absolute paths the known prefixes did not cover. A path is redacted up to
// its first space, comma or semicolon, so the tail of a path containing one survives.
const GENERIC_PATHS: readonly RegExp[] = [
  /(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|*?,;]*/g,
  /(?<![\\\w])\\\\[^\s\\/"'<>|,;]+[\\/][^\s"'<>|,;]*/g,
  /(?<![\w.~-])\/(?:home|Users|root|tmp|var|private|mnt|opt|srv|etc|Volumes|media|run)\/[^\s"'<>|,;]*/g,
  /(?<![\w~])~[\\/][^\s"'<>|,;]*/g,
];

/**
 * Replace absolute paths in free event text (A1 policy: the log holds facts and
 * references, never a machine's layout). Known roots (data dir, home, project
 * roots) become their placeholder, longest first, matched case-insensitively with
 * either separator; any other drive, UNC, POSIX home/temp or ~ path becomes <path>.
 */
export function redactPaths(text: string, prefixes: readonly PathPrefix[]): string {
  let result = text;
  const roots = prefixes
    .map((prefix) => ({ ...prefix, path: prefix.path.replace(/[\\/]+$/, "") }))
    .filter((prefix) => prefix.path.length >= 3)
    .sort((a, b) => b.path.length - a.path.length);
  for (const root of roots) {
    const pattern = root.path
      .split(/[\\/]+/)
      .map(escapeRegExp)
      .join("[\\\\/]+");
    result = result.replace(
      new RegExp(`${pattern}(?=$|[\\\\/\\s"'<>|:;,)\\]])`, "gi"),
      () => root.placeholder,
    );
  }
  for (const generic of GENERIC_PATHS) result = result.replace(generic, "<path>");
  return result;
}

const SECRET_PATTERNS: ReadonlyArray<[RegExp, string]> = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, "<secret>"],
  [/\b(?:sk|pk|rk)-(?:[A-Za-z0-9]+-)*[A-Za-z0-9_]{16,}/g, "<secret>"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, "<secret>"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, "<secret>"],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, "<secret>"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "<secret>"],
  [/\bAIza[0-9A-Za-z_-]{35}/g, "<secret>"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, "<secret>"],
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{16,}/gi, "$1 <secret>"],
  [
    /\b((?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd)["']?\s*[:=]\s*["']?)[^\s"',;]{6,}/gi,
    "$1<secret>",
  ],
];

/** Replace token-like strings (provider keys, bearer tokens, key=value secrets) in free event text. */
export function redactSecrets(text: string): string {
  let result = text;
  for (const [pattern, replacement] of SECRET_PATTERNS)
    result = result.replace(pattern, replacement);
  return result;
}
