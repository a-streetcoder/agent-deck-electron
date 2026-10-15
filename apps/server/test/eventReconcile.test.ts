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
import { describe, expect, it } from "vitest";
import { startServer } from "../src/index.ts";

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
          task: "finished task",
          status: "completed",
          createdAt: T0,
          updatedAt: T1,
          completedAt: T1,
          summary: "done summary",
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
      { id: `${id}-child`, phase: "maker", status: childStatus, output: "RAW CHILD OUTPUT" },
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

function logEvents(dataDir: string): EventEnvelope[] {
  const dir = path.join(dataDir, "events");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => splitJsonl(readFileSync(path.join(dir, name), "utf8")).lines)
    .map((line) => parseEventLine(line)!);
}

const storeViews = (dataDir: string) => ({
  subagent: (
    JSON.parse(readFileSync(path.join(dataDir, "subagent-runs.json"), "utf8")) as {
      runs: PublicSubagentRun[];
    }
  ).runs.map(toPublicSubagentRun),
  loop: (JSON.parse(readFileSync(path.join(dataDir, "loop-runs.json"), "utf8")) as LoopRun[]).map(
    toPublicLoopRun,
  ),
});

const byId = <T extends { id: string }>(items: T[]): Map<string, T> =>
  new Map(items.map((item) => [item.id, item]));

describe("A1b2 startup reconcile", () => {
  it("first boot imports history as reconcile, recovery as system events; a clean boot emits zero", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "event-reconcile-"));
    const ids = seed(dataDir);

    await (await startServer({ dataDir })).close();
    const first = logEvents(dataDir).filter((event) => event.kind !== "server.started");
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
    // Boot recovery (interruptActiveRuns, loop interrupt) after the import, as system events.
    expect(recovery.map((event) => `${event.kind} ${event.subject.id}`)).toEqual(
      expect.arrayContaining([
        `subagent.run.finished ${ids.live}`,
        `loop.run.finished ${ids.loopLive}`,
        `loop.child.upserted ${ids.loopLive}-child`,
      ]),
    );
    for (const prefix of ["subagent.", "loop."]) {
      const seqs = (events: EventEnvelope[]) =>
        events.filter((event) => event.kind.startsWith(prefix)).map((event) => event.seq);
      expect(Math.min(...seqs(recovery))).toBeGreaterThan(Math.max(...seqs(imported)));
    }
    expect(recovery.every((event) => event.actor.type === "system")).toBe(true);
    expect(recovery.find((event) => event.kind === "subagent.run.finished")?.payload).toMatchObject(
      { result: { status: "interrupted" } },
    );

    // The log projects to the stores' public views.
    const views = storeViews(dataDir);
    expect(projectSubagentRuns(first)).toEqual(byId(views.subagent));
    expect(projectLoopRuns(first)).toEqual(byId(views.loop));

    // Nothing private reached the log.
    const text = JSON.stringify(first);
    for (const leaked of [
      "RAW",
      "npm test",
      "sessionFile",
      "checkoutLockKey",
      JSON.stringify(dataDir).slice(1, -1),
    ]) {
      expect(text).not.toContain(leaked);
    }

    // Second boot: nothing to import, nothing to recover.
    await (await startServer({ dataDir })).close();
    const second = logEvents(dataDir).filter((event) => event.kind !== "server.started");
    expect(second).toHaveLength(first.length);
  });

  it("repairs a store write the log missed (crash between the two)", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "event-reconcile-gap-"));
    const ids = seed(dataDir);
    await (await startServer({ dataDir })).close();
    const before = logEvents(dataDir).length;

    const file = path.join(dataDir, "subagent-runs.json");
    const store = JSON.parse(readFileSync(file, "utf8")) as { runs: PublicSubagentRun[] };
    store.runs = store.runs.map((run) =>
      run.id === ids.done ? { ...run, summary: "edited after the log", updatedAt: T1 } : run,
    );
    writeFileSync(file, JSON.stringify(store));

    await (await startServer({ dataDir })).close();
    const repaired = logEvents(dataDir)
      .slice(before)
      .filter((event) => event.kind !== "server.started");
    expect(repaired.map((event) => [event.kind, event.subject.id, event.origin])).toEqual([
      ["subagent.run.updated", ids.done, "reconcile"],
    ]);
  });
});
