// A1d: plan history and the supervisor view read the log projections; the startup
// equivalence report; one busy synthetic day measured through the real log.
import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import type { SessionPlanEvent } from "@agent-deck/contracts";
import {
  diffLoopRuns,
  diffSubagentRuns,
  type EventDraft,
  type PublicLoopIteration,
  type PublicLoopRun,
  type PublicSubagentRun,
} from "@agent-deck/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventLog, disabledEventLog, type EventLog } from "../src/eventLog.ts";
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

const SYSTEM = { type: "system" } as const;

let opened: EventLog[] = [];
let dirs: string[] = [];
const tempDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "ad-cutover-"));
  dirs.push(dir);
  return dir;
};

/** One process's wiring of the log, its readers and the two cheap stores. */
function open(
  dataDir: string,
  options: { clock?: () => Date; skipPlanAppend?: (event: SessionPlanEvent) => boolean } = {},
) {
  const log = createEventLog(dataDir, { clock: options.clock, warn: () => {} });
  opened.push(log);
  const events = createEventProducers(log);
  const readers = createLogReaders(log);
  const supervisor = new SupervisorLog(() => readers.supervisor());
  const plans = makePlanEventService({
    dataDir,
    onRecorded: (event, op) => {
      if (!options.skipPlanAppend?.(event)) events.planChanged(event.sessionId, op, event);
    },
    readLog: (sessionId) => readers.plans(sessionId),
  });
  return { log, events, readers, supervisor, plans };
}
type Plans = ReturnType<typeof makePlanEventService>;

const lockFile = (dataDir: string): string => path.join(dataDir, "events", "writer.lock");
/** Another live process (our parent) holds the lock, refreshed just now. */
const plantLock = (dataDir: string): void => {
  writeFileSync(lockFile(dataDir), JSON.stringify({ pid: process.ppid, token: "planted" }));
};
const staleLock = (dataDir: string): void => {
  const old = new Date(Date.now() - 3 * 60_000);
  utimesSync(lockFile(dataDir), old, old);
};

const step = (i: number) => [{ id: "a", title: `step ${i}`, status: "todo" as const }];
/** Record count plan replacements; the first title can be overridden. */
function recordSteps(plans: Plans, sessionId: string, count: number, firstTitle?: string): void {
  for (let i = 0; i < count; i += 1) {
    const after = i === 0 && firstTitle ? [{ ...step(0)[0]!, title: firstTitle }] : step(i);
    plans.record(sessionId, "set", i === 0 ? [] : step(i - 1), after);
  }
}
const titles = (events: SessionPlanEvent[]) => events.map((event) => event.items[0]?.title);
const steps = (from: number, count: number) =>
  Array.from({ length: count }, (_, i) => `step ${from + i}`);

