// A1d: plan history and the supervisor view read the log projections; the startup
// equivalence report; one busy synthetic day measured through the real log.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { SessionPlanEvent } from "@agent-deck/contracts";
import {
  diffLoopRuns,
  diffSubagentRuns,
  projectLoopRuns,
  projectPlans,
  projectSubagentRuns,
  projectSupervisor,
  type EventDraft,
  type PublicLoopIteration,
  type PublicLoopRun,
  type PublicSubagentRun,
} from "@agent-deck/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventLog, MAX_EVENT_READ_LIMIT, type EventLog } from "../src/eventLog.ts";
import { createEventProducers } from "../src/eventProducers.ts";
import { createLogReaders } from "../src/eventReaders.ts";
import {
  reconcilePlanHistory,
  startEventProducers,
  type DiffProducerStore,
} from "../src/eventReconcile.ts";
import { startServer } from "../src/index.ts";
import { makePlanEventService } from "../src/services/planEvents.ts";
import { SupervisorLog } from "../src/supervisor.ts";

process.env.AGENT_DECK_TEST = "1";

const tempDir = (): string => mkdtempSync(path.join(tmpdir(), "ad-cutover-"));
const SYSTEM = { type: "system" } as const;

let opened: EventLog[] = [];

/** One process's wiring of the log, its readers and the two cheap stores. */
function open(dataDir: string, options: { clock?: () => Date } = {}) {
  const log = createEventLog(dataDir, options);
  opened.push(log);
  const events = createEventProducers(log);
  const readers = createLogReaders(log);
  const supervisor = new SupervisorLog(() => readers.supervisor());
  const plans = makePlanEventService({
    dataDir,
    onRecorded: (event, op) => events.planChanged(event.sessionId, op, event),
    readLog: (sessionId) => readers.plans(sessionId),
  });
  return { log, events, readers, supervisor, plans };
}

afterEach(() => {
  for (const log of opened) log.close();
  opened = [];
  vi.restoreAllMocks();
});

describe("A1d supervisor view from the log", () => {
  it("keeps this process's requests exact and reads earlier pending ones as interrupted", () => {
    const dataDir = tempDir();
    const parent = randomUUID();
    const first = open(dataDir);
    const ask = (message: string) => {
      const request = first.supervisor.record({
        parentSessionId: parent,
        cellId: "run-1",
        method: "need_decision",
        message,
      });
      first.events.supervisorOpened(request, "child-1");
      return request;
    };
    const answered = ask("answered before the restart");
    const pending = ask(`still open, see ${path.join(dataDir, "x.txt")}`);
    first.events.supervisorAnswered(first.supervisor.markAnswered(answered.id, "yes")!, SYSTEM);
    const progress = first.supervisor.record({
      parentSessionId: parent,
      cellId: "run-1",
      method: "progress_update",
      message: "halfway",
    });
    first.events.supervisorOpened(progress, "child-1");

    // Same process: the full text from memory (the log copy is redacted), live status.
    expect(first.supervisor.list(parent).map((r) => [r.id, r.status])).toEqual([
      [answered.id, "answered"],
      [pending.id, "pending"],
      [progress.id, "recorded"],
    ]);
    expect(first.supervisor.list(parent)[1]?.message).toBe(pending.message);
    first.log.close();

    // Restart: the memory log is empty, the projection applies the restart rule.
    const second = open(dataDir);
    const after = second.supervisor.list(parent);
    expect(after.map((r) => [r.id, r.status])).toEqual([
      [answered.id, "answered"],
      [pending.id, "interrupted"],
      [progress.id, "recorded"],
    ]);
    expect(after[0]?.response).toBe("yes");
    expect(after.filter((r) => r.status === "pending")).toEqual([]);
    expect(second.supervisor.list("another-session")).toEqual([]);

    // A request opened after the restart is pending again.
    const fresh = second.supervisor.record({
      parentSessionId: parent,
      cellId: "run-2",
      method: "interview_request",
      message: "new question",
    });
    second.events.supervisorOpened(fresh, "child-2");
    expect(second.supervisor.list(parent).filter((r) => r.status === "pending")).toEqual([
      expect.objectContaining({ id: fresh.id, message: "new question" }),
    ]);
  });

  it("falls back to the memory entries when the log cannot take writes", () => {
    const log = createEventLog(tempDir());
    log.close();
    const supervisor = new SupervisorLog(() => createLogReaders(log).supervisor());
    const request = supervisor.record({
      parentSessionId: "p",
      cellId: "c",
      method: "need_decision",
      message: "m",
    });
    expect(supervisor.list("p")).toEqual([request]);
  });
});

