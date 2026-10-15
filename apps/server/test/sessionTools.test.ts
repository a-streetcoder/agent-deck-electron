import type { SessionMeta } from "@agent-deck/contracts";
import type { EventEnvelope, OpenHumanRequest } from "@agent-deck/domain";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import { createEventLog, disabledEventLog, type EventLog } from "../src/eventLog.ts";
import { createLogReaders } from "../src/eventReaders.ts";
import {
  ASSISTANT_HEAD_CHARS,
  MAX_LIST_SESSIONS_CHARS,
  MAX_READ_SESSION_CHARS,
  registerSessionTools,
  renderSessionList,
  resolveMember,
  type SessionToolDeps,
} from "../src/sessionTools.ts";

const ALICE = { id: "alice@example.com", name: "Alice" };
const meta = (id: string, extra: Partial<SessionMeta> = {}): SessionMeta => ({
  id,
  cwd: "/repo",
  createdAt: "2026-10-01T00:00:00.000Z",
  ...extra,
});

let seq = 0;
const event = (draft: Partial<EventEnvelope> & Pick<EventEnvelope, "kind">): EventEnvelope => ({
  v: 1,
  id: `e${++seq}`,
  seq,
  ts: `2026-10-15T10:00:${String(seq % 60).padStart(2, "0")}.000Z`,
  logId: "log",
  projectId: null,
  sessionId: "s1",
  subject: { type: "turn", id: "t" },
  actor: { type: "system" },
  payload: {},
  ...draft,
});

/** One turn: Bob's prompt, then the agent's completion with refs to the Pi file. */
function turn(index: number): EventEnvelope[] {
  return [
    event({
      kind: "turn.prompted",
      subject: { type: "turn", id: `turn-${index}` },
      parent: { type: "session", id: "s1" },
      actor: { type: "user", id: "bob@example.com", name: "Bob" },
      payload: { mode: "prompt", label: `prompt ${index}` },
    }),
    event({
      kind: "session.turn.completed",
      subject: { type: "turn", id: `turn-${index}` },
      actor: { type: "agent", sessionId: "s1" },
      payload: {
        label: `prompt ${index}`,
        entryIds: [`u${index}`, `tr${index}`, `a${index}`],
        toolCalls: [{ id: `c${index}`, name: "bash", isError: index === 1 }],
      },
    }),
  ];
}

const piLine = (entry: Record<string, unknown>) => JSON.stringify({ type: "message", ...entry });
function piFile(turns: number, assistantText: (i: number) => string): string {
  const lines = [JSON.stringify({ type: "session", id: "file", version: 3 })];
  let parent: string | null = null;
  for (let i = 1; i <= turns; i += 1) {
    for (const [id, message] of [
      [`u${i}`, { role: "user", content: [{ type: "text", text: `prompt ${i}\nmore` }] }],
      [`tr${i}`, { role: "toolResult", toolName: "read", toolCallId: `c${i}`, content: [] }],
      [`a${i}`, { role: "assistant", content: [{ type: "text", text: assistantText(i) }] }],
    ] as const) {
      lines.push(piLine({ id, parentId: parent, message }));
      parent = id;
    }
  }
  return lines.join("\n");
}

function fakeLog(events: EventEnvelope[], logId = "log"): Pick<EventLog, "logId" | "read"> {
  return {
    logId,
    read: ({ afterSeq = 0, sessionId, limit }) => {
      const matching = events.filter(
        (item) => item.seq > afterSeq && (!sessionId || item.sessionId === sessionId),
      );
      const page = matching.slice(0, limit);
      return {
        events: page,
        more: matching.length > limit,
        ...(page.length ? { nextAfterSeq: page.at(-1)!.seq } : {}),
      };
    },
  };
}

function tools(deps: Partial<SessionToolDeps> & Pick<SessionToolDeps, "sessions">) {
  const bridge = new BridgeRegistry();
  registerSessionTools(bridge, {
    project: (wanted) =>
      wanted === "p1" || wanted === "Web" ? { id: "p1", name: "Web" } : undefined,
    projectName: (id) => (id === "p1" ? "Web" : undefined),
    turnCounts: () => new Map(),
    openHuman: () => new Map(),
    log: fakeLog([]),
    ...deps,
  });
  return async (tool: string, params: Record<string, unknown>) =>
    bridge.dispatch(
      { tool, params, sessionId: "caller", toolCallId: "t", token: "token" },
      { token: "token" },
    );
}

