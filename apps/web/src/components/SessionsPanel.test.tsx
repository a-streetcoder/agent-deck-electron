// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { SessionRow, SessionsCollapsedCard } from "./SessionsPanel.tsx";

afterEach(cleanup);

describe("SessionRow parked status", () => {
  it("presents parked as resumable rather than ended", () => {
    render(
      <SessionRow
        session={{
          id: "parked",
          cwd: "/tmp",
          createdAt: "2026-01-01T00:00:00.000Z",
          parkedAt: "2026-01-01T00:10:00.000Z",
        }}
        displayTitle="Parked chat"
        active={false}
        running={false}
        detailed
        onSelect={vi.fn()}
      />,
    );
    const row = screen.getByTestId("chat-parked");
    expect(row.getAttribute("data-status")).toBe("parked");
    expect(row.getAttribute("aria-label")).toContain("resumes on next command");
    expect(screen.getByTestId("chat-parked-parked").textContent).toContain("Parked");
  });
});

describe("SessionRow durable failure state", () => {
  it("gives failure precedence over stale parked evidence", () => {
    render(
      <SessionRow
        session={{
          id: "failed-parked",
          cwd: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          parkedAt: "2026-01-01T00:01:00.000Z",
          status: "failed",
          lastError: "Provider failed",
        }}
        displayTitle="Failed parked chat"
        active={false}
        running={false}
        onSelect={vi.fn()}
      />,
    );
    const row = screen.getByTestId("chat-failed-parked");
    expect(row.getAttribute("data-status")).toBe("failed");
    expect(row.getAttribute("aria-label")).toContain("failed: Provider failed");
    expect(screen.queryByTestId("chat-parked-failed-parked")).toBeNull();
  });

  it("shows an accessible failure icon/subtitle without ordinary-ended dimming", () => {
    render(
      <SessionRow
        session={{
          id: "failed-session",
          cwd: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:01:00.000Z",
          status: "failed",
          lastError: "Provider authentication failed",
        }}
        displayTitle="Broken chat"
        active={false}
        running={false}
        detailed
        onSelect={vi.fn()}
      />,
    );

    const row = screen.getByTestId("chat-failed-session");
    expect(row.getAttribute("data-status")).toBe("failed");
    expect(row.getAttribute("aria-label")).toContain(
      "Broken chat, failed: Provider authentication failed",
    );
    expect(row.className).not.toContain("opacity-60");
    expect(screen.getByTestId("chat-failure-subtitle").textContent).toBe(
      "Failed · Provider authentication failed",
    );
  });

  it("shows durable attention with icon, text, and accessible row state", () => {
    render(
      <SessionRow
        session={{
          id: "pending-session",
          cwd: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:01:00.000Z",
          needsAttention: true,
        }}
        displayTitle="Unseen chat"
        active={false}
        running={false}
        onSelect={vi.fn()}
      />,
    );

    const row = screen.getByTestId("chat-pending-session");
    expect(row.getAttribute("aria-label")).toContain("Unseen chat, needs attention");
    expect(row.getAttribute("data-needs-attention")).toBe("true");
    expect(row.className).not.toContain("opacity-60");
    expect(screen.getByTestId("chat-attention-pending-session").textContent).toBe(
      "Needs attention",
    );
  });

  it("keeps failure detail primary while also exposing durable attention", () => {
    render(
      <SessionRow
        session={{
          id: "failed-pending",
          cwd: "/tmp/project",
          createdAt: "2026-01-01T00:00:00.000Z",
          status: "failed",
          lastError: "Provider unavailable",
          needsAttention: true,
        }}
        displayTitle="Failed pending chat"
        active={false}
        running={false}
        onSelect={vi.fn()}
      />,
    );

    const row = screen.getByTestId("chat-failed-pending");
    expect(row.getAttribute("aria-label")).toBe(
      "Failed pending chat, failed: Provider unavailable, needs attention",
    );
    expect(screen.getByTestId("chat-failure-subtitle").textContent).toContain(
      "Failed · Provider unavailable",
    );
    const failure = screen.getByTestId("chat-failure-subtitle");
    const attention = screen.getByTestId("chat-attention-failed-pending");
    expect(attention).toBeTruthy();
    expect(
      failure.compareDocumentPosition(attention) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe("SessionsCollapsedCard", () => {
  it("lists newest sessions across all projects and exposes selected-chat status", () => {
    useAppStore.setState({
      panelExpanded: false,
      connection: "open",
      currentProjectId: null,
      session: null,
      projects: [
        { id: "p1", name: "Alpha", path: "/alpha", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: "p2", name: "Beta", path: "/beta", createdAt: "2026-01-01T00:00:00.000Z" },
      ],
      sessions: [
        {
          id: "a",
          projectId: "p1",
          cwd: "/alpha",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-02T00:00:00.000Z",
        },
        {
          id: "b",
          projectId: "p2",
          cwd: "/beta",
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-03T00:00:00.000Z",
        },
      ],
    });
    render(<SessionsCollapsedCard onExpand={vi.fn()} />);
    expect(screen.getByTestId("chat-a")).toBeTruthy();
    expect(screen.getByTestId("chat-b")).toBeTruthy();
    expect(screen.getByTestId("status-indicator").getAttribute("data-status")).toBe("idle");
  });
});
