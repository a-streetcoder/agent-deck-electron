// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionMeta } from "@agent-deck/contracts";
import {
  humanAnsweredDraft,
  humanFromAskUser,
  humanFromLoopApproval,
  humanRequestedDraft,
  type EventEnvelope,
} from "@agent-deck/domain";
import { useAppStore } from "../state/store.ts";
import { ActivityList } from "./ActivityList.tsx";

const switchToSession = vi.fn();
const refreshProjectLog = vi.fn(async () => {});
vi.mock("../state/wsBridge.ts", () => ({
  switchToSession: (session: SessionMeta) => switchToSession(session),
  refreshProjectLog: () => refreshProjectLog(),
}));

const OLD_TS = "2020-01-02T03:04:00.000Z";
const session: SessionMeta = { id: "s1", cwd: "/tmp", createdAt: "now", title: "Fix the build" };
const event = (seq: number, overrides: Partial<EventEnvelope>): EventEnvelope => ({
  v: 1,
  id: `id-${seq}`,
  seq,
  ts: new Date().toISOString(),
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
      lastSeq: 4,
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
        event(4, {
          ts: OLD_TS,
          kind: "subagent.run.finished",
          sessionId: "s1",
          subject: { type: "subagentRun", id: "sub-1" },
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
  expect(screen.getByText("Activity (3)")).toBeTruthy();
  const rows = screen.getAllByRole("listitem").map((row) => row.textContent);
  expect(rows[0]).toContain("subagent.run.finished");
  // Not today: the date is shown.
  expect(rows[0]).toContain(
    new Date(OLD_TS).toLocaleString(undefined, { dateStyle: "short", timeStyle: "short" }),
  );
  expect(rows[1]).toContain("builder");
  expect(rows[1]).toContain("loop.run.started");
  expect(rows[2]).toContain("Ale");
  expect(rows[2]).toContain("turn.prompted");
});

it("links turn and subagent rows to their session, loop rows to the Loops view", () => {
  render(<ActivityList />);
  const sessionLinks = screen.getAllByRole("button", { name: "Fix the build" });
  expect(sessionLinks).toHaveLength(2);
  fireEvent.click(sessionLinks[0]!);
  expect(switchToSession).toHaveBeenCalledWith(session);
  expect(useAppStore.getState().view).toBe("chat");
  fireEvent.click(screen.getByRole("button", { name: "loopRun run-1234 (opens Loops)" }));
  expect(useAppStore.getState().view).toBe("loops");
});

it("shows nothing from another project's log", () => {
  useAppStore.setState({ currentProjectId: "p2" });
  render(<ActivityList />);
  expect(screen.getByText("Activity (0)")).toBeTruthy();
});

it("A8: lists open human requests first, outside the collapsed list, linked to where they are answered", () => {
  const ale = { type: "user" as const, id: "ale@example.com", name: "Ale" };
  const asked = (seq: number, draft: ReturnType<typeof humanRequestedDraft>) =>
    event(seq, { ...draft, projectId: "p1" } as Partial<EventEnvelope>);
  const ask = humanFromAskUser({
    requestId: "ask-1",
    sessionId: "s1",
    question: "Ship?",
    options: [],
  });
  useAppStore.setState({
    projectLog: {
      projectId: "p1",
      logId: "log-a",
      lastSeq: 8,
      events: [
        asked(
          5,
          humanRequestedDraft({ ...ask, parent: { type: "session", id: "s1" } }, new Date()),
        ),
        asked(
          6,
          humanRequestedDraft(
            humanFromLoopApproval({
              id: "run-1",
              checkpointPrompt: "Approve the release",
              projectId: "p1",
            }),
            new Date(),
          ),
        ),
        asked(
          7,
          humanRequestedDraft({ ...ask, id: "ask-2", prompt: "Already answered" }, new Date()),
        ),
        asked(8, humanAnsweredDraft({ id: "ask-2", sessionId: "s1" }, ale, "yes")),
      ],
    },
  });
  render(<ActivityList />);
  const waiting = screen.getByTestId("activity-waiting");
  // First in the panel, before the (collapsed) activity list.
  expect(waiting.nextElementSibling).toBe(screen.getByTestId("activity-list"));
  const rows = within(waiting)
    .getAllByTestId("activity-waiting-row")
    .map((row) => row.textContent);
  expect(rows).toEqual([
    expect.stringContaining("Ship?"),
    expect.stringContaining("Approve the release"),
  ]);
  expect(rows[0]).toContain("Question");
  expect(rows[1]).toContain("Loop approval");
  fireEvent.click(within(waiting).getByRole("button", { name: "Ship?" }));
  expect(switchToSession).toHaveBeenCalledWith(session);
  fireEvent.click(within(waiting).getByRole("button", { name: "Approve the release" }));
  expect(useAppStore.getState().view).toBe("loops");
  // The answer row in the list carries who answered.
  const answeredRow = screen.getByTestId("activity-8");
  expect(answeredRow.textContent).toContain("Ale");
  expect(answeredRow.textContent).toContain("human.answered");
});