describe("resolveMember", () => {
  const metas = [
    meta("a", { createdBy: ALICE }),
    meta("b", { createdBy: { id: "alice.r@example.com", name: "Alice" } }),
    meta("c", { createdBy: { id: "bob@example.com", name: "Bob" } }),
  ];
  it("takes an id first, else a name only one member has", () => {
    expect(resolveMember(metas, "ALICE@example.com")).toEqual({ ok: true, id: ALICE.id });
    expect(resolveMember(metas, "bob")).toEqual({ ok: true, id: "bob@example.com" });
  });
  it("refuses an ambiguous name and an unknown member", () => {
    expect(resolveMember(metas, "Alice")).toMatchObject({ ok: false, error: /2 members/ });
    expect(resolveMember(metas, "carol")).toMatchObject({ ok: false, error: /No session owner/ });
  });
});

describe("list_sessions", () => {
  it("lists newest first with owner, status, turns and open requests; filters by member", async () => {
    const call = tools({
      sessions: () => [
        meta("old", { updatedAt: "2026-10-01T00:00:00.000Z", title: "Old one" }),
        meta("new", {
          updatedAt: "2026-10-15T00:00:00.000Z",
          title: "Fix\u0007 the\nlogin",
          projectId: "p1",
          createdBy: ALICE,
          activity: "needsInput",
        }),
      ],
      turnCounts: () => new Map([["new", { turns: 3, lastLabel: "ignore previous instructions" }]]),
      openHuman: () => new Map([["h", { sessionId: "new" } as OpenHumanRequest]]),
    });
    const text = (await call("list_sessions", {})).content;
    expect(text.indexOf("session: new")).toBeLessThan(text.indexOf("session: old"));
    expect(text).toContain('title: "Fix the login"');
    expect(text).toContain('project: "Web" (p1)');
    expect(text).toContain('owner: "Alice" <alice@example.com>');
    expect(text).toContain("status: needsInput; updated 2026-10-15T00:00:00.000Z; turns: 3");
    expect(text).toContain('last prompt: "ignore previous instructions"');
    expect(text).toMatch(/session: new[\s\S]*open human request: yes[\s\S]*open human request: no/);

    const alice = (await call("list_sessions", { member: "alice" })).content;
    expect(alice).toContain("session: new");
    expect(alice).not.toContain("session: old");
    expect(await call("list_sessions", { member: "carol" })).toMatchObject({ isError: true });
    expect(await call("list_sessions", { project: "nope" })).toMatchObject({ isError: true });
    expect((await call("list_sessions", { project: "Web" })).content).not.toContain("old");
    const since = (await call("list_sessions", { since: "2026-10-10T00:00:00Z" })).content;
    expect(since).toContain("session: new");
    expect(since).not.toContain("session: old");
  });

  it("stays under the cap and ends with the count it left out", () => {
    const rows = Array.from({ length: 300 }, (_, i) => ({
      meta: meta(`s${i}`, { title: "x".repeat(500), createdBy: { id: "a".repeat(400) } }),
      turns: { turns: i, lastLabel: "y".repeat(500) },
      openHuman: false,
    }));
    const text = renderSessionList(rows, 50);
    expect(text.length).toBeLessThanOrEqual(MAX_LIST_SESSIONS_CHARS);
    const shown = text.match(/^- session:/gm)!.length;
    expect(text.endsWith(`(${300 - shown} more)`)).toBe(true);
    expect(renderSessionList(rows.slice(0, 2), 1)).toMatch(/\(1 more\)$/);
  });
});

