import type { ServerMessage, SessionMeta } from "@agent-deck/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportHarness = vi.hoisted(() => ({
  emit: null as ((message: ServerMessage) => void) | null,
}));

vi.mock("./clientTransport.ts", () => ({
  RpcClientTransport: class {
    constructor(host: { onServerMessage(message: ServerMessage): void }) {
      transportHarness.emit = (message) => host.onServerMessage(message);
    }
    connect(): void {}
    disconnect(): void {}
    send(): void {}
  },
}));

import { deleteSession, switchToSession } from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

function session(id: string, cwd = "/tmp"): SessionMeta {
  return { id, cwd, createdAt: "2026-01-01T00:00:00.000Z" };
}

const initialDraft = session("initial-draft");

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function seedDraft(session = initialDraft): void {
  useAppStore.setState((state) => ({
    session,
    sessions: [session],
    sessionsLoaded: true,
    sessionSubscriptionSettled: true,
    composerDrafts: {
      [session.id]: {
        text: "stale composer text",
        images: [],
        files: [],
        folders: [],
        pastes: [],
      },
    },
    pendingComposerText: { sessionId: session.id, text: "stale seed" },
    terminalOpen: true,
    transcript: { ...state.transcript, agentStatus: "running" },
    lastSeq: 12,
    error: null,
  }));
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  seedDraft();
});

afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ session: null, sessions: [], composerDrafts: {}, error: null });
});

describe("deleteSession", () => {
  it("leaves no active session after deleting the final draft via the HTTP fallback", async () => {
    const draftSession = session("http-draft");
    seedDraft(draftSession);
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ ok: true }))
      .mockResolvedValueOnce(jsonResponse({ sessions: [] }));

    await deleteSession(draftSession.id);

    expect(
      vi.mocked(fetch).mock.calls.map(([input, init]) => [String(input), init?.method]),
    ).toEqual([
      [`/sessions/${draftSession.id}`, "DELETE"],
      ["/sessions", undefined],
    ]);
    expect(useAppStore.getState()).toMatchObject({
      session: null,
      sessions: [],
      sessionSubscriptionSettled: false,
      pendingComposerText: null,
      composerDrafts: {},
      terminalOpen: false,
      lastSeq: 0,
    });
    expect(useAppStore.getState().transcript.agentStatus).toBe("idle");
  });

  it("handles exit and websocket removal before DELETE resolves without a stale error", async () => {
    const draftSession = session("websocket-draft");
    seedDraft(draftSession);
    let resolveDelete!: (response: Response) => void;
    const deleteResponse = new Promise<Response>((resolve) => {
      resolveDelete = resolve;
    });
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url.endsWith("/resume")) return Promise.resolve(jsonResponse({ session: draftSession }));
      if (init?.method === "DELETE") return deleteResponse;
      return Promise.resolve(jsonResponse({ sessions: init ? [draftSession] : [] }));
    });

    // Establish the transport's active session, then start a deletion whose
    // websocket publications beat its HTTP response.
    await switchToSession(draftSession);
    const deletion = deleteSession(draftSession.id);
    transportHarness.emit?.({
      type: "session_exit",
      sessionId: draftSession.id,
      code: 0,
      signal: null,
    });
    transportHarness.emit?.({ type: "session_removed", sessionId: draftSession.id });

    expect(useAppStore.getState().session).toBeNull();
    expect(useAppStore.getState().error).toBeNull();
    resolveDelete(jsonResponse({ ok: true }));
    await deletion;
    expect(useAppStore.getState()).toMatchObject({ session: null, sessions: [], error: null });
  });

  it("fences a late resume of a websocket-removed target but allows another activation", async () => {
    const draftSession = session("late-resume-draft");
    const other = session("other-session", "/other");
    seedDraft(draftSession);
    let resolveRemovedResume!: (response: Response) => void;
    const removedResume = new Promise<Response>((resolve) => {
      resolveRemovedResume = resolve;
    });
    vi.mocked(fetch)
      .mockReturnValueOnce(removedResume)
      .mockResolvedValueOnce(jsonResponse({ session: other }))
      .mockResolvedValueOnce(jsonResponse({ sessions: [other] }));

    const staleActivation = switchToSession(draftSession);
    transportHarness.emit?.({ type: "session_removed", sessionId: draftSession.id });
    resolveRemovedResume(jsonResponse({ session: draftSession }));
    await staleActivation;
    expect(useAppStore.getState().session).toBeNull();

    await switchToSession(other);
    expect(useAppStore.getState().session?.id).toBe(other.id);
  });
});
