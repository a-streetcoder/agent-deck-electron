import { describe, expect, it } from "vitest";
import { createIngestState, ingestPiEvent, type PiInboundEvent } from "../src/ingest.ts";
import { emptyTranscript, reduceTranscript, type TranscriptState } from "../src/transcript.ts";

function assistantMessage(content: unknown[]): unknown {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "mock",
    model: "mock-model",
    usage: { input: 1, output: 1 },
    stopReason: "stop",
    timestamp: 0,
  };
}

// Synthetic but shape-faithful pi event sequence for one prompt → reply turn.
const TURN: unknown[] = [
  { type: "agent_start" },
  { type: "turn_start" },
  { type: "message_end", message: { role: "user", content: "hi", timestamp: 0 } },
  { type: "message_start", message: assistantMessage([]) },
  {
    type: "message_update",
    message: assistantMessage([]),
    assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: assistantMessage([]) },
  },
  {
    type: "message_update",
    message: assistantMessage([]),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "Hel",
      partial: assistantMessage([]),
    },
  },
  {
    type: "message_update",
    message: assistantMessage([]),
    assistantMessageEvent: {
      type: "text_delta",
      contentIndex: 0,
      delta: "lo!",
      partial: assistantMessage([]),
    },
  },
  {
    type: "message_update",
    message: assistantMessage([]),
    assistantMessageEvent: {
      type: "text_end",
      contentIndex: 0,
      content: "Hello!",
      partial: assistantMessage([]),
    },
  },
  {
    type: "message_end",
    message: assistantMessage([{ type: "text", text: "Hello!" }]),
  },
  { type: "agent_end", messages: [] },
];

function runThrough(events: unknown[]): { state: TranscriptState; deltaCount: number } {
  const ingest = createIngestState();
  let state = emptyTranscript();
  let deltaCount = 0;
  for (const piEvent of events) {
    for (const domainEvent of ingestPiEvent(ingest, piEvent as PiInboundEvent)) {
      if (domainEvent.type === "cell_delta") deltaCount += 1;
      state = reduceTranscript(state, domainEvent);
    }
  }
  return { state, deltaCount };
}

