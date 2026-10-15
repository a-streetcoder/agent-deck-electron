// @vitest-environment jsdom

import type { SessionMeta } from "@agent-deck/contracts";
import { emptyTranscript, type TranscriptCell, type TranscriptState } from "@agent-deck/domain";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedServerResponse } from "@/lib/native";
import { SharedSessionPanel } from "../components/SessionShare.tsx";
import { SessionPlanPanel } from "../components/SessionPlanPanel.tsx";
import { Transcript } from "../components/Transcript.tsx";
import { mirroredTranscript, useAppStore } from "./store.ts";
import { switchToSession } from "./wsBridge.ts";
import { IDLE_POLL_MS, mergeWindow } from "./useSharedSessionMirror.ts";

vi.mock("./wsBridge.ts", () => ({
  forkSession: vi.fn(async () => {}),
  switchToSession: vi.fn(async () => {}),
  sendSupervisorAnswer: vi.fn(),
  respondToQuestion: vi.fn(),
  historyActionPending: () => false,
  subscribeHistoryActionPending: () => () => {},
  runHistoryAction: vi.fn(),
}));
vi.mock("../components/diff/OpenInPicker.tsx", () => ({
  useOpenInEditor: () => ({ available: [], preferred: null, open: vi.fn() }),
  OpenInPicker: () => null,
}));

/** SRV-12c2: the pointer follows its server session through the Electron bridge. */
const SERVER = "https://deck.example.test";
const SID = "9f1d2c3b-4a5e-4f60-8a71-b2c3d4e5f600";
const pointer: SessionMeta = {
  id: "s1",
  cwd: "C:\\dev\\app",
  createdAt: "2026-10-15T00:00:00.000Z",
  title: "Fix the bug",
  piSessionFile: "C:\\pi\\s1.jsonl",
  sharedTo: {
    serverOrigin: SERVER,
    serverSessionId: SID,
    sharedAt: "2026-10-15T09:30:00.000Z",
    mode: "snapshot",
  },
};
const other: SessionMeta = {
  ...pointer,
  id: "s2",
  sharedTo: { ...pointer.sharedTo!, serverSessionId: "1f1d2c3b-4a5e-4f60-8a71-b2c3d4e5f601" },
};
const localCopy = {
  ...emptyTranscript(),
  cells: [{ kind: "user", id: "local", text: "local copy" } as TranscriptCell],
};
const user = (id: string, text: string) => ({ kind: "user", id, text }) as TranscriptCell;
const reply = (id: string, text: string, streaming = false) =>
  ({ kind: "assistant", id, blocks: [{ kind: "text", text }], streaming }) as TranscriptCell;
/** An A2 event the Run tree reducer reads. */
const event = (seq: number) => ({
  seq,
  id: `ev${seq}`,
  ts: "2026-10-15T10:00:00.000Z",
  kind: "turn.prompted",
  sessionId: SID,
  subject: { type: "turn", id: `turn${seq}` },
  actor: { type: "user" },
  payload: { label: `turn ${seq}` },
});

interface Answer {
  cells: TranscriptCell[];
  reset?: boolean;
  firstId?: string | null;
  truncated?: boolean;
  plan?: TranscriptState["plan"];
}
let server: {
  meta: SharedServerResponse;
  events: unknown[];
  transcript: (query: URLSearchParams) => SharedServerResponse;
  prompt: SharedServerResponse;
};
const queries: URLSearchParams[] = [];
const request = vi.fn(async (method: string, path: string, body?: unknown) => {
  void body;
  const url = new URL(path, SERVER);
  if (method === "POST" && url.pathname.endsWith("/prompt")) return server.prompt;
  if (url.pathname === "/events") {
    const after = Number(url.searchParams.get("afterSeq"));
    const events = server.events.filter((e) => (e as { seq: number }).seq > after);
    return {
      status: 200,
      body: { logId: "log", lastSeq: server.events.length, events, more: false },
    };
  }
  if (url.pathname.endsWith("/transcript")) {
    queries.push(url.searchParams);
    return server.transcript(url.searchParams);
  }
  return server.meta;
});
const signIn = vi.fn(async () => ({ ok: true }));
const answer = ({ cells, reset = true, firstId, truncated = false, plan = [] }: Answer) => ({
  status: 200,
  body: {
    source: "live",
    reset,
    truncated,
    firstId: firstId === undefined ? (cells[0]?.id ?? null) : firstId,
    prefixHash: "a".repeat(40),
    state: { ...emptyTranscript(), plan, cells },
  },
});
const live = (activity = "idle"): SharedServerResponse => ({
  status: 200,
  body: { session: { id: SID, activity, createdBy: { id: "a@example.com", name: "Andrea" } } },
});

