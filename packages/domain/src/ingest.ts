import type { RpcEventListener, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import type {
  AssistantBlock,
  AssistantCell,
  BlockKind,
  DomainEvent,
  ProviderRetryCell,
  RecalledMemoryReference,
  ToolCell,
  TranscriptCell,
} from "./transcript.ts";
import { isAnswerableUiRequest } from "./transcript.ts";
import { extractFileAttachments } from "./fileAttachments.ts";
import { extractFolderAttachments } from "./folderAttachments.ts";

/** pi's streaming event union, derived from the exported listener type. */
export type PiAgentEvent = Parameters<RpcEventListener>[0];
export type PiInboundEvent = PiAgentEvent | RpcExtensionUIRequest;

type AssistantMessage = Extract<
  Extract<PiAgentEvent, { type: "message_end" }>["message"],
  { role: "assistant" }
>;

/**
 * Normalization pipeline: raw pi events in, ordered domain events out.
 *
 * Non-negotiable: `text_delta`/`thinking_delta` pass through as `cell_delta`
 * events — never coalesced away, never deferred to message_end.
 *
 * Entry-id strategy (confirmed pi gotcha — responseId may be absent or reused):
 * the cell id is coined once per message window (message_start → message_end)
 * from a monotonic counter, with the responseId recorded on the cell for
 * cross-referencing. Coined ids are deterministic given the event sequence.
 */
export interface IngestState {
  counter: number;
  openAssistant?: {
    cellId: string;
    blocks: Map<number, { kind: BlockKind; text: string }>;
  };
  /** toolCallIds with a live tool_execution_start cell (merge, don't recreate). */
  seenToolCalls: Set<string>;
  /** Count of canonical Pi message entries observed, used for durable retry pairing on resume. */
  messageCount: number;
  openProviderRetry?: ProviderRetryCell;
}

export function createIngestState(): IngestState {
  return { counter: 0, seenToolCalls: new Set(), messageCount: 0 };
}

export const MEMORY_RECALL_ENTRY_TYPE = "agent-deck.memory-recall";
export const MEMORY_RECALL_ENTRY_VERSION = 1;
export const MAX_RECALLED_MEMORIES = 5;
const MEMORY_TYPES = new Set<RecalledMemoryReference["type"]>([
  "context",
  "decision",
  "runbook",
  "failure",
  "preference",
]);

export interface MemoryRecallEntryData {
  version: typeof MEMORY_RECALL_ENTRY_VERSION;
  memories: RecalledMemoryReference[];
}

/** Strict payload validator for untrusted Pi custom entries. */
export function parseMemoryRecallEntryData(value: unknown): MemoryRecallEntryData | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some((key) => key !== "version" && key !== "memories") ||
    record.version !== MEMORY_RECALL_ENTRY_VERSION ||
    !Array.isArray(record.memories) ||
    record.memories.length === 0 ||
    record.memories.length > MAX_RECALLED_MEMORIES
  ) {
    return null;
  }
  const ids = new Set<string>();
  const memories: RecalledMemoryReference[] = [];
  for (const item of record.memories) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const memory = item as Record<string, unknown>;
    if (
      Object.keys(memory).some((key) => key !== "id" && key !== "title" && key !== "type") ||
      typeof memory.id !== "string" ||
      !memory.id ||
      memory.id.length > 256 ||
      ids.has(memory.id) ||
      typeof memory.title !== "string" ||
      !memory.title.trim() ||
      memory.title.length > 256 ||
      typeof memory.type !== "string" ||
      !MEMORY_TYPES.has(memory.type as RecalledMemoryReference["type"])
    ) {
      return null;
    }
    ids.add(memory.id);
    memories.push({
      id: memory.id,
      title: memory.title,
      type: memory.type as RecalledMemoryReference["type"],
    });
  }
  return { version: MEMORY_RECALL_ENTRY_VERSION, memories };
}

/** Convert a valid Pi custom entry into a payload-free transcript card. */
export function ingestMemoryRecallEntry(
  entry: unknown,
  projectId: string | undefined,
): DomainEvent[] {
  if (!projectId || !entry || typeof entry !== "object") return [];
  const candidate = entry as Record<string, unknown>;
  if (
    candidate.type !== "custom" ||
    candidate.customType !== MEMORY_RECALL_ENTRY_TYPE ||
    typeof candidate.id !== "string" ||
    !candidate.id ||
    candidate.id.length > 256
  ) {
    return [];
  }
  const data = parseMemoryRecallEntryData(candidate.data);
  if (!data) return [];
  return [
    {
      type: "cell_final",
      cell: {
        kind: "memory_recall",
        id: `memory-recall-${candidate.id}`,
        projectId,
        memories: data.memories,
      },
    },
  ];
}