describe("ingest → reduce pipeline", () => {
  it("uses Pi session-entry ids as stable user identities during history seeding", () => {
    const ingest = createIngestState();
    const events = ingestPiEvent(ingest, {
      type: "message_end",
      entryId: "entry-123",
      message: { role: "user", content: "same", timestamp: 1 },
    } as unknown as PiInboundEvent);
    expect(events).toEqual([
      {
        type: "cell_final",
        cell: { kind: "user", id: "user-entry-123", entryId: "entry-123", text: "same" },
      },
    ]);
  });

  it("reconstructs durable file chips from Pi history and hides canonical tags", () => {
    const ingest = createIngestState();
    const events = ingestPiEvent(ingest, {
      type: "message_end",
      entryId: "file-entry",
      message: {
        role: "user",
        content:
          'Please review\n\n<file name="/tmp/notes &amp; plans.txt"></file>\n<file name="C:\\Users\\Andrea\\report.txt"></file>',
        timestamp: 1,
      },
    } as unknown as PiInboundEvent);
    expect(events).toEqual([
      {
        type: "cell_final",
        cell: {
          kind: "user",
          id: "user-file-entry",
          entryId: "file-entry",
          text: "Please review",
          files: [
            { name: "notes & plans.txt", path: "/tmp/notes & plans.txt" },
            { name: "report.txt", path: "C:\\Users\\Andrea\\report.txt" },
          ],
        },
      },
    ]);
  });

  it("streams deltas through (never coalesced into message_end)", () => {
    const { deltaCount } = runThrough(TURN);
    expect(deltaCount).toBe(2);
  });

  it("builds the expected transcript for a full turn", () => {
    const { state } = runThrough(TURN);
    expect(state.agentStatus).toBe("idle");
    expect(state.cells).toHaveLength(2);
    expect(state.cells[0]).toMatchObject({ kind: "user", text: "hi" });
    expect(state.cells[1]).toMatchObject({
      kind: "assistant",
      streaming: false,
      blocks: [{ kind: "text", contentIndex: 0, text: "Hello!", done: true }],
    });
  });

  it("shows accumulated partial text mid-stream", () => {
    const { state } = runThrough(TURN.slice(0, 7)); // through the two deltas
    const assistant = state.cells.find((c) => c.kind === "assistant");
    expect(assistant).toMatchObject({
      streaming: true,
      blocks: [{ kind: "text", text: "Hello!", done: false }],
    });
  });

  it("cell_final is authoritative even if a delta was lost (self-healing)", () => {
    const withLostDelta = [...TURN.slice(0, 6), ...TURN.slice(7)]; // drop the second delta
    const { state } = runThrough(withLostDelta);
    const assistant = state.cells.find((c) => c.kind === "assistant");
    expect(assistant).toMatchObject({
      blocks: [{ kind: "text", text: "Hello!", done: true }],
    });
  });

  it("coins distinct assistant cell ids across turns (responseId gotcha)", () => {
    const { state } = runThrough([...TURN, ...TURN]);
    const ids = state.cells.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(state.cells).toHaveLength(4);
  });

  it("tracks tool execution lifecycle without losing args on end", () => {
    const events: unknown[] = [
      { type: "tool_execution_start", toolCallId: "t1", toolName: "bash", args: { command: "ls" } },
      {
        type: "tool_execution_update",
        toolCallId: "t1",
        toolName: "bash",
        args: {},
        partialResult: "a",
      },
      {
        type: "tool_execution_end",
        toolCallId: "t1",
        toolName: "bash",
        result: "a\nb",
        isError: false,
      },
    ];
    const { state } = runThrough(events);
    expect(state.cells[0]).toMatchObject({
      kind: "tool",
      toolName: "bash",
      args: { command: "ls" },
      status: "done",
      result: "a\nb",
    });
  });

  it("replaces Pi's pending queues exactly, preserving order, duplicates, and clear", () => {
    const ingest = createIngestState();
    let state = emptyTranscript();
    for (const event of ingestPiEvent(ingest, {
      type: "queue_update",
      steering: ["first", "same", "same"],
      followUp: ["later", "last"],
    } as unknown as PiInboundEvent)) {
      state = reduceTranscript(state, event);
    }
    expect(state.pendingInput).toEqual({
      status: "available",
      steering: ["first", "same", "same"],
      followUp: ["later", "last"],
    });

    for (const event of ingestPiEvent(ingest, {
      type: "queue_update",
      steering: [],
      followUp: [],
    } as unknown as PiInboundEvent)) {
      state = reduceTranscript(state, event);
    }
    expect(state.pendingInput).toEqual({ status: "available", steering: [], followUp: [] });
  });

  it("replaces stale queues with unavailable state, then recovers on a valid clear", () => {
    const ingest = createIngestState();
    let state = emptyTranscript();
    const apply = (raw: unknown): void => {
      for (const event of ingestPiEvent(ingest, raw as PiInboundEvent)) {
        state = reduceTranscript(state, event);
      }
    };
    apply({ type: "queue_update", steering: ["stale"], followUp: ["stale-later"] });
    apply({ type: "queue_update", steering: Array.from({ length: 101 }, () => "x"), followUp: [] });
    expect(state.pendingInput).toEqual({
      status: "unavailable",
      truncated: true,
      reason: "limit_exceeded",
      steering: [],
      followUp: [],
    });

    apply({ type: "queue_update", steering: ["valid"], followUp: [7] });
    expect(state.pendingInput).toMatchObject({
      status: "unavailable",
      truncated: false,
      reason: "malformed",
    });

    apply({ type: "queue_update", steering: [], followUp: [] });
    expect(state.pendingInput).toEqual({ status: "available", steering: [], followUp: [] });
  });

  it("maps the runtime `compaction_end` event to a contextRevision bump", () => {
    // pi's RPC forwards AgentSessionEvent at runtime (incl. compaction_end),
    // though the exported type union omits it — the ingest still surfaces it.
    const ingest = createIngestState();
    const emitted = ingestPiEvent(ingest, { type: "compaction_end" } as unknown as PiInboundEvent);
    expect(emitted).toEqual([{ type: "context_changed" }]);

    // The reducer increments the monotonic contextRevision the composer watches.
    let state = emptyTranscript();
    expect(state.contextRevision).toBe(0);
    for (const e of emitted) state = reduceTranscript(state, e);
    expect(state.contextRevision).toBe(1);
    // A compaction_start (no-op) doesn't bump it.
    const start = ingestPiEvent(ingest, { type: "compaction_start" } as unknown as PiInboundEvent);
    expect(start).toEqual([]);
  });
});
