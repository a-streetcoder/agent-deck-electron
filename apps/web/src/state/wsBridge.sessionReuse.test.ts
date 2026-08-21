import type { SessionMeta } from "@agent-deck/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transportMock = vi.hoisted(() => ({
  host: undefined as { onServerMessage(message: unknown): void } | undefined,
  connects: [] as string[],
}));

vi.mock("./clientTransport.ts", () => ({
  RpcClientTransport: class {
    constructor(host: { onServerMessage(message: unknown): void }) {
      transportMock.host = host;
    }
    connect(sessionId: string): void {
      transportMock.connects.push(sessionId);
    }
    disconnect(): void {}
    send(): void {}
  },
}));

import { switchToProject } from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

const session = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  cwd: `/tmp/${id}`,
  createdAt: "2026-01-01T00:00:00.000Z",
  ...extra,
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: unknown): string {
  return String(input);
}

function requestMethod(init?: RequestInit): string {
  return (init?.method ?? "GET").toUpperCase();
}

function fetchCalls(): Array<{ url: string; method: string; body?: string }> {
  return vi.mocked(fetch).mock.calls.map(([input, init]) => ({
    url: requestUrl(input),
    method: requestMethod(init),
    ...(typeof init?.body === "string" ? { body: init.body } : {}),
  }));
}

function postSessionCalls(): Array<{ url: string; method: string; body?: string }> {
  return fetchCalls().filter((call) => call.url === "/sessions" && call.method === "POST");
}