function coinId(state: IngestState, prefix: string): string {
  state.counter += 1;
  return `${prefix}-${state.counter}`;
}

const MAX_RETRY_MESSAGE_CODE_POINTS = 2_048;
const MAX_RETRY_ATTEMPTS = 100;

/** Bound and redact an untrusted provider diagnostic before it reaches replay or disk. */
function retryMessage(value: unknown): string {
  const raw = typeof value === "string" ? value : "";
  const withoutAnsi = raw.replace(
    // eslint-disable-next-line no-control-regex
    /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007]*(?:\u0007|\u001b\\))/g,
    "",
  );
  const withoutControls = withoutAnsi.replace(
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,
    " ",
  );
  const secretKey =
    "(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|token|secret)";
  const redacted = withoutControls
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(
      new RegExp(`"(${secretKey})"\\s*:\\s*"(?:\\\\.|[^"\\\\])*"`, "gi"),
      '"$1":"[REDACTED]"',
    )
    .replace(
      new RegExp(`'(${secretKey})'\\s*:\\s*'(?:\\\\.|[^'\\\\])*'`, "gi"),
      "'$1':'[REDACTED]'",
    )
    .replace(new RegExp(`\\b(${secretKey})\\b\\s*[:=]\\s*["']?[^\\s,}"']+`, "gi"), "$1=[REDACTED]")
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{12,}\b/g, "[REDACTED]")
    .replace(/\s+/gu, " ")
    .trim();
  const normalized = redacted || "The model provider returned an error.";
  const points = Array.from(normalized);
  return points.length <= MAX_RETRY_MESSAGE_CODE_POINTS
    ? normalized
    : `${points.slice(0, MAX_RETRY_MESSAGE_CODE_POINTS - 1).join("")}…`;
}

function finiteInt(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined;
}

