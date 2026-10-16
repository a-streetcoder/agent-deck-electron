// @vitest-environment jsdom

import type { ProjectMeta, SessionMeta } from "@agent-deck/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedServerResponse } from "@/lib/native";
import { transferRunning } from "@/lib/sharedTransfers";
import { useAppStore } from "../state/store.ts";
import { forkSession, switchToSession } from "../state/wsBridge.ts";
import { SessionRow } from "./SessionsPanel.tsx";
import { ReturnPendingBanner, SharedSessionPanel, ShareSessionButton } from "./SessionShare.tsx";

vi.mock("../state/wsBridge.ts", () => ({
  deleteSession: vi.fn(),
  forkSession: vi.fn(async () => {}),
  newChat: vi.fn(),
  renameSession: vi.fn(),
  sessionLink: (id: string) => `/?session=${id}`,
  setSessionPinned: vi.fn(),
  switchToSession: vi.fn(async () => {}),
}));

/** SRV-12c1: Share to server, and the frozen pointer the local copy becomes. */
const SERVER = "https://deck.example.test";
const SERVER_SESSION = "9f1d2c3b-4a5e-4f60-8a71-b2c3d4e5f600";
const session: SessionMeta = {
  id: "s1",
  cwd: "C:\\dev\\app",
  createdAt: "2026-10-15T00:00:00.000Z",
  projectId: "p1",
  title: "Fix the bug",
  piSessionFile: "C:\\pi\\s1.jsonl",
};
const pointer: SessionMeta = {
  ...session,
  location: {
    kind: "local",
    live: {
      serverOrigin: SERVER,
      sessionId: SERVER_SESSION,
      at: "2026-10-15T01:00:00.000Z",
      mode: "snapshot",
    },
  },
};
const project: ProjectMeta = {
  id: "p1",
  path: "C:\\dev\\app",
  name: "app",
  createdAt: "now",
  sharedTo: { serverOrigin: SERVER, projectId: "srv-p1", sharedAt: "now" },
};

const request = vi.fn<(...args: unknown[]) => Promise<SharedServerResponse>>();
const openExternal = vi.fn(async () => true);
let routes: Record<string, () => Response>;
const calls: Array<{ url: string; body?: unknown }> = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      const route = routes[`${init?.method ?? "GET"} ${url}`];
      return route ? route() : Response.json({ error: "unexpected" }, { status: 404 });
    }),
  );
  window.agentDeck = {
    isElectron: true,
    openExternal,
    sharedServer: {
      origin: SERVER,
      request,
      signIn: vi.fn(async () => ({ ok: true })),
      cancelSignIn: vi.fn(async () => true),
    },
  };
  useAppStore.setState({ session, sessions: [session], projects: [project] });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete window.agentDeck;
  useAppStore.setState({ session: null, sessions: [], projects: [] });
});

