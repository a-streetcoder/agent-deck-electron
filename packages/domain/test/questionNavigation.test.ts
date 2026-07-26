import { describe, expect, it } from "vitest";
import {
  questionNavigationTarget,
  type AskUserCell,
  type QuestionCell,
  type SupervisorQuestionCell,
  type TranscriptCell,
} from "../src/transcript.ts";

const question = (id: string, answered: boolean): QuestionCell => ({
  kind: "question",
  id,
  requestId: `request-${id}`,
  method: "confirm",
  title: id,
  answered,
});
const askUser = (id: string, status: AskUserCell["status"]): AskUserCell => ({
  kind: "ask_user",
  id,
  requestId: `request-${id}`,
  sessionId: "session",
  question: id,
  options: [],
  allowMultiple: false,
  allowFreeform: true,
  allowComment: false,
  status,
});
const supervisor = (id: string, answered: boolean, closed = false): SupervisorQuestionCell => ({
  kind: "supervisor_question",
  id,
  requestId: `request-${id}`,
  subagentCellId: "subagent",
  method: "need_decision",
  title: id,
  answered,
  closed,
});

const cells: TranscriptCell[] = [
  question("answered-question", true),
  askUser("pending-ask", "pending"),
  supervisor("closed-supervisor", false, true),
  question("pending-question", false),
  askUser("cancelled-ask", "cancelled"),
  supervisor("pending-supervisor", false),
  supervisor("answered-supervisor", true),
];

describe("questionNavigationTarget", () => {
  it("recognizes pending status for every candidate kind and prefers the requested edge", () => {
    expect(questionNavigationTarget(cells, "next", null)).toMatchObject({
      cell: { id: "pending-ask" },
      index: 1,
      total: 7,
      pending: true,
    });
    expect(questionNavigationTarget(cells, "previous", null)).toMatchObject({
      cell: { id: "pending-supervisor" },
      index: 5,
      pending: true,
    });
  });

  it("keeps answered, cancelled, and closed cards in transcript-order navigation", () => {
    expect(questionNavigationTarget(cells, "previous", "pending-question")?.cell.id).toBe(
      "closed-supervisor",
    );
    expect(questionNavigationTarget(cells, "next", "pending-question")?.cell.id).toBe(
      "cancelled-ask",
    );
  });

  it("does not wrap at either boundary", () => {
    expect(questionNavigationTarget(cells, "previous", "answered-question")).toBeNull();
    expect(questionNavigationTarget(cells, "next", "answered-supervisor")).toBeNull();
  });

  it("treats a stale anchor as no anchor", () => {
    expect(questionNavigationTarget(cells, "next", "removed")?.cell.id).toBe("pending-ask");
    expect(questionNavigationTarget(cells, "previous", "removed")?.cell.id).toBe(
      "pending-supervisor",
    );
  });

  it("falls back to the transcript edge when none are pending and lands one card only once", () => {
    const resolved = [question("first", true), askUser("last", "timed_out")];
    expect(questionNavigationTarget(resolved, "next", null)?.cell.id).toBe("first");
    expect(questionNavigationTarget(resolved, "previous", null)?.cell.id).toBe("last");
    expect(questionNavigationTarget([question("only", false)], "next", null)?.cell.id).toBe("only");
    expect(questionNavigationTarget([question("only", false)], "next", "only")).toBeNull();
  });
});
