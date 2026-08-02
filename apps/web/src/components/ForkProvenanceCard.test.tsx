// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionMeta } from "@agent-deck/contracts";
import { useAppStore } from "../state/store.ts";
import { ForkProvenanceCard } from "./ForkProvenanceCard.tsx";

const switchToSession = vi.fn();
vi.mock("../state/wsBridge.ts", () => ({
  switchToSession: (session: SessionMeta) => switchToSession(session),
}));

const source: SessionMeta = { id: "source", cwd: "/tmp", createdAt: "now", title: "Renamed later" };
const target = (
  overrides: Partial<NonNullable<SessionMeta["forkProvenance"]>> = {},
): SessionMeta => ({
  id: "target",
  cwd: "/tmp",
  createdAt: "later",
  forkProvenance: {
    version: 1,
    sourceSessionId: "source",
    sourceEntryId: "stable-user-entry",
    sourceTitle: "Captured source title",
    recap: "User:\nEarlier prompt\n\nAssistant:\nEarlier answer",
    recapTruncated: false,
    ...overrides,
  },
});

beforeEach(() => {
  useAppStore.setState({ sessions: [source, target()] });
});
afterEach(() => {
  cleanup();
  switchToSession.mockClear();
});

describe("ForkProvenanceCard", () => {
  it("shows the captured title and reopens an available immediate source", () => {
    render(<ForkProvenanceCard session={target()} />);
    expect(screen.getByText("Forked from “Captured source title”")).toBeTruthy();
    expect(screen.queryByText(/Renamed later/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(switchToSession).toHaveBeenCalledWith(source);
  });

  it("honestly keeps recap access when the source was deleted", () => {
    useAppStore.setState({ sessions: [target()] });
    render(<ForkProvenanceCard session={target()} />);
    expect(screen.getByText("Source chat is no longer available.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open source" })).toBeNull();
    expect(screen.getByRole("button", { name: "View recap" })).toBeTruthy();
  });

  it("opens a trapped accessible long/empty/truncated dialog and restores focus on Escape", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    render(<ForkProvenanceCard session={target({ recap: "", recapTruncated: true })} />);
    const trigger = screen.getByRole("button", { name: "View recap" });
    trigger.focus();
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Inherited conversation recap" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Close inherited conversation recap" })).toBe(
        document.activeElement,
      ),
    );
    expect(
      screen.getByText("Earlier conversation was omitted to keep this recap bounded."),
    ).toBeTruthy();
    expect(screen.getByText("No earlier conversation was inherited.")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(trigger).toBe(document.activeElement);
    opener.remove();
  });

  it("ignores malformed or unsupported future metadata without crashing", () => {
    const malformed = {
      ...target(),
      forkProvenance: { version: 2, sourceTitle: 42 },
    } as unknown as SessionMeta;
    const { container } = render(<ForkProvenanceCard session={malformed} />);
    expect(container.childElementCount).toBe(0);
  });
});
