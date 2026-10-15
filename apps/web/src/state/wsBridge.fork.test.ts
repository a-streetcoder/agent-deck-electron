vi.mock("./remoteComposerDrafts.ts", () => ({
  forgetComposerDraft: vi.fn(),
  restoreComposerDraft: vi.fn(async () => {}),
  flushComposerDraft: vi.fn(async () => {}),
}));
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { forkSession } from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({ error: null });
});

afterEach(() => vi.unstubAllGlobals());

describe("forkSession refusal", () => {
  it("shows the server's 409 reason, not the raw response body (SRV-15a)", async () => {
    const reason = "This session runs on openai-codex/gpt-5.5, which your providers do not offer.";
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ error: reason }, { status: 409 }));
    await forkSession("source");
    expect(useAppStore.getState().error).toBe(`Error: ${reason}`);
  });
});