describe("the frozen pointer", () => {
  it("keeps the same row and title with an on-host marker", () => {
    render(
      <SessionRow
        session={pointer}
        displayTitle="Fix the bug"
        active={false}
        running={false}
        onSelect={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("chat-title").map((node) => node.textContent)).toEqual([
      "Fix the bug",
    ]);
    expect(screen.getByTestId("chat-shared-s1").textContent).toBe("on deck.example.test");
  });

  it("replaces the composer with the notice, Open on server and Continue locally", () => {
    // SRV-12c2: the forwarding composer appears only once the mirror reads the server.
    request.mockResolvedValue({ status: 0, error: "The shared server could not be reached." });
    render(<SharedSessionPanel session={pointer} />);
    expect(screen.getByText("This session continues on deck.example.test.")).toBeTruthy();
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open on server" }));
    expect(openExternal).toHaveBeenCalledWith(`${SERVER}/?session=${SERVER_SESSION}`);
    fireEvent.click(screen.getByRole("button", { name: "Continue locally" }));
    expect(forkSession).toHaveBeenCalledWith("s1");
  });
});

describe("Share to server", () => {
  it("is offered only for a started session of a shared project, never for a pointer", () => {
    const { rerender } = render(<ShareSessionButton />);
    expect(screen.getByTestId("share-session")).toBeTruthy();
    useAppStore.setState({ session: pointer });
    rerender(<ShareSessionButton />);
    expect(screen.queryByTestId("share-session")).toBeNull();
    useAppStore.setState({ session, projects: [{ ...project, sharedTo: undefined }] });
    rerender(<ShareSessionButton />);
    expect(screen.queryByTestId("share-session")).toBeNull();
  });

  const HANDOFF = "0c1d2e3f-4a5b-4c6d-8e7f-901a2b3c4d5e";
  const REF = "refs/agent-deck/transfer/s1";
  const preflight =
    (untracked: string[], extra: Record<string, unknown> = {}) =>
    () =>
      Response.json({ plan: { branch: "main", files: { tracked: 2, untracked }, ...extra } });
  const exported = (transfer: Record<string, unknown>) => () =>
    Response.json({
      envelope: { version: 1, transfer },
      serverOrigin: SERVER,
      projectId: "srv-p1",
      handoff: HANDOFF,
    });
  const bodiesOf = (url: string) => calls.filter((call) => call.url === url).map((c) => c.body);

  it("shows every untracked file, falls back to the conversation when the push fails, and links the pointer", async () => {
    const untracked = Array.from({ length: 60 }, (_, i) => `file-${i}.txt`).concat(".env.local");
    let shareAnswers = [
      () =>
        Response.json(
          {
            code: "share_push_failed",
            error: "The snapshot could not be pushed: denied",
            fallback: "conversation",
          },
          { status: 409 },
        ),
      exported({ mode: "conversation" }),
    ];
    routes = {
      "POST /sessions/s1/share/preflight": preflight(untracked, { localCommits: 2 }),
      "POST /sessions/s1/share": () => shareAnswers.shift()!(),
      "PATCH /sessions/s1/shared-to": () => Response.json({ session: pointer }),
    };
    request.mockResolvedValue({
      status: 201,
      body: { sessionId: SERVER_SESSION, dropped: ["checkpoints"], mode: "conversation" },
    });

    render(<ShareSessionButton />);
    fireEvent.click(screen.getByTestId("share-session"));
    const list = await screen.findByTestId("share-untracked");
    // All of them, no "and N more": consent covers what travels.
    expect(list.querySelectorAll("li")).toHaveLength(61);
    expect(list.textContent).toContain(".env.local");
    expect(screen.getByText(/Ignored files \(for example \.env\) do not travel/)).toBeTruthy();
    expect(screen.getByTestId("share-local-commits").textContent).toContain("2 local commits");
    fireEvent.click(screen.getByRole("button", { name: "Move with my changes" }));
    expect(await screen.findByText(/could not be pushed: denied/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Move the conversation only" }));
    expect(
      await screen.findByText(/continues on deck.example.test. Not carried: checkpoints/),
    ).toBeTruthy();

    expect(bodiesOf("/sessions/s1/share")).toEqual([
      { mode: "snapshot", untracked },
      { mode: "conversation" },
    ]);
    expect(request).toHaveBeenCalledWith("POST", "/projects/srv-p1/sessions/import", {
      version: 1,
      transfer: { mode: "conversation" },
    });
    expect(bodiesOf("/sessions/s1/shared-to")).toEqual([
      {
        serverOrigin: SERVER,
        serverSessionId: SERVER_SESSION,
        mode: "conversation",
        handoff: HANDOFF,
      },
    ]);
    await waitFor(() => expect(switchToSession).toHaveBeenCalledWith(pointer));
    expect(useAppStore.getState().session?.location?.live?.sessionId).toBe(SERVER_SESSION);
    shareAnswers = [];
  });

  it("asks again when the untracked files changed before the push", async () => {
    let shareAnswers = [
      () =>
        Response.json(
          { code: "share_plan_changed", untracked: ["a.txt", "new-secret.txt"] },
          { status: 409 },
        ),
    ];
    routes = {
      "POST /sessions/s1/share/preflight": preflight(["a.txt"]),
      "POST /sessions/s1/share": () => shareAnswers.shift()!(),
    };
    render(<ShareSessionButton />);
    fireEvent.click(screen.getByTestId("share-session"));
    fireEvent.click(await screen.findByRole("button", { name: "Move with my changes" }));
    expect(await screen.findByText(/untracked files changed since you looked/)).toBeTruthy();
    expect(screen.getByTestId("share-untracked").textContent).toContain("new-secret.txt");
    expect(request).not.toHaveBeenCalled();
    shareAnswers = [];
  });

  it("removes the pushed ref from the device after a successful move", async () => {
    routes = {
      "POST /sessions/s1/share/preflight": preflight([]),
      "POST /sessions/s1/share": exported({ mode: "snapshot", ref: REF }),
      "PATCH /sessions/s1/shared-to": () => Response.json({ session: pointer }),
      "POST /sessions/s1/share/abort": () => Response.json({ error: "denied" }, { status: 409 }),
    };
    request.mockResolvedValue({
      status: 201,
      body: { sessionId: SERVER_SESSION, dropped: [], transferRefDeleted: false },
    });
    render(<ShareSessionButton />);
    fireEvent.click(screen.getByTestId("share-session"));
    fireEvent.click(await screen.findByRole("button", { name: "Move with my changes" }));
    // Neither side could remove it: the user gets the command.
    expect(
      await screen.findByText(
        `The transfer ref could not be removed: run git push origin --delete ${REF}`,
      ),
    ).toBeTruthy();
    expect(bodiesOf("/sessions/s1/share/abort")).toEqual([{ ref: REF }]);
  });

  it("removes the pushed ref and unfreezes when the server refuses the import", async () => {
    routes = {
      "POST /sessions/s1/share/preflight": preflight([]),
      "POST /sessions/s1/share": exported({ mode: "snapshot", ref: REF }),
      "POST /sessions/s1/share/abort": () => Response.json({ ok: true }),
    };
    request.mockResolvedValue({ status: 409, body: { error: "connect GitHub first" } });
    render(<ShareSessionButton />);
    fireEvent.click(screen.getByTestId("share-session"));
    fireEvent.click(await screen.findByRole("button", { name: "Move with my changes" }));
    expect(await screen.findByText("connect GitHub first")).toBeTruthy();
    await waitFor(() =>
      expect(bodiesOf("/sessions/s1/share/abort")).toEqual([{ ref: REF, handoff: HANDOFF }]),
    );
    expect(calls.some((call) => call.url === "/sessions/s1/shared-to")).toBe(false);
  });

  it.each([0, 502, 504, 524])(
    "keeps the ref when the server answers %i: it may still be importing",
    async (status) => {
      routes = {
        "POST /sessions/s1/share/preflight": preflight([]),
        "POST /sessions/s1/share": exported({ mode: "snapshot", ref: REF }),
      };
      request.mockResolvedValue({ status });
      render(<ShareSessionButton />);
      fireEvent.click(screen.getByTestId("share-session"));
      fireEvent.click(await screen.findByRole("button", { name: "Move with my changes" }));
      expect(await screen.findByText(/may still be importing/)).toBeTruthy();
      expect(calls.some((call) => call.url === "/sessions/s1/share/abort")).toBe(false);
    },
  );

  it("turns a failed local request into a closable error (Escape or Close)", async () => {
    routes = {
      "POST /sessions/s1/share/preflight": () =>
        Response.json(
          { error: "Wait until the session has finished responding." },
          { status: 409 },
        ),
    };
    render(<ShareSessionButton />);
    fireEvent.click(screen.getByTestId("share-session"));
    const text = await screen.findByText("Wait until the session has finished responding.");
    // SRV-16b: an open dialog (even one only showing an error) keeps Save refused.
    expect(transferRunning()).toBe(true);
    fireEvent.keyDown(text, { key: "Escape" });
    expect(screen.queryByTestId("share-session-dialog")).toBeNull();
    expect(transferRunning()).toBe(false);

    vi.mocked(fetch).mockRejectedValueOnce(new Error("Failed to fetch"));
    fireEvent.click(screen.getByTestId("share-session"));
    expect(await screen.findByText("Failed to fetch")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByTestId("share-session-dialog")).toBeNull();
  });

  it("says a branch without upstream sends all its unpushed commits, and nothing for zero", async () => {
    routes = { "POST /sessions/s1/share/preflight": preflight([], { localCommits: null }) };
    const { unmount } = render(<ShareSessionButton />);
    fireEvent.click(screen.getByTestId("share-session"));
    expect((await screen.findByTestId("share-local-commits")).textContent).toContain(
      "This branch has no upstream: every commit on it that is not on the remote travels too.",
    );
    unmount();
    routes = { "POST /sessions/s1/share/preflight": preflight([], { localCommits: 0 }) };
    render(<ShareSessionButton />);
    fireEvent.click(screen.getByTestId("share-session"));
    await screen.findByRole("button", { name: "Move with my changes" });
    expect(screen.queryByTestId("share-local-commits")).toBeNull();
  });

  it("offers only the conversation for an LFS checkout", async () => {
    routes = {
      "POST /sessions/s1/share/preflight": preflight([], { lfs: true }),
      "POST /sessions/s1/share": () => Response.json({ error: "stop here" }, { status: 500 }),
    };
    render(<ShareSessionButton />);
    fireEvent.click(screen.getByTestId("share-session"));
    expect((await screen.findByTestId("share-lfs")).textContent).toBe(
      "LFS repositories cannot be moved with their files yet. The conversation moves alone.",
    );
    const snapshot = screen.getByRole("button", { name: "Move with my changes" });
    expect((snapshot as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Conversation only" }));
    await waitFor(() =>
      expect(calls.find((call) => call.url === "/sessions/s1/share")?.body).toEqual({
        mode: "conversation",
      }),
    );
  });

  it("keeps the move when the server is still importing the first attempt", async () => {
    routes = {
      "POST /sessions/s1/share/preflight": preflight([]),
      "POST /sessions/s1/share": exported({ mode: "snapshot", ref: REF }),
    };
    request.mockResolvedValue({
      status: 409,
      body: { code: "session_already_imported", pending: true },
    });
    render(<ShareSessionButton />);
    fireEvent.click(screen.getByTestId("share-session"));
    fireEvent.click(await screen.findByRole("button", { name: "Move with my changes" }));
    expect(await screen.findByText(/still importing this session. Retry later/)).toBeTruthy();
    expect(calls.some((call) => call.url.includes("/share/abort"))).toBe(false);
    expect(calls.some((call) => call.url.includes("/shared-to"))).toBe(false);
  });

  it("never links an earlier copy that differs from this export", async () => {
    routes = {
      "POST /sessions/s1/share/preflight": preflight([]),
      "POST /sessions/s1/share": exported({ mode: "snapshot", ref: REF }),
      "POST /sessions/s1/share/abort": () => Response.json({ ok: true }),
    };
    request.mockResolvedValue({
      status: 409,
      body: { code: "export_changed", sessionId: SERVER_SESSION },
    });
    render(<ShareSessionButton />);
    fireEvent.click(screen.getByTestId("share-session"));
    fireEvent.click(await screen.findByRole("button", { name: "Move with my changes" }));
    expect(await screen.findByText(/earlier copy of this session that differs/)).toBeTruthy();
    expect(calls.some((call) => call.url.includes("/shared-to"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Cancel the move" }));
    await waitFor(() =>
      expect(bodiesOf("/sessions/s1/share/abort")).toEqual([{ ref: REF, handoff: HANDOFF }]),
    );
  });
});

describe("Bring back (SRV-12c3)", () => {
  const plan = { branch: "agent-deck/session-1", files: { tracked: 1, untracked: ["server.md"] } };
  const envelope = {
    direction: "return",
    transfer: { mode: "snapshot", ref: `refs/agent-deck/transfer/${SERVER_SESSION}` },
  };
  const server = (overrides: Record<string, SharedServerResponse> = {}) =>
    request.mockImplementation(async (...args: unknown[]) => {
      const [method, path, body] = args as [string, string, Record<string, unknown> | undefined];
      const key = `${method} ${path}${body && "confirmedUntracked" in body ? " confirmed" : ""}`;
      if (overrides[key]) return overrides[key]!;
      if (key === `POST /sessions/${SERVER_SESSION}/return`) return { status: 200, body: { plan } };
      if (key === `POST /sessions/${SERVER_SESSION}/return confirmed`)
        return { status: 200, body: { envelope, handoff: "h-1" } };
      if (key === `PATCH /sessions/${SERVER_SESSION}/returned`)
        return { status: 200, body: { session: {} } };
      if (key === `POST /sessions/${SERVER_SESSION}/return/abort`)
        return { status: 200, body: { ok: true } };
      // The live mirror's reads: unreachable is enough here.
      return { status: 0, error: "The shared server could not be reached." };
    });
  const pending = {
    direction: "return" as const,
    token: "h-1",
    serverOrigin: SERVER,
    sessionId: SERVER_SESSION,
    ref: `refs/agent-deck/transfer/${SERVER_SESSION}`,
    until: new Date(Date.now() + 15 * 60_000).toISOString(),
  };
  const serverCalls = () =>
    request.mock.calls
      .map(([method, path, body]) => ({ method, path, body }))
      .filter((call) => call.method !== "GET");

  it("lists the untracked files, brings the session back and closes the server copy", async () => {
    server();
    const done: SessionMeta = { ...session, location: { kind: "local" } };
    const back: SessionMeta = { ...done, location: { kind: "local", transfer: pending } };
    routes = {
      "POST /sessions/s1/import-return": () =>
        Response.json({
          session: back,
          restored: "worktree",
          notice: "The session came back in a new worktree: C:\\wt\\x.",
          transferRefDeleted: true,
        }),
      "PATCH /sessions/s1/return-pending": () => Response.json({ session: done }),
    };
    useAppStore.setState({ session: pointer, sessions: [pointer] });
    render(<SharedSessionPanel session={pointer} />);
    fireEvent.click(screen.getByTestId("bring-back"));
    await waitFor(() =>
      expect(screen.getByTestId("bring-back-untracked").textContent).toContain("server.md"),
    );
    fireEvent.click(screen.getAllByRole("button", { name: "Bring back" }).at(-1)!);
    // The server copy closed, so the hand-off is cleared before the session opens.
    await waitFor(() => expect(switchToSession).toHaveBeenCalledWith(done));
    expect(serverCalls()).toEqual([
      { method: "POST", path: `/sessions/${SERVER_SESSION}/return`, body: {} },
      {
        method: "POST",
        path: `/sessions/${SERVER_SESSION}/return`,
        body: { confirmedUntracked: ["server.md"] },
      },
      {
        method: "PATCH",
        path: `/sessions/${SERVER_SESSION}/returned`,
        body: { deviceSessionId: "s1", handoff: "h-1" },
      },
    ]);
    expect(calls.find((call) => call.url === "/sessions/s1/import-return")?.body).toEqual({
      envelope,
      handoff: "h-1",
    });
    expect(calls.find((call) => call.url === "/sessions/s1/return-pending")?.body).toEqual({
      returnPending: null,
    });
    expect(useAppStore.getState().toasts.at(-1)?.message).toContain("new worktree");
    expect(screen.queryByTestId("bring-back-dialog")).toBeNull();
  });

  it("aborts on the server and keeps the link when this device cannot take it", async () => {
    server();
    routes = {
      "POST /sessions/s1/import-return": () =>
        Response.json(
          { error: "The server's snapshot could not be fetched: denied" },
          { status: 409 },
        ),
    };
    render(<SharedSessionPanel session={pointer} />);
    fireEvent.click(screen.getByTestId("bring-back"));
    await waitFor(() => screen.getByTestId("bring-back-untracked"));
    fireEvent.click(screen.getAllByRole("button", { name: "Bring back" }).at(-1)!);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("could not be fetched"),
    );
    expect(serverCalls().at(-1)).toEqual({
      method: "POST",
      path: `/sessions/${SERVER_SESSION}/return/abort`,
      body: { handoff: "h-1" },
    });
    expect(serverCalls().some((call) => call.method === "PATCH")).toBe(false);
    expect(switchToSession).not.toHaveBeenCalled();
  });

  it("asks again when the server's untracked files changed, and shows a refusal", async () => {
    server({
      [`POST /sessions/${SERVER_SESSION}/return confirmed`]: {
        status: 409,
        body: { code: "share_plan_changed", untracked: ["server.md", "late.md"] },
      },
    });
    render(<SharedSessionPanel session={pointer} />);
    fireEvent.click(screen.getByTestId("bring-back"));
    await waitFor(() => screen.getByTestId("bring-back-untracked"));
    fireEvent.click(screen.getAllByRole("button", { name: "Bring back" }).at(-1)!);
    await waitFor(() =>
      expect(screen.getByTestId("bring-back-untracked").textContent).toContain("late.md"),
    );
    expect(screen.getByRole("alert").textContent).toContain("changed since you looked");
    cleanup();
    server({
      [`POST /sessions/${SERVER_SESSION}/return`]: {
        status: 409,
        body: {
          code: "github_not_connected",
          error: "Connect GitHub first: the owner's connection.",
        },
      },
    });
    render(<SharedSessionPanel session={pointer} />);
    fireEvent.click(screen.getByTestId("bring-back"));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Connect GitHub first"),
    );
  });

  it("keeps the return pending when the server copy is not closed, and finishes it later", async () => {
    server({
      [`PATCH /sessions/${SERVER_SESSION}/returned`]: { status: 0, error: "unreachable" },
    });
    const back: SessionMeta = { ...session, location: { kind: "local", transfer: pending } };
    routes = {
      "POST /sessions/s1/import-return": () =>
        Response.json({ session: back, restored: "worktree", transferRefDeleted: false }),
    };
    render(<SharedSessionPanel session={pointer} />);
    fireEvent.click(screen.getByTestId("bring-back"));
    await waitFor(() => screen.getByTestId("bring-back-untracked"));
    fireEvent.click(screen.getAllByRole("button", { name: "Bring back" }).at(-1)!);
    await waitFor(() => expect(switchToSession).toHaveBeenCalledWith(back));
    expect(useAppStore.getState().error).toContain("Finish the return");
    expect(calls.some((call) => call.url === "/sessions/s1/return-pending")).toBe(false);
    cleanup();

    // The banner finishes it while the hand-off is valid.
    server();
    const done = { ...session };
    routes = { "PATCH /sessions/s1/return-pending": () => Response.json({ session: done }) };
    render(<ReturnPendingBanner session={back} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish the return on deck.example.test" }));
    await waitFor(() =>
      expect(calls.find((call) => call.url === "/sessions/s1/return-pending")).toBeTruthy(),
    );
    expect(serverCalls().at(-1)).toEqual({
      method: "PATCH",
      path: `/sessions/${SERVER_SESSION}/returned`,
      body: { deviceSessionId: "s1", handoff: "h-1" },
    });
  });

  it("explains a hand-off that expired: close the server copy, remove the ref", async () => {
    server({
      [`PATCH /sessions/${SERVER_SESSION}/returned`]: {
        status: 409,
        body: { code: "return_stale", error: "This return is no longer prepared." },
      },
    });
    const back: SessionMeta = { ...session, location: { kind: "local", transfer: pending } };
    routes = { "PATCH /sessions/s1/return-pending": () => Response.json({ session }) };
    render(<ReturnPendingBanner session={back} />);
    fireEvent.click(screen.getByRole("button", { name: "Finish the return on deck.example.test" }));
    const close = await screen.findByRole("button", { name: "Close server copy" });
    expect(screen.getByTestId("return-pending").textContent).toContain(
      `git push origin --delete refs/agent-deck/transfer/${SERVER_SESSION}`,
    );
    fireEvent.click(close);
    expect(openExternal).toHaveBeenCalledWith(`${SERVER}/?session=${SERVER_SESSION}`);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() =>
      expect(calls.find((call) => call.url === "/sessions/s1/return-pending")?.body).toEqual({
        returnPending: null,
      }),
    );
  });

  it("on the shared server a returned copy is read-only and says where it continues", () => {
    const returned: SessionMeta = {
      ...session,
      location: {
        kind: "server",
        live: {
          device: "laptop",
          sessionId: "s0",
          at: "2026-10-15T02:00:00.000Z",
          mode: "snapshot",
        },
      },
    };
    render(<SharedSessionPanel session={returned} />);
    expect(screen.getByText("This session continues on laptop.")).toBeTruthy();
    expect(screen.queryByTestId("bring-back")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(request).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Continue here" }));
    expect(forkSession).toHaveBeenCalledWith("s1");
  });

  it("ADR 0006: the pointer banner names the copy it already continued in (lineage)", () => {
    const returned: SessionMeta = {
      ...session,
      location: {
        kind: "server",
        live: {
          device: "laptop",
          sessionId: "s0",
          at: "2026-10-15T02:00:00.000Z",
          mode: "snapshot",
        },
      },
    };
    const continued: SessionMeta = {
      ...session,
      id: "s1-fork",
      title: "Fix the bug (fork)",
      provenance: { kind: "forked", from: { sessionId: "s1" }, by: {}, at: "now" },
      location: { kind: "server" },
    };
    useAppStore.setState({ sessions: [returned, continued] });
    render(<SharedSessionPanel session={returned} />);
    expect(screen.getByTestId("pointer-continued").textContent).toContain(
      "Continued here as “Fix the bug (fork)”.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open it" }));
    expect(switchToSession).toHaveBeenCalledWith(continued);
    useAppStore.setState({ sessions: [] });
  });
});