describe("A1d plan history from the log", () => {
  it("lists more than the store's 100 events, exact items for the ones the store holds", () => {
    const dataDir = tempDir();
    const sessionId = randomUUID();
    const first = open(dataDir);
    const longTitle = `${"x".repeat(300)} in ${dataDir}`;
    for (let i = 0; i < 130; i += 1) {
      const before = i === 0 ? [] : [{ id: "a", title: `step ${i - 1}`, status: "todo" as const }];
      const title = i === 129 ? longTitle : `step ${i}`;
      first.plans.record(sessionId, "set", before, [{ id: "a", title, status: "todo" }]);
    }
    expect(first.plans.all()[sessionId]).toHaveLength(100); // the store write keeps its cap
    first.log.close();

    const second = open(dataDir);
    const history = second.plans.list(sessionId);
    expect(history).toHaveLength(130);
    expect(history.map((event) => event.items[0]?.title)).toEqual(
      Array.from({ length: 130 }, (_, i) => (i === 129 ? longTitle : `step ${i}`)),
    );
    expect(history[0]).toMatchObject({ sessionId, kind: "created" });
    expect(history.slice(30)).toEqual(second.plans.all()[sessionId]);
  });

  it("imports store events the log lacks with their own time, and orders them", () => {
    const dataDir = tempDir();
    const sessionId = randomUUID();
    const old: SessionPlanEvent = {
      id: randomUUID(),
      sessionId,
      kind: "created",
      items: [{ id: "a", title: "before A1", status: "todo" }],
      at: "2026-01-01T00:00:00.000Z",
    };
    // A pre-A1 store: written without the log.
    const legacy = makePlanEventService({ dataDir });
    legacy.record(sessionId, "set", [], old.items);
    const legacyEvent = legacy.list(sessionId)[0]!;
    writeFileSync(
      path.join(dataDir, "plan-events", "index.json"),
      JSON.stringify({ [sessionId]: [old, legacyEvent] }),
    );
    const boot = open(dataDir);
    boot.plans.record(sessionId, "set", old.items, [{ id: "b", title: "after", status: "done" }]);
    const write = (event: SessionPlanEvent) =>
      boot.events.planChanged(event.sessionId, "set", event, "reconcile");
    expect(reconcilePlanHistory(boot.plans.all(), boot.readers, write)).toBe(2);
    expect(reconcilePlanHistory(boot.plans.all(), boot.readers, write)).toBe(0);
    expect(boot.readers.plans(sessionId)?.map((change) => change.at)).toContain(old.at);
    expect(boot.plans.list(sessionId).map((event) => event.items[0]?.title)).toEqual([
      "before A1",
      "before A1",
      "after",
    ]);
  });
});

describe("A1d startup equivalence report", () => {
  it("is zero on a clean boot and counts a planted gap", async () => {
    const dataDir = tempDir();
    const info = vi.spyOn(console, "info");
    const report = async () => {
      info.mockClear();
      await (await startServer({ dataDir })).close();
      const line = info.mock.calls.find((call) => call[0] === "[events] equivalence");
      expect(line).toBeDefined();
      return line![1] as Record<string, number>;
    };
    expect(await report()).toEqual({
      subagentReconciled: 0,
      subagentRecovered: 0,
      loopReconciled: 0,
      loopRecovered: 0,
      planReconciled: 0,
      mismatches: 0,
    });
    // Plant a gap: a store write whose log append never happened.
    makePlanEventService({ dataDir }).record(
      randomUUID(),
      "set",
      [],
      [{ id: "a", title: "lost append", status: "todo" }],
    );
    expect(await report()).toMatchObject({ planReconciled: 1, mismatches: 1 });
    expect(await report()).toMatchObject({ planReconciled: 0, mismatches: 0 });
  });
});

