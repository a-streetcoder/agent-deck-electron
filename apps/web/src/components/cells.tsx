import { AppCopyButton } from "@/design-system/components/AppCopyButton";
import { ControlButton, ControlTextArea } from "@/design-system/components/NativeControls";
import { useEffect, useId, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import {
  Brain,
  CheckCircle2,
  FolderOpen,
  GitFork,
  Hourglass,
  MessageSquareText,
  RotateCcw,
  Send,
  TriangleAlert,
} from "lucide-react";
import {
  memoryToolCardLabel,
  type MemoryRecallCell,
  type ProviderRetryCell,
  type QuestionCell,
  type SubagentCell,
  type SupervisorQuestionCell,
  type ToolCell,
  type TranscriptCell,
} from "@agent-deck/domain";
import {
  DEFAULT_TRANSCRIPT_VISIBILITY,
  type TranscriptVisibilitySettings,
} from "@agent-deck/contracts";
import { balance } from "@/design-system/markdown/balancer";
import { MessageBubble } from "@/components/transcript/MessageBubble";
import { ToolGroupCard, type ToolGroupStatus } from "@/components/transcript/ToolGroupCard";
import {
  toolFilePath,
  toolFileReference,
  toolPresentation,
} from "@/components/transcript/toolPresentation";
import { OpenInPicker, type OpenInEditorController } from "@/components/diff/OpenInPicker";
import { AskUserDecisionCard } from "./AskUserDecisionCard.tsx";
import { RunMeta } from "./RunMeta.tsx";
import { QuestionAnswerControls } from "./QuestionAnswerControls.tsx";
import {
  historyActionPending,
  runHistoryAction,
  sendSupervisorAnswer,
  subscribeHistoryActionPending,
} from "../state/wsBridge.ts";
import { useAppStore } from "../state/store.ts";
import {
  getImageReadToken,
  sessionImageUrl,
  subscribeImageReadToken,
} from "../lib/sessionImageUrl.ts";
import { ExpandedImageDialog } from "./composer/ExpandedImageDialog.tsx";
import { PastePreviewDialog } from "./transcript/PastePreviewDialog.tsx";
import { visibleAssistantBlocks } from "../lib/transcriptVisibility.ts";
import { canRevealSubagentArtifacts, revealSubagentArtifacts } from "../lib/native.ts";
import { ChildTranscriptDialog } from "./ChildTranscriptDialog.tsx";
import { useFocusTrap } from "../lib/useFocusTrap.ts";

const TOOL_STATUS: Record<ToolCell["status"], ToolGroupStatus> = {
  running: "running",
  done: "result",
  error: "failed",
};

// Only these tools show a file-path header — so a non-file tool that happens to
// carry a `path`-like arg (e.g. bash) doesn't get a spurious one.
const FILE_TOOLS = new Set(["read", "edit", "write"]);

function ToolCellView({
  cell,
  editorController,
}: {
  cell: ToolCell;
  editorController?: OpenInEditorController;
}) {
  const session = useAppStore((state) => state.session);
  const argsText =
    cell.args === undefined ? null : (
      <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-xs text-text-muted">
        {typeof cell.args === "string" ? cell.args : JSON.stringify(cell.args, null, 2)}
      </pre>
    );
  const resultText =
    cell.result === undefined ? null : (
      <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs text-text-secondary">
        {typeof cell.result === "string" ? cell.result : JSON.stringify(cell.result, null, 2)}
      </pre>
    );
  // Agent Deck memory tools render as native "Memory Stored / Searched / …"
  // cards (Brain icon, friendly label) instead of the raw tool name.
  const memoryLabel = memoryToolCardLabel(cell);
  // Every other tool gets a friendly name + a distinct icon (native toolVerb /
  // toolIcon) instead of the raw tool name under one generic terminal glyph.
  const preso = memoryLabel ? null : toolPresentation(cell.toolName);
  const PresoIcon = preso?.Icon;
  const filePath = FILE_TOOLS.has(cell.toolName.toLowerCase())
    ? toolFilePath(cell.args)
    : undefined;
  const fileReference = filePath && session ? toolFileReference(cell.args, session.cwd) : undefined;
  return (
    <div
      data-testid="tool-cell"
      data-memory-card={memoryLabel ?? undefined}
      data-tool={memoryLabel ? undefined : cell.toolName}
    >
      <ToolGroupCard
        name={memoryLabel ?? preso!.name}
        variant={memoryLabel ? "memory" : preso!.variant}
        icon={PresoIcon ? ({ className }) => <PresoIcon className={className} /> : undefined}
        status={TOOL_STATUS[cell.status]}
        defaultExpanded={cell.status === "running"}
        body={
          <div className="space-y-2">
            {filePath ? (
              <div className="flex items-center gap-1" data-testid="tool-file-path-row">
                <div
                  className="min-w-0 flex-1 break-all font-mono text-detail text-text-secondary"
                  data-testid="tool-file-path"
                >
                  {filePath}
                </div>
                {fileReference && editorController ? (
                  <OpenInPicker
                    available={editorController.available}
                    preferred={editorController.preferred}
                    onOpen={(editor) =>
                      editorController.open(fileReference.rpcPath, undefined, editor)
                    }
                  />
                ) : null}
              </div>
            ) : null}
            {argsText}
            {resultText}
          </div>
        }
      />
    </div>
  );
}

function MemoryRecallCellView({ cell }: { cell: MemoryRecallCell }) {
  const titleId = useId();
  const requestMemoryNavigation = useAppStore((state) => state.requestMemoryNavigation);

  return (
    <section
      className="rounded-xl border border-border-subtle bg-surface-elevated px-3 py-2"
      aria-labelledby={titleId}
      data-testid="memory-recall-cell"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <Brain size={16} className="shrink-0 text-accent" aria-hidden />
        <h3 id={titleId}>Memory recalled</h3>
      </div>
      <div className="mt-2 space-y-1" data-testid="memory-recall-list">
        {cell.memories.map((memory) => (
          <ControlButton
            key={memory.id}
            type="button"
            className="flex w-full min-w-0 items-center gap-2 rounded-lg border border-border-subtle bg-surface px-2.5 py-2 text-left hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            onClick={() =>
              requestMemoryNavigation({
                projectId: cell.projectId,
                memoryId: memory.id,
                titleSnapshot: memory.title,
              })
            }
            aria-label={`Open memory ${memory.title}`}
            data-testid={`memory-recall-${memory.id}`}
          >
            <span className="shrink-0 rounded-capsule border border-border-subtle px-1.5 text-micro text-text-muted">
              {memory.type}
            </span>
            <span className="min-w-0 truncate text-sm font-medium text-text-primary">
              {memory.title}
            </span>
          </ControlButton>
        ))}
      </div>
    </section>
  );
}

