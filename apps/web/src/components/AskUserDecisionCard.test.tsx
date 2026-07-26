// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AskUserCell } from "@agent-deck/domain";
import { sendAskUserAnswer } from "@/state/wsBridge";
import { AskUserDecisionCard } from "./AskUserDecisionCard.tsx";

vi.mock("@/state/wsBridge", () => ({
  sendAskUserAnswer: vi.fn(),
  sendAskUserCancel: vi.fn(),
}));

const pending: AskUserCell = {
  kind: "ask_user",
  id: "ask-user-r1",
  requestId: "r1",
  sessionId: "s1",
  question: "Which release path?",
  context: "Choose based on risk.",
  options: [{ title: "Safe", description: "Run all checks" }, { title: "Fast" }],
  allowMultiple: true,
  allowFreeform: true,
  allowComment: true,
  status: "pending",
};

const answerMock = vi.mocked(sendAskUserAnswer);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AskUserDecisionCard", () => {
  it("keeps multi-select and freeform mutually exclusive and retries a valid payload", async () => {
    answerMock.mockRejectedValueOnce(new Error("retry me")).mockResolvedValueOnce(undefined);
    render(<AskUserDecisionCard cell={pending} />);

    const safe = screen.getByRole("checkbox", { name: /Safe/ });
    const fast = screen.getByRole("checkbox", { name: /Fast/ });
    const freeform = screen.getByLabelText("Or write your own answer");
    const answer = screen.getByRole("button", { name: "Answer" });

    // Multiple offered choices -> freeform: typing the alternative clears all choices.
    fireEvent.click(safe);
    fireEvent.click(fast);
    expect((safe as HTMLInputElement).checked).toBe(true);
    expect((fast as HTMLInputElement).checked).toBe(true);
    fireEvent.change(freeform, { target: { value: "A staged rollout" } });
    expect((safe as HTMLInputElement).checked).toBe(false);
    expect((fast as HTMLInputElement).checked).toBe(false);

    fireEvent.click(answer);
    await waitFor(() => expect(answerMock).toHaveBeenCalledTimes(1));
    expect(answerMock).toHaveBeenLastCalledWith("s1", "r1", {
      selections: [],
      freeform: "A staged rollout",
    });
    await screen.findByText("retry me");

    // Freeform -> offered choice: selecting one clears the freeform alternative.
    fireEvent.click(safe);
    expect((freeform as HTMLTextAreaElement).value).toBe("");
    expect((safe as HTMLInputElement).checked).toBe(true);
    fireEvent.change(screen.getByLabelText("Optional comment"), {
      target: { value: "Approved after review" },
    });
    fireEvent.click(answer);

    await waitFor(() => expect(answerMock).toHaveBeenCalledTimes(2));
    expect(answerMock).toHaveBeenLastCalledWith("s1", "r1", {
      selections: ["Safe"],
      comment: "Approved after review",
    });
    await screen.findByText("Answer sent.");
  });

  it("does not steal focus when a new concurrent decision card mounts", () => {
    const composer = document.createElement("textarea");
    composer.setAttribute("aria-label", "Composer");
    document.body.append(composer);
    composer.focus();

    const { rerender } = render(
      <div>
        <AskUserDecisionCard cell={pending} />
      </div>,
    );
    expect(document.activeElement).toBe(composer);

    rerender(
      <div>
        <AskUserDecisionCard cell={pending} />
        <AskUserDecisionCard
          cell={{ ...pending, id: "ask-user-r2", requestId: "r2", question: "Second question" }}
        />
      </div>,
    );

    expect(document.activeElement).toBe(composer);
    expect(screen.getAllByTestId("ask-user-cell")).toHaveLength(2);
    expect(
      within(screen.getAllByTestId("ask-user-cell")[1]!).getByText("Second question"),
    ).not.toBeNull();
    composer.remove();
  });

  it("renders a resolved read-only audit state without subagent wording", () => {
    render(
      <AskUserDecisionCard
        cell={{ ...pending, status: "answered", answer: { selections: ["Safe"] } }}
      />,
    );
    expect(screen.getByTestId("ask-user-audit").textContent).toContain("Answered: Safe");
    expect(screen.queryByRole("button", { name: "Answer" })).toBeNull();
    expect(screen.getByTestId("ask-user-cell").textContent).not.toMatch(/subagent/i);
  });
});
