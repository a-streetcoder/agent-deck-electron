import { nativeBridge } from "../lib/native.ts";
import { EMPTY_COMPOSER_DRAFT, useAppStore, type ComposerDraft } from "./store.ts";

const enabled = new Set<string>();
const writes = new Map<string, Promise<void>>();
const pending = new Map<string, ComposerDraft | null>();
const failed = new Set<string>();
const generations = new Map<string, number>();
let restoring = false;

/** Restore before activation. A late response never overwrites edits made meanwhile. */
export async function restoreComposerDraft(sessionId: string): Promise<void> {
  if (enabled.has(sessionId)) return;
  const generation = generations.get(sessionId) ?? 0;
  const before = useAppStore.getState().composerDrafts[sessionId];
  const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/composer-draft`);
  if (!response.ok)
    throw new Error("Your saved draft could not be loaded. Please retry opening this chat.");
  const body = (await response.json()) as { draft?: ComposerDraft | null };
  if ((generations.get(sessionId) ?? 0) !== generation) return;
  const editedDuringRestore = useAppStore.getState().composerDrafts[sessionId] !== before;
  if (!editedDuringRestore && body.draft !== undefined) {
    restoring = true;
    try {
      useAppStore
        .getState()
        .updateComposerDraft(sessionId, () => body.draft ?? EMPTY_COMPOSER_DRAFT);
    } finally {
      restoring = false;
    }
  }
  enabled.add(sessionId);
  if (editedDuringRestore) {
    queueDraftSave(sessionId, useAppStore.getState().composerDrafts[sessionId] ?? null);
  }
}

export function forgetComposerDraft(sessionId: string): void {
  generations.set(sessionId, (generations.get(sessionId) ?? 0) + 1);
  enabled.delete(sessionId);
  failed.delete(sessionId);
  writes.delete(sessionId);
  pending.delete(sessionId);
}

export async function flushAllComposerDrafts(): Promise<void> {
  for (const id of failed) queueDraftSave(id, useAppStore.getState().composerDrafts[id] ?? null);
  // Edits arriving while a save settles become part of this same close barrier.
  while (writes.size > 0) await Promise.all([...writes.values()]);
}

nativeBridge()?.onFlushDrafts?.(flushAllComposerDrafts);

export async function flushComposerDraft(sessionId: string): Promise<void> {
  if (failed.has(sessionId))
    queueDraftSave(sessionId, useAppStore.getState().composerDrafts[sessionId] ?? null);
  await writes.get(sessionId);
}

function queueDraftSave(id: string, draft: ComposerDraft | null): void {
  pending.set(id, draft);
  failed.delete(id);
  if (writes.has(id)) return;
  const generation = generations.get(id) ?? 0;
  // One write at a time, retaining only the newest edit queued behind it.
  // Attachments therefore do not get rewritten for every intermediate keystroke.
  const write = Promise.resolve().then(async () => {
    while (enabled.has(id) && (generations.get(id) ?? 0) === generation && pending.has(id)) {
      const next = pending.get(id)!;
      pending.delete(id);
      const response = await fetch(`/sessions/${encodeURIComponent(id)}/composer-draft`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ draft: next }),
      });
      if (!response.ok)
        throw new Error(
          "Your draft could not be saved. Keep this window open and copy your message before restarting the app.",
        );
    }
  });
  writes.set(id, write);
  void write.then(
    () => {
      if (writes.get(id) === write) writes.delete(id);
    },
    (error: unknown) => {
      if (writes.get(id) !== write) return;
      writes.delete(id);
      if (enabled.has(id)) {
        failed.add(id);
        useAppStore.getState().setError(String(error));
      }
    },
  );
}

useAppStore.subscribe((state, previous) => {
  if (restoring || state.composerDrafts === previous.composerDrafts) return;
  for (const id of enabled) {
    if (state.composerDrafts[id] === previous.composerDrafts[id]) continue;
    queueDraftSave(id, state.composerDrafts[id] ?? null);
  }
});

// Closing during an in-flight (or failed) save must require an explicit discard.
// Electron also honors beforeunload, protecting the ephemeral renderer origin.
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if (writes.size === 0 && failed.size === 0) return;
    event.preventDefault();
    event.returnValue = "";
  });
}
