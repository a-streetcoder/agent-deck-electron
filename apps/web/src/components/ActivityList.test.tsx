// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SessionMeta } from "@agent-deck/contracts";
import {
  humanAnsweredDraft,
  humanFromAskUser,
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

it("A8: lists the server's open human requests first, outside the collapsed list, linked to where they are answered", async () => {
  const ale = { type: "user" as const, id: "ale@example.com", name: "Ale" };
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
    Response.json({
      logId: "log-a",
      requests: [
        {
          id: "ask-1",
          kind: "askUser",
          prompt: "Ship?\n\ncontext",
          timeoutPolicy: { type: "none" },
          projectId: "p1",
          sessionId: "s1",
          actor: { type: "agent", sessionId: "s1", agentName: "builder" },
          requestedAt: "2026-10-15T10:00:00.000Z",
        },
        {
          // Far older than the tail: the server reads the whole log.
          id: "run-1",
          kind: "loopApproval",
          prompt: "Approve the release",
          timeoutPolicy: { type: "none" },
          projectId: "p1",
          actor: { type: "system" },
          requestedAt: "2026-09-01T10:00:00.000Z",
        },
      ],
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  useAppStore.setState({
    projectLog: {
      projectId: "p1",
      logId: "log-a",
      lastSeq: 8,
      events: [
        event(7, {
          ...humanRequestedDraft(
            humanFromAskUser({
              requestId: "ask-2",
              sessionId: "s1",
              question: "Done?",
              options: [],
            }),
            new Date(),
          ),
          projectId: "p1",
        } as Partial<EventEnvelope>),
        event(8, {
          ...humanAnsweredDraft({ id: "ask-2", sessionId: "s1" }, ale, "yes"),
          projectId: "p1",
        } as Partial<EventEnvelope>),
      ],
    },
  });
  render(<ActivityList />);
  await waitFor(() => expect(screen.getByTestId("activity-waiting")).toBeTruthy());
  expect(String(fetchMock.mock.calls[0]![0])).toBe("/events/open-human?projectId=p1");
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
  expect(rows[0]).toContain("builder");
  expect(rows[1]).toContain("Loop approval");
  fireEvent.click(within(waiting).getByRole("button", { name: "Ship?" }));
  expect(switchToSession).toHaveBeenCalledWith(session);
  fireEvent.click(within(waiting).getByRole("button", { name: "Approve the release" }));
  expect(useAppStore.getState().view).toBe("loops");
  // The answer row in the list carries who answered.
  const answeredRow = screen.getByTestId("activity-8");
  expect(answeredRow.textContent).toContain("Ale");
  expect(answeredRow.textContent).toContain("human.answered");
  // A project log nudge refetches.
  act(() =>
    useAppStore.setState({ projectLog: { ...useAppStore.getState().projectLog!, lastSeq: 9 } }),
  );
  await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  vi.unstubAllGlobals();
});

it("A8: hides server-wide restart and takeover rows from the activity rows", () => {
  useAppStore.setState({
    projectLog: {
      projectId: "p1",
      logId: "log-a",
      lastSeq: 11,
      events: [
        event(9, { sessionId: "s1" }),
        event(10, {
          kind: "writer.acquired",
          projectId: null,
          subject: { type: "server", id: "y" },
        }),
        event(11, {
          kind: "server.started",
          projectId: null,
          subject: { type: "server", id: "x" },
        }),
      ],
    },
  });
  render(<ActivityList />);
  expect(screen.getByText("Activity (1)")).toBeTruthy();
  expect(screen.queryByTestId("activity-10")).toBeNull();
  expect(screen.queryByTestId("activity-11")).toBeNull();
});

it("SRV-15b: a fork's session.created row says who forked whose session", () => {
  const bob = { type: "user" as const, id: "bob@example.com", name: "Bob" };
  useAppStore.setState({
    sessions: [
      { ...session, createdBy: { id: "ale@example.com", name: "Ale" } },
      {
        id: "s2",
        cwd: "/tmp",
        createdAt: "now",
        title: "Fix the build (fork)",
        forkedFrom: {
          sessionId: "s1",
          title: "Fix the build",
          owner: { id: "ale@example.com", name: "Ale" },
        },
      },
    ],
    projectLog: {
      projectId: "p1",
      logId: "log-a",
      lastSeq: 5,
      events: [
        event(5, {
          kind: "session.created",
          sessionId: "s2",
          subject: { type: "session", id: "s2" },
          parent: { type: "session", id: "s1" },
          actor: bob,
        }),
      ],
    },
  });
  render(<ActivityList />);
  const row = screen.getByTestId("activity-5");
  expect(row.textContent).toContain("Bob");
  expect(within(row).getByTestId("activity-forked-from").textContent).toBe(
    "forked from Ale's session “Fix the build”",
  );
});

it("SRV-15b: the member chip shows that member's rows only (acted, or in their session)", () => {
  useAppStore.setState({
    sessions: [{ ...session, createdBy: { id: "bob@example.com" } }],
  });
  render(<ActivityList member="bob@example.com" />);
  // Ale's prompt is hers; the agent and system rows ran in Bob's session.
  expect(screen.getByText("Activity (2)")).toBeTruthy();
  expect(screen.queryByText("turn.prompted")).toBeNull();
});
