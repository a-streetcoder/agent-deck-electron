import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { affectedRegion, failedVerifications } from "../src/affectedRegion.ts";
import { parseEventLine, splitJsonl, type EventEnvelope } from "../src/events.ts";
import { projectNodeTree } from "../src/nodeTree.ts";

// The A1b recorded logs, as in nodeTree.test.ts; later steps are appended by hand.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/events");
const events = (name: string): EventEnvelope[] =>
  splitJsonl(readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8")).lines.map(
    (line) => parseEventLine(line)!,
  );
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const SESSION = uuid(5);
const TURN_1 = uuid(6);
let seq = 100;
const ev = (
  kind: string,
  subject: { type: string; id: string },
  extra: Partial<EventEnvelope> = {},
): EventEnvelope => ({
  v: 1,
  id: `ev-${(seq += 1)}`,
  seq,
  ts: "2026-01-01T00:00:00.000Z",
  logId: "log",
  kind,
  projectId: null,
  sessionId: SESSION,
  subject,
  actor: { type: "system" },
  payload: {},
  ...extra,
});
const run = (id: string, status: string) => ({
  run: { id, parentSessionId: SESSION, task: `Task ${id}`, status, createdAt: "", updatedAt: "" },
});
const runRef = (id: string) => ({ type: "subagentRun", id });
const reject = (id: string): EventEnvelope =>
  ev("subagent.run.verified", runRef(id), {
    payload: {
      run: {
        ...run(id, "completed").run,
        verdict: { decision: "REJECT", reason: "no tests", verifierRunId: `v-${id}` },
      },
    },
  });
const underSession = { parent: { type: "session", id: SESSION } };

/** The recorded plan log while the session is live (the recording ends by removing it). */
const planLog = (): EventEnvelope[] =>
  events("plan").filter((event) => event.kind !== "session.removed");

/** A second turn after the recorded one: its delegated run is rejected, then it checkpoints. */
const rejectedSecondTurn = (): EventEnvelope[] => [
  ev("turn.prompted", { type: "turn", id: "t2" }, underSession),
  ev("subagent.run.created", runRef("r2"), {
    parent: { type: "toolCall", id: "call_t2" },
    payload: run("r2", "running"),
  }),
  ev("subagent.run.finished", runRef("r2"), { payload: run("r2", "completed") }),
  reject("r2"),
  ev(
    "session.turn.completed",
    { type: "turn", id: "t2" },
    { payload: { toolCalls: [{ id: "call_t2", name: "managed_subagent" }], label: "Second" } },
  ),
  ev(
    "checkpoint.created",
    { type: "checkpoint", id: `${SESSION}/1` },
    {
      parent: { type: "turn", id: "t2" },
      payload: { turnIndex: 1, label: "Second", node: { type: "turn", id: "t2" } },
    },
  ),
];

