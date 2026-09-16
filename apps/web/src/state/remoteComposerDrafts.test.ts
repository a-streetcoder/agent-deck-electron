// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { EMPTY_COMPOSER_DRAFT, useAppStore } from "./store.ts";
import {
  flushComposerDraft,
  forgetComposerDraft,
  restoreComposerDraft,
} from "./remoteComposerDrafts.ts";

afterEach(() => {
  forgetComposerDraft("remote");
  vi.unstubAllGlobals();
});

it("restores backend drafts across renderer origins and serializes subsequent durable writes", async () => {
  useAppStore.setState({ composerDrafts: {} });
  const draft = { ...EMPTY_COMPOSER_DRAFT, text: "Saved before app restart" };
  const request = vi.fn(async () => new Response(JSON.stringify({ draft }), { status: 200 }));
  vi.stubGlobal("fetch", request);
  await restoreComposerDraft("remote");
  expect(useAppStore.getState().composerDrafts.remote).toEqual(draft);
  useAppStore
    .getState()
    .updateComposerDraft("remote", (current) => ({ ...current, text: "Updated" }));
  await flushComposerDraft("remote");
  expect(request).toHaveBeenLastCalledWith(
    "/sessions/remote/composer-draft",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ draft: { ...draft, text: "Updated" } }),
    }),
  );
});

it("retains text and rejects flush when persistence fails", async () => {
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ draft: null }), { status: 200 }))
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 })),
  );
  await restoreComposerDraft("remote");
  useAppStore
    .getState()
    .updateComposerDraft("remote", () => ({ ...EMPTY_COMPOSER_DRAFT, text: "Keep this" }));
  await expect(flushComposerDraft("remote")).rejects.toThrow("draft could not be saved");
  expect(useAppStore.getState().composerDrafts.remote?.text).toBe("Keep this");
});

it("blocks closing while the latest draft save is pending and releases after acknowledgment", async () => {
  let acknowledge!: (response: Response) => void;
  vi.stubGlobal(
    "fetch",
    vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ draft: null }), { status: 200 }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            acknowledge = resolve;
          }),
      ),
  );
  await restoreComposerDraft("remote");
  useAppStore
    .getState()
    .updateComposerDraft("remote", () => ({ ...EMPTY_COMPOSER_DRAFT, text: "Last edit" }));
  const pending = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(pending);
  expect(pending.defaultPrevented).toBe(true);
  await Promise.resolve();
  await Promise.resolve();
  acknowledge(new Response("{}", { status: 200 }));
  await flushComposerDraft("remote");
  const saved = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(saved);
  expect(saved.defaultPrevented).toBe(false);
});

it("saves edits made while a delayed restore is in flight", async () => {
  let finish!: (response: Response) => void;
  const request = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", request);
  const restoring = restoreComposerDraft("remote");
  useAppStore
    .getState()
    .updateComposerDraft("remote", () => ({ ...EMPTY_COMPOSER_DRAFT, text: "New typing" }));
  finish(
    new Response(JSON.stringify({ draft: { ...EMPTY_COMPOSER_DRAFT, text: "Old saved text" } }), {
      status: 200,
    }),
  );
  await restoring;
  await flushComposerDraft("remote");
  expect(useAppStore.getState().composerDrafts.remote?.text).toBe("New typing");
  expect(request).toHaveBeenLastCalledWith(
    "/sessions/remote/composer-draft",
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({ draft: { ...EMPTY_COMPOSER_DRAFT, text: "New typing" } }),
    }),
  );
});

it("retries a failed durable save before allowing quit", async () => {
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ draft: null }), { status: 200 }))
    .mockResolvedValueOnce(new Response("failure", { status: 503 }))
    .mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", request);
  await restoreComposerDraft("remote");
  useAppStore
    .getState()
    .updateComposerDraft("remote", () => ({ ...EMPTY_COMPOSER_DRAFT, text: "Retry me" }));
  await expect(flushComposerDraft("remote")).rejects.toThrow();
  const { flushAllComposerDrafts } = await import("./remoteComposerDrafts.ts");
  await flushAllComposerDrafts();
  expect(request).toHaveBeenCalledTimes(3);
});

it("coalesces rapid edits behind an in-flight save without losing the latest text", async () => {
  let acknowledge!: (response: Response) => void;
  const request = vi
    .fn()
    .mockResolvedValueOnce(new Response(JSON.stringify({ draft: null }), { status: 200 }))
    .mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          acknowledge = resolve;
        }),
    )
    .mockResolvedValue(new Response("{}", { status: 200 }));
  vi.stubGlobal("fetch", request);
  await restoreComposerDraft("remote");
  useAppStore
    .getState()
    .updateComposerDraft("remote", () => ({ ...EMPTY_COMPOSER_DRAFT, text: "a" }));
  await Promise.resolve();
  useAppStore.getState().updateComposerDraft("remote", (current) => ({ ...current, text: "ab" }));
  useAppStore.getState().updateComposerDraft("remote", (current) => ({ ...current, text: "abc" }));
  acknowledge(new Response("{}", { status: 200 }));
  await flushComposerDraft("remote");
  expect(request).toHaveBeenCalledTimes(3);
  expect(request).toHaveBeenLastCalledWith(
    "/sessions/remote/composer-draft",
    expect.objectContaining({
      body: JSON.stringify({ draft: { ...EMPTY_COMPOSER_DRAFT, text: "abc" } }),
    }),
  );
});
