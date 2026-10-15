import { randomUUID } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  parseEventLine,
  projectLoopRuns,
  projectSubagentRuns,
  splitJsonl,
  toPublicLoopRun,
  toPublicSubagentRun,
  type EventEnvelope,
  type LoopRun,
  type PublicSubagentRun,
} from "@agent-deck/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventLog } from "../src/eventLog.ts";
import { localPathPrefixes, startEventProducers } from "../src/eventReconcile.ts";
import { startServer } from "../src/index.ts";
import { LoopEngine } from "../src/loopEngine.ts";
import { CAPABILITY_FIELDS, SubagentRunStore } from "../src/subagentRunStore.ts";

process.env.AGENT_DECK_TEST = "1";

const T0 = "2026-10-15T08:00:00.000Z";
const T1 = "2026-10-15T08:00:05.000Z";

function seed(dataDir: string): { done: string; live: string; loopDone: string; loopLive: string } {
  const parentSessionId = randomUUID();
  const done = randomUUID();
  const live = randomUUID();
  writeFileSync(
    path.join(dataDir, "subagent-runs.json"),
    JSON.stringify({
      version: 4,
      runs: [
        {
          id: done,
          parentSessionId,
          parentToolCallId: "call-1",
          turnToolCallId: "call-1",
          task: "finished task",
          status: "completed",
          createdAt: T0,
          updatedAt: T1,
          completedAt: T1,
          summary: "done summary",
          error: `partial: could not write ${path.join(dataDir, "spill", "out.txt")}`,
          source: "single",
          sessionFile: path.join(dataDir, "child-session.jsonl"),
        },
        {
          id: live,
          parentSessionId,
          task: "live task",
          status: "running",
          createdAt: T0,
          updatedAt: T0,
          source: "parallel",
        },
      ],
    }),
  );
  const iteration = (id: string, childStatus: string) => ({
    id: `${id}-iteration`,
    index: 1,
    startedAt: T0,
    output: "RAW MAKER OUTPUT",
    validationPassed: true,
    validationResult: {
      command: "npm test",
      workingDirectory: dataDir,
      exitCode: 0,
      durationMs: 10,
      stdout: "RAW STDOUT",
      stderr: "",
      classification: "completed",
      passed: true,
    },
    timeline: [
      { id: `${id}-t1`, phase: "maker", roleName: "Maker", note: "maker started", timestamp: T0 },
    ],
    children: [
      {
        id: `${id}-child`,
        phase: "maker",
        status: childStatus,
        output: "RAW CHILD OUTPUT",
        error: `tool failed in ${path.join(dataDir, "loop-artifacts", "x")}`,
      },
    ],
    artifacts: [],
  });
  const loopDone = randomUUID();
  const loopLive = randomUUID();
  const loop = (id: string, status: string, childStatus: string) => ({
    id,
    loopName: "Loop",
    sessionId: parentSessionId,
    launch: {
      sessionId: parentSessionId,
      writeTarget: "currentCheckout",
      checkoutLockKey: dataDir,
    },
    status,
    currentIteration: 1,
    maxIterations: 1,
    iterations: [iteration(id, childStatus)],
    startedAt: T0,
    updatedAt: T1,
    ...(status === "completed" ? { endedAt: T1, stopReason: "success" } : {}),
  });
  writeFileSync(
    path.join(dataDir, "loop-runs.json"),
    JSON.stringify([
      loop(loopDone, "completed", "completed"),
      loop(loopLive, "running", "running"),
    ]),
  );
  return { done, live, loopDone, loopLive };
}

function segmentFiles(dataDir: string): string[] {
  const dir = path.join(dataDir, "events");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .map((name) => path.join(dir, name));
}

function logEvents(dataDir: string): EventEnvelope[] {
  return segmentFiles(dataDir)
    .flatMap((file) => splitJsonl(readFileSync(file, "utf8")).lines)
    .map((line) => parseEventLine(line)!)
    .filter((event) => event.kind !== "server.started");
}

