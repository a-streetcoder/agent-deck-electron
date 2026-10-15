// A1a event log writer/reader (VISION_ORCHESTRATION principle 1). One log per data
// dir, daily UTC segments, projectId is a read filter. Plain synchronous module like
// the other stores; the envelope, parser and size cap live in @agent-deck/domain.
// The log is not authoritative until A1d, so append never throws in production.
//
// Layout: <dataDir>/events/{log.json, writer.lock, YYYY-MM-DD.jsonl}. Dir 0700, files 0600.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import path from "node:path";
import {
  EVENT_ENVELOPE_VERSION,
  MAX_EVENT_BYTES,
  parseEventLine,
  seqOfLine,
  serializeEvent,
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
// The desktop stops the backend with taskkill /F, so close() often never runs: a lock
// is stale when its pid is dead or the owner stopped touching it.
const LOCK_HEARTBEAT_MS = 10_000;
const LOCK_STALE_MS = 120_000;
const LOCK_RETRY_MS = 30_000;
// After a stale-lock takeover, skip seqs a crashed writer may have used before its fsync.
const TAKEOVER_SEQ_GAP = 1_000;
export const MAX_EVENT_READ_LIMIT = 1_000;
// ponytail: one read scans at most this many segments from disk and returns a
// continuation cursor, so a quiet project never scans all history inside one request
// handler; A1c refines paging.
const MAX_SEGMENTS_PER_READ = 2;
const SEGMENT_NAME = /^\d{4}-\d{2}-\d{2}\.jsonl$/;
const POSIX = process.platform !== "win32";

/** writer.lock paths this process holds, with their token (pid alone is reused). */
const heldLocks = new Map<string, string>();

export interface EventLogOptions {
  clock?: () => Date;
  randomId?: () => string;
  /** Resolves a session's project when the draft has no explicit projectId. */
  projectOf?: (sessionId: string) => string | null | undefined;
  warn?: (message: string, error?: unknown) => void;
  /** Throw on invalid drafts and IO errors instead of returning them (default under tests). */
  strict?: boolean;
}

export type AppendFailure = "readonly" | "closed" | "duplicate" | "invalid" | "io";

export type AppendResult =
  | { ok: true; event: EventEnvelope }
  | { ok: false; reason: AppendFailure; error?: unknown };

export interface EventReadQuery {
  /** Forward page: the oldest events with seq > afterSeq. */
  afterSeq?: number;
  /** Without afterSeq: the newest events with seq < beforeSeq (default: the tail). */
  beforeSeq?: number;
  /** Exact match when present; null selects project-less events. */
  projectId?: string | null;
  /**
   * A2: one session's events: its sessionId, an agent actor in it, the session node
   * itself, or an edge from it (a fork's session.created).
   */
  sessionId?: string;
  /** Also return server.started outside the filters, so a reader can apply the restart rule. */
  includeServerEvents?: boolean;
  /** Capped at MAX_EVENT_READ_LIMIT. */
  limit: number;
}

export interface EventPage {
  /** Ascending by seq. */
  events: EventEnvelope[];
  /** True when another read with the next cursor can return more. */
  more: boolean;
  /** Forward reads: pass as afterSeq to continue (or to poll for new events). */
  nextAfterSeq?: number;
  /** Backward reads: pass as beforeSeq to continue. */
  nextBeforeSeq?: number;
}

export type EventSubscriber = (event: EventEnvelope) => void;

export interface EventLog {
  readonly logId: string;
  /** False when another live process holds writer.lock (append is a no-op) or after close. */
  readonly writable: boolean;
  /** Lines skipped at boot in the loaded segments (corrupt or written by a newer build). */
  readonly unparsableLines: number;
  lastSeq(): number;
  append(draft: EventDraft): AppendResult;
  read(query: EventReadQuery): EventPage;
  /** Subscribers run synchronously in append order and must not call append. */
  subscribe(subscriber: EventSubscriber): () => void;
  close(): void;
}

interface SegmentInfo {
  name: string;
  startSeq: number;
}

interface LockInfo {
  pid?: number;
  token?: string;
  mtimeMs: number;
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

function readLock(file: string): LockInfo | undefined {
  try {
    const { mtimeMs } = statSync(file);
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { pid?: unknown; token?: unknown };
      return {
        mtimeMs,
        ...(typeof parsed.pid === "number" ? { pid: parsed.pid } : {}),
        ...(typeof parsed.token === "string" ? { token: parsed.token } : {}),
      };
    } catch {
      return { mtimeMs };
    }
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
}

function lockIsStale(lockPath: string, lock: LockInfo): boolean {
  // Lock content is published atomically, so an unreadable lock is corrupt, not half-written.
  if (lock.pid === undefined || lock.token === undefined) return true;
  if (Date.now() - lock.mtimeMs > LOCK_STALE_MS) return true;
  if (lock.pid === process.pid) return heldLocks.get(lockPath) !== lock.token;
  return !pidAlive(lock.pid);
}

/** Write a temp file and hard-link it into place: content and creation are one step. */
function publishExclusive(file: string, content: string, token: string): boolean {
  const temp = `${file}.${token}.tmp`;
  writeFileSync(temp, content, { mode: 0o600, flag: "wx" });
  try {
    linkSync(temp, file);
    return true;
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  } finally {
    rmSync(temp, { force: true });
  }
}

/**
 * Take writer.lock. A stale lock is renamed to a unique name first, so only one
 * contender removes it; if the file it moved turns out to be someone's fresh lock,
 * it is put back and this process stays read-only.
 */
function acquireLock(lockPath: string, token: string): "acquired" | "takenOver" | "refused" {
  const content = JSON.stringify({ pid: process.pid, token });
  let tookOver = false;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (publishExclusive(lockPath, content, token)) {
      heldLocks.set(lockPath, token);
      return tookOver ? "takenOver" : "acquired";
    }
    const lock = readLock(lockPath);
    if (!lock) continue;
    if (!lockIsStale(lockPath, lock)) return "refused";
    const grave = `${lockPath}.stale-${token}`;
    try {
      renameSync(lockPath, grave);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      throw error;
    }
    const moved = readLock(grave);
    if (moved?.token !== lock.token) {
      try {
        linkSync(grave, lockPath);
      } catch {
        // Someone else holds the lock now either way.
      }
      rmSync(grave, { force: true });
      return "refused";
    }
    rmSync(grave, { force: true });
    tookOver = true;
  }
  return "refused";
}

function readLogId(file: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as { logId?: unknown };
    return typeof parsed.logId === "string" && parsed.logId.length > 0 ? parsed.logId : undefined;
  } catch (error) {
    if (errorCode(error) === "ENOENT" || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

const exists = (file: string): boolean => {
  try {
    statSync(file);
    return true;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return false;
    throw error;
  }
};

interface SegmentScan {
  events: EventEnvelope[];
  unparsable: number;
  firstSeq?: number;
  maxSeq: number;
}

function readSegment(file: string): SegmentScan {
  const { lines } = splitJsonl(readFileSync(file, "utf8"));
  const scan: SegmentScan = { events: [], unparsable: 0, maxSeq: 0 };
  for (const line of lines) {
    const event = parseEventLine(line);
    const seq = event?.seq ?? seqOfLine(line);
    if (seq !== undefined) {
      scan.firstSeq ??= seq;
      scan.maxSeq = Math.max(scan.maxSeq, seq);
    }
    if (event) scan.events.push(event);
    else scan.unparsable += 1;
  }
  return scan;
}

/** Complete lines of a byte range of a file (one event is at most MAX_EVENT_BYTES). */
function linesAt(file: string, fromEnd: boolean): string[] {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, MAX_EVENT_BYTES * 2 + 2);
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, fromEnd ? size - length : 0);
    return splitJsonl(buffer.subarray(0, read).toString("utf8")).lines;
  } finally {
    closeSync(fd);
  }
}

