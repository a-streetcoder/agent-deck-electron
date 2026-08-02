// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionRow } from "./SessionsPanel.tsx";

afterEach(cleanup);

describe("SessionRow durable failure state", () => {
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
});
