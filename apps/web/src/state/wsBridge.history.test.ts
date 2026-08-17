import type { HistoryActionResult, SessionMeta } from "@agent-deck/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportState = vi.hoisted(() => ({
  host: null as { onServerMessage: (message: unknown) => void } | null,
  connects: [] as string[],
  resubscribes: [] as string[],
}));

vi.mock("./clientTransport.ts", () => ({
  RpcClientTransport: class {
    constructor(host: { onServerMessage: (message: unknown) => void }) {
      transportState.host = host;
    }
    connect(sessionId: string): void {
      transportState.connects.push(sessionId);
    }
    resubscribe(sessionId: string): void {
      transportState.resubscribes.push(sessionId);
    }
    disconnect(): void {}
    send(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

import { historyActionPending, newChat, runHistoryAction, switchToSession } from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

const session = (id: string): SessionMeta => ({ id, cwd: "/tmp/project", createdAt: "now" });
const response = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

beforeEach(() => {
  transportState.connects.length = 0;
  transportState.resubscribes.length = 0;
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({
    session: null,
    sessions: [],
    composerDrafts: {},
    error: null,
    streamGeneration: null,
  });
});

afterEach(() => vi.unstubAllGlobals());

async function activate(source: SessionMeta): Promise<void> {
  vi.mocked(fetch)
    .mockResolvedValueOnce(response({ session: source }))
    .mockResolvedValueOnce(response({ sessions: [source] }));
  await switchToSession(source);
}

describe("history action client ownership", () => {
  it("atomically replaces the exact fork target draft and clears unrelated attachments", async () => {
    const source = session("source");
    const target = session("target");
    await activate(source);
    useAppStore.getState().updateComposerDraft(target.id, () => ({
      text: "stale",
      images: [{ id: "stale", name: "stale", type: "image", data: "eA==", mimeType: "image/png" }],
      files: [{ id: "stale", name: "stale", path: "/stale" }],
      folders: [],
      pastes: [],
    }));
    const result: HistoryActionResult = {
      outcome: "forked",
      session: target,
      draft: {
        text: "canonical",
        images: [],
        files: [],
        folders: [{ id: "folder", name: "src", path: "/tmp/src" }],
        pastes: [],
      },
    };
    vi.mocked(fetch)
      .mockResolvedValueOnce(response(result, 201))
      .mockResolvedValueOnce(response({ sessions: [source, target] }))
      .mockResolvedValueOnce(response({ session: target }))
      .mockResolvedValueOnce(response({ sessions: [source, target] }));

    await runHistoryAction(source.id, "entry", "fork");
    expect(useAppStore.getState().composerDrafts[target.id]).toEqual(result.draft);
    expect(useAppStore.getState().session?.id).toBe(target.id);
  });

  it("keeps the global per-session pending claim until concurrent callers both settle", async () => {
    const source = session("source");
    await activate(source);
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    const first = new Promise<Response>((resolve) => (resolveFirst = resolve));
    const second = new Promise<Response>((resolve) => (resolveSecond = resolve));
    vi.mocked(fetch)
      .mockImplementationOnce(() => first)
      .mockImplementationOnce(() => second);

    const firstRun = runHistoryAction(source.id, "a", "fork");
    const secondRun = runHistoryAction(source.id, "b", "fork");
    expect(historyActionPending(source.id)).toBe(true);
    resolveFirst(response({ error: "busy" }, 409));
    await expect(firstRun).rejects.toThrow();
    expect(historyActionPending(source.id)).toBe(true);
    resolveSecond(response({ error: "busy" }, 409));
    await expect(secondRun).rejects.toThrow();
    expect(historyActionPending(source.id)).toBe(false);
  });

  it("server-driven same-id rebind resets ancestry and RESUBSCRIBES without dropping the socket", async () => {
    const source = session("source");
    await activate(source);
    useAppStore.setState({
      transcript: {
        ...useAppStore.getState().transcript,
        cells: [{ kind: "user", id: "old", text: "old" }],
      },
      lastSeq: 42,
      error: "old process exited",
    });
    const connectsBefore = transportState.connects.length;
    transportState.host?.onServerMessage({ type: "session_rebind", sessionId: source.id });
    expect(useAppStore.getState().transcript.cells).toEqual([]);
    expect(useAppStore.getState().lastSeq).toBe(0);
    expect(useAppStore.getState().error).toBeNull();
    // Over the SAME socket: a reconnect here would reject the in-flight request
    // whose handler caused the rebind (rollback / wake-on-send) even though it
    // succeeded — the defect that stranded the rollback dialog.
    expect(transportState.resubscribes.at(-1)).toBe(source.id);
    expect(transportState.connects.length).toBe(connectsBefore);
  });

  it("a rebind marks the subscription unsettled and drops the dead runtime's sideband state", async () => {
    const source = session("source");
    await activate(source);
    useAppStore.setState({
      sessionSubscriptionSettled: true,
      checkpoints: [{ turnIndex: 0, createdAt: "now", label: "old", hasFiles: true }],
    });
    transportState.host?.onServerMessage({ type: "session_rebind", sessionId: source.id });
    // Stale-until-refetch would otherwise stay on screen indefinitely if the
    // resubscribe or either sideband refresh failed (Codex).
    expect(useAppStore.getState().sessionSubscriptionSettled).toBe(false);
    expect(useAppStore.getState().checkpoints).toEqual([]);
  });

  it("does not navigate or mutate drafts after a newer activation wins", async () => {
    const source = session("source");
    const target = session("target");
    const newer = session("newer");
    await activate(source);
    let resolveAction!: (value: Response) => void;
    const actionResponse = new Promise<Response>((resolve) => (resolveAction = resolve));
    vi.mocked(fetch).mockImplementationOnce(() => actionResponse);
    const pending = runHistoryAction(source.id, "entry", "fork");

    vi.mocked(fetch)
      .mockResolvedValueOnce(response({ session: newer }))
      .mockResolvedValueOnce(response({ sessions: [newer] }));
    await newChat();
    resolveAction(
      response({
        outcome: "forked",
        session: target,
        draft: { text: "must not land", images: [], files: [], folders: [], pastes: [] },
      } satisfies HistoryActionResult),
    );
    // refreshSessions performed by the completed action.
    vi.mocked(fetch).mockResolvedValueOnce(response({ sessions: [newer, target] }));
    await pending;
    expect(useAppStore.getState().session?.id).toBe(newer.id);
    expect(useAppStore.getState().composerDrafts[target.id]).toBeUndefined();
  });
});
