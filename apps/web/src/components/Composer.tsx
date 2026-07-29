import {
  ControlButton,
  ControlInput,
  ControlSelect,
} from "@/design-system/components/NativeControls";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilePlus2, Paperclip, Shrink, X } from "lucide-react";
import TextareaAutosize from "react-textarea-autosize";
import {
  appendFileAttachmentTags,
  fileAttachmentRefs,
  MAX_FILE_ATTACHMENTS,
  openQuestion,
  thinkingLevelsForModel,
} from "@agent-deck/domain";
import {
  EMPTY_COMPOSER_DRAFT,
  pendingComposerTextForSession,
  type ComposerDraftFile,
  type ComposerDraftImage,
  useAppStore,
} from "../state/store.ts";
import { useAgents } from "../state/useAgents.ts";
import {
  sendAbort,
  sendCompact,
  sendPrompt,
  sendSetModel,
  sendSetThinking,
  switchToAgent,
} from "../state/wsBridge.ts";
import {
  ModelChip,
  SendStopButton,
  ThinkingChip,
  chipClass,
  type PiComposerState,
  type PiModelInfo,
} from "./composer/pickers.tsx";
import { SuggestionPanel } from "./composer/SuggestionPanel.tsx";
import { useSuggestions } from "./composer/useSuggestions.ts";
import { ComposerPendingReviewComments } from "./composer/ComposerPendingReviewComments.tsx";
import { appendReviewCommentsToPrompt, type PendingReviewComment } from "../lib/reviewComments.ts";
import { ComposerPendingElementContexts } from "./composer/ComposerPendingElementContexts.tsx";
import {
  appendElementContextsToPrompt,
  type PendingElementContext,
} from "../lib/elementContext.ts";
import { ComposerPendingUserInput } from "./composer/ComposerPendingUserInput.tsx";
import { FileTagChips } from "./composer/FileTagChips.tsx";
import { ExpandedImageDialog } from "./composer/ExpandedImageDialog.tsx";
import { parseFileMentions, removeFileMention } from "../lib/fileMentions.ts";
import { buildExpandedImagePreview } from "../lib/expandedImage.ts";
import { chooseFiles as chooseNativeFiles, isElectron } from "../lib/native.ts";
import {
  createPendingImageId,
  isCurrentComposerSubmission,
  retainUnsubmittedAttachments,
  retainUnsubmittedImages,
  settleComposerImageBatch,
  statusAfterAgentTransition,
  type ComposerSubmitStatus,
} from "../lib/composerSubmission.ts";

/** Stable empty reference so the pending-comments selector never returns a
 * fresh array (which would re-render the composer every store change). */
const EMPTY_COMMENTS: readonly PendingReviewComment[] = [];
/** Stable empty reference for the pending element-context selector (Slice 16). */
const EMPTY_ELEMENT_CONTEXTS: readonly PendingElementContext[] = [];

const PROMPT_IMAGE_MIMES = new Set<ComposerDraftImage["mimeType"]>([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
function isPromptImageMime(value: string): value is ComposerDraftImage["mimeType"] {
  return PROMPT_IMAGE_MIMES.has(value as ComposerDraftImage["mimeType"]);
}
async function fileToImage(file: File): Promise<ComposerDraftImage | null> {
  if (!isPromptImageMime(file.type) || file.size > 15_000_000) return null;
  const buffer = await file.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]!);
  return {
    type: "image",
    data: btoa(binary),
    mimeType: file.type,
    id: createPendingImageId(),
    name: file.name || "pasted image",
  };
}

