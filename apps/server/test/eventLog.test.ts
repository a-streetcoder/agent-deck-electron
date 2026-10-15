import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EventDraft, EventEnvelope } from "@agent-deck/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEventLog, type EventLog, type EventLogOptions } from "../src/eventLog.ts";

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
const options = (extra: EventLogOptions = {}): EventLogOptions => ({
  clock: () => clockNow,
  warn: () => {},
  ...extra,
});

const open = (dataDir: string, extra: EventLogOptions = {}): EventLog => {
  const log = createEventLog(dataDir, options(extra));
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

const seqs = (events: EventEnvelope[]): number[] => events.map((event) => event.seq);
const eventsDir = (dataDir: string): string => path.join(dataDir, "events");

describe("event log", () => {
  it("assigns seq, resolves projectId and reads by cursor, limit and project", () => {
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const projects: Record<string, string> = { s1: "p1", s2: "p2" };
    const log = open(tempDataDir(), { projectOf: (sessionId) => projects[sessionId] });
    expect(log.writable).toBe(true);
    // Boot writes server.started as seq 1.
    expect(log.read({ limit: 10 })).toMatchObject([
      { seq: 1, kind: "server.started", projectId: null },
    ]);

    const a = log.append(draft({ sessionId: "s1" }));
    const b = log.append(draft({ sessionId: "s2" }));
    const c = log.append(draft({ sessionId: "s1" }));
    const d = log.append(draft({ sessionId: "unknown" }));
    expect([a?.seq, b?.seq, c?.seq, d?.seq]).toEqual([2, 3, 4, 5]);
    expect([a?.projectId, b?.projectId, d?.projectId]).toEqual(["p1", "p2", null]);
    expect(a).toMatchObject({ v: 1, logId: log.logId, ts: "2026-10-15T12:00:00.000Z" });
    expect(log.lastSeq()).toBe(5);

    expect(seqs(log.read({ afterSeq: 1, limit: 2 }))).toEqual([2, 3]);
    expect(seqs(log.read({ afterSeq: 3, limit: 10 }))).toEqual([4, 5]);
    expect(seqs(log.read({ afterSeq: 5, limit: 10 }))).toEqual([]);
    expect(seqs(log.read({ limit: 2 }))).toEqual([4, 5]);
    expect(seqs(log.read({ beforeSeq: 4, limit: 2 }))).toEqual([2, 3]);
    expect(seqs(log.read({ projectId: "p1", limit: 10 }))).toEqual([2, 4]);
    expect(seqs(log.read({ projectId: "p1", afterSeq: 2, limit: 10 }))).toEqual([4]);
    expect(seqs(log.read({ projectId: null, limit: 10 }))).toEqual([1, 5]);
    expect(() => log.append(draft({ kind: "not-namespaced" }))).toThrow(/invalid event/);
    expect(log.lastSeq()).toBe(5);
  });

  it("rotates daily UTC segments with a continuous cursor and reads across files", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-13T23:59:59.000Z");
    const first = open(dataDir);
    first.append(draft()); // seq 2
    clockNow = new Date("2026-10-14T00:00:00.000Z");
    first.append(draft()); // seq 3, new segment
    clockNow = new Date("2026-10-15T08:00:00.000Z");
    first.append(draft()); // seq 4, new segment
    // A clock that goes back keeps writing to the newest segment.
    clockNow = new Date("2026-10-14T09:00:00.000Z");
    first.append(draft()); // seq 5
    expect(readdirSync(eventsDir(dataDir)).filter((name) => name.endsWith(".jsonl"))).toEqual([
      "2026-10-13.jsonl",
      "2026-10-14.jsonl",
      "2026-10-15.jsonl",
    ]);
    const lines = (name: string): number[] =>
      readFileSync(path.join(eventsDir(dataDir), name), "utf8")
        .trim()
        .split("\n")
        .map((line) => (JSON.parse(line) as EventEnvelope).seq);
    expect(lines("2026-10-13.jsonl")).toEqual([1, 2]);
    expect(lines("2026-10-14.jsonl")).toEqual([3]);
    expect(lines("2026-10-15.jsonl")).toEqual([4, 5]);
    first.close();

    // After a restart the ring holds only the newest two segments: older reads hit disk.
    clockNow = new Date("2026-10-15T09:00:00.000Z");
    const second = open(dataDir);
    expect(second.logId).toBe(first.logId);
    expect(second.lastSeq()).toBe(6); // seq 6 = this boot's server.started
    expect(seqs(second.read({ afterSeq: 0, limit: 100 }))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(seqs(second.read({ afterSeq: 1, limit: 2 }))).toEqual([2, 3]);
    expect(seqs(second.read({ beforeSeq: 3, limit: 100 }))).toEqual([1, 2]);
    expect(seqs(second.read({ beforeSeq: 5, limit: 3 }))).toEqual([2, 3, 4]);
    expect(seqs(second.read({ limit: 100 }))).toEqual([1, 2, 3, 4, 5, 6]);
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
    expect(second.append(draft())?.seq).toBe(4);
    expect(seqs(second.read({ afterSeq: 0, limit: 10 }))).toEqual([1, 2, 3, 4]);
  });

  it("ignores a duplicate id across a restart and over the previous segment", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const first = open(dataDir);
    expect(first.append(draft({ id: "dup" }))?.seq).toBe(2);
    expect(first.append(draft({ id: "dup" }))).toBeNull();
    first.close();

    const second = open(dataDir);
    expect(second.append(draft({ id: "dup" }))).toBeNull();
    clockNow = new Date("2026-10-16T12:00:00.000Z");
    expect(second.append(draft({ id: "other" }))).not.toBeNull();
    // "dup" now sits in the previous segment: still deduped.
    expect(second.append(draft({ id: "dup" }))).toBeNull();
    expect(second.read({ afterSeq: 0, limit: 10 }).filter((e) => e.id === "dup")).toHaveLength(1);
  });

  it("refuses a second writer and takes over a dead pid's lock", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    const writer = open(dataDir);
    const warn = vi.fn();
    const reader = open(dataDir, { warn });
    expect(reader.writable).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("read-only"));
    expect(reader.logId).toBe(writer.logId);
    expect(reader.append(draft())).toBeNull();
    writer.append(draft());
    // The reader sees the writer's appends on disk.
    expect(seqs(reader.read({ afterSeq: 0, limit: 10 }))).toEqual([1, 2]);
    writer.close();
    expect(readdirSync(eventsDir(dataDir))).not.toContain("writer.lock");
    reader.close();

    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    expect(dead).toBeGreaterThan(0);
    writeFileSync(path.join(eventsDir(dataDir), "writer.lock"), JSON.stringify({ pid: dead }));
    const takeover = open(dataDir);
    expect(takeover.writable).toBe(true);
    expect(takeover.lastSeq()).toBe(3);
    expect(JSON.parse(readFileSync(path.join(eventsDir(dataDir), "writer.lock"), "utf8"))).toEqual({
      pid: process.pid,
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
    expect(log.append(draft())?.seq).toBe(4);
    expect(seen).toEqual(["a2", "b2", "a3", "b3", "a4"]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("subscriber failed"),
      expect.any(Error),
    );
  });

  // Windows has no POSIX modes; the VM (Linux) test run covers this assertion.
  it.skipIf(process.platform === "win32")("creates the dir 0700 and its files 0600", () => {
    const dataDir = tempDataDir();
    clockNow = new Date("2026-10-15T12:00:00.000Z");
    open(dataDir);
    expect(statSync(eventsDir(dataDir)).mode & 0o777).toBe(0o700);
    for (const name of ["log.json", "writer.lock", "2026-10-15.jsonl"]) {
      expect(statSync(path.join(eventsDir(dataDir), name)).mode & 0o777).toBe(0o600);
    }
  });
});
