import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EventDraft, EventEnvelope } from "@agent-deck/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createEventLog,
  MAX_EVENT_READ_LIMIT,
  type EventLog,
  type EventLogOptions,
} from "../src/eventLog.ts";

const dirs: string[] = [];
const logs: EventLog[] = [];

afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tempDataDir = (): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-deck-events-"));
  dirs.push(dir);
  return dir;
};

let clockNow = new Date("2026-10-15T12:00:00.000Z");
const open = (dataDir: string, extra: EventLogOptions = {}): EventLog => {
  const log = createEventLog(dataDir, { clock: () => clockNow, warn: () => {}, ...extra });
  logs.push(log);
  return log;
};

const draft = (overrides: Partial<EventDraft> = {}): EventDraft => ({
  kind: "plan.updated",
  subject: { type: "plan", id: "plan-1" },
  actor: { type: "system" },
  payload: { n: 1 },
  ...overrides,
});

const seqOf = (log: EventLog, value: EventDraft = draft()): number | undefined => {
  const result = log.append(value);
  return result.ok ? result.event.seq : undefined;
};
const seqs = (events: EventEnvelope[]): number[] => events.map((event) => event.seq);
const eventsDir = (dataDir: string): string => path.join(dataDir, "events");
const lockFile = (dataDir: string): string => path.join(eventsDir(dataDir), "writer.lock");
const plantLock = (dataDir: string, pid: number, ageMs = 0): void => {
  writeFileSync(lockFile(dataDir), JSON.stringify({ pid, token: "planted" }));
  const at = new Date(Date.now() - ageMs);
  utimesSync(lockFile(dataDir), at, at);
};

