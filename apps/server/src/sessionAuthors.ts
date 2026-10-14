import { createHash } from "node:crypto";
import type { UserIdentity } from "@agent-deck/contracts";
import type { UserCell } from "@agent-deck/domain";
import type { SessionAuthorIndex } from "./persistence.ts";

/**
 * Who sent each user message on a shared server (remote-server POC).
 *
 * Pi's canonical session file knows nothing about Agent Deck users, so the
 * author is a sidecar, bound the same way session pastes are: the RPC handler
 * stages `{signature(message), author}` when an authenticated connection sends
 * a prompt/steer/follow_up, and the user-cell decorator claims the matching
 * record when Pi echoes the message back (live, or rebuilt from history with a
 * stable entry id). A cell with no record stays unattributed.
 */
export interface AuthorTurn {
  signature: string;
  author: UserIdentity;
  /** A live cell already took this turn; the entry id arrives at reconciliation. */
  claimed?: boolean;
  entryId?: string;
}

const signatureFor = (text: string): string => createHash("sha256").update(text).digest("hex");

function userMessageText(rawMessage: unknown, fallback: string): string {
  if (!rawMessage || typeof rawMessage !== "object") return fallback;
  const content = (rawMessage as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return fallback;
  return content
    .filter(
      (block): block is { type: "text"; text: string } =>
        typeof block === "object" &&
        block !== null &&
        (block as { type?: unknown }).type === "text" &&
        typeof (block as { text?: unknown }).text === "string",
    )
    .map((block) => block.text)
    .join("\n");
}

export class SessionAuthorStore {
  // ponytail: unbound turns stay in memory until matched; capped per session so
  // a failing prompt loop cannot grow it forever.
  static readonly MAX_PENDING = 64;

  constructor(private readonly index: SessionAuthorIndex) {}

  stage(sessionId: string, message: string, author: UserIdentity): void {
    const turns = this.turns(sessionId);
    turns.push({ signature: signatureFor(message), author: { ...author } });
    const unbound = turns.filter((turn) => !turn.entryId);
    if (unbound.length > SessionAuthorStore.MAX_PENDING) {
      turns.splice(turns.indexOf(unbound[0]!), 1);
    }
    this.index.upsert({ id: sessionId, turns });
  }

  /** Pi rejected the message: drop the newest unclaimed turn this author staged for it. */
  unstage(sessionId: string, message: string, author: UserIdentity): void {
    const turns = this.turns(sessionId);
    const signature = signatureFor(message);
    const index = turns.findLastIndex(
      (turn) =>
        turn.signature === signature &&
        turn.author.id === author.id &&
        !turn.claimed &&
        !turn.entryId,
    );
    if (index === -1) return;
    turns.splice(index, 1);
    this.index.upsert({ id: sessionId, turns });
  }

  attachToUserCell(sessionId: string, cell: UserCell, rawMessage: unknown): UserCell {
    const turns = this.turns(sessionId);
    if (turns.length === 0) return cell;
    const signature = signatureFor(userMessageText(rawMessage, cell.text));
    let selected = cell.entryId ? turns.find((turn) => turn.entryId === cell.entryId) : undefined;
    if (!selected) {
      const candidates = turns.filter((turn) => !turn.entryId && turn.signature === signature);
      // History/reconciliation (entryId known) binds the live-claimed turn first;
      // a live cell takes the oldest unclaimed one, in Pi's own message order.
      selected = cell.entryId
        ? (candidates.find((turn) => turn.claimed) ?? candidates[0])
        : candidates.find((turn) => !turn.claimed);
      if (selected) {
        selected.claimed = true;
        if (cell.entryId) selected.entryId = cell.entryId;
        this.index.upsert({ id: sessionId, turns });
      }
    }
    if (!selected || selected.signature !== signature) return cell;
    return { ...cell, author: { ...selected.author } };
  }

  /** Distinct authors of the session's recorded turns, in first-seen order. */
  authors(sessionId: string): UserIdentity[] {
    const byId = new Map<string, UserIdentity>();
    for (const { author } of this.turns(sessionId)) {
      if (!byId.has(author.id)) byId.set(author.id, { ...author });
    }
    return [...byId.values()];
  }

  /** The session is gone (DELETE /sessions/:id): its authors go with it. */
  deleteSession(sessionId: string): void {
    this.index.remove(sessionId);
  }

  /** Startup: drop rows whose session is no longer in sessions.json. */
  retainSessions(sessionIds: ReadonlySet<string>): void {
    for (const { id } of [...this.index.list()]) {
      if (!sessionIds.has(id)) this.index.remove(id);
    }
  }

  private turns(sessionId: string): AuthorTurn[] {
    return (
      this.index.find((item) => item.id === sessionId)?.turns.map((turn) => ({ ...turn })) ?? []
    );
  }
}
