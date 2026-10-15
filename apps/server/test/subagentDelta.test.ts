import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SUBAGENT_RESULT_READ, type EventDraft } from "@agent-deck/domain";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import { registerSubagentDeltaBridgeTool } from "../src/bridgeTools.ts";
import { createEventLog, type EventLog } from "../src/eventLog.ts";
import { createEventProducers } from "../src/eventProducers.ts";
import { createSubagentDeltaReader } from "../src/subagentDelta.ts";
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
  summary: "store summary",
  ...overrides,
});

function harness(run: SubagentRunRecord = record()) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-delta-"));
  dirs.push(dataDir);
  const log = createEventLog(dataDir, { strict: true, warn: () => {} });
  logs.push(log);
  const producers = createEventProducers(log);
  const bridge = new BridgeRegistry();
  const reader = createSubagentDeltaReader(log, {
    get: (id) => (id === run.id ? run : undefined),
  });
  registerSubagentDeltaBridgeTool(bridge, reader, (parent, runId, uptoSeq) =>
    producers.subagentResultRead(parent, runId, uptoSeq),
  );
  const call = (runId: string, sessionId = PARENT) =>
    bridge.dispatch(
      { tool: "subagent_delta", params: { runId }, sessionId, toolCallId: "t", token: "k" },
      { token: "k" },
    );
  const runEvent = (kind: string, status: string, extra: Partial<EventDraft> = {}) =>
    log.append({
      kind,
      sessionId: PARENT,
      subject: { type: "subagentRun", id: RUN },
      actor: { type: "system" },
      payload: {
        run: { ...record(), status },
        ...(kind === "subagent.run.finished"
          ? { result: { status, summary: `summary at ${status}` } }
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
  return { log, call, runEvent, childTurn, reads, reader };
}

describe("subagent_delta bridge tool", () => {
  it("records the parent's cursor after each delivery and reports only new events", async () => {
    const h = harness();
    h.runEvent("subagent.run.created", "running", {
      parent: { type: "session", id: PARENT },
    });
    h.childTurn("read");
    h.runEvent("subagent.run.finished", "completed");

    const first = JSON.parse((await h.call(RUN)).content) as Record<string, unknown>;
    expect(first).toMatchObject({
      sinceSeq: 0,
      full: true,
      statusNow: "completed",
      turnsCompleted: 1,
      toolCallsSinceLastLook: [{ name: "read" }],
      summaryHead: "summary at completed",
      filesTouched: [],
      transcript: {
        sessionId: PARENT,
        runId: RUN,
        transcriptRoute: `/sessions/${PARENT}/subagent-runs/${RUN}/transcript`,
      },
    });
    const [read] = h.reads();
    expect(read).toMatchObject({
      sessionId: PARENT,
      subject: { type: "subagentRun", id: RUN },
      actor: { type: "agent", sessionId: PARENT },
      payload: { uptoSeq: first.uptoSeq },
    });

    // Nothing new: no second cursor event, an empty delta.
    const idle = JSON.parse((await h.call(RUN)).content) as Record<string, unknown>;
    expect(idle).toMatchObject({ sinceSeq: first.uptoSeq, full: false, turnsCompleted: 0 });
    expect(idle.summaryHead).toBeUndefined();
    expect(h.reads()).toHaveLength(1);

    h.runEvent("subagent.run.updated", "running");
    h.childTurn("write");
    h.runEvent("subagent.run.finished", "completed");
    const second = JSON.parse((await h.call(RUN)).content) as Record<string, unknown>;
    expect(second).toMatchObject({
      sinceSeq: first.uptoSeq,
      full: false,
      statusThen: "completed",
      turnsCompleted: 1,
      toolCallsSinceLastLook: [{ name: "write" }],
    });
    expect(h.reads().map((e) => (e.payload as { uptoSeq: number }).uptoSeq)).toEqual([
      first.uptoSeq,
      second.uptoSeq,
    ]);

    // The web card's read is the full summary and never moves the cursor.
    const card = await h.reader.read(PARENT, RUN, "start");
    expect(card.ok && card.delta).toMatchObject({ full: true, turnsCompleted: 2 });
    expect(h.reads()).toHaveLength(2);
  });

  it("is not_found for another session's run and for an unknown run", async () => {
    const h = harness();
    h.runEvent("subagent.run.created", "running");
    const foreign = await h.call(RUN, OTHER_PARENT);
    expect(foreign.isError).toBe(true);
    expect(foreign.content).toMatch(/^not_found/);
    const unknown = await h.call("55555555-5555-4555-8555-555555555555");
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toMatch(/^not_found/);
    expect((await h.call("not-a-uuid")).isError).toBe(true);
    expect(h.reads()).toHaveLength(0);
  });

  it("falls back to the store's result when the log has no events for the run", async () => {
    const h = harness();
    const result = await h.call(RUN);
    expect(result.isError).toBeUndefined();
    expect(result.content).toContain("No event history");
    expect(result.content).toContain("store summary");
    expect(h.reads()).toHaveLength(0);
  });

  it("lists the files the child touched in its worktree since the base commit", async () => {
    const repo = mkdtempSync(path.join(tmpdir(), "agent-deck-delta-git-"));
    dirs.push(repo);
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "core.autocrlf=false", "-c", "user.email=t@t", "-c", "user.name=t", ...args],
        {
          cwd: repo,
          encoding: "utf8",
        },
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

    const h = harness(record({ worktreePath: repo, worktreeBaseCommit: base }));
    h.runEvent("subagent.run.created", "running");
    const delta = JSON.parse((await h.call(RUN)).content) as Record<string, unknown>;
    expect(delta.filesTouched).toEqual(["a.txt", "b.txt", "new.txt"]);
    expect(delta.filesTouchedUnavailable).toBeUndefined();
  });
});
