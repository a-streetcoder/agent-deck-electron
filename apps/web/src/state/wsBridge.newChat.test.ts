import type { SessionMeta } from "@agent-deck/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./clientTransport.ts", () => ({
  RpcClientTransport: class {
    connect(): void {}
    disconnect(): void {}
    send(): void {}
  },
}));

import { newChat } from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

const session = (id: string): SessionMeta => ({
  id,
  cwd: "/tmp/project",
  createdAt: "2026-01-01T00:00:00.000Z",
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({
    session: null,
    sessions: [],
    pendingComposerText: null,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("new chat identity", () => {
  it("returns the exact activated session so a composer seed can be bound to it", async () => {
    const created = session("created");
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ session: created }))
      .mockResolvedValueOnce(jsonResponse({ sessions: [created] }));

    await expect(newChat()).resolves.toEqual(created);
    expect(useAppStore.getState().session?.id).toBe(created.id);
  });

  it("returns null when a newer activation supersedes the pending creation", async () => {
    const stale = session("stale");
    const current = session("current");
    let resolveStale!: (response: Response) => void;
    const staleResponse = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    let postCount = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/sessions" && init?.method === "POST") {
        postCount += 1;
        return postCount === 1
          ? staleResponse
          : Promise.resolve(jsonResponse({ session: current }));
      }
      return Promise.resolve(jsonResponse({ sessions: [current] }));
    });

    const staleCreation = newChat();
    const currentCreation = newChat();
    await expect(currentCreation).resolves.toEqual(current);
    resolveStale(jsonResponse({ session: stale }));

    await expect(staleCreation).resolves.toBeNull();
    expect(useAppStore.getState().session?.id).toBe(current.id);
  });

  it("returns null and rejects stale list data when superseded during refresh", async () => {
    const stale = session("stale-after-connect");
    const current = session("current-after-connect");
    let resolveStaleRefresh!: (response: Response) => void;
    let markStaleRefreshStarted!: () => void;
    const staleRefreshStarted = new Promise<void>((resolve) => {
      markStaleRefreshStarted = resolve;
    });
    const staleRefresh = new Promise<Response>((resolve) => {
      resolveStaleRefresh = resolve;
    });
    let postCount = 0;
    let getCount = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/sessions" && init?.method === "POST") {
        postCount += 1;
        return Promise.resolve(jsonResponse({ session: postCount === 1 ? stale : current }));
      }
      getCount += 1;
      if (getCount === 1) {
        markStaleRefreshStarted();
        return staleRefresh;
      }
      return Promise.resolve(jsonResponse({ sessions: [current] }));
    });

    const staleCreation = newChat();
    await staleRefreshStarted;
    const currentCreation = newChat();
    await expect(currentCreation).resolves.toEqual(current);
    resolveStaleRefresh(jsonResponse({ sessions: [stale] }));

    await expect(staleCreation).resolves.toBeNull();
    expect(useAppStore.getState().session?.id).toBe(current.id);
    expect(useAppStore.getState().sessions.map(({ id }) => id)).toEqual([current.id]);
  });

  it("returns the active session when only its sidebar refresh fails", async () => {
    const created = session("created-with-stale-list");
    vi.mocked(fetch)
      .mockResolvedValueOnce(jsonResponse({ session: created }))
      .mockResolvedValueOnce(jsonResponse({ error: "refresh failed" }, 503));

    await expect(newChat()).resolves.toEqual(created);
    expect(useAppStore.getState().session?.id).toBe(created.id);
    expect(useAppStore.getState().error).toContain("refresh failed");
  });

  it("returns null on failure instead of allowing an unbound seed", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse({ error: "creation failed" }, 500));

    await expect(newChat()).resolves.toBeNull();
    expect(useAppStore.getState().session).toBeNull();
    expect(useAppStore.getState().error).toContain("creation failed");
  });
});
