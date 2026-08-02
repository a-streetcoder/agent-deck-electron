// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@agent-deck/contracts";
import {
  emptyTranscript,
  type QuestionCell,
  type ToolCell,
  type UserCell,
} from "@agent-deck/domain";
import { DEFAULT_TRANSCRIPT_VISIBILITY } from "@agent-deck/contracts";
import { useAppStore } from "../state/store.ts";
import { Transcript } from "./Transcript.tsx";

vi.mock("./cells.tsx", () => ({
  CellView: ({ cell }: { cell: { id: string } }) => <div>cell {cell.id}</div>,
}));
vi.mock("./ForkProvenanceCard.tsx", () => ({ ForkProvenanceCard: () => null }));
vi.mock("./SessionPlanPanel.tsx", () => ({ SessionPlanPanel: () => null }));
vi.mock("./SessionStartupCard.tsx", () => ({ SessionStartupCard: () => null }));
vi.mock("./diff/OpenInPicker.tsx", () => ({ useOpenInEditor: () => ({}) }));

const session = (id: string): SessionMeta => ({
  id,
  cwd: "/tmp/project",
  createdAt: "2026-01-01T00:00:00.000Z",
  piSessionFile: `/tmp/${id}.jsonl`,
});
const question: QuestionCell = {
  kind: "question",
  id: "question-1",
  requestId: "request-1",
  method: "confirm",
  title: "Proceed?",
  answered: false,
};
const streamedCell: UserCell = { kind: "user", id: "streamed-1", text: "new session content" };
const webTool: ToolCell = {
  kind: "tool",
  id: "web-tool",
  toolCallId: "call-web",
  toolName: "web_search",
  args: { query: "test" },
  status: "done",
  result: "result",
};

const scrollIntoView = vi.fn();

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: scrollIntoView,
  });
  useAppStore.setState({
    session: session("one"),
    transcript: { ...emptyTranscript(), cells: [question] },
    lastSeq: 0,
    questionNavigationRequest: null,
    questionNavigationAnchorId: null,
    transcriptVisibility: { ...DEFAULT_TRANSCRIPT_VISIBILITY },
    transcriptVisibilityLoaded: true,
  });
});

afterEach(() => {
  cleanup();
  scrollIntoView.mockClear();
  useAppStore.setState({
    session: null,
    transcript: emptyTranscript(),
    lastSeq: 0,
    questionNavigationRequest: null,
    questionNavigationAnchorId: null,
    transcriptVisibility: { ...DEFAULT_TRANSCRIPT_VISIBILITY },
    transcriptVisibilityLoaded: false,
  });
});

describe("Transcript durable failure details", () => {
  it("renders long persisted error content with polite status semantics", () => {
    const detail = `Provider failure ${"detail ".repeat(400)}`;
    useAppStore.setState({
      session: { ...session("failed"), status: "failed", lastError: detail },
    });

    render(<Transcript />);

    const failure = screen.getByTestId("session-failure-details");
    expect(failure.getAttribute("role")).toBe("status");
    expect(failure.getAttribute("aria-live")).toBe("polite");
    expect(failure.textContent).toContain(detail);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Transcript question navigation", () => {
  it("removes hidden category cells without changing question navigation", () => {
    useAppStore.setState({
      transcript: { ...emptyTranscript(), cells: [webTool, question] },
      transcriptVisibility: {
        ...DEFAULT_TRANSCRIPT_VISIBILITY,
        showWebActivity: false,
      },
      transcriptVisibilityLoaded: true,
    });

    render(<Transcript />);

    expect(screen.queryByText("cell web-tool")).toBeNull();
    expect(screen.getByText("cell question-1")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Pending question, 1 of 1" })).toBeTruthy();
  });

  it("restores bottom-follow when the session changes after programmatic navigation", async () => {
    render(<Transcript />);
    const target = screen.getByRole("group", { name: "Pending question, 1 of 1" });

    act(() => useAppStore.getState().requestQuestionNavigation("previous", "one"));
    await waitFor(() => expect(document.activeElement).toBe(target));
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });

    act(() => {
      useAppStore.getState().setSession(session("two"));
      useAppStore.getState().setTranscript(emptyTranscript(), 0);
    });
    await waitFor(() => expect(useAppStore.getState().questionNavigationAnchorId).toBeNull());
    scrollIntoView.mockClear();

    act(() => {
      useAppStore.getState().setTranscript({ ...emptyTranscript(), cells: [streamedCell] }, 1);
    });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "end" }));
  });
});
