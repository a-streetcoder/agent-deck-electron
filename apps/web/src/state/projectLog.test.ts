import type { EventEnvelope } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { ingestProjectEvents, PROJECT_LOG_LIMIT, type ProjectEventPage } from "./projectLog.ts";

const event = (seq: number, logId = "log-a"): EventEnvelope => ({
  v: 1,
  id: `id-${seq}`,
  seq,
  ts: "2026-10-15T12:00:00.000Z",
  logId,
  kind: "plan.updated",
  projectId: "p1",
  subject: { type: "plan", id: "plan-1" },
  actor: { type: "system" },
  payload: {},
});
const page = (seqs: number[], extra: Partial<ProjectEventPage> = {}): ProjectEventPage => ({
  logId: "log-a",
  lastSeq: Math.max(0, ...seqs),
  events: seqs.map((seq) => event(seq, extra.logId)),
  more: false,
  ...extra,
});
const seqs = (events: EventEnvelope[]): number[] => events.map((e) => e.seq);

describe("ingestProjectEvents", () => {
  it("tolerates gaps and drops what the cursor already covers", () => {
    const tail = ingestProjectEvents(null, "p1", page([2, 5], { lastSeq: 9 }));
    // A tail read moves the cursor to the server's lastSeq (6..9 belong to other projects).
    expect(tail).toMatchObject({ projectId: "p1", logId: "log-a", lastSeq: 9 });
    const next = ingestProjectEvents(tail, "p1", page([5, 9, 12, 20], { nextAfterSeq: 25 }));
    expect(seqs(next.events)).toEqual([2, 5, 12, 20]);
    expect(next.lastSeq).toBe(25);
    // A lagging page never moves the cursor back.
    expect(ingestProjectEvents(next, "p1", page([3], { nextAfterSeq: 3 })).lastSeq).toBe(25);
  });

  it("starts over on a new logId or another project", () => {
    const old = ingestProjectEvents(null, "p1", page([40, 41]));
    const replaced = ingestProjectEvents(old, "p1", page([1, 2], { logId: "log-b" }));
    expect(replaced).toMatchObject({ logId: "log-b", lastSeq: 2 });
    expect(seqs(replaced.events)).toEqual([1, 2]);
    const other = ingestProjectEvents(old, null, page([3]));
    expect(other.projectId).toBeNull();
    expect(seqs(other.events)).toEqual([3]);
  });

  it("keeps only the newest events", () => {
    const many = Array.from({ length: PROJECT_LOG_LIMIT + 5 }, (_, i) => i + 1);
    const state = ingestProjectEvents(null, "p1", page(many));
    expect(state.events).toHaveLength(PROJECT_LOG_LIMIT);
    expect(state.events[0]?.seq).toBe(6);
  });
});
