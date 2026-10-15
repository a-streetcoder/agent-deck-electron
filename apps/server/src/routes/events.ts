import type { EventEnvelope } from "@agent-deck/domain";
import type { ServerMessage } from "@agent-deck/contracts";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MAX_EVENT_READ_LIMIT, type EventLog } from "../eventLog.ts";
import type { SubagentDeltaReader } from "../subagentDelta.ts";

/**
 * A1c event log transport: a REST cursor read and a coalesced `project_events`
 * nudge on the existing socket. The nudge carries no events and no second
 * ordering domain; clients refetch afterSeq, and seq gaps are normal.
 */

const DEFAULT_LIMIT = 200;
export const NUDGE_COALESCE_MS = 100;

const seqParam = z.coerce.number().int().nonnegative().optional();
const eventsQuery = z.object({
  // "null" selects project-less events; omitted = every project.
  projectId: z
    .string()
    .min(1)
    .transform((value) => (value === "null" ? null : value))
    .optional(),
  /** A2: one session's events (see EventReadQuery.sessionId); implies includeServerEvents. */
  sessionId: z.string().min(1).max(500).optional(),
  includeServerEvents: z
    .enum(["true", "false"])
    .transform((value) => value === "true")
    .optional(),
  afterSeq: seqParam,
  beforeSeq: seqParam,
  limit: z.coerce.number().int().min(1).max(MAX_EVENT_READ_LIMIT).default(DEFAULT_LIMIT),
});

export function registerEventRoutes(fastify: FastifyInstance, log: EventLog): void {
  // Shared server: the identity hook already refused unauthenticated callers, and
  // every authenticated user sees every project (ADR 0003 attribution, no membership).
  fastify.get("/events", async (request, reply) => {
    const parsed = eventsQuery.safeParse(request.query);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid event query." });
    const { projectId, sessionId, includeServerEvents, afterSeq, beforeSeq, limit } = parsed.data;
    // lastSeq first: a tail read is capped at it, so the client's cursor never skips
    // an event a read-only process saw appended between the two calls.
    const lastSeq = log.lastSeq();
    const page = log.read({
      afterSeq,
      beforeSeq: afterSeq === undefined ? Math.min(beforeSeq ?? Infinity, lastSeq + 1) : beforeSeq,
      projectId,
      sessionId,
      includeServerEvents: includeServerEvents ?? sessionId !== undefined,
      limit,
    });
    return { logId: log.logId, lastSeq, ...page };
  });
}

/**
 * Broadcasts at most one nudge per projectId per window, carrying the newest seq.
 * Returns the stop function; it drops pending nudges.
 */
export function startProjectEventNudges(
  log: Pick<EventLog, "subscribe">,
  broadcast: (message: ServerMessage) => void,
  windowMs = NUDGE_COALESCE_MS,
): () => void {
  const pending = new Map<string | null, number>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => {
    timer = undefined;
    const due = [...pending];
    pending.clear();
    for (const [projectId, seq] of due) broadcast({ type: "project_events", projectId, seq });
  };
  const unsubscribe = log.subscribe((event: EventEnvelope) => {
    pending.set(event.projectId, event.seq);
    if (timer) return;
    timer = setTimeout(flush, windowMs);
    timer.unref?.();
  });
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = undefined;
    pending.clear();
  };
}

/**
 * A3: the full delta of one subagent run for its parent's result card. Read-only:
 * it never moves the parent agent's cursor (only subagent_delta does).
 */
export function registerSubagentDeltaRoute(
  fastify: FastifyInstance,
  reader: Pick<SubagentDeltaReader, "read">,
): void {
  fastify.get("/sessions/:parentSessionId/subagent-runs/:runId/delta", async (request, reply) => {
    const parsed = z
      .object({ parentSessionId: z.string().uuid(), runId: z.string().uuid() })
      .safeParse(request.params);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Parent session and run IDs must be UUIDs." });
    }
    const read = await reader.read(parsed.data.parentSessionId, parsed.data.runId, {
      from: "start",
    });
    if (!read.ok) return reply.status(404).send({ error: "Subagent run was not found." });
    return { delta: read.delta, hasEvents: read.hasEvents };
  });
}