/** Native `PiAgentRuntimeFooter.compact`: 1_234 → "1k", 2_500_000 → "2.5M". */
function compactTokens(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${Math.floor(value / 1_000)}k`;
  return `${value}`;
}

/**
 * The composer, styled per the native PiAgentComposerBox: a single radius-20
 * content surface with the text editor on top and a footer chip bar (agent,
 * model, thinking) ending in the prominent circular send/stop button.
 */
export function Composer() {
  const pendingComposerText = useAppStore((state) => state.pendingComposerText);
  const setPendingComposerText = useAppStore((state) => state.setPendingComposerText);
  const agentStatus = useAppStore((state) => state.transcript.agentStatus);
  const contextRevision = useAppStore((state) => state.transcript.contextRevision);
  // The single open extension_ui_request (input/select/editor/confirm), surfaced
  // as a composer-anchored pending panel so it is answerable right at the composer
  // (Slice 17). The transcript question-cell still renders; both answer through the
  // same existing ui_response path, and answering either drops both.
  const pendingQuestion = useAppStore((state) => openQuestion(state.transcript));
  const connection = useAppStore((state) => state.connection);
  const queueSettled = useAppStore((state) => state.sessionSubscriptionSettled);
  const session = useAppStore((state) => state.session);
  const sessionId = session?.id ?? null;
  const composerDraft = useAppStore((state) =>
    sessionId ? (state.composerDrafts[sessionId] ?? EMPTY_COMPOSER_DRAFT) : EMPTY_COMPOSER_DRAFT,
  );
  const updateComposerDraft = useAppStore((state) => state.updateComposerDraft);
  const pruneEmptyComposerDraft = useAppStore((state) => state.pruneEmptyComposerDraft);
  const draft = composerDraft.text;
  const images = composerDraft.images;
  const files = composerDraft.files;
  const setDraft = useCallback(
    (next: string | ((current: string) => string)): void => {
      if (!sessionId) return;
      updateComposerDraft(sessionId, (current) => ({
        ...current,
        text: typeof next === "function" ? next(current.text) : next,
      }));
    },
    [sessionId, updateComposerDraft],
  );
  const setImages = useCallback(
    (
      next:
        | readonly ComposerDraftImage[]
        | ((current: readonly ComposerDraftImage[]) => readonly ComposerDraftImage[]),
    ): void => {
      if (!sessionId) return;
      updateComposerDraft(sessionId, (current) => ({
        ...current,
        images: typeof next === "function" ? next(current.images) : next,
      }));
    },
    [sessionId, updateComposerDraft],
  );
  const setFiles = useCallback(
    (
      next:
        | readonly ComposerDraftFile[]
        | ((current: readonly ComposerDraftFile[]) => readonly ComposerDraftFile[]),
    ): void => {
      if (!sessionId) return;
      updateComposerDraft(sessionId, (current) => ({
        ...current,
        files: typeof next === "function" ? next(current.files) : next,
      }));
    },
    [sessionId, updateComposerDraft],
  );
  const currentAgentName = useAppStore((state) => state.currentAgentName);
  // Pending review comments (Slice 12) for the CURRENT session: captured on
  // diff rows, shown as cards above the editor, serialized into the next send.
  const sessionIdForComments = session?.id ?? null;
  const pendingComments = useAppStore((state) =>
    sessionIdForComments
      ? (state.pendingReviewComments[sessionIdForComments] ?? EMPTY_COMMENTS)
      : EMPTY_COMMENTS,
  );
  const removeReviewComment = useAppStore((state) => state.removeReviewComment);
  const requestDiffJump = useAppStore((state) => state.requestDiffJump);
  const openWorkspaceTab = useAppStore((state) => state.openWorkspaceTab);
  // Pending preview element contexts (Slice 16) for the CURRENT session:
  // captured in the preview panel, shown as cards, serialized into the next send.
  const pendingElementContexts = useAppStore((state) =>
    sessionIdForComments
      ? (state.pendingElementContexts[sessionIdForComments] ?? EMPTY_ELEMENT_CONTEXTS)
      : EMPTY_ELEMENT_CONTEXTS,
  );
  const removeElementContext = useAppStore((state) => state.removeElementContext);
  const agents = useAgents();
  const running = agentStatus === "running";
  const pickableAgents = agents.filter((agent) => !agent.shadowed && !agent.disabled);

  const [piState, setPiState] = useState<PiComposerState | null>(null);
  const [models, setModels] = useState<PiModelInfo[]>([]);
  // Live context-window usage (native session context-usage indicator). null
  // until the first LLM response establishes a token estimate.
  const [contextUsage, setContextUsage] = useState<{
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  } | null>(null);
  // Cumulative session token + cost totals (native composer footer: "{n} tokens"
  // and "$x.xx"). null until the first turn establishes a count; cost is null
  // when the provider reports no pricing (free/custom providers price at 0).
  const [sessionTotals, setSessionTotals] = useState<{
    tokens: number;
    cost: number | null;
  } | null>(null);
  // True while a manual compaction is in flight, so the button can't double-fire.
  // Reset on the compaction's contextRevision bump (success) or a safety timeout.
  const [compacting, setCompacting] = useState(false);
  // Guards against a stale session's response/timer clobbering the new one.
  const activeSessionRef = useRef<string | null>(null);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Latest-wins token for the two stats refresh triggers (idle + compaction).
  const statsSeqRef = useRef(0);
  // Previous values so stats refresh only on genuine transitions (a turn
  // completing / a compaction), never on the fresh/initial session state.
  const prevAgentStatusRef = useRef<"idle" | "running" | null>(null);
  /** Blocks duplicate submits until the exact correlated prompt ack settles. */
  const sendLockRef = useRef(false);
  const submissionGenerationRef = useRef(0);
  /** Invalidates File.arrayBuffer completions whenever the active session changes. */
  const imageLoadGenerationRef = useRef(0);
  const [submitting, setSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<ComposerSubmitStatus | null>(null);
  const [streamingBehavior, setStreamingBehavior] = useState<"steer" | "followUp">("steer");
  const previousRunningRef = useRef(false);
  const runningRef = useRef(running);
  runningRef.current = running;
  const prevContextRevisionRef = useRef(0);

  const refreshPiState = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    try {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/state`);
      if (!response.ok || activeSessionRef.current !== sessionId) return;
      const { state } = (await response.json()) as {
        state: { model?: { provider: string; id: string }; thinkingLevel: string };
      };
      if (activeSessionRef.current !== sessionId) return;
      setPiState({
        provider: state.model?.provider,
        modelId: state.model?.id,
        thinkingLevel: state.thinkingLevel,
      });
    } catch {
      // Session may be mid-restart; the next refresh wins.
    }
  }, [sessionId]);

  const scheduleRefresh = useCallback((): void => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    refreshTimerRef.current = setTimeout(() => void refreshPiState(), 300);
  }, [refreshPiState]);

  const refreshStats = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    // Monotonic token: two triggers (idle + contextRevision) fire near a turn
    // boundary, so an older in-flight /stats response must not overwrite a newer
    // one — only the latest request's result is applied.
    const seq = ++statsSeqRef.current;
    try {
      const response = await fetch(`/sessions/${encodeURIComponent(sessionId)}/stats`);
      if (!response.ok || activeSessionRef.current !== sessionId) return;
      const { stats } = (await response.json()) as {
        stats: {
          contextUsage?: { tokens: number | null; contextWindow: number; percent: number | null };
          tokens?: { total?: number };
          cost?: number;
        };
      };
      if (activeSessionRef.current !== sessionId || seq !== statsSeqRef.current) return;
      setContextUsage(stats.contextUsage ?? null);
      // Native hides the token metric until a real count exists (totalTokens !=
      // nil); pi reports 0 pre-turn, so gate on > 0. Cost mirrors native's
      // `if let cost` nil-guard exactly: pi's SessionStats.cost is a non-optional
      // number, so it shows whenever present — a free/custom provider reports 0,
      // which native surfaces as "$0.00" (only a truly absent cost → null).
      const total = stats.tokens?.total;
      setSessionTotals(
        typeof total === "number" && total > 0
          ? {
              tokens: total,
              cost: typeof stats.cost === "number" ? stats.cost : null,
            }
          : null,
      );
    } catch {
      // Session may be mid-restart; the next refresh wins.
    }
  }, [sessionId]);

  useEffect(() => {
    activeSessionRef.current = sessionId;
    // Invalidate every submission callback belonging to the session we just
    // left. The store-id guard also covers the render→effect gap during a switch.
    submissionGenerationRef.current += 1;
    sendLockRef.current = false;
    setSubmitting(false);
    setSubmitStatus(null);
    setPiState(null);
    setModels([]);
    setContextUsage(null);
    setSessionTotals(null);
    setExpandedImageId(null);
    prevAgentStatusRef.current = null;
    if (!sessionId) return;
    void refreshPiState();
    void fetch(`/sessions/${encodeURIComponent(sessionId)}/models`)
      .then((response) => (response.ok ? response.json() : { models: [] }))
      .then((data: { models: Array<{ provider: string; id: string; reasoning?: boolean }> }) => {
        if (activeSessionRef.current === sessionId) {
          setModels(
            data.models.map((m) => ({
              provider: m.provider,
              id: m.id,
              reasoning: m.reasoning,
            })),
          );
        }
      })
      .catch(() => {});
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      // Invalidate reads at the boundary where this composer stops owning the
      // session. Advancing on the next effect would race a file selected from
      // the newly rendered composer and discard that legitimate attachment.
      imageLoadGenerationRef.current += 1;
      if (sessionId) pruneEmptyComposerDraft(sessionId);
    };
  }, [sessionId, refreshPiState, pruneEmptyComposerDraft]);

  // Re-read the context fill ONLY on the two events that change it: a completed
  // TURN (a genuine running→idle transition) and a COMPACTION (contextRevision
  // actually increases — pi runs threshold auto-compaction AFTER agent_end, which
  // the ingest surfaces from the runtime `compaction_end` event). Gating on the
  // transition (not the bare idle/mount state) is deliberate: calling
  // get_session_stats on a FRESH, pre-first-turn session (e.g. just after picking
  // an agent) serialises ahead of the user's prompt in pi's RPC pipeline and can
  // stall the turn — so we never touch stats until a turn has actually run.
  useEffect(() => {
    const prev = prevAgentStatusRef.current;
    prevAgentStatusRef.current = agentStatus;
    if (prev === "running" && agentStatus === "idle" && sessionId) void refreshStats();
  }, [agentStatus, sessionId, refreshStats]);
  useEffect(() => {
    const prev = prevContextRevisionRef.current;
    prevContextRevisionRef.current = contextRevision;
    if (contextRevision > prev && sessionId) {
      void refreshStats();
      setCompacting(false); // a compaction (manual or threshold) landed → re-enable
    }
  }, [contextRevision, sessionId, refreshStats]);

  const suggestions = useSuggestions(sessionId);
  // The current model gates the thinking ladder: a non-reasoning model offers
  // only "off" (native supportsThinking fallback). reasoning comes from the
  // already-fetched models catalog; unknown → full ladder (no flash).
  const currentModel = models.find(
    (m) => m.provider === piState?.provider && m.id === piState?.modelId,
  );
  const thinkingLevels = thinkingLevelsForModel(currentModel?.reasoning);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Full-size preview overlay: the id of the pending image being expanded, or
  // null. Cleared when its image is removed so a stale id can't reopen it.
  const [expandedImageId, setExpandedImageId] = useState<string | null>(null);
  // @-file mentions in the draft, surfaced as removable chips (a view over the
  // text — the literal @path tokens stay in the prompt).
  const fileMentions = useMemo(() => parseFileMentions(draft), [draft]);
  const expandedPreview = expandedImageId
    ? buildExpandedImagePreview(images, expandedImageId)
    : null;
  const pendingInput = useAppStore(
    (state) =>
      state.transcript.pendingInput ?? {
        status: "available" as const,
        steering: [],
        followUp: [],
      },
  );

  useEffect(() => {
    if (running && !previousRunningRef.current) {
      setStreamingBehavior("steer");
      if (images.length > 0) {
        setSubmitStatus({
          kind: "image",
          message: "Remove attached images or wait for Pi to finish before sending.",
        });
      }
    }
    previousRunningRef.current = running;
    setSubmitStatus((current) => statusAfterAgentTransition(current, running));
  }, [running, images.length]);

  // Seed the composer from elsewhere (e.g. an issue) — replaces the draft,
  // since seeding is a deliberate "start on this" action, not an append.
  useEffect(() => {
    const pendingText = pendingComposerTextForSession(pendingComposerText, sessionId);
    if (pendingText === null) return;
    setDraft(pendingText);
    setPendingComposerText(null);
    requestAnimationFrame(() => textareaRef.current?.focus());
  }, [pendingComposerText, sessionId, setDraft, setPendingComposerText]);

  const applyAccept = (accepted: { value: string; caret: number }): void => {
    setSubmitStatus(null);
    setDraft(accepted.value);
    // Restore the caret after React commits the new value.
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.selectionStart = accepted.caret;
        el.selectionEnd = accepted.caret;
      }
    });
  };

  const addFiles = useCallback(
    async (files: FileList | File[]): Promise<void> => {
      const imageFiles = [...files].filter((file) => isPromptImageMime(file.type));
      if (imageFiles.length === 0 || !sessionId) return;
      const originatingSessionId = sessionId;
      const generation = imageLoadGenerationRef.current;
      setSubmitStatus(null);
      if (runningRef.current) {
        setSubmitStatus({
          kind: "image",
          message: "Images can only be added while Pi is idle.",
        });
        return;
      }
      // Cap before encoding so discarded files cannot freeze the renderer.
      const remaining = 8 - images.length;
      if (remaining <= 0) return;
      const candidates = imageFiles.slice(0, remaining);
      const imgs = await settleComposerImageBatch(
        candidates.map(fileToImage),
        originatingSessionId,
        generation,
        () => ({
          sessionId: useAppStore.getState().session?.id ?? null,
          generation: imageLoadGenerationRef.current,
        }),
      );
      // A stale batch must not mutate the newly active session's images or status.
      if (imgs === null) return;
      // Pi may have started while File.arrayBuffer() was pending. Discard the
      // completion rather than introducing an attachment queue_update cannot represent.
      if (runningRef.current) {
        if (imgs.length > 0) {
          setSubmitStatus({
            kind: "image",
            message: "Image loading finished after Pi started; the new image was not added.",
          });
        }
        return;
      }
      if (imgs.length > 0) setImages((previous) => [...previous, ...imgs].slice(0, 8));
    },
    [images.length, sessionId],
  );

  const pickPathFiles = useCallback(async (): Promise<void> => {
    if (!sessionId) return;
    const originatingSessionId = sessionId;
    const selected = await chooseNativeFiles({
      title: "Attach Files",
      buttonLabel: "Attach",
    });
    if (selected.length === 0 || useAppStore.getState().session?.id !== originatingSessionId) {
      return;
    }
    const picked = fileAttachmentRefs(selected);
    if (picked.length === 0) return;
    setSubmitStatus(null);
    setFiles((current) => {
      const seen = new Set(current.map((file) => file.path));
      const added = picked
        .filter((file) => !seen.has(file.path))
        .map((file) => ({ ...file, id: crypto.randomUUID() }));
      return [...current, ...added].slice(0, MAX_FILE_ATTACHMENTS);
    });
  }, [sessionId, setFiles]);

  const submit = (): void => {
    if (sendLockRef.current) return;
    const submittedDraft = draft;
    const message = submittedDraft.trim();
    if (
      (!message &&
        images.length === 0 &&
        files.length === 0 &&
        pendingComments.length === 0 &&
        pendingElementContexts.length === 0) ||
      !session ||
      connection !== "open"
    )
      return;
    if (running && images.length > 0) {
      setSubmitStatus({
        kind: "image",
        message: "Remove attached images or wait for Pi to finish before sending.",
      });
      return;
    }

    const originatingSessionId = session.id;
    const generation = ++submissionGenerationRef.current;
    const isCurrentSubmission = (): boolean =>
      isCurrentComposerSubmission(
        originatingSessionId,
        generation,
        useAppStore.getState().session?.id ?? null,
        submissionGenerationRef.current,
      );
    const submittedComments = [...pendingComments];
    const submittedContexts = [...pendingElementContexts];
    const submittedImages = [...images];
    const submittedFiles = [...files];
    const outgoing = appendFileAttachmentTags(
      appendElementContextsToPrompt(
        appendReviewCommentsToPrompt(message, submittedComments),
        submittedContexts,
      ),
      submittedFiles.map((file) => file.path),
    );
    sendLockRef.current = true;
    setSubmitting(true);
    setSubmitStatus({
      kind: "info",
      message: running ? "Waiting for Pi to acknowledge queued input…" : "Sending…",
    });
    void sendPrompt(
      originatingSessionId,
      outgoing,
      submittedImages.length > 0
        ? submittedImages.map(({ type, data, mimeType }) => ({ type, data, mimeType }))
        : undefined,
      running ? streamingBehavior : undefined,
    )
      .then(() => {
        if (!isCurrentSubmission()) return;
        // Clear only what this acknowledged request submitted. Draft edits and
        // contexts added while the ack was in flight remain untouched.
        setDraft((current) => (current === submittedDraft ? "" : current));
        if (sessionIdForComments) {
          for (const comment of submittedComments) {
            removeReviewComment(sessionIdForComments, comment.id);
          }
          for (const context of submittedContexts) {
            removeElementContext(sessionIdForComments, context.id);
          }
        }
        setImages((current) => retainUnsubmittedImages(current, submittedImages));
        setFiles((current) => retainUnsubmittedAttachments(current, submittedFiles));
        setSubmitStatus(
          running
            ? {
                kind: "info",
                message: streamingBehavior === "steer" ? "Guidance queued." : "Follow-up queued.",
              }
            : null,
        );
        suggestions.close();
      })
      .catch((error: unknown) => {
        if (!isCurrentSubmission()) return;
        // A disconnect after write is ambiguous: retain everything so the user
        // can reconcile against the authoritative queue after reconnect.
        setSubmitStatus({
          kind: "rejection",
          message: `Not acknowledged — draft retained. ${String(error)}`,
        });
      })
      .finally(() => {
        if (!isCurrentSubmission()) return;
        sendLockRef.current = false;
        setSubmitting(false);
      });
  };

  return (
    <div className="px-6 pb-5 pt-2">
      <div className="relative rounded-3xl border border-border-subtle bg-surface-elevated shadow-card">
        {suggestions.mode ? (
          <SuggestionPanel
            items={suggestions.items}
            selectedIndex={suggestions.selectedIndex}
            onHover={suggestions.setSelectedIndex}
            onAccept={(item) => {
              const accepted = suggestions.accept(item);
              if (accepted) applyAccept(accepted);
              textareaRef.current?.focus();
            }}
            testid={suggestions.mode === "slash" ? "slash-panel" : "file-panel"}
          />
        ) : null}

        {pendingQuestion ? <ComposerPendingUserInput question={pendingQuestion} /> : null}

        <ComposerPendingReviewComments
          comments={pendingComments}
          onRemove={(commentId) => {
            if (sessionIdForComments) removeReviewComment(sessionIdForComments, commentId);
          }}
          onJump={(comment) => {
            // Open (or bring to front) the diff tab for this session, then ask it
            // to scroll to the anchored line.
            if (sessionIdForComments) openWorkspaceTab(sessionIdForComments, "diff");
            requestDiffJump({ path: comment.filePath, side: comment.side, line: comment.line });
          }}
        />

        <ComposerPendingElementContexts
          contexts={pendingElementContexts}
          onRemove={(contextId) => {
            if (sessionIdForComments) removeElementContext(sessionIdForComments, contextId);
          }}
        />

        {running ||
        pendingInput.status === "unavailable" ||
        pendingInput.steering.length > 0 ||
        pendingInput.followUp.length > 0 ? (
          <div
            className="mx-3 mt-3 space-y-2 rounded-xl border border-border-subtle bg-surface px-3 py-2 text-xs"
            data-testid="pending-input"
            aria-live="polite"
          >
            {pendingInput.status === "unavailable" ? (
              <p className="text-warning" data-testid="pending-input-unavailable">
                {pendingInput.truncated
                  ? "Queue unavailable: Pi reported more queued input than can be displayed safely."
                  : "Queue unavailable: Pi reported malformed queued input."}
              </p>
            ) : null}
            {pendingInput.status === "available" && pendingInput.steering.length > 0 ? (
              <div>
                <p className="font-medium text-text-secondary">Guidance</p>
                <ol className="list-inside list-decimal text-text-muted">
                  {pendingInput.steering.map((item, index) => (
                    <li key={`steering-${index}`}>{item}</li>
                  ))}
                </ol>
              </div>
            ) : null}
            {pendingInput.status === "available" && pendingInput.followUp.length > 0 ? (
              <div>
                <p className="font-medium text-text-secondary">Follow-ups</p>
                <ol className="list-inside list-decimal text-text-muted">
                  {pendingInput.followUp.map((item, index) => (
                    <li key={`follow-up-${index}`}>{item}</li>
                  ))}
                </ol>
              </div>
            ) : null}
            {running &&
            pendingInput.status === "available" &&
            pendingInput.steering.length === 0 &&
            pendingInput.followUp.length === 0 ? (
              <p className="text-text-muted">No input queued.</p>
            ) : null}
            {!queueSettled ? (
              <p className="text-warning" data-testid="pending-input-stale">
                Queue status may be stale while reconnecting…
              </p>
            ) : null}
          </div>
        ) : null}

        <FileTagChips
          mentions={fileMentions}
          onRemove={(start) => {
            const next = removeFileMention(draft, start);
            setDraft(next);
            requestAnimationFrame(() => textareaRef.current?.focus());
          }}
        />

        {files.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="file-attachments">
            {files.map((file) => (
              <span
                key={file.id}
                data-testid={`file-attachment-${file.id}`}
                title={file.path}
                className="flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-2 py-1 text-xs text-text-secondary"
              >
                <FilePlus2 size={14} aria-hidden="true" />
                <span className="max-w-[20ch] truncate">{file.name}</span>
                <ControlButton
                  className="text-text-muted hover:text-danger"
                  aria-label={`Remove ${file.name} attachment`}
                  onClick={() => {
                    setSubmitStatus(null);
                    setFiles((current) => current.filter((candidate) => candidate !== file));
                  }}
                >
                  <X size={12} />
                </ControlButton>
              </span>
            ))}
          </div>
        ) : null}

        {images.length > 0 ? (
          <div className="flex flex-wrap gap-2 px-3 pt-3" data-testid="attachments">
            {images.map((image) => (
              <span
                key={image.id}
                data-testid={`attachment-${image.id}`}
                className="flex items-center gap-1.5 rounded-lg border border-border-strong bg-surface px-2 py-1 text-xs text-text-secondary"
              >
                <ControlButton
                  type="button"
                  className="rounded outline-none focus-visible:ring-1 focus-visible:ring-accent"
                  aria-label={`Expand ${image.name}`}
                  data-testid={`attachment-expand-${image.id}`}
                  onClick={() => setExpandedImageId(image.id)}
                >
                  <img
                    src={`data:${image.mimeType};base64,${image.data}`}
                    alt={image.name}
                    className="h-8 w-8 cursor-zoom-in rounded object-cover"
                  />
                </ControlButton>
                <span className="max-w-[12ch] truncate">{image.name}</span>
                <ControlButton
                  className="text-text-muted hover:text-danger"
                  aria-label="Remove attachment"
                  onClick={() => {
                    setSubmitStatus(null);
                    setImages((prev) => {
                      if (expandedImageId === image.id) setExpandedImageId(null);
                      return prev.filter((i) => i.id !== image.id);
                    });
                  }}
                >
                  <X size={12} />
                </ControlButton>
              </span>
            ))}
          </div>
        ) : null}

        <TextareaAutosize
          ref={textareaRef}
          data-testid="composer-input"
          className="block w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-sm text-text-primary outline-none placeholder:text-text-muted"
          placeholder={
            running
              ? streamingBehavior === "steer"
                ? "Guide the current response…"
                : "Queue a follow-up prompt…"
              : "Message pi ( / commands, @ files )"
          }
          minRows={2}
          maxRows={6}
          aria-label="Message Pi"
          value={draft}
          onChange={(event) => {
            setSubmitStatus(null);
            setDraft(event.target.value);
            suggestions.update(
              event.target.value,
              event.target.selectionStart ?? event.target.value.length,
            );
          }}
          onPaste={(event) => {
            const files = [...event.clipboardData.items]
              .map((item) => item.getAsFile())
              .filter((f): f is File => f !== null);
            if (files.some((f) => f.type.startsWith("image/"))) {
              event.preventDefault();
              void addFiles(files);
            }
          }}
          onKeyDown={(event) => {
            if (suggestions.handleKeyDown(event)) return;
            if ((event.key === "Enter" || event.key === "Tab") && suggestions.mode) {
              const item = suggestions.items[suggestions.selectedIndex];
              if (item) {
                event.preventDefault();
                const accepted = suggestions.accept(item);
                if (accepted) applyAccept(accepted);
                return;
              }
            }
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
        />
        {/* flex-wrap: with the Slice-10 diff panel open the chat column can
            drop under this row's intrinsic width — the chips wrap instead of
            sliding (unclickably) beneath the panel. */}
        <div className="flex flex-wrap items-center gap-2 px-3 pb-3 pt-1">
          <label className={chipClass()} title="Agent">
            <ControlSelect
              data-testid="agent-picker"
              className="max-w-[18ch] cursor-pointer truncate bg-transparent text-xs font-medium outline-none"
              value={currentAgentName ?? ""}
              disabled={running}
              onChange={(event) => void switchToAgent(event.target.value || null)}
            >
              <option value="">Pi Agent</option>
              {pickableAgents.map((agent) => (
                <option key={agent.filePath} value={agent.name}>
                  {agent.name} ({agent.scope})
                </option>
              ))}
            </ControlSelect>
          </label>
          <ModelChip
            state={piState}
            models={models}
            disabled={running}
            onSelect={(model) => {
              if (runningRef.current) return;
              sendSetModel(model.provider, model.id);
              setPiState((prev) =>
                prev ? { ...prev, provider: model.provider, modelId: model.id } : prev,
              );
              scheduleRefresh();
            }}
          />
          <ThinkingChip
            state={piState}
            levels={thinkingLevels}
            disabled={running}
            onSelect={(level) => {
              if (runningRef.current) return;
              sendSetThinking(level);
              setPiState((prev) => (prev ? { ...prev, thinkingLevel: level } : prev));
              scheduleRefresh();
            }}
          />
          {/* Context-window usage (native session context-usage indicator). Only
              shown once pi has a token estimate (after the first response). */}
          {contextUsage && contextUsage.percent != null ? (
            <span
              data-testid="context-usage"
              className={chipClass()}
              title={
                contextUsage.tokens != null
                  ? `${contextUsage.tokens.toLocaleString()} / ${contextUsage.contextWindow.toLocaleString()} context tokens`
                  : `context window ${contextUsage.contextWindow.toLocaleString()} tokens`
              }
            >
              {Math.round(contextUsage.percent)}% ctx
            </span>
          ) : null}
          {/* Cumulative session token + cost totals (native footer metrics).
              Shown once a turn has reported tokens; cost only when priced. */}
          {sessionTotals ? (
            <span
              data-testid="session-tokens"
              className={chipClass()}
              title={`${sessionTotals.tokens.toLocaleString()} tokens this session`}
            >
              {compactTokens(sessionTotals.tokens)} tokens
            </span>
          ) : null}
          {sessionTotals && sessionTotals.cost != null ? (
            <span
              data-testid="session-cost"
              className={chipClass()}
              title={`$${sessionTotals.cost.toFixed(4)} this session`}
            >
              ${sessionTotals.cost.toFixed(2)}
            </span>
          ) : null}
          {/* Manual "Compact context" (native PiAgentComposerViews.swift:1464):
              pi summarizes older history to free context. Shown alongside the
              context chip (after a turn); disabled mid-stream. */}
          {contextUsage ? (
            <ControlButton
              type="button"
              data-testid="compact-button"
              className="flex h-7 w-7 items-center justify-center rounded-full text-text-muted hover:bg-hover hover:text-text-primary disabled:opacity-40"
              title="Compact context — Pi summarizes older history to free up context"
              disabled={running || compacting}
              onClick={() => {
                if (
                  window.confirm(
                    "Compact context? Pi will summarize older conversation history to free up context.",
                  )
                ) {
                  setCompacting(true);
                  sendCompact();
                  // Safety re-enable if no contextRevision bump arrives (e.g. pi
                  // rejects "nothing to compact") — the success path resets sooner.
                  window.setTimeout(() => setCompacting(false), 15_000);
                }
              }}
            >
              <Shrink size={13} />
            </ControlButton>
          ) : null}
          {running ? (
            <label className={chipClass()} title="Choose where this prompt is queued">
              <span className="sr-only">Running prompt mode</span>
              <ControlSelect
                data-testid="streaming-behavior"
                className="cursor-pointer bg-transparent text-xs font-medium outline-none"
                value={streamingBehavior}
                disabled={submitting}
                onChange={(event) => {
                  setSubmitStatus(null);
                  setStreamingBehavior(event.target.value as "steer" | "followUp");
                }}
              >
                <option value="steer">Guide now</option>
                <option value="followUp">Follow up</option>
              </ControlSelect>
            </label>
          ) : null}
          <div className="flex-1" />
          {isElectron() ? (
            <ControlButton
              type="button"
              className="flex h-8 w-8 items-center justify-center rounded-full text-text-muted hover:bg-hover hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
              title="Attach files by path"
              aria-label="Attach files"
              data-testid="attach-file-button"
              disabled={!sessionId}
              onClick={() => void pickPathFiles()}
            >
              <FilePlus2 size={15} />
            </ControlButton>
          ) : null}
          <label
            className={`flex h-8 w-8 items-center justify-center rounded-full text-text-muted ${
              running || !sessionId
                ? "cursor-not-allowed opacity-40"
                : "cursor-pointer hover:bg-hover hover:text-text-primary"
            }`}
            title={
              running
                ? "Images can only be sent when Pi is idle"
                : sessionId
                  ? "Attach image"
                  : "Wait for the chat to connect before attaching an image"
            }
            aria-disabled={running || !sessionId}
            data-testid="attach-button"
          >
            <Paperclip size={15} />
            <ControlInput
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              data-testid="attach-input"
              disabled={running || !sessionId}
              onChange={(event) => {
                if (event.target.files) void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
          </label>
          <SendStopButton
            running={running}
            disabled={
              submitting ||
              (!draft.trim() &&
                images.length === 0 &&
                files.length === 0 &&
                pendingComments.length === 0 &&
                pendingElementContexts.length === 0) ||
              !session ||
              connection !== "open" ||
              (running && images.length > 0)
            }
            onSend={submit}
            onStop={sendAbort}
          />
        </div>
      </div>
      {submitStatus ? (
        <p
          className={`px-3 pt-2 text-xs ${submitStatus.kind === "rejection" || submitStatus.kind === "image" ? "text-danger" : "text-text-muted"}`}
          data-testid="composer-submit-status"
          role="status"
        >
          {submitStatus.message}
        </p>
      ) : null}
      {expandedPreview ? (
        <ExpandedImageDialog preview={expandedPreview} onClose={() => setExpandedImageId(null)} />
      ) : null}
    </div>
  );
}
