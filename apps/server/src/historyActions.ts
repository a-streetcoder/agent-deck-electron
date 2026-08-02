import type {
  HistoryActionResult,
  ForkProvenance,
  HistoryDraft,
  ImageAttachment,
  SessionMeta,
} from "@agent-deck/contracts";
import type { UserCell } from "@agent-deck/domain";
import { activeEntryChain } from "./services/sessionManager.ts";
import type { SessionManager, ManagedSession } from "./SessionManager.ts";
import type { SessionIndex } from "./persistence.ts";
import type { SessionImageStore } from "./sessionImages.ts";
import type { SessionMutationClaims } from "./sessionMutationClaims.ts";
import type { SessionPasteStore } from "./sessionPastes.ts";

export class HistoryActionError extends Error {
  constructor(
    readonly code:
      | "history_busy"
      | "history_source_missing"
      | "history_entry_missing"
      | "history_runtime_unavailable"
      | "history_cancelled"
      | "history_attachment_missing"
      | "history_failed",
    message: string,
  ) {
    super(message);
    this.name = "HistoryActionError";
  }
}

export const FORK_RECAP_MAX_CHARS = 32_768;

function plainTextBlocks(content: unknown): Array<{ label: string; text: string }> {
  if (typeof content === "string") return [{ label: "", text: content }];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: unknown) => {
    if (!block || typeof block !== "object") return [];
    const value = block as { type?: unknown; text?: unknown; thinking?: unknown };
    if (value.type === "text" && typeof value.text === "string") {
      return [{ label: "", text: value.text }];
    }
    if (value.type === "thinking" && typeof value.thinking === "string") {
      return [{ label: "Thinking", text: value.thinking }];
    }
    return [];
  });
}

/** Build a durable, payload-free recap from canonical active Pi ancestry.
 * The selected user turn itself is the fork origin/composer draft, so only its
 * strict ancestors are inherited by Pi's `fork(entryId)` branch. */
export function deriveForkProvenance(
  data: Awaited<ReturnType<ManagedSession["getEntries"]>>,
  source: SessionMeta,
  sourceEntryId: string,
): ForkProvenance {
  const chain = activeEntryChain(data);
  const selectedIndex = chain.findIndex((entry) => entry.id === sourceEntryId);
  const selected = selectedIndex < 0 ? undefined : chain[selectedIndex];
  if (!selected || selected.type !== "message" || selected.message.role !== "user") {
    throw new HistoryActionError(
      "history_entry_missing",
      "That entry is no longer the selected user message. Refresh the session and try again.",
    );
  }

  const sections: string[] = [];
  for (const entry of chain.slice(0, selectedIndex)) {
    if (entry.type !== "message") continue;
    const role = entry.message.role;
    if (role !== "user" && role !== "assistant") continue;
    for (const block of plainTextBlocks((entry.message as { content?: unknown }).content)) {
      const text = block.text.trim();
      if (!text) continue;
      const label = block.label || (role === "user" ? "User" : "Assistant");
      sections.push(`${label}:\n${text}`);
    }
  }

  const retained = [...sections];
  let recap = retained.join("\n\n");
  let recapTruncated = false;
  while (retained.length > 1 && recap.length > FORK_RECAP_MAX_CHARS) {
    retained.shift();
    recapTruncated = true;
    recap = retained.join("\n\n");
  }
  // An individual recent section can exceed the bound. Preserve a useful tail
  // without ever persisting arbitrary attachment/custom payloads.
  if (recap.length > FORK_RECAP_MAX_CHARS) {
    recap = recap.slice(-FORK_RECAP_MAX_CHARS);
    recapTruncated = true;
  }

  return {
    version: 1,
    sourceSessionId: source.id,
    sourceEntryId,
    sourceTitle: source.title?.trim() || "Untitled chat",
    recap,
    recapTruncated,
  };
}

const waitForIdle = async (session: ManagedSession, timeoutMs = 120_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await session.getState();
    if (!state.isStreaming) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Pi did not return to idle after accepting the re-run prompt");
};

/** Owns the cross-process fork/rebind transaction. Routes only validate input. */
export class HistoryActionCoordinator {
  constructor(
    private readonly sessions: SessionManager,
    private readonly index: SessionIndex,
    private readonly images: SessionImageStore,
    private readonly pastes: SessionPasteStore,
    private readonly claims: SessionMutationClaims,
    private readonly env: () => Record<string, string> | undefined,
    private readonly notifyRebind: (sessionId: string) => void = () => {},
  ) {}

