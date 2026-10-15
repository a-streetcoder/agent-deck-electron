// A1a event log writer/reader (VISION_ORCHESTRATION principle 1). One log per data
// dir, daily UTC segments, projectId is a read filter. Plain synchronous module like
// the other stores; the envelope, parser and size cap live in @agent-deck/domain.
//
// Layout: <dataDir>/events/{log.json, writer.lock, YYYY-MM-DD.jsonl}. Dir 0700, files 0600.
import { randomUUID } from "node:crypto";
import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  capEventSize,
  EVENT_ENVELOPE_VERSION,
  MAX_EVENT_BYTES,
  parseEventLine,
  splitJsonl,
  validateEnvelope,
  type EventDraft,
  type EventEnvelope,
} from "@agent-deck/domain";

const RING_SIZE = 2_000;
// Durability: writeSync hands every line to the OS at once (it survives a process
// crash); fsync is batched up to 1 s and on close, never per event, so a power loss
// can drop up to the last second. Boot repair handles the torn tail.
const FSYNC_DELAY_MS = 1_000;
const SEGMENT_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

export interface EventLogOptions {
  clock?: () => Date;
  randomId?: () => string;
  /** Resolves a session's project for the projectId filter; null/undefined = project-less. */
  projectOf?: (sessionId: string) => string | null | undefined;
  warn?: (message: string, error?: unknown) => void;
}

export interface EventReadQuery {
  /** Forward page: the oldest `limit` events with seq > afterSeq. */
  afterSeq?: number;
  /** Without afterSeq: the newest `limit` events with seq < beforeSeq (default: the tail). */
  beforeSeq?: number;
  /** Exact match when present; null selects project-less events. */
  projectId?: string | null;
  limit: number;
}

export type EventSubscriber = (event: EventEnvelope) => void;

export interface EventLog {
  readonly logId: string;
  /** False when another live process holds writer.lock (append is a no-op) or after close. */
  readonly writable: boolean;
  /** Unparsable lines found at boot in the segments that were loaded. */
  readonly unparsableLines: number;
  lastSeq(): number;
  /** Null when not written: read-only process, closed log, or an id already seen. */
  append(draft: EventDraft): EventEnvelope | null;
  /** Ascending by seq. */
  read(query: EventReadQuery): EventEnvelope[];
  /** Subscribers run synchronously in append order and must not call append. */
  subscribe(subscriber: EventSubscriber): () => void;
  close(): void;
}

interface SegmentInfo {
  name: string;
  startSeq: number;
}

const segmentNameFor = (date: Date): string => `${date.toISOString().slice(0, 10)}.jsonl`;

const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | undefined)?.code;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

/**
 * Take writer.lock with wx; a lock whose pid is dead (or unreadable) is taken over once.
 * ponytail: two processes booting on the same stale lock at the same instant can both
 * win the takeover; fine for the shared dev data dir, add an fs-level lock if it bites.
 */
function acquireLock(lockPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid }));
      } finally {
        closeSync(fd);
      }
      return true;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    let pid: unknown;
    try {
      pid = (JSON.parse(readFileSync(lockPath, "utf8")) as { pid?: unknown }).pid;
    } catch {
      pid = undefined;
    }
    if (typeof pid === "number" && Number.isInteger(pid) && pid > 0 && pidAlive(pid)) return false;
    rmSync(lockPath, { force: true });
  }
  return false;
}

function readLogId(file: string, randomId: () => string, now: Date, writable: boolean): string {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { logId?: unknown };
    if (typeof parsed.logId === "string" && parsed.logId.length > 0) return parsed.logId;
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
  }
  // Missing or corrupt: a new logId tells clients to reset their cursor.
  const logId = randomId();
  if (writable) {
    const meta = { logId, createdAt: now.toISOString(), v: EVENT_ENVELOPE_VERSION };
    writeFileSync(file, `${JSON.stringify(meta)}\n`, { mode: 0o600 });
  }
  return logId;
}

function readSegment(file: string): { events: EventEnvelope[]; unparsable: number } {
  const { lines } = splitJsonl(readFileSync(file, "utf8"));
  const events: EventEnvelope[] = [];
  let unparsable = 0;
  for (const line of lines) {
    const event = parseEventLine(line);
    if (event) events.push(event);
    else unparsable += 1;
  }
  return { events, unparsable };
}