describe("affectedRegion over the recorded trees", () => {
  it("plan log: the delegated run fails inside the only turn, so nothing is trusted", () => {
    const tree = projectNodeTree(planLog(), { sessionId: SESSION });
    const region = affectedRegion(tree, `subagentRun:${uuid(9)}`)!;
    expect(region.trusted.size).toBe(0);
    // Its ancestors, its subtree and the turn's later checkpoint all run again.
    expect([...region.affected]).toEqual(
      expect.arrayContaining([
        `session:${SESSION}`,
        `turn:${TURN_1}`,
        `toolCall:${SESSION}/call_mock_2`,
        `subagentRun:${uuid(9)}`,
        `checkpoint:${SESSION}/0`,
      ]),
    );
    expect(region.frontier).toBeUndefined();
    expect(affectedRegion(tree, "turn:missing")).toBeUndefined();
  });

  it("a run rejected in a later turn: the recorded turn is trusted, its checkpoint the frontier", () => {
    const tree = projectNodeTree([...planLog(), ...rejectedSecondTurn()], { sessionId: SESSION });
    expect(failedVerifications(tree)).toEqual([
      {
        key: "subagentRun:r2",
        reason: "rejected",
        retry: { kind: "turn", key: "turn:t2", sessionId: SESSION },
      },
    ]);
    const region = affectedRegion(tree, "subagentRun:r2")!;
    expect(region.trusted).toContain(`turn:${TURN_1}`);
    expect(region.trusted).toContain(`subagentRun:${uuid(9)}`);
    expect(region.affected).toContain("turn:t2");
    expect(region.affected).toContain(`checkpoint:${SESSION}/1`);
    // The recorded checkpoint predates A10's node reference: it belongs to the turn above it.
    expect(region.frontier).toEqual({
      key: `turn:${TURN_1}`,
      checkpointKey: `checkpoint:${SESSION}/0`,
      sessionId: SESSION,
      turnIndex: 0,
    });
  });

  it("after a rollback, neither the truncated checkpoint nor the safety one is the frontier", () => {
    const log = [
      ...planLog(),
      ...rejectedSecondTurn(),
      // The rollback to 0: a safety checkpoint (no node) first, then 1 is truncated.
      ev(
        "checkpoint.created",
        { type: "checkpoint", id: `${SESSION}/2` },
        { ...underSession, payload: { turnIndex: 2 } },
      ),
      ev(
        "checkpoint.rolledBack",
        { type: "checkpoint", id: `${SESSION}/0` },
        { actor: { type: "user" }, payload: { turnIndex: 0, safetyTurnIndex: 2 } },
      ),
      ev("turn.prompted", { type: "turn", id: "t3" }, underSession),
    ];
    const tree = projectNodeTree(log, { sessionId: SESSION });
    expect(tree.nodes.get(`checkpoint:${SESSION}/1`)?.removed).toBe(true);
    expect(tree.nodes.get(`checkpoint:${SESSION}/2`)?.removed).toBeUndefined();
    // The rolled-back turn ended before the restore, so restoring 0 again loses nothing.
    expect(affectedRegion(tree, "turn:t3")?.frontier).toMatchObject({
      key: `turn:${TURN_1}`,
      turnIndex: 0,
    });
  });

  it("a blocked plan item: no frontier when trusted work finished after the last checkpoint", () => {
    const plan = (items: unknown[]): EventEnvelope =>
      ev("plan.changed", { type: "plan", id: SESSION }, { payload: { kind: "set", items } });
    const log = (aEndsBeforeCheckpoint: boolean): EventEnvelope[] => {
      const finishA = ev("subagent.run.finished", runRef("ra"), {
        payload: run("ra", "completed"),
      });
      return [
        ev("session.created", { type: "session", id: SESSION }),
        ev("turn.prompted", { type: "turn", id: "t1" }, underSession),
        plan([
          { id: "a", status: "in_progress", runId: "ra" },
          { id: "b", status: "todo", dependsOn: ["a"] },
        ]),
        ev("subagent.run.created", runRef("ra"), {
          ...underSession,
          payload: run("ra", "running"),
        }),
        ...(aEndsBeforeCheckpoint ? [finishA] : []),
        ev("session.turn.completed", { type: "turn", id: "t1" }),
        ev(
          "checkpoint.created",
          { type: "checkpoint", id: `${SESSION}/0` },
          {
            parent: { type: "turn", id: "t1" },
            payload: { turnIndex: 0, node: { type: "turn", id: "t1" } },
          },
        ),
        ...(aEndsBeforeCheckpoint ? [] : [finishA]),
        ev("subagent.run.created", runRef("rb"), {
          ...underSession,
          payload: run("rb", "running"),
        }),
        ev("subagent.run.finished", runRef("rb"), { payload: run("rb", "completed") }),
        reject("rb"),
        plan([
          { id: "a", status: "done", runId: "ra" },
          { id: "b", status: "blocked", dependsOn: ["a"], runId: "rb" },
        ]),
      ];
    };
    const late = projectNodeTree(log(false), { sessionId: SESSION });
    expect(failedVerifications(late)).toEqual([
      {
        key: "subagentRun:rb",
        reason: "rejected",
        retry: { kind: "planItem", key: "subagentRun:rb", sessionId: SESSION, itemId: "b" },
      },
    ]);
    const region = affectedRegion(late, "subagentRun:rb")!;
    expect(region.trusted).toContain("subagentRun:ra");
    // Restoring checkpoint 0 would drop the end of run A, which is trusted.
    expect(region.frontier).toBeUndefined();

    const early = projectNodeTree(log(true), { sessionId: SESSION });
    expect(affectedRegion(early, "subagentRun:rb")?.frontier).toMatchObject({
      key: "turn:t1",
      turnIndex: 0,
    });
  });

  it("makerChecker loop: a completed run has nothing to retry; a FAIL iteration of a failed one does", () => {
    const recorded = events("loop-makerChecker");
    const scope = { runId: uuid(1) };
    expect(failedVerifications(projectNodeTree(recorded, scope))).toEqual([]);

    const lastUpdate = recorded.findLastIndex((event) => event.kind === "loop.iteration.updated");
    const failed = recorded.map((event, index) => {
      const payload = event.payload as { iteration?: object; run?: object };
      if (index === lastUpdate) {
        const iteration = { ...payload.iteration, checkerDecision: "FAIL" };
        return { ...event, payload: { ...payload, iteration } };
      }
      if (event.kind === "loop.run.finished") {
        return {
          ...event,
          payload: { ...payload, run: { ...payload.run, status: "notAchieved" } },
        };
      }
      return event;
    });
    const tree = projectNodeTree(failed, scope);
    expect(failedVerifications(tree)).toEqual([
      {
        key: `loopIteration:${uuid(4)}`,
        reason: "checkerFail",
        retry: { kind: "loopRun", key: `loopRun:${uuid(1)}`, runId: uuid(1) },
      },
    ]);
    const iteration = affectedRegion(tree, `loopIteration:${uuid(4)}`)!;
    expect(iteration.trusted.size).toBe(0);
    expect(iteration.frontier).toBeUndefined();
    // From the checker child: the maker finished before it began, the evaluator after.
    const checker = affectedRegion(tree, `loopChild:${uuid(17)}`)!;
    expect([...checker.trusted]).toEqual([`loopChild:${uuid(6)}`]);
    expect(checker.affected).toContain(`loopChild:${uuid(22)}`);
    expect(checker.affected).toContain(`loopIteration:${uuid(4)}`);
  });
});
