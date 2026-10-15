import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SUBAGENT_RESULT_READ, type EventDraft } from "@agent-deck/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import { registerSubagentDeltaBridgeTool } from "../src/bridgeTools.ts";
import { createEventLog, type EventLog } from "../src/eventLog.ts";
import { createEventProducers } from "../src/eventProducers.ts";
import { createLogReaders } from "../src/eventReaders.ts";
import {
  createSubagentDeltaReader,
  renderSubagentDelta,
  SUBAGENT_DELTA_MAX_CHARS,
  type SubagentDeltaView,
} from "../src/subagentDelta.ts";
import type { SubagentRunRecord } from "../src/subagentRunStore.ts";

const PARENT = "11111111-1111-4111-8111-111111111111";
const OTHER_PARENT = "22222222-2222-4222-8222-222222222222";
const RUN = "33333333-3333-4333-8333-333333333333";
const CHILD = "44444444-4444-4444-8444-444444444444";

const dirs: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const record = (overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord => ({
  id: RUN,
  parentSessionId: PARENT,
  task: "Summarize",
  status: "completed",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  summary: "the full private summary",
  ...overrides,
});

function harness(run: SubagentRunRecord = record(), dataDir?: string) {
  const dir = dataDir ?? mkdtempSync(path.join(tmpdir(), "agent-deck-delta-"));
  if (!dataDir) dirs.push(dir);
  const log = createEventLog(dir, { strict: true, warn: () => {} });
  logs.push(log);
  const producers = createEventProducers(log);
  const readers = createLogReaders(log);
  const warn = vi.fn();
  const bridge = new BridgeRegistry();
  const reader = createSubagentDeltaReader({
    index: () => readers.subagentDeltas(),
    runs: {
      get: (id) => (id === run.id ? run : undefined),
      list: (parent) => (parent === run.parentSessionId ? [run] : []),
    },
    recordRead: (parent, runId, uptoSeq) => producers.subagentResultRead(parent, runId, uptoSeq),
    warn,
  });
  registerSubagentDeltaBridgeTool(bridge, reader);
  const call = async (
    runId: string,
    {
      sessionId = PARENT,
      full,
      signal,
    }: { sessionId?: string; full?: boolean; signal?: AbortSignal } = {},
  ) => {
    const result = await bridge.dispatch(
      {
        tool: "subagent_delta",
        params: { runId, ...(full === undefined ? {} : { full }) },
        sessionId,
        toolCallId: "t",
        token: "k",
      },
      { token: "k", signal },
    );
    return { ...result, json: () => JSON.parse(result.content) as Record<string, unknown> };
  };
  const runEvent = (kind: string, status: string, extra: Partial<EventDraft> = {}) =>
    log.append({
      kind,
      sessionId: PARENT,
      subject: { type: "subagentRun", id: RUN },
      actor: { type: "system" },
      payload: {
        run: { ...record(), status },
        ...(kind === "subagent.run.finished"
          ? { result: { status, summary: `head at ${status}` } }
          : {}),
      },
      ...extra,
    });
  const childTurn = (toolName: string) =>
    log.append({
      kind: "session.turn.completed",
      subject: { type: "turn", id: `turn-${toolName}` },
      parent: { type: "subagentRun", id: RUN },
      actor: { type: "agent", sessionId: CHILD },
      payload: { entryIds: [], toolCalls: [{ id: toolName, name: toolName, isError: false }] },
    });
  const reads = () =>
    log.read({ afterSeq: 0, limit: 1_000 }).events.filter((e) => e.kind === SUBAGENT_RESULT_READ);
  return { dir, log, call, runEvent, childTurn, reads, reader, warn };
}

describe("subagent_delta bridge tool", () => {
  it("records the parent's cursor after each delivery and reports only new events", async () => {
    const h = harness();
    h.runEvent("subagent.run.created", "running", { parent: { type: "session", id: PARENT } });
    h.childTurn("read");
    h.runEvent("subagent.run.finished", "completed");

    const first = (await h.call(RUN)).json();
    expect(Object.keys(first)[0]).toBe("statusNow");
    expect(first).toMatchObject({
      statusNow: "completed",
      // The owner gets the private full text of the latest result, not the log's head.
      summary: "the full private summary",
      sinceSeq: 0,
      full: true,
      turnsCompleted: 1,
      toolCalls: { read: 1 },
      filesChangedSinceBase: [],
    });
    expect(first.transcript).toBeUndefined();
    const [read] = h.reads();
    expect(read).toMatchObject({
      sessionId: PARENT,
      subject: { type: "subagentRun", id: RUN },
      actor: { type: "agent", sessionId: PARENT },
      payload: { uptoSeq: first.uptoSeq },
    });

    // Nothing new: no second cursor event, an empty delta without the cumulative files.
    const idle = (await h.call(RUN)).json();
    expect(idle).toMatchObject({ sinceSeq: first.uptoSeq, full: false, turnsCompleted: 0 });
    expect(idle.summary).toBeUndefined();
    expect(idle.filesChangedSinceBase).toBeUndefined();
    expect(h.reads()).toHaveLength(1);

    h.runEvent("subagent.run.updated", "running");
    h.childTurn("write");
    h.runEvent("subagent.run.finished", "completed");
    const second = (await h.call(RUN)).json();
    expect(second).toMatchObject({
      sinceSeq: first.uptoSeq,
      full: false,
      statusThen: "completed",
      turnsCompleted: 1,
      toolCalls: { write: 1 },
    });

    // full: true reads the whole run again (and the cursor only moves forward).
    const again = (await h.call(RUN, { full: true })).json();
    expect(again).toMatchObject({
      full: true,
      turnsCompleted: 2,
      toolCalls: { read: 1, write: 1 },
    });
    expect(h.reads().map((e) => (e.payload as { uptoSeq: number }).uptoSeq)).toEqual([
      first.uptoSeq,
      second.uptoSeq,
    ]);

    // The web card's read is the full summary with the public head and the transcript
    // pointer, and never moves the cursor.
    const card = await h.reader.read(PARENT, RUN, { from: "start" });
    expect(card.ok && card.delta).toMatchObject({
      full: true,
      turnsCompleted: 2,
      summaryHead: "head at completed",
      transcript: { transcriptRoute: `/sessions/${PARENT}/subagent-runs/${RUN}/transcript` },
    });
    expect(h.reads()).toHaveLength(2);
  });

  it("an aborted call leaves the cursor where it was", async () => {
    const h = harness();
    h.runEvent("subagent.run.created", "running");
    const controller = new AbortController();
    controller.abort();
    await h.call(RUN, { signal: controller.signal });
    expect(h.reads()).toHaveLength(0);
    expect((await h.call(RUN)).json()).toMatchObject({ full: true });
  });

  it("two concurrent looks see the same window and write one cursor", async () => {
    const h = harness();
    h.runEvent("subagent.run.created", "running");
    h.childTurn("read");
    const [a, b] = await Promise.all([h.call(RUN), h.call(RUN)]);
    expect(a.json()).toEqual(b.json());
    expect(h.reads()).toHaveLength(1);
    h.childTurn("write");
    const c = (await h.call(RUN)).json();
    expect(c).toMatchObject({ sinceSeq: a.json().uptoSeq, toolCalls: { write: 1 } });
    const cursors = h.reads().map((e) => (e.payload as { uptoSeq: number }).uptoSeq);
    expect(cursors).toEqual([...cursors].sort((x, y) => x - y));
  });

  it("a result hand-back moves the cursor to the finished event it delivered", async () => {
    // managed_parallel hands back by its tool call: the run's current turnToolCallId.
    const h = harness(record({ turnToolCallId: "call-1" }));
    h.runEvent("subagent.run.created", "running");
    h.childTurn("read");
    h.runEvent("subagent.run.finished", "completed");
    h.reader.resultsDelivered(PARENT, { toolCallId: "unrelated" });
    expect(h.reads()).toHaveLength(0);
    h.reader.resultsDelivered(PARENT, { toolCallId: "call-1" });
    h.reader.resultsDelivered(PARENT, [RUN]);
    expect(h.reads()).toHaveLength(1);
    const after = (await h.call(RUN)).json();
    expect(after).toMatchObject({ full: false, turnsCompleted: 0, toolCalls: {} });
    expect(after.summary).toBeUndefined();
  });

  it("is not_found for another session's run and for an unknown run", async () => {
    const h = harness();
    h.runEvent("subagent.run.created", "running");
    const foreign = await h.call(RUN, { sessionId: OTHER_PARENT });
    expect(foreign.isError).toBe(true);
    expect(foreign.content).toMatch(/^not_found/);
    const unknown = await h.call("55555555-5555-4555-8555-555555555555");
    expect(unknown.content).toMatch(/^not_found/);
    expect((await h.call("not-a-uuid")).isError).toBe(true);
    h.reader.resultsDelivered(OTHER_PARENT, [RUN]);
    expect(h.reads()).toHaveLength(0);
  });

  it("falls back to the store's result, as JSON, when the log has no events for the run", async () => {
    const h = harness();
    const result = (await h.call(RUN)).json();
    expect(result).toMatchObject({ statusNow: "completed", summary: "the full private summary" });
    expect(result.note).toContain("No event history");
    expect(h.reads()).toHaveLength(0);
  });

  it("a read-only log: every look is full and the refused cursor is warned once", async () => {
    const writer = harness();
    writer.runEvent("subagent.run.created", "running");
    writer.childTurn("read");
    const readOnly = harness(record(), writer.dir);
    expect(readOnly.log.writable).toBe(false);
    expect((await readOnly.call(RUN)).json()).toMatchObject({ full: true, turnsCompleted: 1 });
    expect((await readOnly.call(RUN)).json()).toMatchObject({ full: true, turnsCompleted: 1 });
    expect(readOnly.warn).toHaveBeenCalledTimes(1);
    expect(writer.reads()).toHaveLength(0);
  });

  it("lists the files changed in the worktree since the base, unavailable once removed", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "agent-deck-delta-git-"));
    dirs.push(repo);
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "core.autocrlf=false", "-c", "user.email=t@t", "-c", "user.name=t", ...args],
        { cwd: repo, encoding: "utf8" },
      ).trim();
    git("init", "-q");
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    writeFileSync(path.join(repo, "b.txt"), "b\n");
    git("add", ".");
    git("commit", "-qm", "base");
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(repo, "a.txt"), "changed\n");
    git("commit", "-qam", "child commit");
    writeFileSync(path.join(repo, "b.txt"), "uncommitted\n");
    writeFileSync(path.join(repo, "new.txt"), "untracked\n");

    const run = record({ worktreePath: repo, worktreeBaseCommit: base });
    const h = harness(run);
    h.runEvent("subagent.run.created", "running");
    const delta = (await h.call(RUN)).json();
    expect(delta.filesChangedSinceBase).toEqual(["a.txt", "b.txt", "new.txt"]);
    expect(delta.filesChangedSinceBaseUnavailable).toBeUndefined();

    run.worktreeCleanup = "physical_removed";
    const removed = (await h.call(RUN, { full: true })).json();
    expect(removed).toMatchObject({
      filesChangedSinceBase: [],
      filesChangedSinceBaseUnavailable: true,
    });
  });
});

