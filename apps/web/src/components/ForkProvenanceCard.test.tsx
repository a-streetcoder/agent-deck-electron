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
const target = (overrides: { text?: string; truncated?: boolean } = {}): SessionMeta => ({
  id: "target",
  cwd: "/tmp",
  createdAt: "later",
  provenance: {
    kind: "forked",
    from: { sessionId: "source", entryId: "stable-user-entry", title: "Captured source title" },
    by: {},
    at: "later",
    recap: {
      text: overrides.text ?? "User:\nEarlier prompt\n\nAssistant:\nEarlier answer",
      truncated: overrides.truncated ?? false,
    },
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
    render(<ForkProvenanceCard session={target({ text: "", truncated: true })} />);
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
      provenance: { kind: "forked", from: { title: 42 }, by: {}, at: "later" },
    } as unknown as SessionMeta;
    const { container } = render(<ForkProvenanceCard session={malformed} />);
    expect(container.childElementCount).toBe(0);
  });
});

describe("plain fork provenance (SRV-15b)", () => {
  const alice = { id: "alice@example.com", name: "Alice" };
  const plain: SessionMeta = {
    id: "plain",
    cwd: "/tmp",
    createdAt: "later",
    createdBy: { id: "bob@example.com" },
    provenance: {
      kind: "forked",
      from: { sessionId: "source", title: "Captured", owner: alice },
      by: { user: { id: "bob@example.com" } },
      at: "later",
    },
  };
  afterEach(() => useAppStore.setState({ me: null }));

  it("says whose session a plain fork copies and opens it", () => {
    render(<ForkProvenanceCard session={plain} />);
    expect(screen.getByTestId("fork-origin-line").textContent).toContain(
      "Forked from Alice's session “Captured”",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open source" }));
    expect(switchToSession).toHaveBeenCalledWith(source);
  });

  it("says 'your session' to the source owner, and names the owner on a message fork", () => {
    useAppStore.setState({
      me: { id: alice.id, email: alice.id },
      sessions: [{ ...source, createdBy: { id: "carol@example.com", name: "Carol" } }, plain],
    });
    render(<ForkProvenanceCard session={plain} />);
    expect(screen.getByTestId("fork-origin-line").textContent).toContain("your session");
    cleanup();
    render(<ForkProvenanceCard session={target()} />);
    expect(screen.getByText("Forked from Carol's session “Captured source title”")).toBeTruthy();
  });
});

describe("imported session origin (ADR 0006 provenance)", () => {
  it("says which device a moved conversation came from", () => {
    const imported: SessionMeta = {
      id: "imported",
      cwd: "/tmp",
      createdAt: "later",
      provenance: {
        kind: "imported",
        from: { device: "laptop", localSessionId: "local-1" },
        by: {},
        at: "later",
        mode: "conversation",
      },
    };
    render(<ForkProvenanceCard session={imported} />);
    expect(screen.getByTestId("shared-from-line").textContent).toBe(
      "Moved from laptop. Earlier edits from laptop are not in this workspace.",
    );
  });
});
