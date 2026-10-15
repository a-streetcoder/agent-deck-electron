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

import { sessionLink } from "./wsBridge.ts";
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

it("SRV-15b: ?session=<id> opens that session once subscribed, then leaves the URL", async () => {
  window.history.replaceState(null, "", "/?session=target&onboarding");
  const target = session("target");
  vi.mocked(fetch).mockImplementation(async (input) => {
    const url = String(input);
    if (url === "/sessions") return json({ sessions: [session("current"), target] });
    if (url === "/sessions/target/resume") return json({ session: target });
    return new Response("{}", { status: 404 });
  });

  transportMock.host?.onSessionSubscribed?.("current");
  expect(new URLSearchParams(window.location.search).has("session")).toBe(false);
  expect(new URLSearchParams(window.location.search).has("onboarding")).toBe(true);
  await vi.waitFor(() => expect(useAppStore.getState().session?.id).toBe("target"));
  expect(useAppStore.getState().view).toBe("chat");

  // Consumed: a later subscription (reconnect) does not switch again.
  vi.mocked(fetch).mockClear();
  transportMock.host?.onSessionSubscribed?.("target");
  expect(vi.mocked(fetch).mock.calls.map(([input]) => String(input))).not.toContain("/sessions");
});

it("SRV-15b: the copied link opens the session on this server", () => {
  expect(sessionLink("a b")).toBe(`${window.location.origin}/?session=a%20b`);
});
