import { describe, expect, it } from "vitest";
import { emptyTranscript, reduceTranscript, type AskUserCell } from "../src/index.ts";

const cell: AskUserCell = {
  kind: "ask_user",
  id: "ask-user-r1",
  requestId: "r1",
  sessionId: "s1",
  question: "Choose",
  options: [{ title: "A" }],
  allowMultiple: false,
  allowFreeform: true,
  allowComment: false,
  status: "pending",
};

describe("ask_user transcript events", () => {
  it("keeps a resolved read-only audit cell and ignores later races", () => {
    let state = reduceTranscript(emptyTranscript(), { type: "cell_open", cell });
    state = reduceTranscript(state, {
      type: "ask_user_answered",
      cellId: cell.id,
      answer: { selections: ["A"] },
    });
    state = reduceTranscript(state, {
      type: "ask_user_closed",
      cellId: cell.id,
      status: "timed_out",
      reason: "late timeout",
    });
    expect(state.cells[0]).toMatchObject({ kind: "ask_user", status: "answered" });
  });
});
