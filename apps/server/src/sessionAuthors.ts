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
  /** CRB-02: copied by a fork or an import; never the running turn's author. */
  inherited?: boolean;
  /** CRB-02: when a live cell claimed it (ms); claims can arrive out of staging order. */
  claimedAt?: number;
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

  private lastClaim = 0;
  /** Strictly increasing claim times: two claims in one millisecond keep their order. */
  private claimTime(): number {
    this.lastClaim = Math.max(Date.now(), this.lastClaim + 1);
    return this.lastClaim;
  }

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
        if (!selected.claimed && !cell.entryId) selected.claimedAt = this.claimTime();
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

  /**
   * CRB-02: the author of the RUNNING turn, the broker's sponsor of first
   * choice: the newest claimed turn (Pi echoed it, so it started), else the
   * newest staged one. A queued steer or follow-up does not take over a turn
   * that is still running; inherited turns never count.
   */
  latest(sessionId: string): UserIdentity | undefined {
    const own = this.turns(sessionId).filter((turn) => !turn.inherited);
    const claimed = own.filter((turn) => turn.claimed);
    // Claim order first (a follow-up staged before a steer may start after it);
    // turns claimed by a cold rebuild carry no time and fall back to staging order.
    const timed = claimed.filter((turn) => turn.claimedAt !== undefined);
    const running =
      timed.length > 0 ? timed.sort((a, b) => a.claimedAt! - b.claimedAt!).at(-1) : claimed.at(-1);
    const author = (running ?? own.at(-1))?.author;
    return author ? { ...author } : undefined;
  }

  /** SRV-15a: a fork keeps the source's bound turns, so inherited messages keep
   * their author. Staged, unclaimed turns stay with the source. */
  fork(sourceSessionId: string, targetSessionId: string): void {
    const turns = this.turns(sourceSessionId)
      .filter((turn) => turn.claimed || turn.entryId)
      .map((turn) => ({ ...turn, inherited: true }));
    if (turns.length > 0) this.index.upsert({ id: targetSessionId, turns });
  }

  /** SRV-12c1: the turns bound to a Pi entry, for a session moved to a server. */
  exportTurns(sessionId: string): AuthorTurn[] {
    // The transfer envelope's schema is strict: `inherited` stays local.
    return this.turns(sessionId)
      .filter((turn) => turn.entryId)
      .map(({ inherited: _inherited, claimedAt: _claimedAt, ...turn }) => turn);
  }

  /** SRV-12c1: an imported session's bound turns (validated by the import route). */
  importTurns(sessionId: string, turns: readonly AuthorTurn[]): void {
    if (turns.length > 0) {
      this.index.upsert({ id: sessionId, turns: turns.map((t) => ({ ...t, inherited: true })) });
    }
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