beforeEach(() => {
  queries.length = 0;
  server = {
    meta: live(),
    events: [event(1)],
    transcript: () => answer({ cells: [user("u1", "fix it"), reply("a1", "fixed")] }),
    prompt: { status: 202, body: { ok: true } },
  };
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  window.agentDeck = {
    isElectron: true,
    openExternal: vi.fn(async () => true),
    sharedServer: {
      origin: SERVER,
      request: request as never,
      signIn,
      cancelSignIn: vi.fn(async () => true),
    },
  };
  useAppStore.setState({ session: pointer, sessions: [pointer, other], transcript: localCopy });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
  delete window.agentDeck;
  useAppStore.setState({ session: null, sessions: [], sharedMirror: null });
});

const shown = () => mirroredTranscript(useAppStore.getState()).cells.map((cell) => cell.id);

describe("the live mirror", () => {
  it("shows the server transcript, its activity, the owner and the Run tree (no raw events)", async () => {
    server.meta = live("running");
    render(<SharedSessionPanel session={pointer} />);
    await waitFor(() => expect(shown()).toEqual(["u1", "a1"]));
    expect(screen.getByText("Runs on deck.example.test as Andrea")).toBeTruthy();
    expect(useAppStore.getState().sessions[0]!.activity).toBe("running");
    const mirror = useAppStore.getState().sharedMirror!;
    expect(mirror).not.toHaveProperty("events");
    expect(mirror.tree?.roots[0]?.key).toBe(`session:${SID}`);
    expect(mirror.lastSeq).toBe(1);
    // Send waits while the server session is answering.
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "more" } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    cleanup();
    // Closed: the mirror is dropped and the local copy is what remains.
    expect(useAppStore.getState().sharedMirror).toBeNull();
    expect(shown()).toEqual(["local"]);
    expect(useAppStore.getState().sessions[0]!.activity).toBe("idle");
  });

  it("forwards a prompt and asks for the window after its last cell, with the open cells", async () => {
    server.transcript = () =>
      answer({ cells: [user("u1", "fix it"), reply("a1", "fixed"), reply("a2", "more…", true)] });
    render(<SharedSessionPanel session={pointer} />);
    await waitFor(() => expect(shown()).toEqual(["u1", "a1", "a2"]));
    server.events = [event(1), event(2)];
    server.transcript = () =>
      answer({
        cells: [reply("a2", "more, done"), user("u2", "and the test")],
        reset: false,
        firstId: "u1",
      });
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "and the test" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(shown()).toEqual(["u1", "a1", "a2", "u2"]));
    expect(request).toHaveBeenCalledWith("POST", `/sessions/${SID}/prompt`, {
      text: "and the test",
    });
    const last = queries.at(-1)!;
    expect(last.get("afterEntryId")).toBe("a2");
    expect(last.get("prefixHash")).toBe("a".repeat(40));
    expect(last.getAll("openId")).toEqual(["a2"]);
    expect(mirroredTranscript(useAppStore.getState()).cells[2]).toMatchObject({ streaming: false });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });

  it("reads the whole window again when the server session stops running", async () => {
    server.meta = live("running");
    render(<SharedSessionPanel session={pointer} />);
    await waitFor(() => expect(shown()).toEqual(["u1", "a1"]));
    server.meta = live("idle");
    server.transcript = () =>
      answer({ cells: [user("u1", "fix it"), reply("a1", "fixed, verified")] });
    queries.length = 0;
    // Focus polls now; the activity left running, so no anchor is sent.
    window.dispatchEvent(new Event("focus"));
    await waitFor(() => expect(queries.length).toBeGreaterThan(0));
    expect(queries.at(-1)!.get("afterEntryId")).toBeNull();
    await waitFor(() =>
      expect(mirroredTranscript(useAppStore.getState()).cells[1]).toMatchObject({
        blocks: [{ text: "fixed, verified" }],
      }),
    );
  });

  it("keeps the window bounded: cells before the server's firstId are dropped", () => {
    const held = [user("u1", "a"), reply("a1", "b"), reply("a2", "c", true)];
    const next = mergeWindow(held, {
      state: { ...emptyTranscript(), cells: [reply("a2", "c!"), user("u3", "d")] },
      reset: false,
      firstId: "a1",
      truncated: true,
      prefixHash: "x",
    });
    expect(next.map((cell) => cell.id)).toEqual(["a1", "a2", "u3"]);
    expect(
      mergeWindow(held, {
        state: { ...emptyTranscript(), cells: [] },
        reset: true,
        firstId: null,
        truncated: false,
        prefixHash: "x",
      }),
    ).toEqual([]);
  });

  it("shows the server's refusal of a prompt", async () => {
    server.prompt = { status: 409, body: { error: "Pi is busy." } };
    render(<SharedSessionPanel session={pointer} />);
    await waitFor(() => expect(shown()).toEqual(["u1", "a1"]));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Pi is busy.");
  });

  it("waits for a person: Send off with Answer on the host while the session needs input", async () => {
    server.meta = live("needsInput");
    render(<SharedSessionPanel session={pointer} />);
    await waitFor(() => expect(shown()).toEqual(["u1", "a1"]));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "hi" } });
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("forward-needs-input").textContent).toContain(
      "Answer on deck.example.test",
    );
  });

  it("falls back to the local copy when unreachable, an unknown 404 included, and retries", async () => {
    // A 404 without the server's own code is a proxy or an older server, not a deletion.
    server.meta = { status: 404, body: null };
    render(<SharedSessionPanel session={pointer} />);
    expect(
      await screen.findByText("Last local copy; deck.example.test is unreachable."),
    ).toBeTruthy();
    expect(shown()).toEqual(["local"]);
    expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    server.meta = live();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(shown()).toEqual(["u1", "a1"]));
    expect(screen.queryByTestId("shared-mirror-banner")).toBeNull();
  });

  it("stops on 403 with the server's text and no retry", async () => {
    server.meta = { status: 403, error: "Your account is not allowed on deck.example.test." };
    render(<SharedSessionPanel session={pointer} />);
    expect(
      await screen.findByText(/Your account is not allowed on deck.example.test\./),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    expect(useAppStore.getState().sharedMirror?.status).toBe("forbidden");
  });

  it("asks to sign in on 401 and follows once signed in", async () => {
    server.meta = { status: 401, signInRequired: true };
    render(<SharedSessionPanel session={pointer} />);
    const button = await screen.findByRole("button", { name: "Sign in to deck.example.test" });
    server.meta = live();
    fireEvent.click(button);
    await waitFor(() => expect(shown()).toEqual(["u1", "a1"]));
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("offers Unlink only for the server's unknown_session, explains the copy, and reopens it", async () => {
    server.meta = { status: 404, body: { code: "unknown_session", error: "unknown session" } };
    const unlinked = { ...pointer, sharedTo: undefined };
    const fetchMock = vi.fn(async () => Response.json({ session: unlinked }));
    vi.stubGlobal("fetch", fetchMock);
    render(<SharedSessionPanel session={pointer} />);
    expect(
      await screen.findByText("This session no longer exists on deck.example.test."),
    ).toBeTruthy();
    expect(screen.getByTestId("pointer-copy-note").textContent).toMatch(
      /Returns to this device's copy from .+; turns run on the server are not brought back\./,
    );
    expect(screen.getByRole("button", { name: "Continue locally" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(switchToSession).toHaveBeenCalledWith(unlinked));
    expect(fetchMock).toHaveBeenCalledWith("/sessions/s1/shared-to", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sharedTo: null }),
    });
    vi.unstubAllGlobals();
  });

  it("keeps each pointer's composer to itself", async () => {
    let finish: (value: SharedServerResponse) => void = () => {};
    server.prompt = new Promise<SharedServerResponse>((resolve) => (finish = resolve)) as never;
    const { rerender } = render(<SharedSessionPanel session={pointer} />);
    await waitFor(() => expect(shown()).toEqual(["u1", "a1"]));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "for A" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    useAppStore.setState({ session: other });
    rerender(<SharedSessionPanel session={other} />);
    await waitFor(() => expect(screen.getByRole("textbox")).toBeTruthy());
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "for B" } });
    await act(async () => finish({ status: 202, body: { ok: true } }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("for B");
  });

  it("stops polling while the window is hidden and when the pointer closes", async () => {
    vi.useFakeTimers();
    render(<SharedSessionPanel session={pointer} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const afterFirst = request.mock.calls.length;
    expect(afterFirst).toBeGreaterThan(0);
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 3);
    });
    expect(request.mock.calls.length).toBe(afterFirst);
    hidden.mockReturnValue(false);
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(0);
    });
    const visible = request.mock.calls.length;
    expect(visible).toBeGreaterThan(afterFirst);
    cleanup();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(IDLE_POLL_MS * 3);
    });
    expect(request.mock.calls.length).toBe(visible);
    hidden.mockRestore();
  });

  it("shows only the local copy when this app has no bridge to that server", async () => {
    window.agentDeck!.sharedServer!.origin = "https://other.example.test";
    render(<SharedSessionPanel session={pointer} />);
    expect(
      await screen.findByText("Last local copy; this app cannot reach deck.example.test."),
    ).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });
});