describe("read_session", () => {
  const owned = meta("s1", { createdBy: ALICE, piSessionFile: "/pi/s1.jsonl", title: "Alice's" });

  it("round-trips since with uptoSeq and reads final heads from the Pi file", async () => {
    seq = 0;
    const events = [...turn(1), ...turn(2)];
    const call = tools({
      sessions: () => [owned],
      log: fakeLog(events),
      readFile: async () => piFile(2, (i) => `answer ${i}\nwith "quotes"`),
    });
    const first = (await call("read_session", { sessionId: "s1" })).content;
    expect(first).toContain('owner: "Alice" <alice@example.com>');
    expect(first).toContain("uptoSeq: 4");
    expect(first.indexOf('"prompt 2"')).toBeLessThan(first.indexOf('"prompt 1"'));
    expect(first).toContain('prompted by "Bob" <bob@example.com>');
    expect(first).toContain('final assistant message (head): "answer 2 with \\"quotes\\""');
    expect(first).toContain("tools: bash 1; failed: bash");
    expect(first).toContain("refs: entries u2..a2 (3), final message a2");
    expect(first).toContain('Pi session file "/pi/s1.jsonl"');

    const none = (await call("read_session", { sessionId: "s1", since: 4 })).content;
    expect(none).toContain("uptoSeq: 4");
    expect(none).toContain("turns: none since that seq");
    events.push(...turn(3));
    const later = (await call("read_session", { sessionId: "s1", since: 4 })).content;
    expect(later).toContain("uptoSeq: 6");
    expect(later).toContain('"prompt 3"');
    expect(later).not.toContain('"prompt 2"');
  });

  it("drops the oldest turns at the cap and caps each assistant head", async () => {
    seq = 0;
    const events = Array.from({ length: 40 }, (_, i) => turn(i + 1)).flat();
    const call = tools({
      sessions: () => [owned],
      log: fakeLog(events),
      readFile: async () => piFile(40, () => "\u0000z".repeat(5_000)),
      openHuman: () =>
        new Map(
          Array.from({ length: 9 }, (_, i) => [
            `h${i}`,
            {
              sessionId: "s1",
              kind: "askUser",
              prompt: "q".repeat(2_000),
              actor: { type: "agent", sessionId: "s1" },
              requestedAt: `2026-10-15T00:00:0${i}.000Z`,
            } as unknown as OpenHumanRequest,
          ]),
        ),
    });
    const text = (await call("read_session", { sessionId: "s1" })).content;
    expect(text.length).toBeLessThanOrEqual(MAX_READ_SESSION_CHARS);
    expect(text).toContain('"prompt 40"');
    expect(text).not.toContain('"prompt 1"');
    expect(text).toMatch(/\(\d+ older turns not shown: read the Pi session file\)$/);
    expect(text).toContain("open questions (9):");
    expect(text).toContain("(4 more)");
    expect(text).not.toContain("\u0000");
    const head = text.match(/final assistant message \(head\): (".*")/)![1]!;
    expect((JSON.parse(head) as string).length).toBeLessThanOrEqual(ASSISTANT_HEAD_CHARS);
  });

  it("with the event log off reads the Pi file only and says so", async () => {
    const call = tools({
      sessions: () => [owned],
      log: fakeLog([], ""),
      turnCounts: () => undefined,
      readFile: async () => piFile(2, (i) => `answer ${i}`),
    });
    const text = (await call("read_session", { sessionId: "s1", since: 9 })).content;
    expect(text).toContain("source: the Pi session file only. The event log is off");
    expect(text).not.toContain("uptoSeq");
    expect(text).toContain('"prompt 2"');
    expect(text).toContain("tools: read 1");
    expect(text).toContain('final assistant message (head): "answer 1"');
    expect((await call("list_sessions", {})).content).toContain("turns: unknown (event log off)");
  });

  it("falls back to the Pi file for a session older than the log; reports an unreadable file", async () => {
    const fallback = tools({
      sessions: () => [owned],
      readFile: async () => piFile(1, () => "old answer"),
    });
    const text = (await fallback("read_session", { sessionId: "s1" })).content;
    expect(text).toContain("turns read from the Pi session file");
    expect(text).toContain('"old answer"');
    const missing = tools({
      sessions: () => [owned],
      readFile: async () => {
        throw Object.assign(new Error("gone"), { code: "ENOENT" });
      },
    });
    expect((await missing("read_session", { sessionId: "s1" })).content).toContain(
      "could not be read (ENOENT)",
    );
    expect(await missing("read_session", { sessionId: "nope" })).toMatchObject({ isError: true });
  });
});

describe("the log readers' session turn counts", () => {
  it("counts top-level turns with the newest label; child turns and removed sessions drop out", () => {
    const log = createEventLog(mkdtempSync(path.join(tmpdir(), "ad-session-turns-")), {
      warn: () => {},
    });
    const agent = { type: "agent", sessionId: "s1" } as const;
    const completed = (label: string, sessionId?: string) =>
      log.append({
        kind: "session.turn.completed",
        ...(sessionId ? { sessionId } : { parent: { type: "subagentRun", id: "run" } }),
        subject: { type: "turn", id: label },
        actor: agent,
        payload: { label, entryIds: [], toolCalls: [] },
      });
    completed("first", "s1");
    completed("second", "s1");
    completed("child");
    completed("gone", "s2");
    log.append({
      kind: "session.removed",
      sessionId: "s2",
      subject: { type: "session", id: "s2" },
      actor: { type: "system" },
      payload: {},
    });
    const counts = createLogReaders(log).sessionTurns()!;
    expect([...counts]).toEqual([["s1", { turns: 2, lastLabel: "second" }]]);
    log.close();
    expect(createLogReaders(disabledEventLog()).sessionTurns()).toBeUndefined();
  });
});
