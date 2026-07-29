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

  it("keeps text and pending attachments scoped to their session for the store lifetime", () => {
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
      files: [{ id: "first-file", name: "notes.txt", path: "/tmp/notes.txt" }],
      folders: [{ id: "first-folder", name: "project", path: "/tmp/project" }],
      pastes: [{ id: 1, marker: "[paste #1 1001 chars]", text: "x".repeat(1_001) }],
    }));
    store.updateComposerDraft("second", () => ({
      text: "Unsent second message",
      images: [],
      files: [],
      folders: [],
      pastes: [],
    }));

    expect(useAppStore.getState().composerDrafts).toMatchObject({
      first: {
        text: "Unsent first message",
        images: [{ id: "first-image", name: "first.png" }],
        files: [{ id: "first-file", name: "notes.txt", path: "/tmp/notes.txt" }],
        folders: [{ id: "first-folder", name: "project", path: "/tmp/project" }],
        pastes: [{ id: 1, marker: "[paste #1 1001 chars]" }],
      },
      second: {
        text: "Unsent second message",
        images: [],
        files: [],
        folders: [],
        pastes: [],
      },
    });
  });

  it("clears only the empty draft and removes deleted session drafts", () => {
    const store = useAppStore.getState();
    store.setSessions([session("first"), session("second")]);
    store.updateComposerDraft("first", () => ({
      text: "First",
      images: [],
      files: [],
      folders: [],
      pastes: [],
    }));
    store.updateComposerDraft("second", () => ({
      text: "Second",
      images: [],
      files: [],
      folders: [],
      pastes: [],
    }));

    store.updateComposerDraft("first", (current) => ({ ...current, text: "" }));
    expect(useAppStore.getState().composerDrafts).toEqual({
      second: { text: "Second", images: [], files: [], folders: [], pastes: [] },
    });

    store.removeSession("second");
    expect(useAppStore.getState().composerDrafts).toEqual({});
  });

  it("keeps a folder-only draft until that folder is removed", () => {
    const store = useAppStore.getState();
    store.updateComposerDraft("first", () => ({
      text: "",
      images: [],
      files: [],
      folders: [{ id: "folder", name: "project", path: "/tmp/project" }],
      pastes: [],
    }));
    expect(useAppStore.getState().composerDrafts.first?.folders).toHaveLength(1);

    store.updateComposerDraft("first", (current) => ({ ...current, folders: [] }));
    expect(useAppStore.getState().composerDrafts.first).toBeUndefined();
  });

  it("prunes whitespace-only text only after its composer is left", () => {
    const store = useAppStore.getState();
    store.updateComposerDraft("first", () => ({
      text: "   \n",
      images: [],
      files: [],
      folders: [],
      pastes: [],
    }));
    store.updateComposerDraft("second", () => ({
      text: "Second",
      images: [],
      files: [],
      folders: [],
      pastes: [],
    }));

    expect(useAppStore.getState().composerDrafts.first?.text).toBe("   \n");
    store.pruneEmptyComposerDraft("first");

    expect(useAppStore.getState().composerDrafts).toEqual({
      second: { text: "Second", images: [], files: [], folders: [], pastes: [] },
    });
  });

  it("keeps a marker-only paste draft until both marker and payload are removed", () => {
    const store = useAppStore.getState();
    const paste = { id: 1, marker: "[paste #1 1001 chars]", text: "x".repeat(1_001) };
    store.updateComposerDraft("first", () => ({
      text: paste.marker,
      images: [],
      files: [],
      folders: [],
      pastes: [paste],
    }));
    expect(useAppStore.getState().composerDrafts.first?.pastes).toEqual([paste]);

    store.updateComposerDraft("first", (current) => ({ ...current, text: "", pastes: [] }));
    expect(useAppStore.getState().composerDrafts.first).toBeUndefined();
  });
});
