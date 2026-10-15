// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  emptyTranscript,
  humanAnsweredDraft,
  humanFromAskUser,
  humanFromSupervisor,
  humanRequestedDraft,
  parseEventLine,
  splitJsonl,
  type EventDraft,
  type EventEnvelope,
  type TranscriptCell,
} from "@agent-deck/domain";
import { useAppStore } from "../state/store.ts";
import { NodeTreeView } from "./NodeTreeView.tsx";
// The A1b recorded plan log: a turn that plans, delegates one subagent run and checkpoints.
import planLog from "../../../../packages/domain/test/fixtures/events/plan.jsonl?raw";

const switchToSession = vi.fn();
vi.mock("../state/wsBridge.ts", () => ({
  switchToSession: (session: unknown) => switchToSession(session),
}));

const SESSION = "00000000-0000-4000-8000-000000000005";
const recorded = splitJsonl(planLog)
  .lines.map((line) => parseEventLine(line)!)
  // The view reads a live session; the recording ends by removing it.
  .filter((event) => event.kind !== "session.removed");
const fork: EventEnvelope = {
  ...recorded[1]!,
  id: "fork-event",
  seq: 20,
  sessionId: "fork-1",
  subject: { type: "session", id: "fork-1" },
  parent: { type: "session", id: SESSION },
  payload: { title: "Try another plan" },
};

// A stub transcript of the same session: the prompt (same line as the turn label), a
// steer that says more, the assistant's reasoning and text, and the turn's tool calls.
// A tool call id the CHILD session also used must not join the child's node.
const cells: TranscriptCell[] = [
  { kind: "user", id: "user-e0000005", entryId: "e0000005", text: "Plan and delegate\nthe rest" },
  {
    kind: "assistant",
    id: "a1",
    streaming: false,
    blocks: [
      { kind: "thinking", contentIndex: 0, text: "Need a plan first\nthen delegate", done: true },
      { kind: "text", contentIndex: 1, text: "Planning now.", done: true },
    ],
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
  {
    kind: "tool",
    id: "t3",
    toolCallId: "call_mock_3",
    toolName: "set_session_plan",
    args: {},
    status: "done",
  },
  { kind: "user", id: "user-e0000008", entryId: "e0000008", text: "Also summarize the notes" },
  { kind: "user", id: "user-other", text: "A later turn" },
  {
    kind: "assistant",
    id: "a2",
    streaming: false,
    blocks: [{ kind: "text", contentIndex: 0, text: "Not this turn", done: true }],
  },
];

let served: EventEnvelope[] = [];
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input), "http://x");
  const after = Number(url.searchParams.get("afterSeq"));
  const limit = Number(url.searchParams.get("limit"));
  const rest = served.filter((event) => event.seq > after);
  const events = rest.slice(0, limit);
  return Response.json({
    logId: "log",
    lastSeq: 20,
    events,
    more: rest.length > limit,
    nextAfterSeq: events.at(-1)?.seq ?? after,
  });
});

