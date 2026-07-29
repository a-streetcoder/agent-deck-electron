import { ControlButton, ControlTextArea } from "@/design-system/components/NativeControls";
import { useEffect, useState, useSyncExternalStore } from "react";
import { Send } from "lucide-react";
import {
  memoryToolCardLabel,
  type QuestionCell,
  type SubagentCell,
  type SupervisorQuestionCell,
  type ToolCell,
  type TranscriptCell,
} from "@agent-deck/domain";
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
import { sendSupervisorAnswer } from "../state/wsBridge.ts";
import { useAppStore } from "../state/store.ts";
import {
  getImageReadToken,
  sessionImageUrl,
  subscribeImageReadToken,
} from "../lib/sessionImageUrl.ts";
import { ExpandedImageDialog } from "./composer/ExpandedImageDialog.tsx";
import { PastePreviewDialog } from "./transcript/PastePreviewDialog.tsx";

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

const SUBAGENT_STATUS: Record<SubagentCell["status"], ToolGroupStatus> = {
  running: "running",
  done: "result",
  error: "failed",
};

/**
 * A native subagent run streamed into the parent transcript (managed_subagent /
 * managed_parallel). The child's task and its live/authoritative output render
 * in an expandable card, mirroring the native "agent block".
 */
function SubagentCellView({ cell }: { cell: SubagentCell }) {
  return (
    <div data-testid="subagent-cell" data-status={cell.status}>
      <ToolGroupCard
        name={cell.agentName ? `Subagent · ${cell.agentName}` : "Subagent"}
        variant="generic"
        status={SUBAGENT_STATUS[cell.status]}
        defaultExpanded={cell.status === "running"}
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
            <div className="whitespace-pre-wrap text-xs text-text-muted">{cell.task}</div>
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
                className="max-h-64 overflow-auto whitespace-pre-wrap text-xs text-text-secondary"
                data-testid="subagent-output"
              >
                {cell.text}
              </div>
            ) : null}
            <RunMeta
              model={cell.model}
              inputTokens={cell.inputTokens}
              outputTokens={cell.outputTokens}
              durationMs={cell.durationMs}
            />
          </div>
        }
      />
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

function UserCellView({ cell }: { cell: Extract<TranscriptCell, { kind: "user" }> }) {
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
  const attachments = [...fileAttachments, ...folderAttachments, ...pasteAttachments];
  const fileSummary = fileAttachments.length === 1 ? "1 file" : `${fileAttachments.length} files`;
  const folderSummary =
    folderAttachments.length === 1 ? "1 folder" : `${folderAttachments.length} folders`;
  const pasteSummary =
    pasteAttachments.length === 1 ? "1 paste" : `${pasteAttachments.length} pastes`;
  const summaryParts = [
    ...(fileAttachments.length > 0 ? [fileSummary] : []),
    ...(folderAttachments.length > 0 ? [folderSummary] : []),
    ...(pasteAttachments.length > 0 ? [pasteSummary] : []),
  ];
  const attachmentSummary =
    summaryParts.length === 1
      ? summaryParts[0] === "1 file"
        ? "Attached a file."
        : summaryParts[0] === "1 folder"
          ? "Attached a folder."
          : summaryParts[0] === "1 paste"
            ? "Attached a paste."
            : `Attached ${summaryParts[0]}.`
      : summaryParts.length === 2
        ? `Attached ${summaryParts[0]} and ${summaryParts[1]}.`
        : summaryParts.length === 3
          ? `Attached ${summaryParts[0]}, ${summaryParts[1]}, and ${summaryParts[2]}.`
          : "";
  const visibleText = cell.text || attachmentSummary;
  return (
    <div className="flex justify-end" data-testid="user-cell">
      <div className="max-w-[80%] space-y-2">
        {visibleText || attachments.length > 0 ? (
          <MessageBubble role="user" text={visibleText} attachments={attachments} />
        ) : null}
        {items.length ? (
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
        {expanded !== null ? (
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

export function CellView({
  cell,
  editorController,
}: {
  cell: TranscriptCell;
  editorController?: OpenInEditorController;
}) {
  switch (cell.kind) {
    case "user":
      return <UserCellView cell={cell} />;
    case "assistant":
      return (
        <div
          className="space-y-2"
          data-testid="assistant-cell"
          data-streaming={cell.streaming ? "true" : "false"}
        >
          {cell.blocks.map((block) =>
            block.kind === "thinking" ? (
              <MessageBubble
                key={block.contentIndex}
                role="thinking"
                text={block.done ? block.text : balance(block.text)}
              />
            ) : (
              <div key={block.contentIndex} data-testid="assistant-text">
                <MessageBubble
                  role="assistant"
                  text={block.done ? block.text : balance(block.text)}
                />
              </div>
            ),
          )}
          {cell.errorMessage ? <MessageBubble role="error" text={cell.errorMessage} /> : null}
        </div>
      );
    case "tool":
      return <ToolCellView cell={cell} editorController={editorController} />;
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
