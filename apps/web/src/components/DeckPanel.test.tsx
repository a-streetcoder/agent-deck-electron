// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emptyTranscript, parseEventLine, splitJsonl, type SubagentCell } from "@agent-deck/domain";
import { afterEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/store.ts";
import { DeckPanel } from "./DeckPanel.tsx";
// The A1b recorded plan log: one managed_subagent run that sends one progress update.
import planLog from "../../../../packages/domain/test/fixtures/events/plan.jsonl?raw";

const cell = (overrides: Partial<SubagentCell> = {}): SubagentCell => ({
  kind: "subagent",
  id: "run-id",
  task: "A durable task",
  status: "interrupted",
  text: "partial result",
  error: "Disconnected during restart.",
  progress: [],
  ...overrides,
});

function renderDeck(run: SubagentCell): void {
  useAppStore.setState({
    transcript: { ...emptyTranscript(), cells: [run] },
  });
  render(<DeckPanel />);
}

afterEach(() => {
  cleanup();
  useAppStore.setState({ transcript: emptyTranscript(), session: null, projectLog: null });
});

describe("Deck durable subagent runs", () => {
  it("labels interrupted and stopped independently from failed", () => {
    renderDeck(cell());
    expect(screen.getByText("Interrupted")).toBeTruthy();
    cleanup();
    renderDeck(cell({ status: "stopped", error: "Stopped by parent." }));
    expect(screen.getByText("Stopped")).toBeTruthy();
  });

  it("expands once when a terminal row resumes, then respects collapse during streaming", () => {
    const terminal = cell({ status: "done", error: undefined });
    renderDeck(terminal);
    const row = screen.getByTestId("deck-run");
    const toggle = screen.getByTestId("deck-run-toggle");
    expect(row.getAttribute("data-expanded")).toBe("false");

    act(() => {
      useAppStore.setState({
        transcript: {
          ...emptyTranscript(),
          cells: [{ ...terminal, status: "running", task: "Follow-up", text: "live" }],
        },
      });
    });
    expect(row.getAttribute("data-expanded")).toBe("true");
    fireEvent.click(toggle);
    expect(row.getAttribute("data-expanded")).toBe("false");

    act(() => {
      useAppStore.setState({
        transcript: {
          ...emptyTranscript(),
          cells: [{ ...terminal, status: "running", task: "Follow-up", text: "live delta" }],
        },
      });
    });
    expect(row.getAttribute("data-expanded")).toBe("false");
  });

  it("shows partial output with the failure reason and focusable clipped regions", () => {
    const task = "long task ".repeat(10_000);
    const output = "partial output ".repeat(10_000);
    renderDeck(cell({ task, text: output }));
    fireEvent.click(screen.getByTestId("deck-run-toggle"));

    expect(screen.getByRole("alert").textContent).toBe("Disconnected during restart.");
    const taskRegion = screen.getByTestId("deck-run-task");
    const outputRegion = screen.getByTestId("deck-run-output");
    expect(taskRegion.getAttribute("tabindex")).toBe("0");
    expect(outputRegion.getAttribute("tabindex")).toBe("0");
    expect(taskRegion.textContent).toBe(task);
    expect(outputRegion.textContent).toBe(output);
    taskRegion.focus();
    expect(document.activeElement).toBe(taskRegion);
  });
});

describe("Deck data source", () => {
  const SESSION = "00000000-0000-4000-8000-000000000005";
  const RUN = "00000000-0000-4000-8000-000000000009";
  const events = splitJsonl(planLog).lines.map((line) => parseEventLine(line)!);
  const setLog = (sessionId: string): void =>
    useAppStore.setState({
      session: { id: sessionId, cwd: "/tmp", createdAt: "now" },
      projectLog: { projectId: null, logId: "log", lastSeq: 13, events },
    });

  it("reads the rows from the event-log tree and the detail from the transcript", () => {
    setLog(SESSION);
    // The transcript cell is stale (still running, no progress): the tree wins for the row.
    renderDeck(cell({ id: RUN, status: "running", task: "Transcript task", error: undefined }));
    const row = screen.getByTestId("deck-run");
    expect(row.getAttribute("data-status")).toBe("done");
    expect(row.textContent).toContain("Summarize the notes.");
    expect(row.textContent).toContain("1 update(s)");
    fireEvent.click(screen.getByTestId("deck-run-toggle"));
    expect(screen.getByTestId("deck-run-task").textContent).toBe("Transcript task");
  });

  it("falls back to the transcript when the log has no runs for the session", () => {
    setLog("another-session");
    renderDeck(cell({ status: "running", task: "Transcript task" }));
    expect(screen.getByTestId("deck-run").getAttribute("data-status")).toBe("running");
    expect(screen.getByTestId("deck-run").textContent).toContain("Transcript task");
  });
});
