// @vitest-environment jsdom
vi.mock("./remoteComposerDrafts.ts", () => ({
  forgetComposerDraft: vi.fn(),
  restoreComposerDraft: vi.fn(async () => {}),
  flushComposerDraft: vi.fn(async () => {}),
}));
import type { SessionMeta } from "@agent-deck/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const transportMock = vi.hoisted(() => ({
  host: undefined as { onSessionSubscribed?(sessionId: string): void } | undefined,
}));
vi.mock("./clientTransport.ts", () => ({
  RpcClientTransport: class {
    constructor(host: { onSessionSubscribed?(sessionId: string): void }) {
      transportMock.host = host;
    }
    connect(): void {}
    disconnect(): void {}
    send(): void {}
  },
}));

import { connectAndBootstrap, sessionLink } from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

const session = (id: string): SessionMeta => ({ id, cwd: `/tmp/${id}`, createdAt: "now" });
const json = (body: unknown): Response => Response.json(body);

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({ session: session("current"), sessions: [session("current")] });
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.history.replaceState(null, "", "/");
});

it("SRV-15b: ?session=<id> opens that session at boot instead of the newest one", async () => {
  window.history.replaceState(null, "", "/?session=target&onboarding");
  const target = session("target");
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/projects") return json({ projects: [] });
    if (url === "/sessions") return json({ sessions: [session("current"), target] });
    if (url === "/sessions/target/resume") return json({ session: target });
    return new Response("{}", { status: 404 });
  });

  await connectAndBootstrap();
  const search = new URLSearchParams(window.location.search);
  expect(search.has("session")).toBe(false);
  expect(search.has("onboarding")).toBe(true);
  expect(useAppStore.getState().session?.id).toBe("target");
  expect(useAppStore.getState().view).toBe("chat");
  // No other session was resumed first.
  const resumed = vi
    .mocked(fetch)
    .mock.calls.map(([input]) => String(input))
    .filter((url) => url.endsWith("/resume"));
  expect(resumed).toEqual(["/sessions/target/resume"]);
});

it("SRV-15b: an unknown or deleted id shows a notice and boots as usual", async () => {
  window.history.replaceState(null, "", "/?session=gone");
  useAppStore.setState({ toasts: [] });
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/projects") return json({ projects: [] });
    if (url === "/sessions") return json({ sessions: [session("current")] });
    if (url === "/sessions/current/resume") return json({ session: session("current") });
    return new Response("{}", { status: 404 });
  });

  await connectAndBootstrap();
  expect(useAppStore.getState().toasts.map((toast) => toast.message)).toEqual([
    "The shared session no longer exists.",
  ]);
  expect(window.location.search).toBe("");
  // The usual boot: the newest project-less session.
  expect(useAppStore.getState().session?.id).toBe("current");
});

it("SRV-15b: the copied link opens the session on this server", () => {
  expect(sessionLink("a b")).toBe(`${window.location.origin}/?session=a%20b`);
});

it("SRV-12b: ?project=<id> opens a new draft in that project, never resuming a session", async () => {
  window.history.replaceState(null, "", "/?project=shared-1");
  const project = { id: "shared-1", path: "/srv/app", name: "app", createdAt: "now" };
  const theirs = { ...session("theirs"), projectId: "shared-1" };
  const draft = { ...session("draft-1"), projectId: "shared-1", lifecycle: "draft" as const };
  let created: unknown;
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const url = String(input);
    if (url === "/projects") return json({ projects: [project] });
    if (url === "/sessions" && init?.method === "POST") {
      created = JSON.parse(String(init.body));
      return json({ session: draft });
    }
    if (url.startsWith("/sessions")) return json({ sessions: [theirs] });
    return new Response("{}", { status: 404 });
  });

  await connectAndBootstrap();
  expect(window.location.search).toBe("");
  expect(created).toEqual({ projectId: "shared-1" });
  expect(useAppStore.getState().session?.id).toBe("draft-1");
  const resumed = vi
    .mocked(fetch)
    .mock.calls.map(([input]) => String(input))
    .filter((url) => url.endsWith("/resume"));
  expect(resumed).toEqual([]);
});

it("SRV-12b: an unknown ?project= id shows a notice and boots as usual", async () => {
  window.history.replaceState(null, "", "/?project=gone");
  useAppStore.setState({ toasts: [] });
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/projects") return json({ projects: [] });
    if (url.startsWith("/sessions?") || url === "/sessions")
      return json({ sessions: [session("current")] });
    if (url === "/sessions/current/resume") return json({ session: session("current") });
    return new Response("{}", { status: 404 });
  });
  await connectAndBootstrap();
  expect(useAppStore.getState().toasts.map((toast) => toast.message)).toEqual([
    "The shared project is not on this server.",
  ]);
});
