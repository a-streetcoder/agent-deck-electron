import { describe, expect, it } from "vitest";
import {
  capEventSize,
  MAX_EVENT_BYTES,
  parseEventLine,
  splitJsonl,
  utf8Suffix,
  type EventEnvelope,
} from "../src/events.ts";

const envelope = (overrides: Partial<EventEnvelope> = {}): EventEnvelope => ({
  v: 1,
  id: "evt-1",
  seq: 7,
  ts: "2026-10-15T10:00:00.000Z",
  logId: "log-1",
  kind: "subagent.run.finished",
  projectId: null,
  sessionId: "session-1",
  subject: { type: "subagentRun", id: "run-1" },
  parent: { type: "session", id: "session-1" },
  causationId: "evt-0",
  actor: { type: "agent", sessionId: "session-1", agentName: "worker" },
  payload: { status: "completed", tokens: 12 },
  ...overrides,
});

const bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("parseEventLine", () => {
  it("round-trips a full envelope", () => {
    const event = envelope();
    expect(parseEventLine(JSON.stringify(event))).toEqual(event);
    const minimal = envelope({ sessionId: undefined, parent: undefined, causationId: undefined });
    expect(parseEventLine(JSON.stringify({ ...minimal, actor: { type: "system" } }))).toEqual({
      ...JSON.parse(JSON.stringify(minimal)),
      actor: { type: "system" },
    });
  });

  it("rejects malformed lines and invalid envelopes", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine('{"v":1,"id":')).toBeNull();
    expect(parseEventLine("[]")).toBeNull();
    expect(parseEventLine(JSON.stringify({ ...envelope(), v: 2 }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ ...envelope(), seq: 0 }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ ...envelope(), seq: 1.5 }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ ...envelope(), kind: "finished" }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ ...envelope(), ts: "yesterday" }))).toBeNull();
    expect(
      parseEventLine(JSON.stringify({ ...envelope(), subject: { type: "graph", id: "x" } })),
    ).toBeNull();
    expect(parseEventLine(JSON.stringify({ ...envelope(), actor: { type: "agent" } }))).toBeNull();
    expect(parseEventLine(JSON.stringify({ ...envelope(), origin: "import" }))).toBeNull();
    const { projectId: _projectId, ...withoutProject } = envelope();
    expect(parseEventLine(JSON.stringify(withoutProject))).toBeNull();
  });
});

describe("splitJsonl", () => {
  it("keeps complete lines and returns a torn tail separately", () => {
    expect(splitJsonl('{"a":1}\n\n{"b":2}\r\n{"c":')).toEqual({
      lines: ['{"a":1}', '{"b":2}'],
      rest: '{"c":',
    });
    expect(splitJsonl('{"a":1}\n')).toEqual({ lines: ['{"a":1}'], rest: "" });
    expect(splitJsonl('{"torn"')).toEqual({ lines: [], rest: '{"torn"' });
    expect(splitJsonl("")).toEqual({ lines: [], rest: "" });
  });
});

describe("event size cap", () => {
  it("keeps the newest UTF-8 suffix on a code point boundary", () => {
    expect(utf8Suffix("abc", 10)).toBe("abc");
    expect(utf8Suffix("abc", 0)).toBe("");
    // "é" is 2 bytes, the emoji 4: a 3-byte budget cannot start inside the emoji.
    expect(utf8Suffix("é😀", 3)).toBe("");
    expect(utf8Suffix("é😀", 4)).toBe("😀");
    expect(utf8Suffix("xé", 2)).toBe("é");
  });

  it("leaves small events untouched and caps oversized payloads at MAX_EVENT_BYTES", () => {
    const small = envelope();
    expect(capEventSize(small)).toBe(small);

    // Quotes double under JSON escaping, so the first budget guess overshoots.
    const text = `${'"'.repeat(MAX_EVENT_BYTES)}END`;
    const capped = capEventSize(envelope({ payload: { text } }));
    expect(bytes(capped)).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    expect(bytes(capped)).toBeGreaterThan(MAX_EVENT_BYTES - 1_000);
    const payload = capped.payload as { truncated: boolean; originalBytes: number; tail: string };
    expect(payload.truncated).toBe(true);
    expect(payload.originalBytes).toBe(bytes({ text }));
    expect(payload.tail.endsWith('END"}')).toBe(true);
    expect(parseEventLine(JSON.stringify(capped))).toEqual(capped);
    expect({ ...capped, payload: null }).toEqual({ ...envelope(), payload: null });
  });
});
