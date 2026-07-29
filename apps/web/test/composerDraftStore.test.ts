import type { SessionMeta } from "@agent-deck/contracts";
import { afterEach, describe, expect, it } from "vitest";
import { pendingComposerTextForSession, useAppStore } from "../src/state/store.ts";

const session = (id: string): SessionMeta => ({
  id,
  cwd: "/tmp/project",
  createdAt: "2026-01-01T00:00:00.000Z",
});

afterEach(() => {
  useAppStore.setState({
    session: null,
    sessions: [],
    composerDrafts: {},
  });
});

describe("composer drafts", () => {
  it("offers one-shot text only to its owning session", () => {
    const pending = { sessionId: "first", text: "Bound seed" };

    expect(pendingComposerTextForSession(pending, "first")).toBe("Bound seed");
    expect(pendingComposerTextForSession(pending, "second")).toBeNull();
    expect(pendingComposerTextForSession(pending, null)).toBeNull();
  });

  it("keeps text and pending images scoped to their session for the store lifetime", () => {
    const store = useAppStore.getState();
    store.updateComposerDraft("first", () => ({
      text: "Unsent first message",
      images: [
        {
          type: "image",
          data: "aGVsbG8=",
          mimeType: "image/png",
          id: "first-image",
          name: "first.png",
        },
      ],
    }));
    store.updateComposerDraft("second", () => ({
      text: "Unsent second message",
      images: [],
    }));

    expect(useAppStore.getState().composerDrafts).toMatchObject({
      first: {
        text: "Unsent first message",
        images: [{ id: "first-image", name: "first.png" }],
      },
      second: {
        text: "Unsent second message",
        images: [],
      },
    });
  });

  it("clears only the empty draft and removes deleted session drafts", () => {
    const store = useAppStore.getState();
    store.setSessions([session("first"), session("second")]);
    store.updateComposerDraft("first", () => ({ text: "First", images: [] }));
    store.updateComposerDraft("second", () => ({ text: "Second", images: [] }));

    store.updateComposerDraft("first", (current) => ({ ...current, text: "" }));
    expect(useAppStore.getState().composerDrafts).toEqual({
      second: { text: "Second", images: [] },
    });

    store.removeSession("second");
    expect(useAppStore.getState().composerDrafts).toEqual({});
  });

  it("prunes whitespace-only text only after its composer is left", () => {
    const store = useAppStore.getState();
    store.updateComposerDraft("first", () => ({ text: "   \n", images: [] }));
    store.updateComposerDraft("second", () => ({ text: "Second", images: [] }));

    expect(useAppStore.getState().composerDrafts.first?.text).toBe("   \n");
    store.pruneEmptyComposerDraft("first");

    expect(useAppStore.getState().composerDrafts).toEqual({
      second: { text: "Second", images: [] },
    });
  });
});
