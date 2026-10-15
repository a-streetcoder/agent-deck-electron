import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEventLine, splitJsonl, type EventEnvelope } from "../src/events.ts";
import {
  lastSubagentReadSeq,
  SUBAGENT_DELTA_MAX_TOOL_CALLS,
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
      sinceSeq: 0,
      uptoSeq: 9,
      full: true,
      statusNow: "completed",
      turnsCompleted: 1,
      lastTurnOutcome: "completed",
      toolCallsSinceLastLook: [{ id: "call_mock_3", name: "contact_supervisor", isError: false }],
      openQuestions: [],
      decisions: [],
      summaryHead: "Child summary: done.",
      summaryBytes: 20,
    });
  });

  it("second look: only what changed after the parent's cursor", () => {
    const sinceSeq = lastSubagentReadSeq(log, RUN);
    expect(sinceSeq).toBe(9);
    const delta = subagentDelta(log, { runId: RUN, sinceSeq });
    expect(delta).toEqual({
      runId: RUN,
      sinceSeq: 9,
      uptoSeq: continuation.at(-1)!.seq,
      full: false,
      statusNow: "failed",
      statusThen: "completed",
      turnsCompleted: 1,
      lastTurnOutcome: "failed",
      partialTurns: 1,
      toolCallsSinceLastLook: [
        { id: "call_a", name: "read", isError: false },
        { id: "call_b", name: "bash", isError: true },
      ],
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
      error: "bash exited 1",
    });
  });

  it("a look with nothing new is empty but keeps the open questions and the cursor", () => {
    const upto = continuation.at(-1)!.seq;
    const delta = subagentDelta(log, { runId: RUN, sinceSeq: upto });
    expect(delta).toMatchObject({
      uptoSeq: upto,
      full: false,
      turnsCompleted: 0,
      toolCallsSinceLastLook: [],
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

  it("keeps the newest tool calls and counts the rest", () => {
    const calls = Array.from({ length: SUBAGENT_DELTA_MAX_TOOL_CALLS + 5 }, (_, i) => ({
      id: `c${i}`,
      name: "read",
      isError: false,
    }));
    const turn = next(
      "session.turn.completed",
      { type: "turn", id: uuid(500) },
      { entryIds: [], toolCalls: calls, label: "big" },
      { sessionId: undefined, parent: runRef, actor: childActor },
    );
    const delta = subagentDelta([...recorded, turn], { runId: RUN, sinceSeq: 9 });
    expect(delta.toolCallsSinceLastLook).toHaveLength(SUBAGENT_DELTA_MAX_TOOL_CALLS);
    expect(delta.toolCallsSinceLastLook[0]!.id).toBe("c5");
    expect(delta.toolCallsOmitted).toBe(5);
  });
});
