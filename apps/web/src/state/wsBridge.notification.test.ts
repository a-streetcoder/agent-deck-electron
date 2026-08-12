import type { SessionMeta } from "@agent-deck/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportMock = vi.hoisted(() => ({
  host: undefined as { onServerMessage(message: unknown): void } | undefined,
}));
vi.mock("./clientTransport.ts", () => ({
  RpcClientTransport: class {
    constructor(host: { onServerMessage(message: unknown): void }) {
      transportMock.host = host;
    }
    connect(): void {}
    disconnect(): void {}
    send(): void {}
  },
}));

import {
  acknowledgeSessionAttention,
  focusSessionFromNotification,
  switchToSession,
} from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

const session = (id: string): SessionMeta => ({
  id,
  cwd: `/tmp/${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function deferredResponse(): {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
} {
  let resolve!: (response: Response) => void;
  return {
    promise: new Promise<Response>((done) => {
      resolve = done;
    }),
    resolve: (response) => resolve(response),
  };
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({
    session: session("current"),
    sessions: [session("current")],
    view: "projects",
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("attention acknowledgement ordering", () => {
  it("does not apply a delayed false response over a newer true metadata push", async () => {
    const delayed = deferredResponse();
    vi.mocked(fetch)
      .mockReturnValueOnce(delayed.promise)
      .mockResolvedValueOnce(
        jsonResponse({ sessions: [{ ...session("current"), needsAttention: true }] }),
      );
    const request = acknowledgeSessionAttention("current");

    transportMock.host?.onServerMessage({
      type: "session_meta",
      session: { ...session("current"), needsAttention: true },
    });
    delayed.resolve(jsonResponse({ session: { ...session("current"), needsAttention: false } }));
    await request;

    expect(useAppStore.getState().session?.needsAttention).toBe(true);
  });
});

describe("notification session routing", () => {
  it("preserves newer websocket attention over an older notification catalog", async () => {
    const current = { ...session("current"), needsAttention: true };
    const target = { ...session("target"), needsAttention: true };
    useAppStore.setState({ session: current, sessions: [current, target] });
    const delayedCatalog = deferredResponse();
    vi.mocked(fetch)
      .mockReturnValueOnce(delayedCatalog.promise)
      .mockResolvedValueOnce(jsonResponse({ session: target }))
      .mockResolvedValueOnce(jsonResponse({ sessions: [current, target] }));

    const routing = focusSessionFromNotification(target.id);
    transportMock.host?.onServerMessage({
      type: "session_meta",
      session: { ...current, needsAttention: true },
    });
    delayedCatalog.resolve(
      jsonResponse({
        sessions: [
          { ...current, needsAttention: false },
          { ...target, needsAttention: true },
        ],
      }),
    );
    await routing;

    expect(
      useAppStore.getState().sessions.find((candidate) => candidate.id === current.id)
        ?.needsAttention,
    ).toBe(true);
    expect(useAppStore.getState().session?.id).toBe(target.id);
    expect(useAppStore.getState().view).toBe("chat");
  });

  it("resolves the opaque id from the live session catalog and activates it", async () => {
    const current = session("current");
    const target = session("target");
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ sessions: [current, target] }))
      .mockResolvedValueOnce(jsonResponse({ session: target }))
      .mockResolvedValueOnce(jsonResponse({ sessions: [current, target] }));

    await focusSessionFromNotification(target.id);

    expect(useAppStore.getState().view).toBe("chat");
    expect(useAppStore.getState().session?.id).toBe(target.id);
    expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).toEqual([
      "/sessions",
      "/sessions/target/resume",
      "/sessions",
    ]);
  });

  it("returns to chat without restarting the already-selected session", async () => {
    const current = session("current");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ sessions: [current] }));

    await focusSessionFromNotification(current.id);

    expect(useAppStore.getState().view).toBe("chat");
    expect(useAppStore.getState().session?.id).toBe(current.id);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("ignores an id that is not present in the app-owned session catalog", async () => {
    const current = session("current");
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ sessions: [current] }));

    await focusSessionFromNotification("missing");

    expect(useAppStore.getState().view).toBe("projects");
    expect(useAppStore.getState().session?.id).toBe(current.id);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("cannot supersede a newer explicit session switch when its catalog lookup resolves last", async () => {
    const current = session("current");
    const staleTarget = session("notification-a");
    const userTarget = session("user-b");
    const staleLookup = deferredResponse();
    let sessionListCalls = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/sessions" && init?.method === undefined) {
        sessionListCalls += 1;
        return sessionListCalls === 1
          ? staleLookup.promise
          : Promise.resolve(jsonResponse({ sessions: [current, staleTarget, userTarget] }));
      }
      if (url === `/sessions/${userTarget.id}/resume`) {
        return Promise.resolve(jsonResponse({ session: userTarget }));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const staleNotification = focusSessionFromNotification(staleTarget.id);
    await switchToSession(userTarget);
    staleLookup.resolve(jsonResponse({ sessions: [current, staleTarget, userTarget] }));
    await staleNotification;

    expect(useAppStore.getState().session?.id).toBe(userTarget.id);
  });

  it("does not cancel an in-flight explicit switch when the notification target is gone", async () => {
    const current = session("current");
    const userTarget = session("user-b");
    const resume = deferredResponse();
    let sessionListCalls = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === `/sessions/${userTarget.id}/resume`) return resume.promise;
      if (url === "/sessions" && init?.method === undefined) {
        sessionListCalls += 1;
        return Promise.resolve(
          jsonResponse({
            sessions: sessionListCalls === 1 ? [current] : [current, userTarget],
          }),
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const userSwitch = switchToSession(userTarget);
    await focusSessionFromNotification("deleted-notification-session");
    resume.resolve(jsonResponse({ session: userTarget }));
    await userSwitch;

    expect(useAppStore.getState().session?.id).toBe(userTarget.id);
  });

  it("keeps the newer notification selected when catalog lookups resolve out of order", async () => {
    const current = session("current");
    const staleTarget = session("notification-a");
    const newestTarget = session("notification-b");
    const firstLookup = deferredResponse();
    const secondLookup = deferredResponse();
    let sessionListCalls = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = String(input);
      if (url === "/sessions" && init?.method === undefined) {
        sessionListCalls += 1;
        if (sessionListCalls === 1) return firstLookup.promise;
        if (sessionListCalls === 2) return secondLookup.promise;
        return Promise.resolve(jsonResponse({ sessions: [current, staleTarget, newestTarget] }));
      }
      if (url === `/sessions/${newestTarget.id}/resume`) {
        return Promise.resolve(jsonResponse({ session: newestTarget }));
      }
      throw new Error(`unexpected request: ${url}`);
    });

    const staleNotification = focusSessionFromNotification(staleTarget.id);
    const newestNotification = focusSessionFromNotification(newestTarget.id);
    secondLookup.resolve(jsonResponse({ sessions: [current, staleTarget, newestTarget] }));
    await newestNotification;
    firstLookup.resolve(jsonResponse({ sessions: [current, staleTarget, newestTarget] }));
    await staleNotification;

    expect(useAppStore.getState().session?.id).toBe(newestTarget.id);
  });
});