/** First valid seq of a segment, reading only its head (one event is at most MAX_EVENT_BYTES). */
function firstSeq(file: string): number | undefined {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(MAX_EVENT_BYTES * 2 + 2);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    for (const line of splitJsonl(buffer.subarray(0, read).toString("utf8")).lines) {
      const event = parseEventLine(line);
      if (event) return event.seq;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** Last index whose startSeq <= seq (0 when seq precedes every segment). */
function segmentAt(index: readonly SegmentInfo[], seq: number): number {
  let low = 0;
  let high = index.length - 1;
  let found = 0;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((index[mid] as SegmentInfo).startSeq <= seq) {
      found = mid;
      low = mid + 1;
    } else high = mid - 1;
  }
  return found;
}

export function createEventLog(dataDir: string, options: EventLogOptions = {}): EventLog {
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const warn =
    options.warn ?? ((message, error) => console.warn(`[events] ${message}`, error ?? ""));
  const dir = path.join(dataDir, "events");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(dir, "writer.lock");
  let writable = acquireLock(lockPath);
  if (!writable) warn("another live process holds events/writer.lock; this process is read-only");
  const logId = readLogId(path.join(dir, "log.json"), randomId, clock(), writable);

  const segmentFiles = (): string[] =>
    readdirSync(dir)
      .filter((name) => SEGMENT_NAME.test(name))
      .sort();

  // Boot repair: a crash mid-append leaves an unterminated last line; cut it so the
  // next append starts on a fresh line. Only the writer may touch the files.
  let repairedBytes = 0;
  const files = segmentFiles();
  const lastFile = files.at(-1);
  if (writable && lastFile) {
    const file = path.join(dir, lastFile);
    const bytes = readFileSync(file);
    const keep = bytes.lastIndexOf(0x0a) + 1;
    if (keep < bytes.length) {
      repairedBytes = bytes.length - keep;
      const fd = openSync(file, "r+");
      try {
        ftruncateSync(fd, keep);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      warn(`truncated a torn tail of ${repairedBytes} bytes in ${lastFile}`);
    }
  }

  // Load the newest two segments into the ring and the dedupe sets; walk further back
  // only while no valid event was found, so lastSeq survives empty or corrupt days.
  const today = segmentNameFor(clock());
  let currentIds = new Set<string>();
  let previousIds = new Set<string>();
  let lastSeq = 0;
  let unparsableLines = 0;
  let ring: EventEnvelope[] = [];
  let loadedFiles = 0;
  const startSeqs = new Map<string, number>();
  for (let i = files.length - 1; i >= 0 && (loadedFiles < 2 || lastSeq === 0); i -= 1) {
    const name = files[i] as string;
    const { events, unparsable } = readSegment(path.join(dir, name));
    unparsableLines += unparsable;
    if (events[0]) startSeqs.set(name, events[0].seq);
    for (const event of events) lastSeq = Math.max(lastSeq, event.seq);
    if (loadedFiles < 2) {
      const ids = name === today ? currentIds : previousIds;
      for (const event of events) ids.add(event.id);
      ring = [...events, ...ring];
    }
    loadedFiles += 1;
  }
  // True while the ring holds every event ever written (backward reads need no disk).
  let ringComplete = loadedFiles === files.length && ring.length <= RING_SIZE;
  ring = ring.slice(-RING_SIZE);
  if (unparsableLines > 0) warn(`${unparsableLines} unparsable event lines skipped at boot`);

  const buildIndex = (): SegmentInfo[] => {
    const index: SegmentInfo[] = [];
    for (const name of segmentFiles()) {
      const startSeq = startSeqs.get(name) ?? firstSeq(path.join(dir, name));
      if (startSeq !== undefined) index.push({ name, startSeq });
    }
    return index;
  };
  // The writer keeps its index current; a read-only process rebuilds it per read
  // because another process is appending.
  const segments = buildIndex();

  let fd: number | undefined;
  let openSegment: string | undefined;
  let segmentBytes = 0;
  let fsyncTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let dispatching = false;
  const subscribers = new Set<EventSubscriber>();

  const flush = (): void => {
    if (fsyncTimer) clearTimeout(fsyncTimer);
    fsyncTimer = undefined;
    if (fd === undefined) return;
    try {
      fsyncSync(fd);
    } catch (error) {
      warn("event log fsync failed", error);
    }
  };

  /** The fd for this append's day; never moves back to an older file if the clock does. */
  const segmentFd = (): number => {
    const dated = segmentNameFor(clock());
    const newest = openSegment ?? lastFile;
    const name = newest && newest > dated ? newest : dated;
    if (fd !== undefined && name === openSegment) return fd;
    if (fd !== undefined) {
      flush();
      closeSync(fd);
      previousIds = currentIds;
      currentIds = new Set();
    }
    fd = openSync(path.join(dir, name), "a", 0o600);
    segmentBytes = fstatSync(fd).size;
    openSegment = name;
    return fd;
  };

  const append = (draft: EventDraft): EventEnvelope | null => {
    if (dispatching) throw new Error("event log subscribers must not append (re-entrant append)");
    if (!writable || closed) return null;
    const id = draft.id ?? randomId();
    if (currentIds.has(id) || previousIds.has(id)) return null;
    const projectId = draft.sessionId ? (options.projectOf?.(draft.sessionId) ?? null) : null;
    const valid = validateEnvelope({
      ...draft,
      v: EVENT_ENVELOPE_VERSION,
      id,
      seq: lastSeq + 1,
      ts: clock().toISOString(),
      logId,
      projectId,
      payload: draft.payload ?? null,
    });
    if (!valid) throw new Error(`invalid event envelope for kind ${String(draft.kind)}`);
    const event = capEventSize(valid);
    const line = Buffer.from(`${JSON.stringify(event)}\n`, "utf8");
    const target = segmentFd();
    try {
      let written = 0;
      while (written < line.length) {
        written += writeSync(target, line, written, line.length - written);
      }
    } catch (error) {
      // Cut a partial line so the next append does not merge into it.
      try {
        ftruncateSync(target, segmentBytes);
      } catch (truncateError) {
        warn("could not truncate a partial event line", truncateError);
      }
      throw error;
    }
    segmentBytes += line.length;
    if (segments.at(-1)?.name !== openSegment) {
      segments.push({ name: openSegment as string, startSeq: event.seq });
      startSeqs.set(openSegment as string, event.seq);
    }
    lastSeq = event.seq;
    currentIds.add(id);
    ring.push(event);
    if (ring.length > RING_SIZE) {
      ring.shift();
      ringComplete = false;
    }
    fsyncTimer ??= setTimeout(flush, FSYNC_DELAY_MS).unref();
    // Same single-op rule as the push bus: every subscriber sees seq N before any sees N+1.
    dispatching = true;
    try {
      for (const subscriber of subscribers) {
        try {
          subscriber(event);
        } catch (error) {
          warn(`event subscriber failed on ${event.kind}`, error);
        }
      }
    } finally {
      dispatching = false;
    }
    return event;
  };

  const read = (query: EventReadQuery): EventEnvelope[] => {
    const { afterSeq, projectId, limit } = query;
    if (limit <= 0) return [];
    const upper = query.beforeSeq ?? Number.POSITIVE_INFINITY;
    const lower = afterSeq ?? Number.NEGATIVE_INFINITY;
    const matches = (event: EventEnvelope): boolean =>
      event.seq > lower &&
      event.seq < upper &&
      (projectId === undefined || event.projectId === projectId);
    // A read-only process's ring is a boot snapshot, so it always reads the files.
    const useRing = writable && !closed;
    const index = useRing ? segments : buildIndex();
    const load = (info: SegmentInfo): EventEnvelope[] =>
      readSegment(path.join(dir, info.name)).events.filter(matches);

    if (afterSeq !== undefined) {
      const first = ring[0];
      if (useRing && (first ? afterSeq >= first.seq - 1 : ringComplete)) {
        return ring.filter(matches).slice(0, limit);
      }
      const out: EventEnvelope[] = [];
      for (let i = segmentAt(index, afterSeq + 1); i < index.length && out.length < limit; i += 1) {
        out.push(...load(index[i] as SegmentInfo));
      }
      return out.slice(0, limit);
    }

    if (useRing) {
      const fromRing = ring.filter(matches);
      if (fromRing.length >= limit || ringComplete) return fromRing.slice(-limit);
    }
    // ponytail: a sparse projectId filter scans segments back to the first one; add a
    // per-project index if Activity reads on old projects get slow.
    let out: EventEnvelope[] = [];
    for (
      let i = index.length > 0 ? segmentAt(index, upper - 1) : -1;
      i >= 0 && out.length < limit;
      i -= 1
    ) {
      out = [...load(index[i] as SegmentInfo), ...out];
    }
    return out.slice(-limit);
  };

  const log: EventLog = {
    logId,
    get writable() {
      return writable && !closed;
    },
    unparsableLines,
    lastSeq: () => lastSeq,
    append,
    read,
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
    close() {
      if (closed) return;
      closed = true;
      flush();
      if (fd !== undefined) closeSync(fd);
      fd = undefined;
      if (writable) rmSync(lockPath, { force: true });
      writable = false;
      subscribers.clear();
    },
  };

  if (writable) {
    append({
      kind: "server.started",
      subject: { type: "server", id: randomId() },
      actor: { type: "system" },
      payload: { pid: process.pid, unparsableLines, repairedBytes },
    });
  }
  return log;
}
