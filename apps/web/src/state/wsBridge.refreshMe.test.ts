vi.mock("./remoteComposerDrafts.ts", () => ({
  forgetComposerDraft: vi.fn(),
  restoreComposerDraft: vi.fn(async () => {}),
  flushComposerDraft: vi.fn(async () => {}),
}));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshMe } from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

const ale = { id: "ale@example.com", email: "ale@example.com", providersConnected: false };
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({ me: ale });
});
afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.setState({ me: null });
});

it("SRV-13: keeps the last known identity when /me fails", async () => {
  vi.mocked(fetch).mockRejectedValueOnce(new TypeError("network down"));
  await refreshMe();
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: "busy" }, { status: 503 }));
  await refreshMe();
  expect(useAppStore.getState().me).toEqual(ale);
});

it("updates on a successful answer, and clears only on user null", async () => {
  vi.mocked(fetch).mockResolvedValueOnce(
    Response.json({ user: { ...ale, providersConnected: true } }),
  );
  await refreshMe();
  expect(useAppStore.getState().me?.providersConnected).toBe(true);
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ user: null }));
  await refreshMe();
  expect(useAppStore.getState().me).toBeNull();
});