  private async restoreSource(meta: SessionMeta): Promise<void> {
    if (this.sessions.get(meta.id)?.isRunning) return;
    await this.sessions.resume(
      { ...meta, endedAt: undefined },
      { kind: "parent", resumeSessionPath: meta.piSessionFile },
      this.env(),
    );
  }

  async run(
    sessionId: string,
    entryId: string,
    action: "fork" | "rerun",
  ): Promise<HistoryActionResult> {
    const releaseClaim = this.claims.tryClaim(sessionId, "history");
    if (!releaseClaim) {
      throw new HistoryActionError(
        "history_busy",
        "Another session mutation is already in progress for this session.",
      );
    }
    let stagedImages: { rollback: () => void } | undefined;
    let stagedPastes: { rollback: () => void } | undefined;
    let piForked = false;
    let committed = false;
    try {
      let source = this.sessions.get(sessionId);
      let liveMeta = source?.meta ?? this.index.find((item) => item.id === sessionId);
      if (!liveMeta)
        throw new HistoryActionError("history_source_missing", "The session was deleted.");
      const originalMeta = { ...liveMeta };
      if (!source?.isRunning) {
        try {
          source = await this.sessions.resume(
            liveMeta,
            { kind: "parent", resumeSessionPath: liveMeta.piSessionFile },
            this.env(),
          );
          liveMeta = source.meta;
        } catch {
          throw new HistoryActionError(
            "history_runtime_unavailable",
            "The session could not be resumed. Reopen it and try again.",
          );
        }
      }
      const state = await source.getState().catch(() => null);
      if (!state) {
        throw new HistoryActionError(
          "history_runtime_unavailable",
          "Pi runtime state could not be verified. Reopen the session and try again.",
        );
      }
      if (state.isStreaming) {
        throw new HistoryActionError(
          "history_busy",
          "Wait for the current Pi turn to finish before using a history action.",
        );
      }

      const candidates = await source.getForkMessages().catch(() => null);
      const target = candidates?.messages.find((candidate) => candidate.entryId === entryId);
      if (!target) {
        throw new HistoryActionError(
          "history_entry_missing",
          "That message is no longer available in Pi's active history. Refresh the session and try again.",
        );
      }

      let promptImages: ImageAttachment[];
      let pasteProjection: ReturnType<SessionPasteStore["promptProjection"]>;
      let cell: UserCell | undefined;
      let forkProvenance: ForkProvenance;
      try {
        const entries = await source.getEntries();
        // Revalidate stable identity and role against canonical active ancestry
        // immediately before any attachment staging or Pi mutation.
        forkProvenance = deriveForkProvenance(entries, originalMeta, entryId);
        const entry = entries.entries.find((candidate) => candidate.id === entryId);
        if (!entry || entry.type !== "message" || entry.message.role !== "user") {
          throw new HistoryActionError(
            "history_entry_missing",
            "The selected user message changed.",
          );
        }
        const content = (entry.message as { content?: unknown }).content;
        const expectedImages = Array.isArray(content)
          ? content.filter(
              (block: unknown) =>
                block !== null &&
                typeof block === "object" &&
                (block as { type?: unknown }).type === "image",
            ).length
          : 0;
        promptImages = this.images.promptImages(sessionId, entryId);
        if (expectedImages !== promptImages.length) throw new Error("image count mismatch");
        pasteProjection = this.pastes.promptProjection(sessionId, entryId);
        const found = source
          .snapshot()
          .state.cells.find(
            (candidate): candidate is UserCell =>
              candidate.kind === "user" && candidate.entryId === entryId,
          );
        cell = found;
      } catch (error) {
        if (error instanceof HistoryActionError) throw error;
        throw new HistoryActionError(
          "history_attachment_missing",
          "An original image attachment is missing or corrupt. The conversation was not changed.",
        );
      }

      const draft: HistoryDraft = {
        text: pasteProjection?.transcriptText ?? target.text,
        images: promptImages.map((image, index) => ({
          ...image,
          id: `${entryId}-image-${index}`,
          name: `Original image ${index + 1}`,
        })),
        files: (cell?.files ?? []).map((file, index) => ({
          id: `${entryId}-file-${index}`,
          ...file,
        })),
        folders: (cell?.folders ?? []).map((folder, index) => ({
          id: `${entryId}-folder-${index}`,
          ...folder,
        })),
        pastes: pasteProjection?.pastes.map((paste) => ({ ...paste })) ?? [],
      };

      // Rerun attachment ownership is staged while the old branch is still
      // authoritative. Every failure before prompt acceptance rolls it back.
      if (action === "rerun") {
        stagedImages = promptImages.length
          ? this.images.stage(sessionId, target.text, promptImages)
          : undefined;
        stagedPastes = pasteProjection
          ? this.pastes.stage(
              sessionId,
              target.text,
              pasteProjection.transcriptText,
              pasteProjection.pastes,
            )
          : undefined;
      }

      const originalRuntimeFile =
        state.sessionFile ?? source.piSessionFile ?? liveMeta.piSessionFile;
      let forked: Awaited<ReturnType<ManagedSession["forkAtEntry"]>>;
      try {
        forked = await source.forkAtEntry(entryId);
      } catch (error) {
        // A transport/response failure is ambiguous: Pi may have completed the
        // fork and rebound this process before the reply was lost. Compare the
        // authoritative runtime handle before deciding whether restoration is
        // required. An unreadable post-error state is treated conservatively.
        const after = await source.getState().catch(() => null);
        piForked = after === null || after.sessionFile !== originalRuntimeFile;
        throw new HistoryActionError("history_failed", String(error));
      }
      if (forked.cancelled) {
        throw new HistoryActionError("history_cancelled", "The Pi history action was cancelled.");
      }
      piForked = true;
      if (forked.text !== target.text) {
        throw new HistoryActionError(
          "history_failed",
          "Pi returned changed canonical text for the selected entry; the source will be restored.",
        );
      }
      const branchState = await source.getState().catch(() => null);
      const branchFile = branchState?.sessionFile;
      if (!branchFile) {
        throw new HistoryActionError(
          "history_failed",
          "Pi created the branch but did not return a resumable session handle.",
        );
      }

      if (action === "rerun") {
        try {
          await source.prompt(forked.text, promptImages.length ? promptImages : undefined);
          await waitForIdle(source);
        } catch (error) {
          throw new HistoryActionError(
            "history_failed",
            `Pi could not complete the re-run prompt: ${String(error)}`,
          );
        }
      }

      // Pi fork rebinds this process. Stop it before creating another owner.
      await this.sessions.destroy(sessionId);
      if (action === "fork") {
        try {
          const targetSession = await this.sessions.materializeHistoryFork(
            originalMeta,
            branchFile,
            this.env(),
            forkProvenance,
          );
          committed = true;
          return { outcome: "forked", session: targetSession.meta, draft };
        } catch (error) {
          throw new HistoryActionError(
            "history_failed",
            `The fork could not be materialized; the source will be restored when possible: ${String(error)}`,
          );
        }
      }

      try {
        const rebound = await this.sessions.rebindHistoryDeferred(
          originalMeta,
          branchFile,
          this.env(),
        );
        committed = true;
        // Every websocket connection subscribed to this same Deck id must drop
        // its old bus and request a fresh authoritative snapshot.
        this.notifyRebind(sessionId);
        return { outcome: "rerun", session: rebound.meta };
      } catch (error) {
        throw new HistoryActionError(
          "history_failed",
          `The completed re-run branch could not be published. The original session was restored and the Pi branch file was retained for recovery: ${String(error)}`,
        );
      }
    } catch (error) {
      // If Pi already rebound but the transaction did not commit, stop that
      // process and restore the still-authoritative indexed source.
      const indexed = this.index.find((item) => item.id === sessionId);
      if (piForked && !committed && indexed && error instanceof HistoryActionError) {
        if (this.sessions.get(sessionId)?.isRunning) {
          await this.sessions.destroy(sessionId).catch(() => {});
        }
        await this.restoreSource(indexed).catch(() => {});
      }
      throw error;
    } finally {
      if (!committed) {
        try {
          stagedImages?.rollback();
        } catch {
          // Preserve the primary transaction failure.
        }
        try {
          stagedPastes?.rollback();
        } catch {
          // Preserve the primary transaction failure.
        }
      }
      releaseClaim();
    }
  }
}
