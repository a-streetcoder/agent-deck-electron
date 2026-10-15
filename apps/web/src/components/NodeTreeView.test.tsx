// @vitest-environment jsdom

import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  emptyTranscript,
  parseEventLine,
  splitJsonl,
  type EventEnvelope,
} from "@agent-deck/domain";
import { useAppStore } from "../state/store.ts";
import { NodeTreeView } from "./NodeTreeView.tsx";
// The A1b recorded plan log: a turn that plans, delegates one subagent run and checkpoints.
import planLog from "../../../../packages/domain/test/fixtures/events/plan.jsonl?raw";

const refreshProjectLog = vi.fn(async () => {});
vi.mock("../state/wsBridge.ts", () => ({ refreshProjectLog: () => refreshProjectLog() }));

const fixture = (text: string): EventEnvelope[] =>
  splitJsonl(text).lines.map((line) => parseEventLine(line)!);
const SESSION = "00000000-0000-4000-8000-000000000005";

beforeEach(() => {
  useAppStore.setState({
    session: { id: SESSION, cwd: "/tmp", createdAt: "now" },
    projectLog: { projectId: null, logId: "log", lastSeq: 13, events: fixture(planLog) },
    // A stub transcript: the user message of the turn and its two tool calls.
    transcript: {
      ...emptyTranscript(),
      cells: [
        {
          kind: "user",
          id: "user-e0000005",
          entryId: "e0000005",
          text: "Plan and delegate\nthe rest",
        },
        {
          kind: "tool",
          id: "t1",
          toolCallId: "call_mock_1",
          toolName: "set_session_plan",
          args: {},
          status: "done",
        },
        {
          kind: "tool",
          id: "t2",
          toolCallId: "call_mock_2",
          toolName: "managed_subagent",
          args: {},
          status: "done",
        },
      ],
    },
  });
});
afterEach(() => {
  cleanup();
  useAppStore.setState({ session: null, projectLog: null, transcript: emptyTranscript() });
});

it("renders the session's tree with leaves joined from the transcript", () => {
  render(<NodeTreeView />);
  expect(refreshProjectLog).toHaveBeenCalled();
  const nodes = screen.getAllByTestId("tree-node");
  expect(nodes.map((node) => node.getAttribute("data-type"))).toEqual([
    "turn",
    "plan",
    "toolCall",
    "toolCall",
    "subagentRun",
    "supervisorRequest",
    "turn",
    "toolCall",
    "checkpoint",
  ]);
  const turn = nodes[0]!;
  expect(turn.getAttribute("data-status")).toBe("done");
  // The user message resolves by entryId: its first line, from the transcript.
  expect(
    within(turn)
      .getAllByTestId("tree-node-message")
      .map((li) => li.textContent),
  ).toEqual(["Plan and delegate"]);
  // Tool calls resolve by toolCallId and take the transcript's tool labels.
  const labels = screen.getAllByTestId("tree-node-label").map((label) => label.textContent);
  expect(labels[2]).toBe("Plan");
  expect(labels[3]).toBe("Agent");
  // The child's tool call is not in this transcript: the ref's own name.
  expect(labels[7]).toBe("contact_supervisor");
  expect(labels[4]).toBe("Summarize the notes.");
});

it("says so when the log has nothing for the session", () => {
  useAppStore.setState({ projectLog: null });
  render(<NodeTreeView />);
  expect(screen.getByTestId("node-tree").textContent).toContain("No recorded activity");
});