const firstSeqOf = (file: string): number | undefined => {
  for (const line of linesAt(file, false)) {
    const seq = seqOfLine(line);
    if (seq !== undefined) return seq;
  }
  return undefined;
};

const lastSeqOf = (file: string): number => {
  const lines = linesAt(file, true);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const seq = seqOfLine(lines[i] as string);
    if (seq !== undefined) return seq;
  }
  return 0;
};

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

/** A log that records nothing: the server falls back to it when the real one cannot open. */
export function disabledEventLog(): EventLog {
  return {
    logId: "",
    writable: false,
    unparsableLines: 0,
    lastSeq: () => 0,
    append: () => ({ ok: false, reason: "readonly" }),
    read: () => ({ events: [], more: false }),
    subscribe: () => () => {},
    close: () => {},
  };
}

export function createEventLog(dataDir: string, options: EventLogOptions = {}): EventLog {
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  const strict = options.strict ?? process.env.AGENT_DECK_TEST === "1";
  const warn =
    options.warn ?? ((message, error) => console.warn(`[events] ${message}`, error ?? ""));
  const dir = path.join(dataDir, "events");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const metaPath = path.join(dir, "log.json");
  const lockPath = path.join(dir, "writer.lock");
  const token = randomId();
  const meta = (logId: string): string =>
    `${JSON.stringify({ logId, createdAt: clock().toISOString(), v: EVENT_ENVELOPE_VERSION })}\n`;

  // log.json is published (atomically, first one wins) before anyone takes the lock,
  // so a reader never invents its own logId.
  let logId = readLogId(metaPath);
  if (logId === undefined && !exists(metaPath)) {
    publishExclusive(metaPath, meta(randomId()), token);
    logId = readLogId(metaPath);
  }
  const lock = acquireLock(lockPath, token);
  let writable = lock !== "refused";
  if (!writable) warn("another live process holds events/writer.lock; this process is read-only");
  if (logId === undefined) {
    if (!writable)
      throw new Error("events/log.json is unreadable and this process cannot repair it");
    // Corrupt: a new logId tells clients to reset their cursor.
    logId = randomId();
    const temp = `${metaPath}.${token}.tmp`;
    writeFileSync(temp, meta(logId), { mode: 0o600 });
    renameSync(temp, metaPath);
    warn("events/log.json was unreadable; started a new logId");
  }

  const segmentFiles = (): string[] =>
    readdirSync(dir)
      .filter((name) => SEGMENT_NAME.test(name))
      .sort();

  let currentIds = new Set<string>();
  let previousIds = new Set<string>();
  let lastSeq = 0;
  let unparsableLines = 0;
  let ring: EventEnvelope[] = [];
  let ringComplete = false;
  let lastFile: string | undefined;
  const startSeqs = new Map<string, number>();
  let segments: SegmentInfo[] = [];

  const buildIndex = (): SegmentInfo[] => {
    const index: SegmentInfo[] = [];
    for (const name of segmentFiles()) {
      let startSeq = startSeqs.get(name);
      if (startSeq === undefined) {
        startSeq = firstSeqOf(path.join(dir, name));
        if (startSeq !== undefined) startSeqs.set(name, startSeq);
      }
      if (startSeq !== undefined) index.push({ name, startSeq });
    }
    return index;
  };

  /**
   * Load state from disk: at boot, and again when a read-only process becomes the
   * writer. Only a writer tightens modes and repairs the torn tail. Returns the
   * number of torn bytes cut.
   */
  const loadFromDisk = (asWriter: boolean, tookOver: boolean): number => {
    const files = segmentFiles();
    lastFile = files.at(-1);

    if (asWriter && POSIX) {
      // A synced or restored directory may come back 0755/0644.
      const tighten = (file: string, mode: number): void => {
        try {
          if ((statSync(file).mode & 0o777 & ~mode) !== 0) chmodSync(file, mode);
        } catch (error) {
          warn(`could not restrict ${path.basename(file)}`, error);
        }
      };
      tighten(dir, 0o700);
      for (const name of ["log.json", "writer.lock", ...files]) {
        tighten(path.join(dir, name), 0o600);
      }
    }

    // A crash mid-append leaves an unterminated last line; cut it so the next append
    // starts on a fresh line.
    let repairedBytes = 0;
    if (asWriter && lastFile) {
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

    // Load the newest two segments into the ring and the dedupe sets; walk further
    // back only while no seq was found, so lastSeq survives empty or corrupt days.
    const today = segmentNameFor(clock());
    currentIds = new Set();
    previousIds = new Set();
    unparsableLines = 0;
    ring = [];
    let loadedFiles = 0;
    let diskSeq = 0;
    for (let i = files.length - 1; i >= 0 && (loadedFiles < 2 || diskSeq === 0); i -= 1) {
      const name = files[i] as string;
      const scan = readSegment(path.join(dir, name));
      if (scan.firstSeq !== undefined) startSeqs.set(name, scan.firstSeq);
      diskSeq = Math.max(diskSeq, scan.maxSeq);
      if (loadedFiles < 2) {
        unparsableLines += scan.unparsable;
        const ids = name === today ? currentIds : previousIds;
        for (const event of scan.events) ids.add(event.id);
        ring = scan.events.concat(ring);
      }
      loadedFiles += 1;
    }
    // True while the ring holds every event ever written (backward reads need no disk).
    ringComplete = files.length <= 2 && ring.length <= RING_SIZE;
    ring = ring.slice(-RING_SIZE);
    if (unparsableLines > 0) warn(`${unparsableLines} unparsable event lines skipped at boot`);
    lastSeq = Math.max(lastSeq, diskSeq);
    if (tookOver && lastSeq > 0) lastSeq += TAKEOVER_SEQ_GAP;
    // The writer keeps its index current; a read-only process rebuilds it per read
    // (start seqs are cached) because another process is appending.
    segments = buildIndex();
    return repairedBytes;
  };

  const repairedBytes = loadFromDisk(writable, lock === "takenOver");

  let fd: number | undefined;
  let openSegment: string | undefined;
  let tornWrite = false;
  let fsyncTimer: NodeJS.Timeout | undefined;
  let closed = false;
  let dispatching = false;
  const subscribers = new Set<EventSubscriber>();
  let heartbeat: NodeJS.Timeout | undefined;
  let lockRetry: NodeJS.Timeout | undefined;

  const startHeartbeat = (): void => {
    heartbeat = setInterval(() => {
      try {
        if (readLock(lockPath)?.token !== token) {
          warn("events/writer.lock was taken over; this process is now read-only");
          writable = false;
          clearInterval(heartbeat);
          heartbeat = undefined;
          startLockRetry();
          return;
        }
        const now = new Date();
        utimesSync(lockPath, now, now);
      } catch (error) {
        warn("could not refresh events/writer.lock", error);
      }
    }, LOCK_HEARTBEAT_MS).unref();
  };

  // A read-only process keeps trying: a lock held by a reused pid or a writer that
  // died goes stale after LOCK_STALE_MS, and this process then becomes the writer.
  const startLockRetry = (): void => {
    lockRetry = setInterval(() => {
      if (closed) return;
      try {
        const result = acquireLock(lockPath, token);
        if (result === "refused") return;
        clearInterval(lockRetry);
        lockRetry = undefined;
        if (fd !== undefined) closeSync(fd);
        fd = undefined;
        openSegment = undefined;
        tornWrite = false;
        loadFromDisk(true, result === "takenOver");
        writable = true;
        startHeartbeat();
        warn("acquired events/writer.lock; this process is now the writer");
      } catch (error) {
        warn("could not retry events/writer.lock", error);
      }
    }, LOCK_RETRY_MS).unref();
  };

  if (writable) startHeartbeat();
  else startLockRetry();

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
  const segmentFd = (now: Date): number => {
    const dated = segmentNameFor(now);
    const newest = openSegment ?? lastFile;
    const name = newest && newest > dated ? newest : dated;
    if (fd !== undefined && name === openSegment) return fd;
    if (fd !== undefined) {
      flush();
      closeSync(fd);
      fd = undefined;
      previousIds = currentIds;
      currentIds = new Set();
    }
    fd = openSync(path.join(dir, name), "a", 0o600);
    openSegment = name;
    return fd;
  };

  const fail = (reason: "invalid" | "io", error: unknown): AppendResult => {
    if (strict) throw error;
    warn(`event append failed (${reason})`, error);
    return { ok: false, reason, error };
  };

  const append = (draft: EventDraft): AppendResult => {
    if (dispatching) {
      return fail("invalid", new Error("event log subscribers must not append (re-entrant)"));
    }
    if (closed) return { ok: false, reason: "closed" };
    if (!writable) return { ok: false, reason: "readonly" };
    const id = draft.id ?? randomId();
    if (currentIds.has(id) || previousIds.has(id)) return { ok: false, reason: "duplicate" };
    const now = clock();
    let text: string;
    let event: EventEnvelope;
    try {
      const projectId =
        draft.projectId !== undefined
          ? draft.projectId
          : draft.sessionId
            ? (options.projectOf?.(draft.sessionId) ?? null)
            : null;
      const valid = validateEnvelope({
        ...draft,
        v: EVENT_ENVELOPE_VERSION,
        id,
        seq: lastSeq + 1,
        ts: now.toISOString(),
        logId,
        projectId,
        payload: draft.payload ?? null,
      });
      if (!valid) throw new Error(`invalid event envelope for kind ${String(draft.kind)}`);
      text = serializeEvent(valid);
      // Ring and subscribers get the line as written, not the producer's live objects.
      event = JSON.parse(text) as EventEnvelope;
    } catch (error) {
      return fail("invalid", error);
    }
    try {
      const target = segmentFd(now);
      // After a failed write the file may end in a partial line: start on a fresh one.
      const line = Buffer.from(`${tornWrite ? "\n" : ""}${text}\n`, "utf8");
      let written = 0;
      while (written < line.length) {
        written += writeSync(target, line, written, line.length - written);
      }
      tornWrite = false;
    } catch (error) {
      tornWrite = true;
      lastSeq = event.seq; // never reuse a seq that may have reached the disk
      return fail("io", error);
    }
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
    return { ok: true, event };
  };

  const currentLastSeq = (): number => {
    // A read-only process re-derives the watermark from the writer's newest segment.
    if (!writable || closed) {
      const newest = segmentFiles().at(-1);
      if (newest) lastSeq = Math.max(lastSeq, lastSeqOf(path.join(dir, newest)));
    }
    return lastSeq;
  };

  const read = (query: EventReadQuery): EventPage => {
    const { afterSeq, projectId, sessionId } = query;
    const limit = Math.min(Math.max(Math.floor(query.limit), 0), MAX_EVENT_READ_LIMIT);
    const upper = query.beforeSeq ?? Number.POSITIVE_INFINITY;
    const lower = afterSeq ?? Number.NEGATIVE_INFINITY;
    const ofSession = (event: EventEnvelope): boolean =>
      event.sessionId === sessionId ||
      (event.actor.type === "agent" && event.actor.sessionId === sessionId) ||
      (event.subject.type === "session" && event.subject.id === sessionId) ||
      (event.parent?.type === "session" && event.parent.id === sessionId);
    const matches = (event: EventEnvelope): boolean =>
      event.seq > lower &&
      event.seq < upper &&
      (((projectId === undefined || event.projectId === projectId) &&
        (sessionId === undefined || ofSession(event))) ||
        (query.includeServerEvents === true && event.kind === "server.started"));
    // A read-only process's ring is a boot snapshot, so it always reads the files.
    const useRing = writable && !closed;
    const index = useRing ? segments : buildIndex();
    const segmentEvents = (i: number): EventEnvelope[] =>
      readSegment(path.join(dir, (index[i] as SegmentInfo).name)).events;

    if (afterSeq !== undefined) {
      // Collect limit + 1 to know whether there is more.
      const out: EventEnvelope[] = [];
      let scannedTo = afterSeq;
      let next: number | undefined;
      const first = ring[0];
      if (useRing && (first ? afterSeq >= first.seq - 1 : ringComplete)) {
        for (const event of ring) {
          if (matches(event)) out.push(event);
          if (out.length > limit) break;
        }
        scannedTo = Math.max(afterSeq, lastSeq);
      } else {
        let i = segmentAt(index, afterSeq + 1);
        const stop = Math.min(index.length, i + MAX_SEGMENTS_PER_READ);
        for (; i < stop && out.length <= limit; i += 1) {
          for (const event of segmentEvents(i)) {
            scannedTo = Math.max(scannedTo, event.seq);
            if (matches(event)) out.push(event);
            if (out.length > limit) break;
          }
        }
        if (out.length <= limit && i < index.length) next = (index[i] as SegmentInfo).startSeq - 1;
      }
      if (out.length > limit) {
        const events = out.slice(0, limit);
        return { events, more: true, nextAfterSeq: events.at(-1)?.seq ?? afterSeq };
      }
      if (next !== undefined) return { events: out, more: true, nextAfterSeq: next };
      return { events: out, more: false, nextAfterSeq: scannedTo };
    }

    if (limit === 0) return { events: [], more: true, nextBeforeSeq: query.beforeSeq };
    if (useRing) {
      const newestFirst: EventEnvelope[] = [];
      for (let i = ring.length - 1; i >= 0 && newestFirst.length <= limit; i -= 1) {
        const event = ring[i] as EventEnvelope;
        if (matches(event)) newestFirst.push(event);
      }
      if (newestFirst.length >= limit || ringComplete) {
        const events = newestFirst.slice(0, limit).reverse();
        const more = newestFirst.length > limit || !ringComplete;
        return { events, more, nextBeforeSeq: events[0]?.seq ?? query.beforeSeq };
      }
    }
    let out: EventEnvelope[] = [];
    let i = index.length > 0 ? segmentAt(index, upper - 1) : -1;
    const stop = i - MAX_SEGMENTS_PER_READ;
    for (; i >= 0 && i > stop && out.length <= limit; i -= 1) {
      const found = segmentEvents(i).filter(matches);
      out = found.slice(-(limit + 1 - out.length)).concat(out);
    }
    if (out.length > limit) {
      const events = out.slice(-limit);
      return { events, more: true, nextBeforeSeq: (events[0] as EventEnvelope).seq };
    }
    if (i >= 0)
      return { events: out, more: true, nextBeforeSeq: (index[i + 1] as SegmentInfo).startSeq };
    return { events: out, more: false, nextBeforeSeq: out[0]?.seq ?? query.beforeSeq };
  };

  const log: EventLog = {
    logId,
    get writable() {
      return writable && !closed;
    },
    get unparsableLines() {
      return unparsableLines;
    },
    lastSeq: currentLastSeq,
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
      if (heartbeat) clearInterval(heartbeat);
      if (lockRetry) clearInterval(lockRetry);
      flush();
      if (fd !== undefined) closeSync(fd);
      fd = undefined;
      // Release only our own lock: a contender that took over keeps its fresh one.
      if (heldLocks.get(lockPath) === token) {
        heldLocks.delete(lockPath);
        try {
          if (readLock(lockPath)?.token === token) rmSync(lockPath, { force: true });
        } catch (error) {
          warn("could not release events/writer.lock", error);
        }
      }
      writable = false;
      subscribers.clear();
    },
  };

  if (writable) {
    append({
      kind: "server.started",
      subject: { type: "server", id: randomId() },
      actor: { type: "system" },
      payload: { unparsableLines, repairedBytes },
    });
  }
  return log;
}
