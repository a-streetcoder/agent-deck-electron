// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { SessionRow, SessionsMainPanel } from "./SessionsPanel.tsx";

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

describe("SessionsMainPanel", () => {
  it("lists sessions from every project and exposes the selected-chat status", () => {
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
    render(<SessionsMainPanel />);
    expect(screen.getByTestId("chat-a")).toBeTruthy();
    expect(screen.getByTestId("chat-b")).toBeTruthy();
    expect(screen.getByTestId("status-indicator").getAttribute("data-status")).toBe("idle");
  });
});

describe("SessionRow fork action (SRV-15a)", () => {
  it("says the fork shares another member's checkout", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const alice = { id: "alice@example.com", name: "Alice" };
    const owner = {
      id: "wt",
      cwd: "/wt",
      createdAt: at,
      worktreePath: "/wt",
      piSessionFile: "/w.jsonl",
      createdBy: alice,
    };
    const fork = {
      id: "fork",
      cwd: "/wt",
      createdAt: at,
      worktreeOwnerSessionId: "wt",
      piSessionFile: "/f.jsonl",
    };
    const plain = { id: "plain", cwd: "/tmp", createdAt: at, piSessionFile: "/p.jsonl" };
    useAppStore.setState({
      sessions: [owner, fork, plain],
      me: { id: "bob@example.com", email: "bob@example.com" },
    });
    try {
      for (const session of [owner, fork, plain]) {
        render(
          <SessionRow
            session={session}
            displayTitle={session.id}
            active={false}
            running={false}
            onSelect={vi.fn()}
          />,
        );
      }
      expect(screen.getByTestId("chat-fork-fork").getAttribute("title")).toContain(
        "shares Alice's checkout",
      );
      expect(screen.getByTestId("chat-fork-wt").getAttribute("title")).toContain(
        "shares Alice's checkout",
      );
      expect(screen.getByTestId("chat-fork-plain").getAttribute("title")).toBe("Duplicate");
      // The checkout owner sees a plain duplicate.
      cleanup();
      useAppStore.setState({ me: { id: alice.id, email: alice.id } });
      render(
        <SessionRow
          session={fork}
          displayTitle="fork"
          active={false}
          running={false}
          onSelect={vi.fn()}
        />,
      );
      expect(screen.getByTestId("chat-fork-fork").getAttribute("title")).toBe("Duplicate");
    } finally {
      useAppStore.setState({ sessions: [], me: null });
    }
  });
});

describe("SessionRow fork action on Loop sessions (SRV-15a)", () => {
  it("disables the fork with the server's refusal reason", () => {
    const at = "2026-01-01T00:00:00.000Z";
    const sessions = [
      { id: "review", cwd: "/r", createdAt: at, piSessionFile: "/r.jsonl", loopReviewRunId: "run" },
      { id: "parent", cwd: "/p", createdAt: at, piSessionFile: "/p.jsonl", agentName: "Loop · x" },
    ];
    for (const session of sessions) {
      render(
        <SessionRow
          session={session}
          displayTitle={session.id}
          active={false}
          running={false}
          onSelect={vi.fn()}
        />,
      );
      const button = screen.getByTestId(`chat-fork-${session.id}`);
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(button.getAttribute("title")).toContain("A Loop session cannot be forked");
    }
  });
});

describe("SRV-15b: status, member chips and links", () => {
  const at = "2026-01-01T00:00:00.000Z";
  const alice = { id: "alice@example.com", name: "Alice" };
  const bob = { id: "bob@example.com", name: "Bob" };
  const rows = [
    { id: "a1", cwd: "/a", createdAt: at, createdBy: alice, activity: "running" as const },
    { id: "a2", cwd: "/a", createdAt: at, createdBy: alice, activity: "needsInput" as const },
    { id: "b1", cwd: "/b", createdAt: at, createdBy: bob, parkedAt: at },
  ];
  const turn = (
    seq: number,
    actor: { type: "user"; id: string } | { type: "system" },
    sessionId: string,
  ) => ({
    v: 1 as const,
    id: `e${seq}`,
    seq,
    ts: at,
    logId: "log",
    kind: "turn.prompted",
    projectId: null,
    sessionId,
    subject: { type: "turn", id: `t${seq}` },
    actor,
    payload: {},
  });
  const show = (sessions: typeof rows) => {
    useAppStore.setState({
      connection: "open",
      currentProjectId: null,
      session: null,
      projects: [],
      sessions,
      projectLog: {
        projectId: null,
        logId: "log",
        lastSeq: 2,
        events: [turn(1, { type: "user", id: alice.id }, "a1"), turn(2, { type: "system" }, "b1")],
      },
    });
    render(<SessionsMainPanel />);
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    useAppStore.setState({ sessions: [], projectLog: null, me: null });
  });

  it("puts a status dot on every row, not only the open one", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    show(rows);
    expect(screen.getByTestId("chat-activity-a1").getAttribute("data-activity")).toBe("running");
    expect(screen.getByTestId("chat-activity-a2").getAttribute("data-activity")).toBe("needsInput");
    expect(screen.getByTestId("chat-a2").getAttribute("aria-label")).toContain(", needs input");
    expect(screen.getByTestId("chat-a1").getAttribute("aria-label")).toContain(", running");
    // No pushed activity yet: the meta decides (parked).
    expect(screen.getByTestId("chat-activity-b1").getAttribute("data-activity")).toBe("parked");
  });

  it("hides the member chips with one owner", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    show(rows.slice(0, 2));
    expect(screen.queryByTestId("member-chips")).toBeNull();
  });

  it("filters the sessions list and the Activity list by the chosen member", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    show(rows);
    const chips = within(screen.getByTestId("member-chips"));
    expect(screen.getByText("Activity (2)")).toBeTruthy();
    fireEvent.click(chips.getByRole("button", { name: "Bob" }));
    expect(screen.queryByTestId("chat-a1")).toBeNull();
    expect(screen.getByTestId("chat-b1")).toBeTruthy();
    // The system's turn in Bob's session is Bob's activity.
    expect(screen.getByText("Activity (1)")).toBeTruthy();
    expect(screen.getByTestId("activity-2")).toBeTruthy();
    fireEvent.click(chips.getByRole("button", { name: "Bob" }));
    expect(screen.getByTestId("chat-a1")).toBeTruthy();
    expect(screen.getByText("Activity (2)")).toBeTruthy();
  });

  it("copies a link that opens the session, on the shared server only", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {})),
    );
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const onSelect = vi.fn();
    const row = (
      <SessionRow
        session={rows[0]!}
        displayTitle="a1"
        active={false}
        running={false}
        onSelect={onSelect}
      />
    );
    // Loopback (no signed-in person): no link to share.
    const view = render(row);
    expect(screen.queryByTestId("chat-copy-link-a1")).toBeNull();
    act(() => useAppStore.setState({ me: { id: alice.id, email: alice.id } }));
    view.rerender(row);
    fireEvent.click(screen.getByTestId("chat-copy-link-a1"));
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/?session=a1`),
    );
    expect(onSelect).not.toHaveBeenCalled();
  });
});
