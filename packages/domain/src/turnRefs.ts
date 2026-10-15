// A1b1: the session.turn.completed payload, projected from Pi's active entry chain.
// REFERENCES to Pi entries (ids, tool call ids and names), never copies of content;
// A3 reads the full transcript from the Pi session file.

/** Producers cap their own strings: names and short labels. */
export const EVENT_LABEL_MAX_CHARS = 200;
/** A prompt-derived label (turn, checkpoint, title): never the whole prompt. */
export const PROMPT_LABEL_MAX_CHARS = 80;
/** Human-written free text (notes, questions, answers): head kept. */
export const EVENT_TEXT_MAX_CHARS = 4_000;
/** A single turn rarely has more; the rest of the chain is still in the Pi file. */
export const TURN_MAX_ENTRY_REFS = 500;

export interface TurnToolCallRef {
  id: string;
  name: string;
  isError: boolean;
}

export interface TurnRefs {
  entryIds: string[];
  toolCalls: TurnToolCallRef[];
  /** First line of the turn's first user message (producers redact and shorten it). */
  label: string;
  /** The entries could not be read in time: the refs are empty, the turn still happened. */
  partial?: boolean;
  /** How the turn ended, when the session knows (absent: completed or unknown). */
  outcome?: TurnOutcome;
}

export type TurnOutcome = "completed" | "failed" | "cancelled";

/** Cap a string field to `max` characters, marking the cut with an ellipsis. */
export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** First non-blank line, trimmed and capped: the human label of a prompt. */
export function eventLabel(text: string, max = EVENT_LABEL_MAX_CHARS): string {
  const line =
    text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  return capText(line, max);
}

interface EntryShape {
  id?: unknown;
  type?: unknown;
  message?: {
    role?: unknown;
    content?: unknown;
    toolCallId?: unknown;
    toolName?: unknown;
    isError?: unknown;
  };
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && (block as { type?: unknown }).type === "text"
        ? String((block as { text?: unknown }).text ?? "")
        : "",
    )
    .join("\n");
}

const isUserMessage = (entry: EntryShape | undefined): boolean =>
  entry?.type === "message" && entry.message?.role === "user";

/**
 * The newest turn of an active entry chain (oldest first). With `afterEntryId`
 * (the leaf the previous report ended at) the turn is every entry after it, so a
 * steer or follow-up inside the turn keeps the original prompt and its tool calls;
 * without it, or when that entry is no longer on the chain (rollback, history
 * rewrite), the turn starts at the last user message. Null when it holds no user
 * message.
 */
export function turnRefsFromEntries(
  chain: readonly unknown[],
  afterEntryId?: string,
): TurnRefs | null {
  const entries = chain as readonly EntryShape[];
  let start = afterEntryId ? entries.findIndex((entry) => entry.id === afterEntryId) + 1 : 0;
  if (start === 0) {
    start = -1;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      if (isUserMessage(entries[i])) {
        start = i;
        break;
      }
    }
    if (start === -1) return null;
  }
  const turn = entries.slice(start);
  const firstUser = turn.find(isUserMessage);
  if (!firstUser) return null;
  const toolCalls: TurnToolCallRef[] = [];
  for (const entry of turn) {
    const message = entry.message;
    if (entry.type !== "message" || message?.role !== "toolResult") continue;
    if (typeof message.toolCallId !== "string") continue;
    toolCalls.push({
      id: capText(message.toolCallId, EVENT_LABEL_MAX_CHARS),
      name: capText(
        typeof message.toolName === "string" ? message.toolName : "",
        EVENT_LABEL_MAX_CHARS,
      ),
      isError: message.isError === true,
    });
  }
  return {
    entryIds: turn
      .map((entry) => entry.id)
      .filter((id): id is string => typeof id === "string")
      .slice(0, TURN_MAX_ENTRY_REFS),
    toolCalls: toolCalls.slice(0, TURN_MAX_ENTRY_REFS),
    label: eventLabel(messageText(firstUser.message?.content)),
  };
}