function resumeCalls(): Array<{ url: string; method: string }> {
  return fetchCalls().filter((call) => call.method === "POST" && call.url.endsWith("/resume"));
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  transportMock.connects.length = 0;
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({
    session: null,
    sessions: [],
    projects: [],
    currentProjectId: null,
    currentAgentName: null,
    error: null,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("session reuse before subscribe", () => {
  it("resumes a live-looking catalog row instead of creating", async () => {
    const existing = session("index-only");
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = requestUrl(input);
      const method = requestMethod(init);
      if (url === "/sessions" && method === "GET") {
        return Promise.resolve(jsonResponse({ sessions: [existing] }));
      }
      if (url === `/sessions/${existing.id}/resume` && method === "POST") {
        return Promise.resolve(jsonResponse({ session: existing }));
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await switchToProject(null);

    expect(resumeCalls().map((call) => call.url)).toEqual([`/sessions/${existing.id}/resume`]);
    expect(postSessionCalls()).toEqual([]);
    expect(transportMock.connects).toEqual([existing.id]);
    expect(useAppStore.getState().session?.id).toBe(existing.id);
  });

  it.each(["endedAt", "parkedAt"] as const)(
    "still resumes a catalog row with %s",
    async (field) => {
      const existing = session("stopped", { [field]: "2026-01-02T00:00:00.000Z" });
      vi.mocked(fetch).mockImplementation((input, init) => {
        const url = requestUrl(input);
        const method = requestMethod(init);
        if (url === "/sessions" && method === "GET") {
          return Promise.resolve(jsonResponse({ sessions: [existing] }));
        }
        if (url === `/sessions/${existing.id}/resume` && method === "POST") {
          return Promise.resolve(jsonResponse({ session: existing }));
        }
        throw new Error(`unexpected request: ${method} ${url}`);
      });

      await switchToProject(null);

      expect(resumeCalls().map((call) => call.url)).toEqual([`/sessions/${existing.id}/resume`]);
      expect(postSessionCalls()).toEqual([]);
      expect(transportMock.connects).toEqual([existing.id]);
    },
  );

  it("creates only when the catalog is empty", async () => {
    const created = session("fresh");
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = requestUrl(input);
      const method = requestMethod(init);
      if (url === "/sessions" && method === "GET") {
        return Promise.resolve(jsonResponse({ sessions: [] }));
      }
      if (url === "/sessions" && method === "POST") {
        return Promise.resolve(jsonResponse({ session: created }));
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await switchToProject(null);

    expect(resumeCalls()).toEqual([]);
    expect(postSessionCalls()).toHaveLength(1);
    expect(postSessionCalls()[0]?.body).toBe("{}");
    expect(transportMock.connects).toEqual([created.id]);
    expect(useAppStore.getState().session?.id).toBe(created.id);
  });
});

describe("unknown session subscribe recovery", () => {
  it("resumes, creates on 404, reconnects, and clears the error", async () => {
    const dead = session("dead");
    const live = session("live");
    let resumeCount = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = requestUrl(input);
      const method = requestMethod(init);
      if (url === "/sessions" && method === "GET") {
        return Promise.resolve(jsonResponse({ sessions: [dead] }));
      }
      if (url === `/sessions/${dead.id}/resume` && method === "POST") {
        resumeCount += 1;
        if (resumeCount === 1) return Promise.resolve(jsonResponse({ session: dead }));
        return Promise.resolve(jsonResponse({ error: "unknown session" }, 404));
      }
      if (url === "/sessions" && method === "POST") {
        return Promise.resolve(jsonResponse({ session: live }));
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await switchToProject(null);
    expect(transportMock.connects).toEqual([dead.id]);

    transportMock.host?.onServerMessage({
      type: "error",
      message: "unknown session",
      sessionId: dead.id,
    });
    await vi.waitFor(() => {
      expect(useAppStore.getState().session?.id).toBe(live.id);
    });

    expect(resumeCalls()).toHaveLength(2);
    expect(postSessionCalls()).toHaveLength(1);
    expect(postSessionCalls()[0]?.body).toBe("{}");
    expect(transportMock.connects).toEqual([dead.id, live.id]);
    expect(useAppStore.getState().error).toBeNull();
  });

  it("sets the error and does not resume or create for other error strings", async () => {
    const existing = session("live");
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = requestUrl(input);
      const method = requestMethod(init);
      if (url === "/sessions" && method === "GET") {
        return Promise.resolve(jsonResponse({ sessions: [existing] }));
      }
      if (url === `/sessions/${existing.id}/resume` && method === "POST") {
        return Promise.resolve(jsonResponse({ session: existing }));
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await switchToProject(null);
    const resumesBefore = resumeCalls().length;
    const createsBefore = postSessionCalls().length;

    transportMock.host?.onServerMessage({
      type: "error",
      message: "prompt failed",
      sessionId: existing.id,
    });
    await flush();

    expect(useAppStore.getState().error).toBe("prompt failed");
    expect(useAppStore.getState().session?.id).toBe(existing.id);
    expect(resumeCalls()).toHaveLength(resumesBefore);
    expect(postSessionCalls()).toHaveLength(createsBefore);
    expect(transportMock.connects).toEqual([existing.id]);
  });

  it("clears the dead session, keeps the error, and does not recover twice", async () => {
    const dead = session("dead");
    let resumeCount = 0;
    let createCount = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      const url = requestUrl(input);
      const method = requestMethod(init);
      if (url === "/sessions" && method === "GET") {
        return Promise.resolve(jsonResponse({ sessions: [dead] }));
      }
      if (url === `/sessions/${dead.id}/resume` && method === "POST") {
        resumeCount += 1;
        if (resumeCount === 1) return Promise.resolve(jsonResponse({ session: dead }));
        return Promise.resolve(jsonResponse({ error: "unknown session" }, 404));
      }
      if (url === "/sessions" && method === "POST") {
        createCount += 1;
        return Promise.resolve(jsonResponse({ error: "create failed" }, 500));
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    });

    await switchToProject(null);
    transportMock.host?.onServerMessage({
      type: "error",
      message: "unknown session",
      sessionId: dead.id,
    });
    await vi.waitFor(() => {
      expect(useAppStore.getState().session).toBeNull();
      expect(useAppStore.getState().error).toContain("create failed");
    });

    const resumesAfterFailure = resumeCount;
    const createsAfterFailure = createCount;
    expect(useAppStore.getState().error).toContain("create failed");

    transportMock.host?.onServerMessage({
      type: "error",
      message: "unknown session",
      sessionId: dead.id,
    });
    await flush();

    expect(resumeCount).toBe(resumesAfterFailure);
    expect(createCount).toBe(createsAfterFailure);
    expect(useAppStore.getState().session).toBeNull();
    expect(useAppStore.getState().error).not.toBeNull();
    expect(transportMock.connects).toEqual([dead.id]);
  });
});