describe("renderSubagentDelta", () => {
  const view = (overrides: Partial<SubagentDeltaView> = {}): SubagentDeltaView => ({
    runId: RUN,
    statusNow: "completed",
    lastTurnOutcome: "completed",
    full: true,
    sinceSeq: 0,
    uptoSeq: 10,
    turnsCompleted: 3,
    toolCalls: Object.fromEntries(
      Array.from({ length: 100 }, (_, i) => [`tool_with_a_long_name_${i}`, i + 1]),
    ),
    failedToolCalls: ["tool_with_a_long_name_1"],
    openQuestions: [{ id: "q", message: "Which folder? ".repeat(200) }],
    decisions: Array.from({ length: 20 }, (_, i) => ({
      id: `d${i}`,
      message: `decision ${i} "quoted"\n`.repeat(50),
      response: "yes",
    })),
    filesChangedSinceBase: Array.from(
      { length: 200 },
      (_, i) => `src/some/deep/folder/file-${i}.ts`,
    ),
    transcript: { sessionId: PARENT, runId: RUN, transcriptRoute: "/x" },
    ...overrides,
  });

  it("stays valid JSON under the cap: state first, lists trimmed, then the result cut", () => {
    for (const summary of ["r".repeat(4_000), `"\\\n`.repeat(20_000)]) {
      const text = renderSubagentDelta(view({ summary }));
      expect(text.length).toBeLessThanOrEqual(SUBAGENT_DELTA_MAX_CHARS);
      const parsed = JSON.parse(text) as Record<string, unknown>;
      expect(Object.keys(parsed).slice(0, 3)).toEqual(["statusNow", "lastTurnOutcome", "summary"]);
      expect(parsed.toolNamesOmitted).toBeGreaterThan(0);
      // The most used tools survive the trim.
      expect(parsed.toolCalls).not.toHaveProperty("tool_with_a_long_name_0");
      expect(parsed.transcript).toBeUndefined();
    }
    const small = JSON.parse(renderSubagentDelta(view({ summary: "r".repeat(4_000) }))) as {
      summary: string;
      summaryTruncated?: boolean;
    };
    expect(small.summary).toHaveLength(4_000);
    expect(small.summaryTruncated).toBeUndefined();
    const big = JSON.parse(renderSubagentDelta(view({ summary: "x".repeat(40_000) }))) as {
      summary: string;
      summaryTruncated?: boolean;
    };
    expect(big.summaryTruncated).toBe(true);
    expect(big.summary.length).toBeLessThan(40_000);
  });
});