// ---------------------------------------------------------------------------
// One busy synthetic day: 10 sessions, ~5,000 events through the real log.

const SESSIONS = 10;
const TARGET_EVENTS = 5_000;
const DAY = Date.parse("2026-10-15T00:00:00.000Z");
const text = (length: number, seed: number): string =>
  `word${seed} `.repeat(Math.ceil(length / 5)).slice(0, length);

function writeBusyDay(dataDir: string) {
  let tick = 0;
  // Spread the appends over one UTC day (one segment).
  const clock = () => new Date(DAY + Math.min(tick++ * 15_000, 86_000_000));
  const { log, events, plans, supervisor } = open(dataDir, { clock });
  const append = (drafts: EventDraft[]) => {
    for (const draft of drafts) log.append(draft);
  };
  const subagent: PublicSubagentRun[] = [];
  const loop: PublicLoopRun[] = [];
  for (let n = 1; log.lastSeq() < TARGET_EVENTS; n += 1) {
    for (let s = 0; s < SESSIONS; s += 1) {
      const sessionId = `session-${s}`;
      const turnId = randomUUID();
      append([
        {
          kind: "turn.prompted",
          sessionId,
          projectId: null,
          subject: { type: "turn", id: turnId },
          parent: { type: "session", id: sessionId },
          actor: { type: "user", id: "u1", name: "User" },
          payload: { mode: "prompt", label: text(80, n) },
        },
        {
          kind: "session.turn.completed",
          sessionId,
          projectId: null,
          subject: { type: "turn", id: turnId },
          actor: { type: "agent", sessionId },
          payload: { firstEntryId: randomUUID(), lastEntryId: randomUUID(), label: text(80, n) },
        },
      ]);
      if (n % 3 === 0) {
        const items = Array.from({ length: 6 }, (_, i) => ({
          id: `item-${i}`,
          title: text(60, i + n),
          status: (i < n % 6 ? "done" : "todo") as "done" | "todo",
        }));
        plans.record(sessionId, "set", plans.list(sessionId).at(-1)?.items ?? [], items);
      }
      if (n % 10 === 0) {
        const request = supervisor.record({
          parentSessionId: sessionId,
          cellId: `cell-${n}`,
          method: "need_decision",
          message: text(300, n),
        });
        events.supervisorOpened(request, `child-${s}`);
        events.supervisorAnswered(supervisor.markAnswered(request.id, text(120, n))!, SYSTEM);
      }
      if (n % 5 === 0) {
        const createdAt = clock().toISOString();
        const starting: PublicSubagentRun = {
          id: randomUUID(),
          parentSessionId: sessionId,
          parentToolCallId: randomUUID(),
          task: text(500, n),
          status: "starting",
          createdAt,
          updatedAt: createdAt,
        };
        const running: PublicSubagentRun = { ...starting, status: "running" };
        const done: PublicSubagentRun = {
          ...running,
          status: "completed",
          updatedAt: clock().toISOString(),
          completedAt: clock().toISOString(),
          summary: text(1_500, n),
          inputTokens: 12_000,
          outputTokens: 900,
          durationMs: 45_000,
        };
        append(diffSubagentRuns([], [starting]));
        append(diffSubagentRuns([starting], [running]));
        append(diffSubagentRuns([running], [done]));
        subagent.push(done);
      }
      if (n % 25 === 0) {
        const startedAt = clock().toISOString();
        let run: PublicLoopRun = {
          id: randomUUID(),
          sessionId,
          loopName: "Maker / checker",
          status: "running",
          currentIteration: 0,
          maxIterations: 5,
          startedAt,
          updatedAt: startedAt,
          iterations: [],
        };
        let prev: PublicLoopRun[] = [];
        const commit = (next: PublicLoopRun) => {
          append(diffLoopRuns(prev, [next]));
          prev = [next];
          run = next;
        };
        commit(run);
        for (let i = 1; i <= 5; i += 1) {
          const at = clock().toISOString();
          const iteration = {
            id: randomUUID(),
            index: i,
            startedAt: at,
            validationPassed: null,
            timeline: ["maker", "checker", "goal"].map((phase) => ({
              id: randomUUID(),
              phase,
              roleName: phase,
              note: text(120, i),
              timestamp: at,
            })),
            children: ["maker", "checker"].map((phase) => ({
              id: randomUUID(),
              phase,
              status: "running",
              startedAt: at,
            })),
            artifacts: [],
          } as unknown as PublicLoopIteration;
          commit({ ...run, currentIteration: i, iterations: [...run.iterations, iteration] });
          const finished = {
            ...iteration,
            endedAt: clock().toISOString(),
            validationPassed: true,
            children: iteration.children.map((child) => ({ ...child, status: "completed" })),
          } as PublicLoopIteration;
          commit({ ...run, iterations: [...run.iterations.slice(0, -1), finished] });
        }
        const endedAt = clock().toISOString();
        commit({ ...run, status: "completed", stopReason: "success", endedAt, updatedAt: endedAt });
        loop.push(run);
      }
    }
  }
  return { log, plans, subagent, loop };
}

