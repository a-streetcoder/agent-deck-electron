import { describe, expect, it } from "vitest";
import {
  MAX_EVENT_BYTES,
  parseEventLine,
  seqOfLine,
  serializeEvent,
  splitJsonl,
  validateEnvelope,
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

const line = (value: unknown): string => JSON.stringify(value);

describe("parseEventLine", () => {
  it("round-trips a full envelope", () => {
    const event = envelope();
    expect(parseEventLine(line(event))).toEqual(event);
    const minimal = envelope({ sessionId: undefined, parent: undefined, causationId: undefined });
    expect(parseEventLine(line({ ...minimal, actor: { type: "system" } }))).toEqual({
      ...JSON.parse(line(minimal)),
      actor: { type: "system" },
    });
  });

  it("rejects malformed lines and invalid envelopes", () => {
    expect(parseEventLine("")).toBeNull();
    expect(parseEventLine('{"v":1,"id":')).toBeNull();
    expect(parseEventLine("[]")).toBeNull();
    expect(parseEventLine(line({ ...envelope(), v: 2 }))).toBeNull();
    expect(parseEventLine(line({ ...envelope(), seq: 0 }))).toBeNull();
    expect(parseEventLine(line({ ...envelope(), seq: 1.5 }))).toBeNull();
    expect(parseEventLine(line({ ...envelope(), kind: "finished" }))).toBeNull();
    expect(parseEventLine(line({ ...envelope(), ts: "yesterday" }))).toBeNull();
    expect(parseEventLine(line({ ...envelope(), actor: { type: "agent" } }))).toBeNull();
    expect(parseEventLine(line({ ...envelope(), origin: "import" }))).toBeNull();
    const { projectId: _projectId, ...withoutProject } = envelope();
    expect(parseEventLine(line(withoutProject))).toBeNull();
  });

  it("reads node types from a newer build but refuses to write them", () => {
    const newer = envelope({ subject: { type: "graphNode", id: "n1" } });
    expect(parseEventLine(line(newer))).toEqual(newer);
    expect(validateEnvelope(newer)).toBeNull();
    expect(validateEnvelope(envelope({ parent: { type: "graphNode", id: "n1" } }))).toBeNull();
    expect(validateEnvelope(envelope())).toEqual(envelope());
  });
});

describe("seqOfLine", () => {
  it("recovers the seq from any JSON line, schema or not", () => {
    expect(seqOfLine(line({ v: 2, seq: 50, shape: "newer" }))).toBe(50);
    expect(seqOfLine(line(envelope()))).toBe(7);
    expect(seqOfLine(line({ seq: 0 }))).toBeUndefined();
    expect(seqOfLine(line({ seq: "5" }))).toBeUndefined();
    expect(seqOfLine("null")).toBeUndefined();
    expect(seqOfLine('{"seq":')).toBeUndefined();
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

describe("serializeEvent", () => {
  it("keeps small events and replaces an oversized payload with a marker", () => {
    const small = envelope();
    expect(serializeEvent(small)).toBe(line(small));

    const big = envelope({ payload: { text: "é".repeat(MAX_EVENT_BYTES) } });
    const text = serializeEvent(big);
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(MAX_EVENT_BYTES);
    const parsed = parseEventLine(text);
    expect(parsed).toEqual({
      ...big,
      payload: { truncated: true, originalBytes: new TextEncoder().encode(line(big)).byteLength },
    });
  });

  it("throws on an unserializable payload", () => {
    expect(() => serializeEvent(envelope({ payload: { n: 1n } }))).toThrow();
  });
});