/** Simulate a crash that lost log lines: drop the matching events from the segments. */
function dropEvents(dataDir: string, drop: (event: EventEnvelope) => boolean): void {
  for (const file of segmentFiles(dataDir)) {
    const kept = splitJsonl(readFileSync(file, "utf8")).lines.filter(
      (line) => !drop(parseEventLine(line)!),
    );
    writeFileSync(file, kept.map((line) => `${line}\n`).join(""));
  }
}

const storeViews = (dataDir: string) => {
  const options = { pathPrefixes: localPathPrefixes(dataDir, []) };
  return {
    subagent: (
      JSON.parse(readFileSync(path.join(dataDir, "subagent-runs.json"), "utf8")) as {
        runs: PublicSubagentRun[];
      }
    ).runs.map((run) => toPublicSubagentRun(run, options)),
    loop: (JSON.parse(readFileSync(path.join(dataDir, "loop-runs.json"), "utf8")) as LoopRun[]).map(
      (run) => toPublicLoopRun(run, options),
    ),
  };
};

const byId = <T extends { id: string }>(items: T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]));

const boot = async (dataDir: string): Promise<void> => {
  await (await startServer({ dataDir })).close();
};

afterEach(() => {
  vi.useRealTimers();
});

describe("A1b2 startup reconcile", () => {
  it("first boot imports history as reconcile, then recovery as system events; a clean boot emits zero", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "event-reconcile-"));
    const ids = seed(dataDir);

    await boot(dataDir);
    const first = logEvents(dataDir);
    const imported = first.filter((event) => event.origin === "reconcile");
    const recovery = first.filter((event) => event.origin === undefined);

    expect(imported.map((event) => `${event.kind} ${event.subject.id}`)).toEqual(
      expect.arrayContaining([
        `subagent.run.created ${ids.done}`,
        `subagent.run.finished ${ids.done}`,
        `subagent.run.created ${ids.live}`,
        `loop.run.started ${ids.loopDone}`,
        `loop.run.finished ${ids.loopDone}`,
        `loop.run.started ${ids.loopLive}`,
      ]),
    );
    expect(imported.find((event) => event.subject.id === ids.done)?.parent).toEqual({
      type: "toolCall",
      id: "call-1",
    });
    // Boot recovery (interruptActiveRuns, loop interrupt) as system events...
    expect(recovery.map((event) => `${event.kind} ${event.subject.id}`)).toEqual(
      expect.arrayContaining([
        `subagent.run.finished ${ids.live}`,
        `loop.run.finished ${ids.loopLive}`,
        `loop.child.upserted ${ids.loopLive}-child`,
      ]),
    );
    expect(recovery.every((event) => event.actor.type === "system")).toBe(true);
    // ...and only after both stores are reconciled.
    expect(Math.min(...recovery.map((event) => event.seq))).toBeGreaterThan(
      Math.max(...imported.map((event) => event.seq)),
    );
    expect(recovery.find((event) => event.kind === "subagent.run.finished")?.payload).toMatchObject(
      { result: { status: "interrupted" } },
    );

    // The log projects to the stores' public views.
    const views = storeViews(dataDir);
    expect(projectSubagentRuns(first)).toEqual(byId(views.subagent));
    expect(projectLoopRuns(first)).toEqual(byId(views.loop));

    // Nothing private reached the log; local paths in error text are redacted.
    const text = JSON.stringify(first);
    for (const field of CAPABILITY_FIELDS) expect(text).not.toContain(`"${field}"`);
    for (const leaked of [
      "RAW",
      "npm test",
      "checkoutLockKey",
      JSON.stringify(dataDir).slice(1, -1),
    ]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("could not write <data>");
    expect(text).toContain("tool failed in <data>");

    // Second boot: nothing to import, nothing to recover.
    await boot(dataDir);
    expect(logEvents(dataDir)).toHaveLength(first.length);
  });

  it("repairs store writes the log missed: an edit, a missing created, a missing finished", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "event-reconcile-gap-"));
    const ids = seed(dataDir);
    await boot(dataDir);

    // Lost: the done run's created (so its finished cannot apply) and the live run's
    // recovery finished.
    dropEvents(
      dataDir,
      (event) =>
        (event.kind === "subagent.run.created" && event.subject.id === ids.done) ||
        (event.kind === "subagent.run.finished" &&
          event.subject.id === ids.live &&
          event.origin === undefined),
    );
    const before = logEvents(dataDir).length;
    await boot(dataDir);
    const repaired = logEvents(dataDir).slice(before);
    expect(repaired.map((event) => [event.kind, event.subject.id, event.origin])).toEqual([
      ["subagent.run.created", ids.done, "reconcile"],
      ["subagent.run.finished", ids.done, "reconcile"],
      ["subagent.run.finished", ids.live, "reconcile"],
    ]);

    // A store write after the last log write.
    const file = path.join(dataDir, "subagent-runs.json");
    const store = JSON.parse(readFileSync(file, "utf8")) as { runs: PublicSubagentRun[] };
    store.runs = store.runs.map((run) =>
      run.id === ids.done ? { ...run, summary: "edited after the log" } : run,
    );
    writeFileSync(file, JSON.stringify(store));
    const count = logEvents(dataDir).length;
    await boot(dataDir);
    expect(
      logEvents(dataDir)
        .slice(count)
        .map((event) => [event.kind, event.subject.id, event.origin]),
    ).toEqual([["subagent.run.updated", ids.done, "reconcile"]]);
  });

  it("a store quarantined at boot does not remove its runs from the log", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "event-reconcile-quarantine-"));
    seed(dataDir);
    await boot(dataDir);
    const before = logEvents(dataDir).length;
    writeFileSync(path.join(dataDir, "subagent-runs.json"), "{ not json");
    await boot(dataDir);
    expect(logEvents(dataDir).slice(before)).toEqual([]);
    // A corrupt loop-runs.json cannot go through startServer today: the engine's warn
    // reaches fastify before it is initialized. Same boot path, without the server.
    writeFileSync(path.join(dataDir, "loop-runs.json"), "[ not json");
    const log = createEventLog(dataDir);
    const store = new SubagentRunStore(dataDir, () => {});
    const engine = new LoopEngine({ dataDir });
    try {
      expect(engine.quarantined()).toBe(true);
      startEventProducers(
        log,
        { subagentRuns: store, loopRuns: engine },
        { view: () => ({}), warn: () => {}, strict: true },
      );
    } finally {
      log.close();
      store.close();
    }
    // The subagent file is simply absent now (not corrupt): its runs are reported removed.
    const after = logEvents(dataDir).slice(before);
    expect(after.filter((event) => event.kind === "loop.run.removed")).toEqual([]);
  });

  it("a process read-only at boot reconciles at the first commit after its promotion", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "event-reconcile-readonly-"));
    const writer = createEventLog(dataDir);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const reader = createEventLog(dataDir, { warn: () => {} });
    expect(reader.writable).toBe(false);
    const store = new SubagentRunStore(dataDir, () => {});
    const warn = vi.fn();
    try {
      expect(
        startEventProducers(
          reader,
          { subagentRuns: store, loopRuns: new LoopEngine() },
          { view: () => ({}), warn, strict: true },
        ),
      ).toBeUndefined();
      const id = randomUUID();
      store.create({
        id,
        parentSessionId: randomUUID(),
        task: "while read-only",
        status: "starting",
        createdAt: T0,
        updatedAt: T0,
      });
      store.update(id, { status: "running", updatedAt: T1 });
      const readonlyWarnings = warn.mock.calls.filter(([message]) =>
        String(message).includes("subagent runs events wait"),
      );
      expect(readonlyWarnings).toHaveLength(1);

      writer.close();
      vi.advanceTimersByTime(30_000);
      expect(reader.writable).toBe(true);

      store.update(id, { status: "completed", updatedAt: T1, completedAt: T1, summary: "ok" });
      store.update(id, { summary: "ok, edited" });
      const events = reader
        .read({ afterSeq: 0, limit: 100 })
        .events.filter((event) => event.kind.startsWith("subagent."));
      expect(events.map((event) => [event.kind, event.origin])).toEqual([
        ["subagent.run.created", "reconcile"],
        ["subagent.run.finished", "reconcile"],
        ["subagent.run.updated", undefined],
      ]);
      expect(projectSubagentRuns(events)).toEqual(byId(store.publicRuns()));
    } finally {
      reader.close();
      writer.close();
      store.close();
    }
  });
});
