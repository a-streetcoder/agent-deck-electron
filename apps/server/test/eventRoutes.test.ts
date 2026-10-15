import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ServerMessage } from "@agent-deck/contracts";
import type { EventEnvelope } from "@agent-deck/domain";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventLog, type EventLog, type EventSubscriber } from "../src/eventLog.ts";
import { registerEventRoutes, startProjectEventNudges } from "../src/routes/events.ts";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});

async function serve(): Promise<{
  log: EventLog;
  get: (query: string) => Promise<{ status: number; body: Record<string, unknown> }>;
}> {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-deck-event-routes-"));
  const log = createEventLog(dir, { warn: () => {} });
  const fastify = Fastify();
  registerEventRoutes(fastify, log);
  cleanups.push(
    () => rmSync(dir, { recursive: true, force: true }),
    () => log.close(),
    () => fastify.close(),
  );
  // seq 1 is server.started (project-less); then p1, p2, p1, null, p1 = 2..6.
  for (const projectId of ["p1", "p2", "p1", null, "p1"]) {
    log.append({
      kind: "plan.updated",
      projectId,
      subject: { type: "plan", id: "plan-1" },
      actor: { type: "system" },
      payload: {},
    });
  }
  return {
    log,
    get: async (query) => {
      const response = await fastify.inject({ method: "GET", url: `/events${query}` });
      return { status: response.statusCode, body: response.json() };
    },
  };
}

const seqs = (body: Record<string, unknown>): number[] =>
  (body.events as EventEnvelope[]).map((event) => event.seq);

describe("GET /events", () => {
  it("pages forward with a cursor inside one project", async () => {
    const { log, get } = await serve();
    const first = await get("?projectId=p1&afterSeq=0&limit=2");
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ logId: log.logId, lastSeq: 6, more: true, nextAfterSeq: 4 });
    expect(seqs(first.body)).toEqual([2, 4]);
    const second = await get("?projectId=p1&afterSeq=4&limit=2");
    expect(second.body).toMatchObject({ more: false, nextAfterSeq: 6 });
    expect(seqs(second.body)).toEqual([6]);
  });

  it("pages backward from the tail and filters project-less events with null", async () => {
    const { get } = await serve();
    const tail = await get("?beforeSeq=6&limit=2");
    expect(tail.body).toMatchObject({ more: true, nextBeforeSeq: 4 });
    expect(seqs(tail.body)).toEqual([4, 5]);
    expect(seqs((await get("?projectId=null")).body)).toEqual([1, 5]);
    expect(seqs((await get("?projectId=p2")).body)).toEqual([3]);
    expect(seqs((await get("")).body)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("reads one session's events with the server markers, and server markers on request", async () => {
    const { log, get } = await serve();
    const s1 = [
      { kind: "session.created", sessionId: "s1", subject: { type: "session", id: "s1" } },
      { kind: "turn.prompted", sessionId: "s1", subject: { type: "turn", id: "t1" } },
      // A fork of s1: its own session, with an edge from s1.
      {
        kind: "session.created",
        sessionId: "s2",
        subject: { type: "session", id: "s2" },
        parent: { type: "session", id: "s1" },
      },
      { kind: "turn.prompted", sessionId: "s2", subject: { type: "turn", id: "t2" } },
    ] as const;
    for (const draft of s1) {
      log.append({ ...draft, projectId: "p1", actor: { type: "user" }, payload: {} });
    }
    log.append({
      kind: "session.turn.completed",
      projectId: "p1",
      subject: { type: "turn", id: "t3" },
      actor: { type: "agent", sessionId: "s1" },
      payload: {},
    });
    expect(seqs((await get("?sessionId=s1&afterSeq=0")).body)).toEqual([1, 7, 8, 9, 11]);
    expect(seqs((await get("?sessionId=s1&afterSeq=0&includeServerEvents=false")).body)).toEqual([
      7, 8, 9, 11,
    ]);
    expect(seqs((await get("?projectId=p2&includeServerEvents=true")).body)).toEqual([1, 3]);
    expect(seqs((await get("?projectId=p2")).body)).toEqual([3]);
  });

  it("rejects malformed cursors and limits", async () => {
    const { get } = await serve();
    for (const query of [
      "?afterSeq=-1",
      "?beforeSeq=x",
      "?limit=0",
      "?limit=5000",
      "?projectId=",
      "?sessionId=",
      "?includeServerEvents=yes",
    ]) {
      expect((await get(query)).status).toBe(400);
    }
  });
});

describe("GET /events against a log that moves under the read", () => {
  it("caps a tail read at the lastSeq it reports", async () => {
    // A read-only backend: another process appends between lastSeq() and read().
    let head = 5;
    const stored = (): EventEnvelope[] =>
      Array.from({ length: head }, (_, i) => ({ seq: i + 1 }) as EventEnvelope);
    const log = {
      logId: "log-a",
      lastSeq: () => head,
      read: (query: { beforeSeq?: number }) => {
        const events = stored().filter((event) => event.seq < (query.beforeSeq ?? Infinity));
        head += 1; // appended right after the read
        return { events, more: false };
      },
    } as unknown as EventLog;
    const fastify = Fastify();
    registerEventRoutes(fastify, log);
    cleanups.push(() => fastify.close());
    const body = (await fastify.inject({ method: "GET", url: "/events" })).json();
    expect(body.lastSeq).toBe(5);
    expect(seqs(body)).toEqual([1, 2, 3, 4, 5]);
  });
});

describe("project_events nudges", () => {
  it("coalesces a burst into one nudge per project carrying the newest seq", () => {
    vi.useFakeTimers();
    let subscriber: EventSubscriber = () => {};
    const unsubscribe = vi.fn();
    const sent: ServerMessage[] = [];
    const stop = startProjectEventNudges(
      {
        subscribe: (fn) => {
          subscriber = fn;
          return unsubscribe;
        },
      },
      (message) => sent.push(message),
    );
    const emit = (projectId: string | null, seq: number): void =>
      subscriber({ projectId, seq } as EventEnvelope);

    emit("p1", 2);
    emit("p1", 3);
    emit(null, 4);
    emit("p1", 5);
    vi.advanceTimersByTime(99);
    expect(sent).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(sent).toEqual([
      { type: "project_events", projectId: "p1", seq: 5 },
      { type: "project_events", projectId: null, seq: 4 },
    ]);

    emit("p1", 6);
    vi.advanceTimersByTime(100);
    expect(sent.at(-1)).toEqual({ type: "project_events", projectId: "p1", seq: 6 });
    expect(sent).toHaveLength(3);

    emit("p2", 7);
    stop();
    vi.advanceTimersByTime(200);
    expect(sent).toHaveLength(3);
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
});