afterEach(() => {
  vi.useRealTimers();
  for (const log of opened) log.close();
  opened = [];
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
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

  it("shows an entry whose append failed in time order", () => {
    const { supervisor, events } = open(tempDir());
    const record = (minute: number, logged: boolean) => {
      const request = supervisor.record({
        parentSessionId: "p",
        cellId: "c",
        method: "need_decision",
        message: `m${minute}`,
        now: `2026-10-15T08:0${minute}:00.000Z`,
      });
      if (logged) events.supervisorOpened(request, "child");
      return request.id;
    };
    const ids = [record(1, true), record(2, false), record(3, true)];
    expect(supervisor.list("p").map((r) => r.id)).toEqual(ids);
  });

  it("interrupts a dead writer's pending requests when a read-only process takes over", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dataDir = tempDir();
    const writer = open(dataDir);
    const orphan = writer.supervisor.record({
      parentSessionId: "p",
      cellId: "c",
      method: "need_decision",
      message: "asked by the old writer",
    });
    writer.events.supervisorOpened(orphan, "child");
    writer.log.close();
    plantLock(dataDir); // the old writer looks alive
    const reader = open(dataDir);
    expect(reader.log.writable).toBe(false);
    // Read-only still reads the log; the writer may be alive, so the request is pending.
    expect(reader.supervisor.list("p").map((r) => r.status)).toEqual(["pending"]);
    staleLock(dataDir); // it died
    vi.advanceTimersByTime(30_000);
    expect(reader.log.writable).toBe(true);
    expect(reader.supervisor.list("p").map((r) => r.status)).toEqual(["interrupted"]);
  });

  it("keeps its own pending request when the lock is lost and re-acquired", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const dataDir = tempDir();
    const sessionId = randomUUID();
    const node = open(dataDir);
    recordSteps(node.plans, sessionId, 120);
    const mine = node.supervisor.record({
      parentSessionId: "p",
      cellId: "c",
      method: "need_decision",
      message: "mine",
    });
    node.events.supervisorOpened(mine, "child");
    plantLock(dataDir);
    vi.advanceTimersByTime(10_000); // the heartbeat finds the takeover
    expect(node.log.writable).toBe(false);
    expect(node.plans.list(sessionId)).toHaveLength(120);
    staleLock(dataDir);
    vi.advanceTimersByTime(30_000);
    expect(node.log.writable).toBe(true);
    expect(node.supervisor.list("p")).toEqual([mine]); // memory is exact and still pending
    expect(node.plans.list(sessionId)).toHaveLength(120);
  });

  it("falls back to the memory entries for the disabled log", () => {
    const readers = createLogReaders(disabledEventLog());
    const supervisor = new SupervisorLog(() => readers.supervisor());
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
  it("lists more than the store's 100 events; log-only copies are marked and capped", () => {
    const dataDir = tempDir();
    const sessionId = randomUUID();
    const first = open(dataDir);
    recordSteps(first.plans, sessionId, 130, `${"x".repeat(300)} done`);
    expect(first.plans.all()[sessionId]).toHaveLength(100); // the store write keeps its cap
    first.log.close();

    const second = open(dataDir);
    const history = second.plans.list(sessionId);
    expect(history).toHaveLength(130);
    expect(titles(history).slice(1)).toEqual(steps(1, 129));
    expect(history[0]).toMatchObject({ sessionId, kind: "created", source: "log" });
    expect(history[0]?.items[0]?.title).toHaveLength(200); // the capped copy
    expect(history.slice(0, 30).every((event) => event.source === "log")).toBe(true);
    expect(history.slice(30)).toEqual(second.plans.all()[sessionId]); // exact, unmarked
  });

  it("reads the writer's history uncapped while another process holds the lock", () => {
    const dataDir = tempDir();
    const sessionId = randomUUID();
    const writer = open(dataDir);
    recordSteps(writer.plans, sessionId, 130);
    writer.log.close();
    plantLock(dataDir);
    const reader = open(dataDir);
    expect(reader.log.writable).toBe(false);
    expect(titles(reader.plans.list(sessionId))).toEqual(steps(0, 130));
  });

  it("falls back to the store for the disabled log", () => {
    const sessionId = randomUUID();
    const readers = createLogReaders(disabledEventLog());
    const plans = makePlanEventService({ dataDir: tempDir(), readLog: (id) => readers.plans(id) });
    recordSteps(plans, sessionId, 120);
    expect(plans.list(sessionId)).toHaveLength(100);
  });

  it("keeps log order when the clock goes backwards", () => {
    let now = Date.parse("2026-10-15T12:00:00.000Z");
    const node = open(tempDir(), { clock: () => new Date((now -= 60_000)) });
    const sessionId = randomUUID();
    vi.useFakeTimers({ toFake: ["Date"] });
    for (let i = 0; i < 3; i += 1) {
      vi.setSystemTime(Date.parse("2026-10-15T12:00:00.000Z") - i * 60_000); // the store's at too
      node.plans.record(sessionId, "set", i === 0 ? [] : step(i - 1), step(i));
    }
    vi.useRealTimers();
    expect(titles(node.plans.list(sessionId))).toEqual(steps(0, 3));
  });

  it("imports at store position: pre-A1 history first, a lost append between two live ones", () => {
    const dataDir = tempDir();
    const sessionId = randomUUID();
    const at = "2026-10-15T08:00:00.000Z"; // equal timestamps: only positions order them
    const pre = (id: string, title: string): SessionPlanEvent => ({
      id,
      sessionId,
      kind: "updated",
      items: [{ id: "a", title, status: "todo" }],
      at,
    });
    makePlanEventService({ dataDir }); // creates plan-events/
    writeFileSync(
      path.join(dataDir, "plan-events", "index.json"),
      JSON.stringify({ [sessionId]: [pre("p1", "pre 1"), pre("p2", "pre 2")] }),
    );
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse(at));
    const node = open(dataDir, { skipPlanAppend: (event) => event.items[0]?.title === "lost" });
    const live = (title: string, before: string) =>
      node.plans.record(
        sessionId,
        "set",
        [{ id: "a", title: before, status: "todo" }],
        [{ id: "a", title, status: "todo" }],
      );
    live("live 1", "pre 2");
    live("lost", "live 1");
    live("live 2", "lost");
    vi.useRealTimers();
    const write = (event: SessionPlanEvent, afterId?: string) =>
      node.events.planChanged(event.sessionId, "set", event, { afterId });
    // The log's first event shares the timestamp: nothing is older than the log.
    expect(reconcilePlanHistory(node.plans.all(), node.readers, write)).toEqual({
      imported: 0,
      reconciled: 3,
      contentMismatches: 0,
    });
    expect(reconcilePlanHistory(node.plans.all(), node.readers, write)).toEqual({
      imported: 0,
      reconciled: 0,
      contentMismatches: 0,
    });
    const expected = ["pre 1", "pre 2", "live 1", "lost", "live 2"];
    expect(titles(node.plans.list(sessionId))).toEqual(expected);
    // A fresh fold of the log gives the same order.
    node.log.close();
    expect(titles(open(dataDir).plans.list(sessionId))).toEqual(expected);
  });
});