describe("event log", () => {
  it("assigns seq, resolves projectId and reads by cursor, limit and project", () => {
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const projects: Record<string, string> = { s1: "p1", s2: "p2" };
    const log = open(tempDataDir(), { projectOf: (sessionId) => projects[sessionId] });
    expect(log.writable).toBe(true);
    // Boot writes server.started as seq 1.
    expect(log.read({ limit: 10 }).events).toMatchObject([
      { seq: 1, kind: "server.started", projectId: null },
    ]);

    const a = log.append(draft({ sessionId: "s1" }));
    expect(a).toMatchObject({
      ok: true,
      event: { seq: 2, v: 1, logId: log.logId, projectId: "p1", ts: "2026-10-15T12:00:00.000Z" },
    });
    expect(seqOf(log, draft({ sessionId: "s2" }))).toBe(3);
    expect(seqOf(log, draft({ sessionId: "s1" }))).toBe(4);
    expect(seqOf(log, draft({ sessionId: "unknown" }))).toBe(5);
    // An explicit projectId wins over the session lookup.
    expect(log.append(draft({ projectId: "p2", sessionId: "s1" }))).toMatchObject({
      event: { seq: 6, projectId: "p2" },
    });
    expect(log.lastSeq()).toBe(6);

    expect(log.read({ afterSeq: 1, limit: 2 })).toMatchObject({ more: true, nextAfterSeq: 3 });
    expect(seqs(log.read({ afterSeq: 1, limit: 2 }).events)).toEqual([2, 3]);
    expect(log.read({ afterSeq: 3, limit: 10 })).toMatchObject({ more: false, nextAfterSeq: 6 });
    expect(seqs(log.read({ afterSeq: 6, limit: 10 }).events)).toEqual([]);
    expect(seqs(log.read({ limit: 2 }).events)).toEqual([5, 6]);
    expect(log.read({ beforeSeq: 4, limit: 2 })).toMatchObject({ more: true, nextBeforeSeq: 2 });
    expect(seqs(log.read({ beforeSeq: 4, limit: 2 }).events)).toEqual([2, 3]);
    expect(log.read({ beforeSeq: 4, limit: 5 }).more).toBe(false);
    expect(seqs(log.read({ projectId: "p1", limit: 10 }).events)).toEqual([2, 4]);
    expect(seqs(log.read({ projectId: "p2", afterSeq: 3, limit: 10 }).events)).toEqual([6]);
    expect(seqs(log.read({ projectId: null, limit: 10 }).events)).toEqual([1, 5]);
  });

  it("never throws outside strict mode and throws under it", () => {
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const warn = vi.fn();
    const log = open(tempDataDir(), {
      strict: false,
      warn,
      projectOf: () => {
        throw new Error("lookup failed");
      },
    });
    expect(log.append(draft({ kind: "not-namespaced" }))).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(log.append(draft({ payload: { n: 1n } }))).toMatchObject({
      ok: false,
      reason: "invalid",
    });
    expect(log.append(draft({ sessionId: "s1" }))).toMatchObject({ ok: false, reason: "invalid" });
    expect(warn).toHaveBeenCalledWith("event append failed (invalid)", expect.any(Error));
    expect(log.lastSeq()).toBe(1);

    const strict = open(tempDataDir(), { strict: true });
    expect(() => strict.append(draft({ kind: "not-namespaced" }))).toThrow(/invalid event/);
    strict.close();
    expect(strict.append(draft())).toEqual({ ok: false, reason: "closed" });
  });

  it("keeps the event as written, not the producer's live payload", () => {
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const log = open(tempDataDir());
    const payload = { status: "running" };
    const seen: EventEnvelope[] = [];
    log.subscribe((event) => seen.push(event));
    log.append(draft({ payload }));
    payload.status = "mutated";
    expect(log.read({ afterSeq: 1, limit: 1 }).events[0]?.payload).toEqual({ status: "running" });
    expect(seen[0]?.payload).toEqual({ status: "running" });
  });

  it("rotates daily UTC segments with a continuous cursor and pages across files", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-12T10:00:00.000Z");
    const first = open(dataDir, { projectOf: () => "quiet" }); // seq 1 = server.started
    first.append(draft({ sessionId: "s" })); // seq 2, the only "quiet" event
    clockNow = new Date("2026-10-13T23:59:59.000Z");
    first.append(draft()); // seq 3
    clockNow = new Date("2026-10-14T00:00:00.000Z");
    first.append(draft()); // seq 4, new segment at the UTC day boundary
    clockNow = new Date("2026-10-15T08:00:00.000Z");
    first.append(draft()); // seq 5
    // A clock that goes back keeps writing to the newest segment.
    clockNow = new Date("2026-10-14T09:00:00.000Z");
    first.append(draft()); // seq 6
    expect(readdirSync(eventsDir(dataDir)).filter((name) => name.endsWith(".jsonl"))).toEqual([
      "2026-10-12.jsonl",
      "2026-10-13.jsonl",
      "2026-10-14.jsonl",
      "2026-10-15.jsonl",
    ]);
    const lines = (name: string): number[] =>
      readFileSync(path.join(eventsDir(dataDir), name), "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as EventEnvelope).seq);
    expect(lines("2026-10-12.jsonl")).toEqual([1, 2]);
    expect(lines("2026-10-13.jsonl")).toEqual([3]);
    expect(lines("2026-10-14.jsonl")).toEqual([4]);
    expect(lines("2026-10-15.jsonl")).toEqual([5, 6]);
    first.close();

    // After a restart the ring holds only the newest two segments: older reads hit
    // disk, at most two segments per read, with a continuation cursor.
    clockNow = new Date("2026-10-15T09:00:00.000Z");
    const second = open(dataDir);
    expect(second.logId).toBe(first.logId);
    expect(second.lastSeq()).toBe(7); // this boot's server.started
    const page1 = second.read({ afterSeq: 0, limit: 100 });
    expect(page1).toMatchObject({ more: true, nextAfterSeq: 3 });
    expect(seqs(page1.events)).toEqual([1, 2, 3]);
    const page2 = second.read({ afterSeq: 3, limit: 100 });
    expect(seqs(page2.events)).toEqual([4, 5, 6, 7]);
    expect(page2.more).toBe(false);
    expect(seqs(second.read({ afterSeq: 1, limit: 2 }).events)).toEqual([2, 3]);
    // Two segments (10-14, 10-13) per read: the third event needs the next page.
    const back = second.read({ beforeSeq: 5, limit: 3 });
    expect(back).toMatchObject({ more: true, nextBeforeSeq: 3 });
    expect(seqs(back.events)).toEqual([3, 4]);
    expect(seqs(second.read({ beforeSeq: 3, limit: 1 }).events)).toEqual([2]);

    // A quiet project: the first backward page scans two segments, finds nothing, and
    // hands back a cursor; the next page reaches the event.
    const quiet1 = second.read({ projectId: "quiet", limit: 10 });
    expect(quiet1).toEqual({ events: [], more: true, nextBeforeSeq: 4 });
    const quiet2 = second.read({ projectId: "quiet", beforeSeq: 4, limit: 10 });
    expect(seqs(quiet2.events)).toEqual([2]);
    expect(quiet2.more).toBe(false);
    expect(second.read({ limit: 1_000_000 }).events.length).toBeLessThanOrEqual(
      MAX_EVENT_READ_LIMIT,
    );
  });

  it("repairs a torn tail, counts unparsable lines and keeps the seq", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const first = open(dataDir);
    first.append(draft());
    first.close();
    const segment = path.join(eventsDir(dataDir), "2026-10-15.jsonl");
    appendFileSync(segment, 'not json\n{"v":1,"id":"torn","seq":');

    const warn = vi.fn();
    const second = open(dataDir, { warn });
    expect(second.unparsableLines).toBe(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("torn tail"));
    const text = readFileSync(segment, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain('"torn"');
    expect(second.lastSeq()).toBe(3);
    expect(seqOf(second)).toBe(4);
    expect(seqs(second.read({ afterSeq: 0, limit: 10 }).events)).toEqual([1, 2, 3, 4]);
  });

  it("recovers seq from lines a newer build wrote and still reads its node types", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const first = open(dataDir);
    first.close();
    const segment = path.join(eventsDir(dataDir), "2026-10-15.jsonl");
    const base = { v: 1, ts: clockNow.toISOString(), logId: first.logId, projectId: null };
    const newerType = {
      ...base,
      id: "n1",
      seq: 40,
      kind: "graph.node.created",
      subject: { type: "graphNode", id: "g1" },
      actor: { type: "system" },
      payload: null,
    };
    appendFileSync(segment, `${JSON.stringify(newerType)}\n`);
    appendFileSync(segment, `${JSON.stringify({ v: 2, seq: 50, id: "n2", shape: "v2" })}\n`);

    const second = open(dataDir);
    expect(second.unparsableLines).toBe(1);
    expect(second.lastSeq()).toBe(51);
    expect(seqs(second.read({ afterSeq: 1, limit: 10 }).events)).toEqual([40, 51]);
    // Writing the unknown node type is still refused.
    expect(() =>
      second.append(draft({ subject: { type: "graphNode" as "plan", id: "g2" } })),
    ).toThrow(/invalid event/);
  });

  it("ignores a duplicate id across a restart and over the previous segment", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const first = open(dataDir);
    expect(seqOf(first, draft({ id: "dup" }))).toBe(2);
    expect(first.append(draft({ id: "dup" }))).toEqual({ ok: false, reason: "duplicate" });
    first.close();

    const second = open(dataDir);
    expect(second.append(draft({ id: "dup" }))).toEqual({ ok: false, reason: "duplicate" });
    clockNow = new Date("2026-10-16T12:00:00.000Z");
    expect(second.append(draft({ id: "other" })).ok).toBe(true);
    // "dup" now sits in the previous segment: still deduped.
    expect(second.append(draft({ id: "dup" })).ok).toBe(false);
    const all = second.read({ afterSeq: 0, limit: 10 }).events;
    expect(all.filter((event) => event.id === "dup")).toHaveLength(1);
  });

  it("refuses a second writer and lets a reader follow the writer's watermark", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const writer = open(dataDir);
    const warn = vi.fn();
    const reader = open(dataDir, { warn });
    expect(reader.writable).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("read-only"));
    expect(reader.logId).toBe(writer.logId);
    expect(reader.append(draft())).toEqual({ ok: false, reason: "readonly" });
    writer.append(draft());
    expect(reader.lastSeq()).toBe(2);
    expect(seqs(reader.read({ afterSeq: 0, limit: 10 }).events)).toEqual([1, 2]);
    reader.close();
    expect(readdirSync(eventsDir(dataDir))).toContain("writer.lock");
    writer.close();
    expect(readdirSync(eventsDir(dataDir))).not.toContain("writer.lock");
  });

  it("takes over a stale lock (dead pid, own pid not held, old heartbeat) with a seq gap", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    open(dataDir).close(); // seq 1

    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(dead).toBeGreaterThan(0);
    plantLock(dataDir, dead as number);
    const afterDead = open(dataDir);
    expect(afterDead.writable).toBe(true);
    expect(afterDead.lastSeq()).toBe(1 + 1_000 + 1);
    expect(JSON.parse(readFileSync(lockFile(dataDir), "utf8")).pid).toBe(process.pid);
    afterDead.close();

    // A pid reused by this very process (taskkill /F, then restart) is not ours.
    plantLock(dataDir, process.pid);
    const afterReuse = open(dataDir);
    expect(afterReuse.writable).toBe(true);
    afterReuse.close();

    // A live pid that stopped touching the lock (e.g. EPERM system pids).
    plantLock(dataDir, process.ppid, 10 * 60_000);
    const afterSilent = open(dataDir);
    expect(afterSilent.writable).toBe(true);
    afterSilent.close();

    // A live pid with a fresh heartbeat keeps the lock.
    plantLock(dataDir, process.ppid);
    expect(open(dataDir).writable).toBe(false);
    expect(readdirSync(eventsDir(dataDir)).filter((name) => /\.(tmp|stale-)/.test(name))).toEqual(
      [],
    );
  });

  it("refreshes the lock and turns read-only when another process took it over", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const dataDir = tempDataDir();
      clockNow = new Date("2026-10-15T12:00:00.000Z");
      const log = open(dataDir);
      const old = new Date(Date.now() - 60_000);
      utimesSync(lockFile(dataDir), old, old);
      vi.advanceTimersByTime(10_000);
      expect(statSync(lockFile(dataDir)).mtimeMs).toBeGreaterThan(old.getTime() + 30_000);
      plantLock(dataDir, process.ppid);
      vi.advanceTimersByTime(10_000);
      expect(log.writable).toBe(false);
      expect(log.append(draft())).toEqual({ ok: false, reason: "readonly" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries the lock while read-only and becomes the writer once it goes stale", () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      const dataDir = tempDataDir();
      clockNow = new Date("2026-10-15T12:00:00.000Z");
      const first = open(dataDir);
      first.append(draft()); // seq 2
      first.close();
      // A live pid holding a fresh lock: this boot starts read-only.
      plantLock(dataDir, process.ppid);
      const warn = vi.fn();
      const log = open(dataDir, { warn });
      expect(log.writable).toBe(false);
      vi.advanceTimersByTime(30_000);
      expect(log.writable).toBe(false);
      // The holder stopped refreshing: past 2 minutes the next retry takes over.
      const old = new Date(Date.now() - 3 * 60_000);
      utimesSync(lockFile(dataDir), old, old);
      vi.advanceTimersByTime(30_000);
      expect(log.writable).toBe(true);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("now the writer"));
      expect(JSON.parse(readFileSync(lockFile(dataDir), "utf8")).pid).toBe(process.pid);
      // lastSeq reloaded from disk (2), then the takeover gap and the takeover boundary.
      expect(seqOf(log)).toBe(2 + 1_000 + 2);
      const events = log.read({ afterSeq: 0, limit: 10 }).events;
      expect(seqs(events)).toEqual([1, 2, 1_003, 1_004]);
      expect(events[2]?.kind).toBe("writer.acquired");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not delete a lock another process took over", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const log = open(dataDir);
    plantLock(dataDir, process.ppid);
    log.close();
    expect(JSON.parse(readFileSync(lockFile(dataDir), "utf8"))).toEqual({
      pid: process.ppid,
      token: "planted",
    });
  });

  it("notifies subscribers in seq order and rejects re-entrant appends", () => {
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const warn = vi.fn();
    const log = open(tempDataDir(), { warn });
    const seen: string[] = [];
    let reentrant: unknown;
    log.subscribe((event) => {
      seen.push(`a${event.seq}`);
      try {
        log.append(draft());
      } catch (error) {
        reentrant = error;
      }
    });
    const unsubscribe = log.subscribe((event) => seen.push(`b${event.seq}`));
    log.append(draft());
    log.append(draft());
    expect(seen).toEqual(["a2", "b2", "a3", "b3"]);
    expect(String(reentrant)).toMatch(/re-entrant/);
    expect(log.lastSeq()).toBe(3);
    unsubscribe();
    log.subscribe(() => {
      throw new Error("boom");
    });
    expect(seqOf(log)).toBe(4);
    expect(seen).toEqual(["a2", "b2", "a3", "b3", "a4"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("subscriber failed"),
      expect.any(Error),
    );
  });

  // Windows has no POSIX modes; the VM (Linux) test run covers this assertion.
  it.skipIf(process.platform === "win32")("keeps the dir 0700 and its files 0600", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    open(dataDir).close();
    // A synced or restored copy comes back loose; the next writer tightens it.
    mkdirSync(eventsDir(dataDir), { recursive: true });
    chmodSync(eventsDir(dataDir), 0o755);
    chmodSync(path.join(eventsDir(dataDir), "2026-10-15.jsonl"), 0o644);
    chmodSync(path.join(eventsDir(dataDir), "log.json"), 0o644);
    open(dataDir);
    expect(statSync(eventsDir(dataDir)).mode & 0o777).toBe(0o700);
    for (const name of ["log.json", "writer.lock", "2026-10-15.jsonl"]) {
      expect(statSync(path.join(eventsDir(dataDir), name)).mode & 0o777).toBe(0o600);
    }
  });
});