beforeEach(() => {
  served = [...recorded, fork];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
  useAppStore.setState({
    session: { id: SESSION, cwd: "/tmp", createdAt: "now" },
    sessions: [{ id: "fork-1", cwd: "/tmp", createdAt: "now", title: "Fork title" }],
    projectLog: null,
    transcript: { ...emptyTranscript(), cells },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAppStore.setState({
    session: null,
    sessions: [],
    projectLog: null,
    transcript: emptyTranscript(),
  });
});

it("renders the session's full history with leaves joined from the same session's transcript", async () => {
  render(<NodeTreeView />);
  await waitFor(() => expect(screen.getAllByTestId("tree-node").length).toBeGreaterThan(0));
  expect(String(fetchMock.mock.calls[0]![0])).toBe(
    `/events?sessionId=${SESSION}&afterSeq=0&limit=1000`,
  );
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
  // The prompt line is the turn's own label: not repeated; the steer is.
  expect(
    within(turn)
      .getAllByTestId("tree-leaf-message")
      .map((li) => li.textContent),
  ).toEqual(["Planning now.", "Also summarize the notes"]);
  expect(within(turn).getByTestId("tree-leaf-reasoning").textContent).toBe(
    "Reasoning: Need a plan first",
  );
  expect(turn.textContent).not.toContain("Not this turn");
  const labels = screen.getAllByTestId("tree-node-label").map((label) => label.textContent);
  expect(labels[2]).toBe("Plan");
  expect(labels[3]).toBe("Agent");
  // The child's call_mock_3 is the child session's: the parent's cell with that id does not join.
  expect(labels[7]).toBe("contact_supervisor");
  expect(labels[4]).toBe("Summarize the notes.");
  // Chips on the turn and the run; none on a tool call or the checkpoint.
  const ownChip = (index: number) =>
    within(nodes[index]!.querySelector("summary, div")! as HTMLElement).queryByTestId(
      "tree-node-status",
    );
  expect(ownChip(0)).not.toBeNull();
  expect(ownChip(4)).not.toBeNull();
  expect(ownChip(2)).toBeNull();
  expect(ownChip(3)).toBeNull();
  expect(ownChip(8)).toBeNull();
  // The fork is a link row, not a nested session.
  expect(screen.getByTestId("tree-fork").textContent).toBe("Forked to Fork title");
  expect(nodes.some((node) => node.getAttribute("data-type") === "session")).toBe(false);
});

it("pulls from the cursor when the project log advances", async () => {
  served = recorded.slice(0, 3);
  render(<NodeTreeView />);
  await waitFor(() => expect(screen.getAllByTestId("tree-node")).toHaveLength(1));
  served = recorded;
  act(() =>
    useAppStore.setState({
      projectLog: { projectId: null, logId: "log", lastSeq: 12, events: [] },
    }),
  );
  await waitFor(() => expect(screen.getAllByTestId("tree-node")).toHaveLength(9));
  expect(String(fetchMock.mock.calls.at(-1)![0])).toContain(`afterSeq=${recorded[2]!.seq}`);
});

it("says so when the log has nothing for the session", async () => {
  served = [];
  render(<NodeTreeView />);
  await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  expect(screen.getByTestId("node-tree").textContent).toContain("No recorded activity");
});

it("A7: a verifier run sits under its producer, which shows the verdict chip with the reason", async () => {
  const at = (seq: number, kind: string, id: string, run: object, parent?: object) =>
    ({
      v: 1,
      id: `a7-${seq}`,
      seq,
      ts: "2026-10-15T00:00:00.000Z",
      logId: "log",
      kind,
      projectId: null,
      sessionId: SESSION,
      subject: { type: "subagentRun", id },
      ...(parent ? { parent } : {}),
      actor: { type: "system" },
      payload: {
        run: {
          id,
          parentSessionId: SESSION,
          createdAt: "2026-10-15T00:00:00.000Z",
          updatedAt: "2026-10-15T00:00:00.000Z",
          ...run,
        },
      },
    }) as EventEnvelope;
  const verdict = { decision: "REJECT", reason: "no tests", verifierRunId: "verifier" };
  served = [
    at(1, "subagent.run.created", "producer", { task: "Build it", status: "completed" }),
    at(
      2,
      "subagent.run.created",
      "verifier",
      { task: "verify: Build it", status: "completed", role: "verify", targetRunId: "producer" },
      { type: "subagentRun", id: "producer" },
    ),
    at(3, "subagent.run.verified", "producer", { task: "Build it", status: "completed", verdict }),
  ];
  render(<NodeTreeView />);
  const producer = await waitFor(() => {
    const node = screen
      .getAllByTestId("tree-node")
      .find((row) => row.getAttribute("data-type") === "subagentRun");
    expect(node).toBeDefined();
    return node!;
  });
  expect(within(producer).getAllByTestId("tree-node-label")[0]!.textContent).toBe("Build it");
  expect(within(producer).getByTestId("verdict-chip").textContent).toBe("Rejected");
  expect(within(producer).getByTestId("verdict-reason").textContent).toBe("no tests");
  // The verifier is the producer's child row.
  const nested = within(producer)
    .getAllByTestId("tree-node")
    .map((row) => within(row).getAllByTestId("tree-node-label")[0]!.textContent);
  expect(nested).toEqual(["verify: Build it"]);
});

it("A8: shows open human nodes first and who answered the settled ones", async () => {
  const ale = { type: "user" as const, id: "ale@example.com", name: "Ale" };
  const at = new Date("2026-10-15T10:00:00.000Z");
  const envelope = (seq: number, draft: EventDraft): EventEnvelope => ({
    v: 1,
    id: `human-${seq}`,
    seq,
    ts: at.toISOString(),
    logId: "log",
    projectId: null,
    ...draft,
  });
  const ask = (id: string, question: string) => ({
    ...humanFromAskUser({ requestId: id, sessionId: SESSION, question, options: [] }),
    parent: { type: "session" as const, id: SESSION },
  });
  served = [
    ...recorded,
    envelope(30, humanRequestedDraft(ask("ask-1", "Ship the release?"), at)),
    envelope(31, humanAnsweredDraft(ask("ask-1", ""), ale, "Ship")),
    envelope(32, humanRequestedDraft(ask("ask-2", "Which region?"), at)),
  ];
  render(<NodeTreeView />);
  await waitFor(() => expect(screen.getByTestId("open-human-nodes")).toBeTruthy());
  const tree = screen.getByTestId("node-tree");
  // The waiting list comes before the tree itself.
  expect(tree.firstElementChild).toBe(screen.getByTestId("open-human-nodes"));
  const waiting = within(screen.getByTestId("open-human-nodes")).getAllByTestId("tree-node");
  expect(waiting.map((row) => row.textContent)).toEqual([expect.stringContaining("Which region?")]);
  expect(waiting[0]!.getAttribute("data-status")).toBe("pending");
  const outcomes = screen.getAllByTestId("human-outcome").map((span) => span.textContent);
  expect(outcomes).toContain("Answered by Ale: Ship");
  expect(outcomes).toContain("Question: waiting on a person");
});

it("A8: a supervisor request's row gives way to its human node", async () => {
  const request = recorded.find((event) => event.subject.type === "supervisorRequest")!;
  const human = humanRequestedDraft(
    humanFromSupervisor(
      {
        id: request.subject.id,
        parentSessionId: SESSION,
        cellId: request.parent!.id,
        message: "Pick",
      },
      "child",
    ),
    new Date(request.ts),
  );
  served = [...recorded, { ...request, ...human, id: "human-dup", seq: 40, projectId: null }];
  render(<NodeTreeView />);
  await waitFor(() => expect(screen.getAllByTestId("tree-node").length).toBeGreaterThan(0));
  const types = screen.getAllByTestId("tree-node").map((node) => node.getAttribute("data-type"));
  expect(types).not.toContain("supervisorRequest");
  expect(types).toContain("human");
});
