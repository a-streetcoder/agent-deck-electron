// Event log envelope (A1, VISION_ORCHESTRATION principle 1): the pure half.
// apps/server/src/eventLog.ts owns the files, the lock and seq assignment; this
// module owns the wire shape, line parsing and the size cap.
import { z } from "zod";

export const EVENT_ENVELOPE_VERSION = 1;
/** One serialized event (one JSONL line, without its newline) never exceeds this. */
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

export interface NodeRef {
  type: NodeRefType;
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
  /** Resolved by the writer from sessionId; null = project-less or app-level. */
  projectId: string | null;
  sessionId?: string;
  subject: NodeRef;
  /** Tree edge for A2; only on *.created / *.started / *.opened. */
  parent?: NodeRef;
  causationId?: string;
  actor: EventActor;
  origin?: "reconcile";
  /** Per-kind whitelisted public projection, validated by the producer. */
  payload: unknown;
}

/** What a producer hands to the writer; the writer fills the rest. */
export type EventDraft = Omit<EventEnvelope, "v" | "id" | "seq" | "ts" | "logId" | "projectId"> & {
  /** Producer-generated (randomUUID) so a retry dedupes; the writer generates one if absent. */
  id?: string;
};

const ref = z.string().min(1).max(500);
const nodeRefSchema = z.object({ type: z.enum(NODE_REF_TYPES), id: ref });

const eventEnvelopeSchema = z.object({
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
  subject: nodeRefSchema,
  parent: nodeRefSchema.optional(),
  causationId: ref.optional(),
  actor: z.discriminatedUnion("type", [
    z.object({ type: z.literal("user"), id: ref.optional(), name: ref.optional() }),
    z.object({ type: z.literal("agent"), sessionId: ref, agentName: ref.optional() }),
    z.object({ type: z.literal("system") }),
  ]),
  origin: z.literal("reconcile").optional(),
  payload: z.unknown(),
});

export function validateEnvelope(value: unknown): EventEnvelope | null {
  const result = eventEnvelopeSchema.safeParse(value);
  return result.success
    ? ({ ...result.data, payload: result.data.payload ?? null } as EventEnvelope)
    : null;
}

/** One JSONL line to an envelope, or null when it is not JSON or not a valid envelope. */
export function parseEventLine(line: string): EventEnvelope | null {
  try {
    return validateEnvelope(JSON.parse(line));
  } catch {
    return null;
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

const utf8Bytes = (value: string): number => new TextEncoder().encode(value).byteLength;

/** Retain the newest UTF-8 suffix of at most maxBytes without cutting a code point. */
export function utf8Suffix(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  let start = bytes.length - maxBytes;
  // Skip UTF-8 continuation bytes so the suffix starts on a code point boundary.
  while (start < bytes.length && ((bytes[start] ?? 0) & 0xc0) === 0x80) start += 1;
  return new TextDecoder().decode(bytes.subarray(start));
}

/**
 * Cap one event at MAX_EVENT_BYTES: an oversized payload is replaced by
 * { truncated, originalBytes, tail } where tail is the newest suffix of its JSON.
 * Envelope fields are length-capped by the schema, so only the payload can overflow.
 */
export function capEventSize(event: EventEnvelope): EventEnvelope {
  if (utf8Bytes(JSON.stringify(event)) <= MAX_EVENT_BYTES) return event;
  const json = JSON.stringify(event.payload ?? null);
  const originalBytes = utf8Bytes(json);
  const build = (budget: number): EventEnvelope => ({
    ...event,
    payload: { truncated: true, originalBytes, tail: utf8Suffix(json, budget) },
  });
  const overhead = utf8Bytes(JSON.stringify(build(0)));
  let budget = MAX_EVENT_BYTES - overhead;
  for (;;) {
    const capped = build(budget);
    const size = utf8Bytes(JSON.stringify(capped));
    if (size <= MAX_EVENT_BYTES || budget <= 0) return capped;
    // JSON escaping grows the tail (up to 6x): shrink the budget by the observed ratio.
    const ratio = (MAX_EVENT_BYTES - overhead) / (size - overhead);
    budget = Math.min(budget - 1, Math.floor(budget * ratio));
  }
}