function retryJson(message: string): Record<string, unknown> | undefined {
  const start = message.indexOf("{");
  const end = message.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(message.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function humanRetryMessage(payload: string): string {
  const root = retryJson(payload);
  const error =
    root?.error && typeof root.error === "object"
      ? (root.error as Record<string, unknown>)
      : undefined;
  const direct = error?.message ?? root?.message;
  if (typeof direct === "string" && direct.trim()) return retryMessage(direct);
  const nested = root?.errorMessage ?? root?.finalError;
  if (typeof nested === "string" && nested !== payload) return humanRetryMessage(nested);
  const prose = (payload.includes("{") ? payload.slice(0, payload.indexOf("{")) : payload)
    .trim()
    .replace(/:$/, "")
    .trim();
  return prose || "The model provider returned an error.";
}

function goDurationSeconds(value: unknown): number | undefined {
  if (typeof value !== "string" || !value) return undefined;
  let total = 0;
  let number = "";
  for (const character of value) {
    if ((character >= "0" && character <= "9") || character === ".") {
      number += character;
      continue;
    }
    const parsed = Number(number);
    if (!Number.isFinite(parsed)) return undefined;
    if (character === "h") total += parsed * 3_600;
    else if (character === "m") total += parsed * 60;
    else if (character === "s") total += parsed;
    else return undefined;
    number = "";
  }
  return number === "" && total > 0 ? total : undefined;
}

function retryMetadata(
  payload: string,
): Pick<ProviderRetryCell, "isQuotaLimit" | "resetsAt" | "planType"> {
  const isQuotaLimit =
    /(?:usage[_ ]limit|rate[_ ]limit|quota|too many requests|insufficient_quota|resource_exhausted)/i.test(
      payload,
    ) || /(?:^|\D)429(?:\D|$)/.test(payload);
  const root = retryJson(payload);
  const error =
    root?.error && typeof root.error === "object" ? (root.error as Record<string, unknown>) : root;
  const headers =
    root?.headers && typeof root.headers === "object"
      ? (root.headers as Record<string, unknown>)
      : undefined;
  const plan = error?.plan_type ?? headers?.["X-Codex-Plan-Type"];
  const resetSeconds = error?.resets_in_seconds;
  const resetEpoch = error?.resets_at ?? headers?.["X-Codex-Primary-Reset-At"];
  let resetsAt: string | undefined;
  if (typeof resetEpoch === "number" && Number.isFinite(resetEpoch) && resetEpoch > 0) {
    resetsAt = new Date(resetEpoch * 1_000).toISOString();
  } else if (
    typeof resetEpoch === "string" &&
    Number.isFinite(Number(resetEpoch)) &&
    Number(resetEpoch) > 0
  ) {
    resetsAt = new Date(Number(resetEpoch) * 1_000).toISOString();
  } else if (
    typeof resetSeconds === "number" &&
    Number.isFinite(resetSeconds) &&
    resetSeconds > 0
  ) {
    resetsAt = new Date(Date.now() + resetSeconds * 1_000).toISOString();
  } else if (error && Array.isArray(error.details)) {
    for (const detail of error.details) {
      if (!detail || typeof detail !== "object") continue;
      const candidate = detail as Record<string, unknown>;
      if (typeof candidate["@type"] !== "string" || !candidate["@type"].includes("RetryInfo")) {
        continue;
      }
      const seconds = goDurationSeconds(candidate.retryDelay);
      if (seconds !== undefined) resetsAt = new Date(Date.now() + seconds * 1_000).toISOString();
      break;
    }
  }
  return {
    ...(isQuotaLimit ? { isQuotaLimit: true } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(typeof plan === "string" && plan.trim() ? { planType: plan.trim().slice(0, 64) } : {}),
  };
}

function assistantCellFromMessage(id: string, message: AssistantMessage): AssistantCell {
  const blocks = message.content.flatMap((content, contentIndex): AssistantBlock[] => {
    if (content.type === "text") {
      return [{ kind: "text", contentIndex, text: content.text, done: true }];
    }
    if (content.type === "thinking") {
      return [{ kind: "thinking", contentIndex, text: content.thinking, done: true }];
    }
    return [];
  });
  return {
    kind: "assistant",
    id,
    blocks,
    streaming: false,
    model: message.model,
    stopReason: message.stopReason,
    errorMessage: message.errorMessage,
  };
}

function userText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (block): block is { type: "text"; text: string } =>
          typeof block === "object" &&
          block !== null &&
          (block as { type?: string }).type === "text",
      )
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

const MAX_QUEUE_ITEMS = 100;
const MAX_QUEUE_ITEM_CHARS = 10_000;
const MAX_QUEUE_CHARS = 100_000;

type BoundedQueue =
  | { ok: true; items: string[]; chars: number }
  | { ok: false; reason: "malformed" | "limit_exceeded" };

/** Validate one external queue array without retaining any invalid prefix. */
function boundedQueue(value: unknown): BoundedQueue {
  if (!Array.isArray(value)) return { ok: false, reason: "malformed" };
  if (value.length > MAX_QUEUE_ITEMS) return { ok: false, reason: "limit_exceeded" };
  let chars = 0;
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") return { ok: false, reason: "malformed" };
    if (item.length > MAX_QUEUE_ITEM_CHARS) return { ok: false, reason: "limit_exceeded" };
    chars += item.length;
    if (chars > MAX_QUEUE_CHARS) return { ok: false, reason: "limit_exceeded" };
    items.push(item);
  }
  return { ok: true, items, chars };
}

/** Feed one pi event; mutates `state`, returns the domain events it produced. */
export function ingestPiEvent(state: IngestState, event: PiInboundEvent): DomainEvent[] {
  // pi's RPC mode forwards the FULL AgentSessionEvent union at runtime
  // (rpc-mode.js `session.subscribe`), including `compaction_end` — even though
  // the exported RpcEventListener/AgentEvent TYPE is narrower and omits it. A
  // compaction changes the context outside the normal turn cycle, so surface it
  // as `context_changed` (the context-usage indicator re-reads stats on it).
  const external = event as unknown as {
    type?: unknown;
    steering?: unknown;
    followUp?: unknown;
    attempt?: unknown;
    maxAttempts?: unknown;
    delayMs?: unknown;
    errorMessage?: unknown;
    success?: unknown;
    finalError?: unknown;
  };
  if (external.type === "auto_retry_start") {
    const attempt = finiteInt(external.attempt, 1, MAX_RETRY_ATTEMPTS) ?? 1;
    const maxAttempts = finiteInt(external.maxAttempts, 1, MAX_RETRY_ATTEMPTS);
    const delayMs = finiteInt(external.delayMs, 0, 86_400_000);
    const payload = retryMessage(external.errorMessage);
    const message = humanRetryMessage(payload);
    const prior = state.openProviderRetry;
    const collapsedMessageCounts = Array.from(
      new Set([
        ...(prior?.collapsedMessageCounts ?? []),
        ...(state.messageCount > 0 ? [state.messageCount] : []),
      ]),
    ).slice(-MAX_RETRY_ATTEMPTS);
    const cell: ProviderRetryCell = {
      kind: "provider_retry",
      id: prior?.id ?? coinId(state, "provider-retry"),
      status: "retrying",
      attempt,
      ...(maxAttempts !== undefined ? { maxAttempts } : {}),
      ...(delayMs !== undefined ? { delayMs } : {}),
      message,
      ...retryMetadata(payload),
      collapsedMessageCounts,
    };
    state.openProviderRetry = cell;
    return [{ type: "provider_retry", cell, collapseLatestAssistantError: true }];
  }
  if (external.type === "auto_retry_end") {
    const prior = state.openProviderRetry;
    const success = external.success === true;
    const payload = retryMessage(external.finalError ?? prior?.message);
    const message = success
      ? (prior?.message ?? "The request recovered after a provider retry.")
      : humanRetryMessage(payload);
    const collapsedMessageCounts = Array.from(
      new Set([
        ...(prior?.collapsedMessageCounts ?? []),
        ...(!success && state.messageCount > 0 ? [state.messageCount] : []),
      ]),
    ).slice(-MAX_RETRY_ATTEMPTS);
    const metadata = success
      ? {
          ...(prior?.isQuotaLimit ? { isQuotaLimit: true } : {}),
          ...(prior?.resetsAt ? { resetsAt: prior.resetsAt } : {}),
          ...(prior?.planType ? { planType: prior.planType } : {}),
        }
      : retryMetadata(payload);
    const cell: ProviderRetryCell = {
      kind: "provider_retry",
      id: prior?.id ?? coinId(state, "provider-retry"),
      status: success ? "succeeded" : "gave_up",
      attempt: finiteInt(external.attempt, 1, MAX_RETRY_ATTEMPTS) ?? prior?.attempt ?? 1,
      ...(prior?.maxAttempts !== undefined ? { maxAttempts: prior.maxAttempts } : {}),
      ...(prior?.delayMs !== undefined ? { delayMs: prior.delayMs } : {}),
      message,
      ...metadata,
      collapsedMessageCounts,
    };
    state.openProviderRetry = undefined;
    return [{ type: "provider_retry", cell, collapseLatestAssistantError: !success }];
  }
  if (external.type === "compaction_end") return [{ type: "context_changed" }];
  if (external.type === "queue_update") {
    const steering = boundedQueue(external.steering);
    const followUp = boundedQueue(external.followUp);
    if (!steering.ok || !followUp.ok) {
      const reason = !steering.ok ? steering.reason : !followUp.ok ? followUp.reason : "malformed";
      return [
        {
          type: "pending_input",
          pendingInput: {
            status: "unavailable",
            truncated: reason === "limit_exceeded",
            reason,
            steering: [],
            followUp: [],
          },
        },
      ];
    }
    if (steering.chars + followUp.chars > MAX_QUEUE_CHARS) {
      return [
        {
          type: "pending_input",
          pendingInput: {
            status: "unavailable",
            truncated: true,
            reason: "limit_exceeded",
            steering: [],
            followUp: [],
          },
        },
      ];
    }
    return [
      {
        type: "pending_input",
        pendingInput: {
          status: "available",
          steering: steering.items,
          followUp: followUp.items,
        },
      },
    ];
  }
  switch (event.type) {
    case "agent_start":
      return [{ type: "agent_status", status: "running" }];
    case "agent_end":
      state.openAssistant = undefined;
      return [{ type: "agent_status", status: "idle" }];

    case "message_start": {
      if (event.message.role !== "assistant") return [];
      const cellId = coinId(state, "assistant");
      state.openAssistant = { cellId, blocks: new Map() };
      const cell: TranscriptCell = {
        kind: "assistant",
        id: cellId,
        blocks: [],
        streaming: true,
      };
      return [{ type: "cell_open", cell }];
    }

    case "message_update": {
      const open = state.openAssistant;
      if (!open) return [];
      const ame = event.assistantMessageEvent;
      switch (ame.type) {
        case "text_start":
        case "thinking_start": {
          const kind: BlockKind = ame.type === "text_start" ? "text" : "thinking";
          open.blocks.set(ame.contentIndex, { kind, text: "" });
          return [];
        }
        case "text_delta":
        case "thinking_delta": {
          const kind: BlockKind = ame.type === "text_delta" ? "text" : "thinking";
          const block = open.blocks.get(ame.contentIndex) ?? { kind, text: "" };
          block.text += ame.delta;
          open.blocks.set(ame.contentIndex, block);
          return [
            {
              type: "cell_delta",
              cellId: open.cellId,
              contentIndex: ame.contentIndex,
              blockKind: kind,
              delta: ame.delta,
            },
          ];
        }
        case "text_end":
        case "thinking_end":
          return [
            {
              type: "block_end",
              cellId: open.cellId,
              contentIndex: ame.contentIndex,
              content: ame.content,
            },
          ];
        default:
          // toolcall_* deltas are rendered via tool_execution_* cells; start/done/error
          // are subsumed by message_start/message_end.
          return [];
      }
    }

    case "message_end": {
      state.messageCount += 1;
      const message = event.message;
      if (message.role === "assistant") {
        const cellId = state.openAssistant?.cellId ?? coinId(state, "assistant");
        state.openAssistant = undefined;
        return [{ type: "cell_final", cell: assistantCellFromMessage(cellId, message) }];
      }
      if (message.role === "user") {
        const entryId = (event as unknown as { entryId?: unknown }).entryId;
        const stableEntryId = typeof entryId === "string" && entryId ? entryId : undefined;
        const folderContent = extractFolderAttachments(userText(message.content));
        const { text, files } = extractFileAttachments(folderContent.text);
        return [
          {
            type: "cell_final",
            cell: {
              kind: "user",
              id: stableEntryId ? `user-${stableEntryId}` : coinId(state, "user"),
              ...(stableEntryId ? { entryId: stableEntryId } : {}),
              text,
              ...(files.length > 0 ? { files } : {}),
              ...(folderContent.folders.length > 0 ? { folders: folderContent.folders } : {}),
            },
          },
        ];
      }
      if (message.role === "toolResult") {
        // Live sessions already have a cell from tool_execution_start — merge.
        // When rebuilding from get_messages (resume) the cell doesn't exist yet.
        if (state.seenToolCalls.has(message.toolCallId)) {
          return [
            {
              type: "tool_end",
              cellId: `tool-${message.toolCallId}`,
              status: message.isError ? "error" : "done",
              result: userText(message.content),
            },
          ];
        }
        return [
          {
            type: "cell_final",
            cell: {
              kind: "tool",
              id: `tool-${message.toolCallId}`,
              toolCallId: message.toolCallId,
              toolName: message.toolName,
              args: undefined,
              status: message.isError ? "error" : "done",
              result: userText(message.content),
            },
          },
        ];
      }
      return [];
    }

    case "tool_execution_start": {
      state.seenToolCalls.add(event.toolCallId);
      const cell: ToolCell = {
        kind: "tool",
        id: `tool-${event.toolCallId}`,
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
        status: "running",
      };
      return [{ type: "cell_open", cell }];
    }
    case "tool_execution_update":
      return [
        {
          type: "tool_update",
          cellId: `tool-${event.toolCallId}`,
          partialResult: event.partialResult,
        },
      ];
    case "tool_execution_end":
      return [
        {
          type: "tool_end",
          cellId: `tool-${event.toolCallId}`,
          status: event.isError ? "error" : "done",
          result: event.result,
        },
      ];

    case "extension_ui_request": {
      // Only requests that await an answer become cards; fire-and-forget
      // methods (notify, widgets, …) are not questions.
      if (!isAnswerableUiRequest(event.method)) return [];
      // The union has many variants; extract the display fields structurally.
      const request = event as {
        id: string;
        method: string;
        title?: string;
        message?: string;
        options?: string[];
        placeholder?: string;
        prefill?: string;
      };
      const cell: TranscriptCell = {
        kind: "question",
        id: `question-${request.id}`,
        requestId: request.id,
        method: request.method,
        title: request.title ?? request.method,
        message: request.message,
        options: request.options,
        placeholder: request.placeholder,
        prefill: request.prefill,
        answered: false,
      };
      return [{ type: "cell_open", cell }];
    }

    default:
      // turn_start/turn_end do not affect the transcript; cell_final
      // self-healing keeps durable message content sound.
      return [];
  }
}

/** Resolve a retry left open only because its owning Pi process terminated. */
export function finalizeOpenProviderRetry(
  state: IngestState,
  message = "Retrying stopped before the request completed.",
): DomainEvent[] {
  const prior = state.openProviderRetry;
  if (!prior) return [];
  state.openProviderRetry = undefined;
  const collapsedMessageCounts = Array.from(
    new Set([
      ...prior.collapsedMessageCounts,
      ...(state.messageCount > 0 ? [state.messageCount] : []),
    ]),
  ).slice(-MAX_RETRY_ATTEMPTS);
  return [
    {
      type: "provider_retry",
      cell: {
        ...prior,
        status: "gave_up",
        message: retryMessage(message),
        collapsedMessageCounts,
      },
      // The reducer proves the latest cell is an assistant provider error before removal.
      collapseLatestAssistantError: state.messageCount > 0,
    },
  ];
}
