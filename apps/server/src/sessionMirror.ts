import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import type { SessionMeta } from "@agent-deck/contracts";
import {
  emptyTranscript,
  isOpenCell,
  redactSecrets,
  type TranscriptCell,
  type TranscriptState,
} from "@agent-deck/domain";
import { readPiTranscript } from "./rpcHandler.ts";
import type { SessionManager } from "./SessionManager.ts";

/**
 * SRV-12c2: what GET /sessions/:id/transcript answers a device mirroring a session
 * it moved here. Any member may read any session on a shared server (visibility,
 * ADR 0003), but anything that looks like a secret is redacted and the answer is
 * a bounded window of the newest cells: each cell is measured (and redacted)
 * before it joins the window.
 */
export const MAX_MIRROR_CELLS = 200;
export const MAX_MIRROR_BYTES = 2 * 1024 * 1024;
export const MAX_MIRROR_CELL_BYTES = 512 * 1024;
/** Unsettled cells a client may ask for again by id. */
export const MAX_OPEN_IDS = 20;

/** A value under one of these keys is a secret whatever its type. */
const SECRET_KEY =
  /^(?:token|(?:refresh|access|id|auth|bearer|session)[_-]?token|client[_-]?secret|secret|password|passwd|pwd|authorization|proxy[_-]?authorization|(?:set[_-])?cookie|api[_-]?key|apikey|x[_-]api[_-]key|private[_-]?key|credentials?)$/i;
