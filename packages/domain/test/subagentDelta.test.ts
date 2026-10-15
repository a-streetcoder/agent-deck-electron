import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEventLine, splitJsonl, type EventEnvelope } from "../src/events.ts";
import { projectNodeTree } from "../src/nodeTree.ts";
import {
  SubagentDeltaIndex,
  SUBAGENT_DELTA_MAX_DECISIONS,
  SUBAGENT_RESULT_READ,
  subagentDelta,
} from "../src/subagentDelta.ts";

// The A1b1 recorded log: one managed_subagent run with a progress update, one child
// turn and a finished result (seq 1-11 before the run and session are removed).
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/events");
const recorded = splitJsonl(readFileSync(path.join(FIXTURES, "plan.jsonl"), "utf8"))
  .lines.map((line) => parseEventLine(line)!)
  .filter((event) => event.seq <= 11);

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const RUN = uuid(9);
const PARENT = uuid(5);
const CHILD = uuid(12);
const run = (status: string) => ({
  id: RUN,
  parentSessionId: PARENT,
  task: "Summarize the notes.",
  status,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

let seq = 11;
const next = (
  kind: string,
  subject: EventEnvelope["subject"],
  payload: unknown,
  extra: Partial<EventEnvelope> = {},
): EventEnvelope => {
  seq += 1;
  return {
    v: 1,
    id: uuid(100 + seq),
    seq,
    ts: "2026-01-01T00:01:00.000Z",
    logId: uuid(2),
    kind,
    projectId: null,
    sessionId: PARENT,
    subject,
    actor: { type: "system" },
    payload,
    ...extra,
  };
};
const runRef = { type: "subagentRun", id: RUN };
const childActor = { type: "agent", sessionId: CHILD } as const;

// The parent looks once (seq 12), then the child is continued.
const firstRead = next(
  SUBAGENT_RESULT_READ,
  runRef,
  { uptoSeq: 9 },
  {
    actor: { type: "agent", sessionId: PARENT },
  },
);
const continuation = [
  next("subagent.run.updated", runRef, { run: run("running") }),
  next(
    "supervisor.request.opened",
    { type: "supervisorRequest", id: uuid(201) },
    {
      id: uuid(201),
      cellId: RUN,
      method: "need_decision",
      title: "Pick a format",
      message: "JSON or YAML?",
      status: "pending",
    },
    { parent: runRef, actor: childActor },
  ),
  next(
    "supervisor.request.answered",
    { type: "supervisorRequest", id: uuid(201) },
    { id: uuid(201), response: "JSON" },
    { actor: { type: "user" } },
  ),
  next(
    "supervisor.request.opened",
    { type: "supervisorRequest", id: uuid(202) },
    {
      id: uuid(202),
      cellId: RUN,
      method: "interview_request",
      message: "Which folder?",
      status: "pending",
    },
    { parent: runRef, actor: childActor },
  ),
  next(
    "session.turn.completed",
    { type: "turn", id: uuid(203) },
    {
      entryIds: ["e1", "e2"],
      toolCalls: [
        { id: "call_a", name: "read", isError: false },
        { id: "call_b", name: "bash", isError: true },
      ],
      label: "Summarize the notes.",
      outcome: "failed",
      partial: true,
    },
    { sessionId: undefined, parent: runRef, actor: childActor },
  ),
  next("subagent.run.finished", runRef, {
    run: { ...run("failed") },
    result: { status: "failed", error: "bash exited 1" },
  }),
];
// Another run's events never leak into this one.
const other = next(
  "session.turn.completed",
  { type: "turn", id: uuid(300) },
  { entryIds: [], toolCalls: [{ id: "x", name: "write", isError: false }], label: "other" },
  { sessionId: undefined, parent: { type: "subagentRun", id: uuid(301) }, actor: childActor },
);
const log = [...recorded, firstRead, ...continuation, other];

describe("subagentDelta over a recorded child log", () => {
  it("first look: the full summary of the run so far", () => {
    const delta = subagentDelta(recorded, { runId: RUN, sinceSeq: 0 });
    expect(delta).toEqual({
      runId: RUN,
      statusNow: "completed",
      lastTurnOutcome: "completed",
      summaryHead: "Child summary: done.",
      summaryBytes: 20,
      resultIsLatest: true,
      full: true,
      sinceSeq: 0,
      uptoSeq: 9,
      turnsCompleted: 1,
      toolCalls: { contact_supervisor: 1 },
      failedToolCalls: [],
      openQuestions: [],
      decisions: [],
    });
  });

  it("A7: a verdict on the finished run keeps its result the latest (no new turn)", () => {
    const verified = {
      ...recorded.at(-1)!,
      id: uuid(400),
      seq: 10,
      kind: "subagent.run.verified",
      subject: runRef,
      payload: {
        run: {
          ...run("completed"),
          verdict: { decision: "APPROVE", reason: "ok", verifierRunId: uuid(401) },
        },
        runId: RUN,
        verdict: "APPROVE",
      },
    } as EventEnvelope;
    const delta = subagentDelta([...recorded, verified], { runId: RUN, sinceSeq: 0 });
    expect(delta).toMatchObject({
      statusNow: "completed",
      resultIsLatest: true,
      turnsCompleted: 1,
    });
  });

  it("second look: only what changed after the parent's cursor", () => {
    const delta = subagentDelta(log, { runId: RUN, sinceSeq: 9 });
    expect(delta).toEqual({
      runId: RUN,
      statusNow: "failed",
      statusThen: "completed",
      lastTurnOutcome: "failed",
      error: "bash exited 1",
      resultIsLatest: true,
      full: false,
      sinceSeq: 9,
      uptoSeq: continuation.at(-1)!.seq,
      turnsCompleted: 1,
      partialTurns: 1,
      toolCalls: { read: 1, bash: 1 },
      failedToolCalls: ["bash"],
      openQuestions: [{ id: uuid(202), method: "interview_request", message: "Which folder?" }],
      decisions: [
        {
          id: uuid(201),
          method: "need_decision",
          title: "Pick a format",
          message: "JSON or YAML?",
          response: "JSON",
        },
      ],
    });
  });

  it("the index takes the cursor from the parent's read events and merges what it passes", () => {
    const index = new SubagentDeltaIndex();
    for (const event of log) index.apply(event);
    expect(index.delta(RUN, "cursor")).toEqual(subagentDelta(log, { runId: RUN, sinceSeq: 9 }));
    // The whole run from the start: both turns, both results' newest, counts merged.
    expect(index.delta(RUN, "start")).toMatchObject({
      full: true,
      turnsCompleted: 2,
      toolCalls: { contact_supervisor: 1, read: 1, bash: 1 },
      error: "bash exited 1",
    });
    // A later cursor leaves an empty window; an older or equal one is ignored.
    const upto = continuation.at(-1)!.seq;
    index.apply(next(SUBAGENT_RESULT_READ, runRef, { uptoSeq: upto }));
    index.apply(next(SUBAGENT_RESULT_READ, runRef, { uptoSeq: 9 }));
    expect(index.get(RUN)!.cursor).toBe(upto);
    expect(index.get(RUN)!.tail).toEqual([]);
    expect(index.delta(RUN, "cursor")).toMatchObject({
      sinceSeq: upto,
      uptoSeq: upto,
      statusThen: "failed",
      turnsCompleted: 0,
      toolCalls: {},
      decisions: [],
      openQuestions: [{ id: uuid(202) }],
    });
    // A removed run is dropped with its open requests.
    index.apply(next("subagent.run.removed", runRef, { id: RUN }));
    expect(index.get(RUN)).toBeUndefined();
    expect(index.size).toBe(1); // the other run
  });

  it("a look with nothing new is empty but keeps the open questions and the cursor", () => {
    const upto = continuation.at(-1)!.seq;
    const delta = subagentDelta(log, { runId: RUN, sinceSeq: upto });
    expect(delta).toMatchObject({
      uptoSeq: upto,
      full: false,
      turnsCompleted: 0,
      toolCalls: {},
      decisions: [],
      openQuestions: [{ id: uuid(202) }],
    });
    expect(delta.summaryHead).toBeUndefined();
    expect(delta.error).toBeUndefined();
  });

  it("a restart closes a pending question (the supervisor restart rule)", () => {
    const restart = next(
      "server.started",
      { type: "server", id: uuid(400) },
      {},
      {
        sessionId: undefined,
      },
    );
    const delta = subagentDelta([...log, restart], { runId: RUN, sinceSeq: 0 });
    expect(delta.openQuestions).toEqual([]);
    // The restart marker is not a run event: the cursor stays on the run.
    expect(delta.uptoSeq).toBe(continuation.at(-1)!.seq);
  });

  it("counts tool calls per name and keeps the newest decisions", () => {
    const calls = Array.from({ length: 105 }, (_, i) => ({
      id: `c${i}`,
      name: i % 2 ? "read" : "bash",
      isError: i === 4,
    }));
    const turn = next(
      "session.turn.completed",
      { type: "turn", id: uuid(500) },
      { entryIds: [], toolCalls: calls, label: "big" },
      { sessionId: undefined, parent: runRef, actor: childActor },
    );
    const answers = Array.from({ length: SUBAGENT_DELTA_MAX_DECISIONS + 2 }, (_, i) => [
      next(
        "supervisor.request.opened",
        { type: "supervisorRequest", id: `q${i}` },
        { id: `q${i}`, method: "need_decision", message: `question ${i}` },
        { parent: runRef, actor: childActor },
      ),
      next(
        "supervisor.request.answered",
        { type: "supervisorRequest", id: `q${i}` },
        { id: `q${i}`, response: `answer ${i}` },
      ),
    ]).flat();
    const delta = subagentDelta([...recorded, turn, ...answers], { runId: RUN, sinceSeq: 9 });
    expect(delta.toolCalls).toEqual({ bash: 53, read: 52 });
    expect(delta.failedToolCalls).toEqual(["bash"]);
    expect(delta.decisions).toHaveLength(SUBAGENT_DELTA_MAX_DECISIONS);
    expect(delta.decisions[0]!.response).toBe("answer 2");
  });
});

describe("the read cursor in the node tree", () => {
  it("is not a step of the run: the tree is the same without it", () => {
    const withRead = projectNodeTree(log);
    const withoutRead = projectNodeTree(log.filter((event) => event !== firstRead));
    expect(withRead).toEqual(withoutRead);
  });
});
