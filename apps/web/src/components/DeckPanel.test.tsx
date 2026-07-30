// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { emptyTranscript, type SubagentCell } from "@agent-deck/domain";
import { afterEach, describe, expect, it } from "vitest";
import { useAppStore } from "../state/store.ts";
import { DeckPanel } from "./DeckPanel.tsx";

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
  useAppStore.setState({ transcript: emptyTranscript() });
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