function ProviderRetryCellView({ cell }: { cell: ProviderRetryCell }) {
  const accessibleId = useId();
  const retrying = cell.status === "retrying";
  const succeeded = cell.status === "succeeded";
  const Icon = retrying
    ? cell.isQuotaLimit
      ? Hourglass
      : RotateCcw
    : succeeded
      ? CheckCircle2
      : TriangleAlert;
  const headline = retrying
    ? cell.isQuotaLimit
      ? "Usage limit reached — retrying"
      : "Retrying model provider request"
    : succeeded
      ? "Request succeeded after retrying"
      : "Model provider stopped retrying";
  const accent = succeeded ? "text-success" : retrying ? "text-warning" : "text-danger";
  const border = succeeded
    ? "border-success/30 bg-success/5"
    : retrying
      ? "border-warning/30 bg-warning/5"
      : "border-danger/30 bg-danger/5";
  const attempt = retrying
    ? `Attempt ${cell.attempt}${cell.maxAttempts ? ` of ${cell.maxAttempts}` : ""} · Waiting to retry`
    : `${cell.attempt} ${cell.attempt === 1 ? "attempt" : "attempts"}`;
  const resetDate = cell.resetsAt ? new Date(cell.resetsAt) : null;
  let reset: string | null = null;
  if (resetDate && Number.isFinite(resetDate.getTime())) {
    const now = new Date();
    const sameDay =
      resetDate.getFullYear() === now.getFullYear() &&
      resetDate.getMonth() === now.getMonth() &&
      resetDate.getDate() === now.getDate();
    const date = sameDay
      ? ""
      : `${resetDate.toLocaleDateString([], {
          month: "short",
          day: "numeric",
          ...(resetDate.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}),
        })} `;
    reset = `Resets at ${date}${resetDate.toLocaleTimeString([], {
      hour: "numeric",
      minute: "2-digit",
    })}`;
  }
  const headlineId = `${accessibleId}-headline`;
  const detailId = `${accessibleId}-detail`;

  return (
    <section
      className={`rounded-xl border px-3 py-2 ${border}`}
      role={retrying ? "status" : undefined}
      aria-live={retrying ? "polite" : undefined}
      aria-atomic={retrying ? "true" : undefined}
      aria-labelledby={retrying ? headlineId : undefined}
      aria-describedby={retrying ? detailId : undefined}
      data-testid="provider-retry-cell"
      data-status={cell.status}
    >
      <div className="flex items-start gap-2">
        <Icon size={16} className={`mt-0.5 shrink-0 ${accent}`} aria-hidden />
        <div className="min-w-0 space-y-1">
          <div id={headlineId} className={`text-sm font-semibold ${accent}`}>
            {headline}
          </div>
          <div id={detailId} className="space-y-1">
            <div
              className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded text-xs text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              tabIndex={0}
              data-testid="provider-retry-message"
            >
              {succeeded ? "Recovered from: " : ""}
              {cell.message}
              {cell.planType ? ` (${cell.planType} plan)` : ""}
            </div>
            <div className="flex flex-wrap gap-x-2 text-detail text-text-muted">
              <span>{attempt}</span>
              {reset ? <span className={accent}>{reset}</span> : null}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

const SUBAGENT_STATUS: Record<SubagentCell["status"], ToolGroupStatus> = {
  running: "running",
  done: "result",
  error: "failed",
  stopped: "stopped",
  interrupted: "interrupted",
};

/**
 * A native subagent run streamed into the parent transcript (managed_subagent /
 * managed_parallel). The child's task and its live/authoritative output render
 * in an expandable card, mirroring the native "agent block".
 */
function ReadOnlyChildCell({ cell }: { cell: TranscriptCell }) {
  if (cell.kind === "question" || cell.kind === "ask_user" || cell.kind === "supervisor_question") {
    return (
      <div className="rounded-lg border border-border px-3 py-2 text-sm text-text-secondary">
        Interactive child request (read-only)
      </div>
    );
  }
  return <CellView cell={cell} />;
}

function SubagentCellView({ cell }: { cell: SubagentCell }) {
  const parentSessionId = useAppStore((state) => state.session?.id);
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  const [revealState, setRevealState] = useState<{
    status: "idle" | "pending" | "success" | "error";
    message?: string;
  }>({ status: "idle" });
  const revealAvailable = canRevealSubagentArtifacts();
  const reveal = async (): Promise<void> => {
    if (revealState.status === "pending" || !cell.artifactRootId) return;
    setRevealState({ status: "pending", message: "Revealing artifacts…" });
    try {
      if (await revealSubagentArtifacts(cell.artifactRootId)) {
        setRevealState({ status: "success", message: "Artifacts revealed in your file manager." });
      } else {
        setRevealState({
          status: "error",
          message: "Artifact reveal is unavailable. Open this run in the Agent Deck desktop app.",
        });
      }
    } catch {
      setRevealState({
        status: "error",
        message:
          "Artifacts could not be revalidated. Retry, or restart Agent Deck if the run was moved.",
      });
    }
  };
  return (
    <div data-testid="subagent-cell" data-status={cell.status}>
      <ToolGroupCard
        name={cell.agentName ? `Subagent · ${cell.agentName}` : "Subagent"}
        variant="generic"
        status={SUBAGENT_STATUS[cell.status]}
        defaultExpanded={cell.status === "running"}
        expandOnRunningTransition
        body={
          <div className="space-y-2">
            {/* Named delegation (native named subagents): which agent's persona
                this run adopted. Absent for a plain anonymous subagent. */}
            {cell.agentName ? (
              <div
                data-testid="subagent-agent-name"
                className="flex items-center gap-1 text-xs text-text-muted"
              >
                <Send size={11} className="shrink-0" />
                <span className="truncate">{cell.agentName}</span>
              </div>
            ) : null}
            <div className="text-xs font-medium uppercase tracking-wide text-text-muted">Task</div>
            <div
              className="max-h-32 overflow-auto whitespace-pre-wrap rounded text-xs text-text-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
              data-testid="subagent-task"
              tabIndex={0}
            >
              {cell.task}
            </div>
            {cell.progress.length > 0 ? (
              <ul className="space-y-1" data-testid="subagent-progress">
                {cell.progress.map((message, index) => (
                  <li
                    key={index}
                    className="flex gap-1.5 text-xs text-text-muted"
                    data-testid="subagent-progress-item"
                  >
                    <span aria-hidden>→</span>
                    <span className="whitespace-pre-wrap">{message}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            {cell.text ? (
              <div
                className="max-h-64 overflow-auto whitespace-pre-wrap rounded text-xs text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
                data-testid="subagent-output"
                tabIndex={0}
              >
                {cell.text}
              </div>
            ) : null}
            {cell.error ? (
              <div
                className="whitespace-pre-wrap text-xs text-danger"
                role="alert"
                data-testid="subagent-error"
              >
                {cell.error}
              </div>
            ) : null}
            <RunMeta
              model={cell.model}
              inputTokens={cell.inputTokens}
              outputTokens={cell.outputTokens}
              durationMs={cell.durationMs}
            />
            {parentSessionId ? (
              <ControlButton
                type="button"
                className="flex items-center gap-1.5 rounded-capsule border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                onClick={() => setTranscriptOpen(true)}
                data-testid="subagent-open-transcript"
              >
                <MessageSquareText size={13} aria-hidden />
                Open child transcript
              </ControlButton>
            ) : null}
            {cell.artifactRootId && revealAvailable ? (
              <div className="flex flex-wrap items-center gap-2">
                <ControlButton
                  type="button"
                  className="flex items-center gap-1.5 rounded-capsule border border-border px-2.5 py-1 text-xs font-medium text-text-secondary hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:cursor-wait disabled:opacity-60"
                  onClick={() => void reveal()}
                  disabled={revealState.status === "pending"}
                  aria-describedby={`subagent-reveal-status-${cell.id}`}
                  data-testid="subagent-reveal-artifacts"
                >
                  <FolderOpen size={13} aria-hidden />
                  {revealState.status === "pending" ? "Revealing…" : "Reveal Artifacts"}
                </ControlButton>
                <span
                  id={`subagent-reveal-status-${cell.id}`}
                  className={
                    revealState.status === "error"
                      ? "text-xs text-danger"
                      : "text-xs text-text-muted"
                  }
                  role={revealState.status === "error" ? "alert" : "status"}
                  aria-live="polite"
                  data-testid="subagent-reveal-status"
                >
                  {revealState.message}
                </span>
              </div>
            ) : null}
          </div>
        }
      />
      {transcriptOpen && parentSessionId ? (
        <ChildTranscriptDialog
          parentSessionId={parentSessionId}
          runId={cell.id}
          expectedStatus={cell.status}
          renderCell={(childCell) => <ReadOnlyChildCell cell={childCell} />}
          onClose={() => setTranscriptOpen(false)}
        />
      ) : null}
    </div>
  );
}

/**
 * A BLOCKING supervisor request a child subagent raised (need_decision /
 * interview_request). The child is suspended until this is answered; answering
 * POSTs to the supervisor answer route and resolves the child's tool call.
 */
function SupervisorQuestionCellView({ cell }: { cell: SupervisorQuestionCell }) {
  const [inputValue, setInputValue] = useState("");
  const resolved = cell.answered || cell.closed;
  const answer = (response: string): void => {
    if (!response.trim() || resolved) return;
    void sendSupervisorAnswer(cell.requestId, response);
  };

  return (
    <div
      className="rounded-xl border px-4 py-3"
      style={{
        borderColor: "var(--color-selection-stroke)",
        background: "var(--color-selection-fill)",
      }}
      data-testid="supervisor-question-cell"
      data-answered={cell.answered ? "true" : "false"}
      data-closed={cell.closed ? "true" : "false"}
    >
      <div className="text-xs font-medium uppercase tracking-wide text-text-muted">
        Subagent needs input
      </div>
      <div className="mt-1 font-medium text-text-primary" style={{ fontStretch: "expanded" }}>
        {cell.title}
      </div>
      {cell.message ? (
        <div className="mt-1 whitespace-pre-wrap text-sm text-text-secondary">{cell.message}</div>
      ) : null}
      {cell.answered ? (
        <div className="mt-2 text-sm text-text-muted" data-testid="supervisor-answer">
          Answered: {cell.answer}
        </div>
      ) : cell.closed ? (
        <div className="mt-2 text-sm text-text-muted" data-testid="supervisor-closed">
          Closed: {cell.closedReason}
        </div>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          {cell.options && cell.options.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {cell.options.map((option) => (
                <ControlButton
                  key={option}
                  data-testid={`supervisor-option-${option}`}
                  className="rounded-capsule border border-border-strong px-3 py-1.5 text-sm text-text-primary hover:border-accent"
                  onClick={() => answer(option)}
                >
                  {option}
                </ControlButton>
              ))}
            </div>
          ) : null}
          <ControlTextArea
            data-testid="supervisor-input"
            aria-label={cell.title}
            className="min-h-[4rem] resize-y rounded-md border border-border-strong bg-surface px-2 py-1.5 text-sm text-text-primary outline-none focus:border-accent"
            placeholder="Type a response…"
            value={inputValue}
            onChange={(event) => setInputValue(event.target.value)}
          />
          <ControlButton
            data-testid="supervisor-submit"
            className="self-end rounded-capsule bg-primary px-3 py-1.5 text-sm font-medium disabled:opacity-50"
            style={{ color: "var(--color-accent-foreground)" }}
            disabled={!inputValue.trim()}
            onClick={() => answer(inputValue)}
          >
            Send response
          </ControlButton>
        </div>
      )}
    </div>
  );
}

function QuestionCellView({ cell }: { cell: QuestionCell }) {
  return (
    <div
      className="rounded-xl border px-4 py-3"
      style={{
        borderColor: "var(--color-selection-stroke)",
        background: "var(--color-selection-fill)",
      }}
      data-testid="question-cell"
      data-answered={cell.answered ? "true" : "false"}
    >
      <div className="font-medium text-text-primary" style={{ fontStretch: "expanded" }}>
        {cell.title}
      </div>
      {cell.message ? <div className="mt-1 text-sm text-text-secondary">{cell.message}</div> : null}
      {cell.answered ? (
        <div className="mt-2 text-sm text-text-muted">Answered.</div>
      ) : (
        <QuestionAnswerControls question={cell} testidPrefix="question" />
      )}
    </div>
  );
}

function UserHistoryActions({ entryId }: { entryId: string }) {
  const sessionId = useAppStore((state) => state.session?.id);
  const sessionPending = useSyncExternalStore(
    subscribeHistoryActionPending,
    () => historyActionPending(sessionId ?? null),
    () => false,
  );
  const [pending, setPending] = useState<"fork" | "rerun" | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState("");
  const [failed, setFailed] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useFocusTrap<HTMLDivElement>(confirming, cancelRef);

  useEffect(() => {
    if (!confirming) return;
    const keydown = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && !pending) {
        event.preventDefault();
        setConfirming(false);
      }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [confirming, pending]);

  const run = async (action: "fork" | "rerun"): Promise<void> => {
    if (!sessionId || sessionPending) return;
    setPending(action);
    setFailed(false);
    setMessage(action === "fork" ? "Forking message…" : "Re-running message…");
    try {
      const result = await runHistoryAction(sessionId, entryId, action);
      setFailed(false);
      setMessage(result.outcome === "forked" ? "Fork created." : "Message re-sent.");
      setConfirming(false);
    } catch (error) {
      setFailed(true);
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setPending(null);
    }
  };

  return (
    <>
      <div className="flex flex-wrap justify-end gap-1.5" aria-busy={sessionPending}>
        <ControlButton
          type="button"
          className="inline-flex items-center gap-1 rounded-capsule border border-border px-2 py-1 text-detail text-text-secondary hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          title="Fork before this message"
          aria-label="Fork before this message"
          disabled={sessionPending}
          onClick={() => void run("fork")}
          data-testid="message-fork"
        >
          <GitFork size={12} aria-hidden /> Fork
        </ControlButton>
        <ControlButton
          type="button"
          className="inline-flex items-center gap-1 rounded-capsule border border-border px-2 py-1 text-detail text-text-secondary hover:bg-hover focus-visible:ring-2 focus-visible:ring-accent disabled:opacity-50"
          title="Re-run from this message"
          aria-label="Re-run from this message"
          disabled={sessionPending}
          onClick={() => setConfirming(true)}
          data-testid="message-rerun"
        >
          <RotateCcw size={12} aria-hidden /> Re-run
        </ControlButton>
      </div>
      <div
        className={message ? "text-right text-detail text-text-muted" : "sr-only"}
        role={failed ? "alert" : "status"}
        aria-live="polite"
      >
        {message}
      </div>
      {confirming ? (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-overlay px-4">
          <div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={`rerun-title-${entryId}`}
            className="w-full max-w-sm rounded-xl border border-border-strong bg-surface p-4 shadow-card"
            data-testid="rerun-confirm"
          >
            <h2 id={`rerun-title-${entryId}`} className="font-semibold text-text-primary">
              Re-run from this message?
            </h2>
            <p className="mt-2 text-sm text-text-secondary">
              Later conversation messages will be abandoned. Workspace files are not changed. This
              message and its original attachments will be sent once.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <ControlButton
                ref={cancelRef}
                type="button"
                className="rounded-md px-3 py-1.5 text-sm text-text-secondary hover:bg-hover"
                disabled={sessionPending}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </ControlButton>
              <ControlButton
                type="button"
                className="rounded-md bg-danger px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
                disabled={sessionPending}
                onClick={() => void run("rerun")}
                data-testid="rerun-confirm-button"
              >
                {pending === "rerun" ? "Re-running…" : "Re-run"}
              </ControlButton>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

function CopyableMessage({
  text,
  side,
  children,
}: {
  text: string;
  side: "leading" | "trailing";
  children: ReactNode;
}) {
  return (
    <div className="group/message relative">
      {children}
      <AppCopyButton
        text={text}
        aria-label="Copy message"
        className={
          "pointer-events-none absolute top-0 opacity-0 " +
          "group-hover/message:pointer-events-auto group-hover/message:opacity-100 " +
          "group-focus-within/message:pointer-events-auto group-focus-within/message:opacity-100 " +
          "focus:pointer-events-auto focus:opacity-100 " +
          (side === "leading" ? "right-full" : "left-full")
        }
        data-side={side}
        data-testid="message-copy"
      />
    </div>
  );
}

function UserCellView({
  cell,
  showImages,
}: {
  cell: Extract<TranscriptCell, { kind: "user" }>;
  showImages: boolean;
}) {
  const sessionId = useAppStore((state) => state.session?.id ?? "");
  const imageReadToken = useSyncExternalStore(
    subscribeImageReadToken,
    getImageReadToken,
    getImageReadToken,
  );
  const [expanded, setExpanded] = useState<number | null>(null);
  const [expandedPaste, setExpandedPaste] = useState<number | null>(null);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  useEffect(() => setFailed(new Set()), [imageReadToken, sessionId]);
  useEffect(() => {
    if (!showImages) setExpanded(null);
  }, [showImages]);
  const items = (cell.images ?? []).map((image, index) => ({
    src: sessionImageUrl(sessionId, image.id),
    name: `Sent image ${index + 1}`,
  }));
  const fileAttachments = (cell.files ?? []).map((file, index) => ({
    id: `${cell.id}-file-${index}`,
    kind: "file" as const,
    label: file.name,
    title: file.path,
  }));
  const folderAttachments = (cell.folders ?? []).map((folder, index) => ({
    id: `${cell.id}-folder-${index}`,
    kind: "folder" as const,
    label: folder.name,
    title: folder.path,
  }));
  const pasteAttachments = (cell.pastes ?? []).map((paste, index) => ({
    id: `${cell.id}-paste-${paste.id}`,
    kind: "paste" as const,
    label: paste.marker,
    title: "Preview pasted text",
    onActivate: () => setExpandedPaste(index),
  }));
  const hiddenImageAttachments =
    !showImages && items.length > 0
      ? [
          {
            id: `${cell.id}-images`,
            kind: "image" as const,
            label: items.length === 1 ? "1 image" : `${items.length} images`,
            title: "Image previews hidden",
          },
        ]
      : [];
  const attachments = [
    ...fileAttachments,
    ...folderAttachments,
    ...pasteAttachments,
    ...hiddenImageAttachments,
  ];
  const fileSummary = fileAttachments.length === 1 ? "1 file" : `${fileAttachments.length} files`;
  const folderSummary =
    folderAttachments.length === 1 ? "1 folder" : `${folderAttachments.length} folders`;
  const pasteSummary =
    pasteAttachments.length === 1 ? "1 paste" : `${pasteAttachments.length} pastes`;
  const imageSummary = items.length === 1 ? "1 image" : `${items.length} images`;
  const summaryParts = [
    ...(fileAttachments.length > 0 ? [fileSummary] : []),
    ...(folderAttachments.length > 0 ? [folderSummary] : []),
    ...(pasteAttachments.length > 0 ? [pasteSummary] : []),
    ...(!showImages && items.length > 0 ? [imageSummary] : []),
  ];
  const attachmentSummary =
    summaryParts.length === 1
      ? summaryParts[0] === "1 file"
        ? "Attached a file."
        : summaryParts[0] === "1 folder"
          ? "Attached a folder."
          : summaryParts[0] === "1 paste"
            ? "Attached a paste."
            : summaryParts[0] === "1 image"
              ? "Attached an image."
              : `Attached ${summaryParts[0]}.`
      : summaryParts.length === 2
        ? `Attached ${summaryParts[0]} and ${summaryParts[1]}.`
        : summaryParts.length > 2
          ? `Attached ${summaryParts.slice(0, -1).join(", ")}, and ${summaryParts.at(-1)}.`
          : "";
  const visibleText = cell.text || attachmentSummary;
  return (
    <div className="flex justify-end" data-testid="user-cell">
      <div className="max-w-[80%] space-y-2">
        {visibleText || attachments.length > 0 ? (
          cell.text ? (
            <CopyableMessage text={cell.text} side="leading">
              <MessageBubble role="user" text={visibleText} attachments={attachments} />
            </CopyableMessage>
          ) : (
            <MessageBubble role="user" text={visibleText} attachments={attachments} />
          )
        ) : null}
        {showImages && items.length ? (
          <div className="flex flex-wrap justify-end gap-2" data-testid="sent-image-gallery">
            {items.map((item, index) => {
              const ref = cell.images![index]!;
              return failed.has(ref.id) || !item.src ? (
                <div
                  key={ref.id}
                  className="flex h-24 w-24 items-center justify-center rounded-lg border border-border-strong bg-surface text-center text-xs text-text-muted"
                  role="img"
                  aria-label={`${item.name} unavailable`}
                >
                  Image unavailable
                </div>
              ) : (
                <ControlButton
                  key={ref.id}
                  type="button"
                  className="rounded-lg focus-visible:ring-2 focus-visible:ring-accent"
                  aria-label={`Expand ${item.name}`}
                  onClick={() => setExpanded(index)}
                >
                  <img
                    src={item.src}
                    alt={item.name}
                    width={ref.width}
                    height={ref.height}
                    loading="lazy"
                    decoding="async"
                    className="h-24 w-24 cursor-zoom-in rounded-lg border border-border-strong bg-surface object-cover"
                    onError={() => setFailed((old) => new Set(old).add(ref.id))}
                  />
                </ControlButton>
              );
            })}
          </div>
        ) : null}
        {cell.entryId ? <UserHistoryActions entryId={cell.entryId} /> : null}
        {showImages && expanded !== null ? (
          <ExpandedImageDialog
            preview={{ images: items, index: expanded }}
            onClose={() => setExpanded(null)}
          />
        ) : null}
        {expandedPaste !== null && cell.pastes?.[expandedPaste] ? (
          <PastePreviewDialog
            paste={cell.pastes[expandedPaste]!}
            onClose={() => setExpandedPaste(null)}
          />
        ) : null}
      </div>
    </div>
  );
}

function AssistantCellView({
  cell,
  transcriptVisibility,
}: {
  cell: Extract<TranscriptCell, { kind: "assistant" }>;
  transcriptVisibility: TranscriptVisibilitySettings;
}) {
  const visibleBlocks = visibleAssistantBlocks(cell.blocks, transcriptVisibility);
  const copyText = visibleBlocks
    .filter((block) => block.kind === "text" && block.text)
    .map((block) => block.text)
    .join("\n\n");
  const content = (
    <div
      className="space-y-2"
      data-testid="assistant-cell"
      data-streaming={cell.streaming ? "true" : "false"}
    >
      {visibleBlocks.map((block) =>
        block.kind === "thinking" ? (
          <MessageBubble
            key={block.contentIndex}
            role="thinking"
            text={block.done ? block.text : balance(block.text)}
          />
        ) : (
          <div key={block.contentIndex} data-testid="assistant-text">
            <MessageBubble role="assistant" text={block.done ? block.text : balance(block.text)} />
          </div>
        ),
      )}
      {cell.errorMessage ? <MessageBubble role="error" text={cell.errorMessage} /> : null}
    </div>
  );

  return copyText ? (
    <CopyableMessage text={copyText} side="trailing">
      {content}
    </CopyableMessage>
  ) : (
    content
  );
}

export function CellView({
  cell,
  editorController,
  transcriptVisibility = DEFAULT_TRANSCRIPT_VISIBILITY,
}: {
  cell: TranscriptCell;
  editorController?: OpenInEditorController;
  transcriptVisibility?: TranscriptVisibilitySettings;
}) {
  switch (cell.kind) {
    case "user":
      return <UserCellView cell={cell} showImages={transcriptVisibility.showImages} />;
    case "assistant":
      return <AssistantCellView cell={cell} transcriptVisibility={transcriptVisibility} />;
    case "tool":
      return <ToolCellView cell={cell} editorController={editorController} />;
    case "memory_recall":
      return <MemoryRecallCellView cell={cell} />;
    case "provider_retry":
      return <ProviderRetryCellView cell={cell} />;
    case "subagent":
      return <SubagentCellView cell={cell} />;
    case "supervisor_question":
      return <SupervisorQuestionCellView cell={cell} />;
    case "question":
      return <QuestionCellView cell={cell} />;
    case "ask_user":
      return <AskUserDecisionCard cell={cell} />;
  }
}