describe("mirrored cells are read-only", () => {
  const question = {
    kind: "question",
    id: "q1",
    requestId: "r1",
    method: "confirm",
    title: "Proceed?",
    answered: false,
  } as TranscriptCell;
  const withImage = {
    kind: "user",
    id: "u9",
    entryId: "e9",
    text: "look",
    images: [{ id: "img1", name: "shot.png" }],
  } as TranscriptCell;
  const run = {
    kind: "subagent",
    id: "run1",
    task: "check",
    status: "done",
    text: "ok",
    progress: [],
  } as TranscriptCell;

  it("answers on the server, shows images and child runs as on the host, no history actions", async () => {
    server.transcript = () =>
      answer({
        cells: [withImage, question, run],
        truncated: true,
        plan: [{ id: "p1", title: "Mirrored step", status: "pending" }] as never,
      });
    const fetchSpy = vi.fn(async () => Response.json({}));
    vi.stubGlobal("fetch", fetchSpy);
    render(
      <>
        <SessionPlanPanel />
        <Transcript />
        <SharedSessionPanel session={pointer} />
      </>,
    );
    expect(await screen.findByTestId("mirrored-question")).toBeTruthy();
    expect(screen.getByText("Answer on deck.example.test")).toBeTruthy();
    expect(screen.queryByTestId("question-cell")).toBeNull();
    expect(screen.getByText("Earlier messages are on deck.example.test")).toBeTruthy();
    expect(screen.getByText("Images (on deck.example.test)")).toBeTruthy();
    // The finished run's card opens on a click, like any other.
    fireEvent.click(screen.getByTestId("subagent-cell").querySelector("button")!);
    expect(screen.getByText("Child transcript (on deck.example.test)")).toBeTruthy();
    expect(screen.queryByTestId("subagent-open-transcript")).toBeNull();
    expect(screen.queryByTestId("message-fork")).toBeNull();
    expect(screen.queryByTestId("message-rerun")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    // The plan panel follows the mirror too.
    expect(screen.getAllByText("Mirrored step").length).toBeGreaterThan(0);
    // Nothing a mirrored cell shows asks the local backend.
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