describe("A1d startup equivalence report", () => {
  it("counts the first-boot import apart, is zero on a clean boot, counts a planted gap", async () => {
    const dataDir = tempDir();
    // History from before the log existed.
    makePlanEventService({ dataDir });
    const sessionId = randomUUID();
    writeFileSync(
      path.join(dataDir, "plan-events", "index.json"),
      JSON.stringify({
        [sessionId]: [
          {
            id: randomUUID(),
            sessionId,
            kind: "created",
            items: [{ id: "a", title: "old", status: "todo" }],
            at: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    const info = vi.spyOn(console, "info");
    const report = async () => {
      info.mockClear();
      await (await startServer({ dataDir })).close();
      const lines = info.mock.calls.filter((call) => call[0] === "[events] equivalence");
      expect(lines).toHaveLength(1);
      return lines[0]![1] as Record<string, unknown>;
    };
    expect(await report()).toMatchObject({ planImported: 1, planReconciled: 0, mismatches: 0 });
    expect(await report()).toEqual({
      readOnly: false,
      failures: 0,
      subagentReconciled: 0,
      subagentRecovered: 0,
      loopReconciled: 0,
      loopRecovered: 0,
      planImported: 0,
      planReconciled: 0,
      planContentMismatches: 0,
      mismatches: 0,
    });
    // Plant a gap: a store write whose log append never happened.
    makePlanEventService({ dataDir }).record(randomUUID(), "set", [], step(0));
    expect(await report()).toMatchObject({ planReconciled: 1, mismatches: 1 });
    expect(await report()).toMatchObject({ planImported: 0, planReconciled: 0, mismatches: 0 });
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

const fakeStore = <T>(runs: T[]): DiffProducerStore<T> => ({
  bootPublicRuns: () => runs,
  publicRuns: () => runs,
  quarantined: () => false,
  attachEventSink: () => {},
});

describe("A1d busy-day measurements", () => {
  // Opt-in (AGENT_DECK_MEASURE=1): timing on a shared machine is noise in a normal run.
  it.runIf(process.env.AGENT_DECK_MEASURE === "1")(
    "replays one busy day well under the snapshot threshold",
    () => {
      const dataDir = tempDir();
      const day = writeBusyDay(dataDir);
      day.log.close();
      const dir = path.join(dataDir, "events");
      const bytes = readdirSync(dir)
        .filter((name) => name.endsWith(".jsonl"))
        .reduce((sum, name) => sum + statSync(path.join(dir, name)).size, 0);

      // Cold startup as the server does it: open the log, one fold shared by the run
      // store reconcile and the plan history reconcile.
      const coldStart = performance.now();
      const log = createEventLog(dataDir);
      opened.push(log);
      const readers = createLogReaders(log);
      const counts = startEventProducers(
        log,
        { subagentRuns: fakeStore(day.subagent), loopRuns: fakeStore(day.loop) },
        { view: () => ({}), warn: () => {}, strict: true, readers },
      );
      const plans = reconcilePlanHistory(day.plans.all(), readers, () => {
        throw new Error("a clean day has nothing to import");
      });
      const coldMs = performance.now() - coldStart;

      // One whole fold into the four projections on a fresh reader (the writer's ring).
      const replayStart = performance.now();
      const projected = createLogReaders(log).projections();
      const replayMs = performance.now() - replayStart;

      // The same fold from disk: a second open is read-only (the writer holds the lock),
      // so it parses the segment files instead of the writer's ring.
      const diskStart = performance.now();
      const reader = createEventLog(dataDir, { warn: () => {} });
      opened.push(reader);
      const fromDisk = createLogReaders(reader).projections();
      const diskReplayMs = performance.now() - diskStart;
      expect(reader.writable).toBe(false);
      expect(fromDisk.subagent.size).toBe(day.subagent.length);

      const events = log.lastSeq();
      console.info("[A1d measurements]", {
        events,
        megabytes: Number((bytes / 1_048_576).toFixed(2)),
        bytesPerEvent: Math.round(bytes / events),
        replayMs: Math.round(replayMs),
        diskReplayMs: Math.round(diskReplayMs),
        coldStartupReconcileMs: Math.round(coldMs),
      });
      expect(events).toBeGreaterThanOrEqual(TARGET_EVENTS);
      expect(counts).toMatchObject({ subagentReconciled: 0, loopReconciled: 0 });
      expect(plans).toEqual({ imported: 0, reconciled: 0, contentMismatches: 0 });
      expect(projected.subagent.size).toBe(day.subagent.length);
      expect(projected.loop.size).toBe(day.loop.length);
      expect(projected.plans.size).toBe(SESSIONS);
      expect(replayMs).toBeLessThan(5_000);
      expect(coldMs).toBeLessThan(10_000);
    },
    60_000,
  );
});