/** Identity fields: never rewritten, so anchors and joins stay stable. */
const ID_KEYS = new Set(["id", "parentId", "toolCallId", "requestId", "runId", "sessionId"]);
/** A header line: everything after it on the line is the secret. */
const HEADER_SECRET = /((?:proxy-)?(?:authorization|set-cookie|cookie)\s*:\s*)[^\r\n"\\]+/gi;
/** `"refresh_token": "x"`, `password=x`, `\"token\":\"x\"` inside free text (any value length). */
const KEYED_SECRET =
  /((?:^|[^A-Za-z0-9])[A-Za-z0-9_-]*?(?:token|secret|password|passwd|pwd|authorization|cookie|api[_-]?key|apikey|private[_-]?key|credentials?)[\\"']*\s*[:=]\s*)(\\"(?:[^\\]|\\[^"])*\\"|"(?:[^"\\]|\\.)*"|'[^']*'|[^\s,;}&"'\\]+)/gi;

const quoted = (value: string): string =>
  value.startsWith('\\"')
    ? '\\"<secret>\\"'
    : value.startsWith('"')
      ? '"<secret>"'
      : value.startsWith("'")
        ? "'<secret>'"
        : "<secret>";

const redactText = (text: string): string =>
  redactSecrets(text)
    .replace(HEADER_SECRET, "$1<secret>")
    .replace(KEYED_SECRET, (_match, lead: string, value: string) => `${lead}${quoted(value)}`);

/** A deep copy: secret-like keys lose their whole value, other strings are redacted. */
export function redactDeep<T>(value: T, key?: string): T {
  if (typeof value === "string")
    return (key !== undefined && ID_KEYS.has(key) ? value : redactText(value)) as T;
  if (Array.isArray(value)) return value.map((item) => redactDeep(item)) as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [name, item] of Object.entries(value)) {
      out[name] = SECRET_KEY.test(name) ? "<secret>" : redactDeep(item, name);
    }
    return out as T;
  }
  return value;
}

interface Prepared {
  cell: TranscriptCell;
  json: string;
  bytes: number;
}
// Cells are replaced, never mutated, when they change: one preparation per cell object.
const prepared = new WeakMap<TranscriptCell, Prepared>();

function prepare(raw: TranscriptCell): Prepared {
  const cached = prepared.get(raw);
  if (cached) return cached;
  // Measured before any redaction work: an oversized cell is never walked.
  const cell: TranscriptCell =
    Buffer.byteLength(JSON.stringify(raw)) > MAX_MIRROR_CELL_BYTES
      ? {
          kind: "notice",
          id: raw.id,
          level: "info",
          message:
            "This entry is too large to show here. Open the session on the server to read it.",
          ...(isOpenCell(raw) ? { open: true as const } : {}),
        }
      : redactDeep(raw);
  const json = JSON.stringify(cell);
  const result = { cell, json, bytes: Buffer.byteLength(json) };
  prepared.set(raw, result);
  return result;
}

/** The first index of the capped window that ends at `end` (inclusive). */
function windowStart(cells: readonly TranscriptCell[], end: number): number {
  let bytes = 0;
  let start = end + 1;
  for (let i = end; i >= 0 && end - i < MAX_MIRROR_CELLS; i -= 1) {
    bytes += prepare(cells[i]!).bytes;
    if (bytes > MAX_MIRROR_BYTES) break;
    start = i;
  }
  return start;
}

/** sha1 of the window's prepared cells, leaving out the ones that may still change. */
function windowHash(window: readonly Prepared[], skip: (cell: TranscriptCell) => boolean): string {
  const hash = createHash("sha1");
  for (const item of window) if (!skip(item.cell)) hash.update(item.json).update("\n");
  return hash.digest("hex");
}

export interface MirrorQuery {
  /** The last cell the client holds. */
  afterEntryId?: string;
  /** The hash this route gave with that cell; a different window now resets. */
  prefixHash?: string;
  /** Cells the client holds as unsettled: sent again. */
  openIds?: readonly string[];
}

export interface MirrorTranscript {
  /** reset: the whole window; else the open cells again and the new ones (replace by id or append). */
  state: TranscriptState;
  reset: boolean;
  /** The client drops every cell before this one (the window's first), or keeps none. */
  firstId: string | null;
  /** Older cells exist on the server outside the window. */
  truncated: boolean;
  /** Identifies the window's settled cells, for the next request. */
  prefixHash: string;
}

export function mirrorTranscript(
  state: TranscriptState,
  query: MirrorQuery = {},
): MirrorTranscript {
  const { cells } = state;
  const last = cells.length - 1;
  const start = windowStart(cells, last);
  const window = cells.slice(start).map(prepare);
  let reset = true;
  let sent = window;
  const anchor = query.afterEntryId
    ? cells.findIndex((cell) => cell.id === query.afterEntryId)
    : -1;
  if (anchor !== -1 && query.prefixHash && (query.openIds?.length ?? 0) <= MAX_OPEN_IDS) {
    const open = new Set(query.openIds ?? []);
    const held = cells.slice(windowStart(cells, anchor), anchor + 1).map(prepare);
    if (windowHash(held, (cell) => open.has(cell.id)) === query.prefixHash) {
      reset = false;
      sent = window.filter((item, i) => start + i > anchor || open.has(item.cell.id));
    }
  }
  const { agentStatus, pendingInput, plan, contextRevision } = state;
  return {
    state: {
      ...redactDeep({ agentStatus, pendingInput, plan, contextRevision }),
      cells: sent.map((item) => item.cell),
    },
    reset,
    firstId: window[0]?.cell.id ?? null,
    truncated: start > 0,
    prefixHash: windowHash(window, isOpenCell),
  };
}

/**
 * The running session's in-memory transcript (mid-stream cells included), else
 * its Pi file. A Pi file that cannot be read throws (the route answers 503).
 */
export async function sessionTranscriptSource(
  sessions: Pick<SessionManager, "get">,
  meta: SessionMeta,
): Promise<{ source: "live" | "file"; state: TranscriptState }> {
  const live = sessions.get(meta.id);
  if (live && !live.isParked && live.isRunning)
    return { source: "live", state: live.snapshot().state };
  return {
    source: "file",
    state: meta.piSessionFile ? await readPiTranscript(meta) : emptyTranscript(),
  };
}
