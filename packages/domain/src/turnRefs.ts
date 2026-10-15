// A1b1: the session.turn.completed payload, projected from Pi's active entry chain.
// REFERENCES to Pi entries (ids, tool call ids and names), never copies of content;
// A3 reads the full transcript from the Pi session file.

/** Producers cap their own strings: labels and short summaries. */
export const EVENT_LABEL_MAX_CHARS = 200;
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
  label: string;
}

/** Cap a string field to `max` characters, marking the cut with an ellipsis. */
export function capText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** First non-blank line, trimmed and capped: the human label of a prompt. */
export function eventLabel(text: string): string {
  const line =
    text
      .split("\n")
      .map((part) => part.trim())
      .find((part) => part.length > 0) ?? "";
  return capText(line, EVENT_LABEL_MAX_CHARS);
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

/**
 * The last turn of an active entry chain (oldest first): from its last user
 * message to the end. Null when the chain holds no user message.
 */
export function turnRefsFromEntries(chain: readonly unknown[]): TurnRefs | null {
  const entries = chain as readonly EntryShape[];
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "user") {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  const turn = entries.slice(start);
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
    label: eventLabel(messageText(turn[0]?.message?.content)),
  };
}
