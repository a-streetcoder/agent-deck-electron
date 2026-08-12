// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { FinalSystemPromptButton } from "./FinalSystemPromptDialog.tsx";

const session = {
  id: "prompt-session",
  cwd: "/tmp/project",
  createdAt: "2026-08-01T10:00:00.000Z",
};

describe("FinalSystemPromptButton", () => {
  afterEach(cleanup);

  beforeEach(() => {
    useAppStore.setState({ session, sessions: [session] });
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockResolvedValue(undefined) },
    });
  });

  it("is absent before capture", () => {
    render(<FinalSystemPromptButton />);
    expect(screen.queryByRole("button", { name: "View final system prompt" })).toBeNull();
  });

  it("opens a trapped read-only large-content dialog, copies, Escapes, and restores focus", async () => {
    const text = `launch instruction\n${"memory augmentation ".repeat(10_000)}`;
    useAppStore.setState({
      session: {
        ...session,
        finalSystemPromptAudit: { text, capturedAt: "2026-08-01T10:02:03.000Z" },
      },
    });
    render(<FinalSystemPromptButton />);
    const opener = screen.getByRole("button", { name: "View final system prompt" });
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByRole("dialog", { name: "Final system prompt" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const scroller = screen.getByTestId("final-system-prompt-content");
    expect(scroller.textContent).toBe(text);
    expect(scroller.getAttribute("tabindex")).toBe("0");
    expect(scroller.className).toContain("focus-visible:ring-2");
    expect(opener.className).toContain("[-webkit-app-region:no-drag]");
    expect(dialog.parentElement?.className).toContain("[-webkit-app-region:no-drag]");
    expect(dialog.textContent).toContain("not synced");
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close final system prompt" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Copy final system prompt" }));
    await waitFor(() => expect(navigator.clipboard.writeText).toHaveBeenCalledWith(text));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("updates an already-open dialog when a newer turn is captured", () => {
    useAppStore.setState({
      session: {
        ...session,
        finalSystemPromptAudit: { text: "turn one", capturedAt: "2026-08-01T10:02:03.000Z" },
      },
    });
    render(<FinalSystemPromptButton />);
    fireEvent.click(screen.getByRole("button", { name: "View final system prompt" }));
    expect(screen.getByTestId("final-system-prompt-content").textContent).toBe("turn one");

    act(() => {
      useAppStore.getState().upsertSessionMeta({
        ...session,
        finalSystemPromptAudit: {
          text: "turn two exact",
          capturedAt: "2026-08-01T10:03:04.000Z",
        },
      });
    });
    expect(screen.getByTestId("final-system-prompt-content").textContent).toBe("turn two exact");
    expect(screen.getByRole("time").getAttribute("datetime")).toBe("2026-08-01T10:03:04.000Z");
    expect(screen.getByRole("status").textContent).toBe(
      "A newer final system prompt was captured.",
    );
    expect(screen.getByRole("status").textContent).not.toContain("turn two exact");
  });

  it("renders an explicitly captured empty prompt and reports copy failure", async () => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    useAppStore.setState({
      session: {
        ...session,
        finalSystemPromptAudit: { text: "", capturedAt: "not-a-date" },
      },
    });
    render(<FinalSystemPromptButton />);
    fireEvent.click(screen.getByRole("button", { name: "View final system prompt" }));
    expect(screen.getByText("Pi used an empty system prompt for this turn.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy final system prompt" }));
    expect((await screen.findByRole("status")).textContent).toContain("Could not copy");
  });
});