/** Replay the whole log into the four projections, paged as the server does. */
function replay(log: EventLog) {
  let subagent = projectSubagentRuns([]);
  let loop = projectLoopRuns([]);
  let supervisor = projectSupervisor([]);
  let plans = projectPlans([]);
  let afterSeq = 0;
  let events = 0;
  for (;;) {
    const page = log.read({ afterSeq, limit: MAX_EVENT_READ_LIMIT });
    events += page.events.length;
    subagent = projectSubagentRuns(page.events, subagent.values());
    loop = projectLoopRuns(page.events, loop.values());
    supervisor = projectSupervisor(page.events, supervisor);
    plans = projectPlans(page.events, plans);
    if (!page.more || page.nextAfterSeq === undefined || page.nextAfterSeq <= afterSeq) break;
    afterSeq = page.nextAfterSeq;
  }
  return { events, subagent, loop, supervisor, plans };
}

const fakeStore = <T>(runs: T[]): DiffProducerStore<T> => ({
  bootPublicRuns: () => runs,
  publicRuns: () => runs,
  quarantined: () => false,
  attachEventSink: () => {},
});

describe("A1d busy-day measurements", () => {
  // Skippable on slow machines; the bounds are generous (snapshots are due at ~1 s).
  it.skipIf(process.env.AGENT_DECK_SKIP_MEASURE === "1")(
    "replays one busy day well under the snapshot threshold",
    () => {
      const dataDir = tempDir();
      const day = writeBusyDay(dataDir);
      day.log.close();
      const dir = path.join(dataDir, "events");
      const bytes = readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0);

      // Cold startup: open the log, reconcile both diff stores and the plan history.
      const coldStart = performance.now();
      const log = createEventLog(dataDir);
      opened.push(log);
      const counts = startEventProducers(
        log,
        { subagentRuns: fakeStore(day.subagent), loopRuns: fakeStore(day.loop) },
        { view: () => ({}), warn: () => {}, strict: true },
      );
      const planReconciled = reconcilePlanHistory(day.plans.all(), createLogReaders(log), () => {
        throw new Error("a clean day has nothing to import");
      });
      const coldMs = performance.now() - coldStart;

      const replayStart = performance.now();
      const projected = replay(log);
      const replayMs = performance.now() - replayStart;

      console.info("[A1d measurements]", {
        events: projected.events,
        megabytes: Number((bytes / 1_048_576).toFixed(2)),
        bytesPerEvent: Math.round(bytes / projected.events),
        replayMs: Math.round(replayMs),
        coldStartupReconcileMs: Math.round(coldMs),
      });
      expect(projected.events).toBeGreaterThanOrEqual(TARGET_EVENTS);
      expect(counts).toMatchObject({ subagentReconciled: 0, loopReconciled: 0 });
      expect(planReconciled).toBe(0);
      expect(projected.subagent.size).toBe(day.subagent.length);
      expect(projected.loop.size).toBe(day.loop.length);
      expect(projected.plans.size).toBe(SESSIONS);
      expect(replayMs).toBeLessThan(5_000);
      expect(coldMs).toBeLessThan(10_000);
    },
    60_000,
  );
});
