// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionMeta } from "@agent-deck/contracts";
import type { EventEnvelope } from "@agent-deck/domain";
import { useAppStore } from "../state/store.ts";
import { ActivityList } from "./ActivityList.tsx";

const switchToSession = vi.fn();
const refreshProjectLog = vi.fn(async () => {});
vi.mock("../state/wsBridge.ts", () => ({
  switchToSession: (session: SessionMeta) => switchToSession(session),
  refreshProjectLog: () => refreshProjectLog(),
}));

const session: SessionMeta = { id: "s1", cwd: "/tmp", createdAt: "now", title: "Fix the build" };
const event = (seq: number, overrides: Partial<EventEnvelope>): EventEnvelope => ({
  v: 1,
  id: `id-${seq}`,
  seq,
  ts: "2026-10-15T12:00:00.000Z",
  logId: "log-a",
  kind: "turn.prompted",
  projectId: "p1",
  subject: { type: "turn", id: "turn-1" },
  actor: { type: "system" },
  payload: {},
  ...overrides,
});

beforeEach(() => {
  useAppStore.setState({
    currentProjectId: "p1",
    sessions: [session],
    view: "skills",
    projectLog: {
      projectId: "p1",
      logId: "log-a",
      lastSeq: 3,
      events: [
        event(1, {
          sessionId: "s1",
          actor: { type: "user", id: "ale@example.com", name: "Ale" },
        }),
        event(3, {
          kind: "loop.run.started",
          subject: { type: "loopRun", id: "run-12345678" },
          actor: { type: "agent", sessionId: "s1", agentName: "builder" },
        }),
      ],
    },
  });
});
afterEach(() => {
  cleanup();
  switchToSession.mockClear();
  useAppStore.setState({ projectLog: null, currentProjectId: null, sessions: [] });
});

it("renders the open project's events newest first and fetches on mount", () => {
  render(<ActivityList />);
  expect(refreshProjectLog).toHaveBeenCalled();
  expect(screen.getByText("Activity (2)")).toBeTruthy();
  const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
  expect(rows[0]).toContain("builder");
  expect(rows[0]).toContain("loop.run.started");
  expect(rows[1]).toContain("Ale");
  expect(rows[1]).toContain("turn.prompted");
});

it("activates the session from a turn row and opens Loops from a loop row", () => {
  render(<ActivityList />);
  fireEvent.click(screen.getByRole("button", { name: "Fix the build" }));
  expect(switchToSession).toHaveBeenCalledWith(session);
  expect(useAppStore.getState().view).toBe("chat");
  fireEvent.click(screen.getByRole("button", { name: "loopRun run-1234" }));
  expect(useAppStore.getState().view).toBe("loops");
});

it("shows nothing from another project's log", () => {
  useAppStore.setState({ currentProjectId: "p2" });
  render(<ActivityList />);
  expect(screen.getByText("Activity (0)")).toBeTruthy();
});
