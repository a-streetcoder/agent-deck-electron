import { describe, expect, it, vi } from "vitest";
import {
  createIngestState,
  finalizeOpenProviderRetry,
  ingestPiEvent,
  type PiInboundEvent,
} from "../src/ingest.ts";
import {
  emptyTranscript,
  isAnswerableUiRequest,
  reduceTranscript,
  type TranscriptState,
} from "../src/transcript.ts";

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

  it("reconstructs durable folder chips from Pi history and hides canonical references", () => {
    const ingest = createIngestState();
    const events = ingestPiEvent(ingest, {
      type: "message_end",
      entryId: "folder-entry",
      message: {
        role: "user",
        content: "Inspect this\n\nfolder: `/definitely-missing/ses-07/project folder`",
        timestamp: 1,
      },
    } as unknown as PiInboundEvent);
    expect(events).toEqual([
      {
        type: "cell_final",
        cell: {
          kind: "user",
          id: "user-folder-entry",
          entryId: "folder-entry",
          text: "Inspect this",
          folders: [
            {
              name: "project folder",
              path: "/definitely-missing/ses-07/project folder",
            },
          ],
        },
      },
    ]);
  });

  it("reconstructs mixed file and folder history in their distinct attachment fields", () => {
    const ingest = createIngestState();
    const events = ingestPiEvent(ingest, {
      type: "message_end",
      entryId: "mixed-entry",
      message: {
        role: "user",
        content: 'Review both\n\n<file name="/tmp/notes.txt"></file>\nfolder: `/tmp/project`',
        timestamp: 1,
      },
    } as unknown as PiInboundEvent);
    expect(events).toEqual([
      {
        type: "cell_final",
        cell: {
          kind: "user",
          id: "user-mixed-entry",
          entryId: "mixed-entry",
          text: "Review both",
          files: [{ name: "notes.txt", path: "/tmp/notes.txt" }],
          folders: [{ name: "project", path: "/tmp/project" }],
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

  it("collapses provider errors into one ordered retry card and records recovery", () => {
    const error = assistantMessage([]) as Record<string, unknown>;
    error.stopReason = "error";
    error.errorMessage = "HTTP 429 rate limit token=super-secret";
    const { state } = runThrough([
      { type: "message_end", message: error },
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        errorMessage: error.errorMessage,
      },
      { type: "auto_retry_end", success: true, attempt: 1 },
    ]);

    expect(state.cells).toHaveLength(1);
    expect(state.cells[0]).toMatchObject({
      kind: "provider_retry",
      status: "succeeded",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      isQuotaLimit: true,
      collapsedMessageCounts: [1],
    });
    expect(JSON.stringify(state.cells[0])).not.toContain("super-secret");
  });

  it("extracts high-quality quota details only when provider payloads supply them", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const { state } = runThrough([
      {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 3,
        delayMs: 2_000,
        errorMessage: `Gemini error: ${JSON.stringify({
          error: {
            code: 429,
            message: "Resource has been exhausted",
            status: "RESOURCE_EXHAUSTED",
            details: [
              {
                "@type": "type.googleapis.com/google.rpc.RetryInfo",
                retryDelay: "1m30s",
              },
            ],
          },
        })}`,
      },
    ]);
    expect(state.cells[0]).toMatchObject({
      kind: "provider_retry",
      message: "Resource has been exhausted",
      isQuotaLimit: true,
      resetsAt: "2026-01-01T00:01:30.000Z",
    });
    vi.useRealTimers();
  });

  it("updates a retry burst in place, gives up, and bounds untrusted content", () => {
    const ingest = createIngestState();
    let state = emptyTranscript();
    const apply = (raw: unknown): void => {
      for (const event of ingestPiEvent(ingest, raw as PiInboundEvent)) {
        state = reduceTranscript(state, event);
      }
    };
    apply({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: `\u001b[31mprovider unavailable Bearer secret-value ${"😀".repeat(3_000)}`,
    });
    apply({
      type: "auto_retry_start",
      attempt: 2,
      maxAttempts: 3,
      delayMs: 4_000,
      errorMessage: "provider unavailable again",
    });
    apply({ type: "auto_retry_end", success: false, attempt: 2, finalError: "final outage" });

    expect(state.cells).toHaveLength(1);
    const retry = state.cells[0];
    expect(retry).toMatchObject({
      kind: "provider_retry",
      status: "gave_up",
      attempt: 2,
      message: "final outage",
    });
    expect(retry?.kind === "provider_retry" ? retry.collapsedMessageCounts : []).toEqual([]);
  });

  it("adds the final failed assistant ordinal when a retry burst gives up", () => {
    const ingest = createIngestState();
    let state = emptyTranscript();
    const apply = (raw: unknown): void => {
      for (const event of ingestPiEvent(ingest, raw as PiInboundEvent)) {
        state = reduceTranscript(state, event);
      }
    };
    apply({ type: "message_end", message: { role: "user", content: "try", timestamp: 1 } });
    const failedAssistant = {
      ...(assistantMessage([]) as Record<string, unknown>),
      stopReason: "error",
    };
    apply({ type: "message_end", message: failedAssistant });
    apply({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 1,
      delayMs: 1,
      errorMessage: "first error",
    });
    apply({ type: "message_end", message: failedAssistant });
    apply({ type: "auto_retry_end", success: false, attempt: 1, finalError: "final error" });
    expect(state.cells).toEqual([
      expect.objectContaining({ kind: "user" }),
      expect.objectContaining({
        kind: "provider_retry",
        status: "gave_up",
        collapsedMessageCounts: [2, 3],
      }),
    ]);
  });

  it("redacts single-quoted secret fields before the first retry event", () => {
    const events = ingestPiEvent(createIngestState(), {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "Provider failed {'access_token':'single-secret','api-key':'other-secret'}",
    } as unknown as PiInboundEvent);
    expect(JSON.stringify(events)).not.toContain("single-secret");
    expect(JSON.stringify(events)).not.toContain("other-secret");
    expect(events).toMatchObject([{ cell: { message: "Provider failed" } }]);
  });

  it("finalizes a retry left open by process teardown exactly once", () => {
    const ingest = createIngestState();
    ingestPiEvent(ingest, {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "temporary outage",
    } as unknown as PiInboundEvent);
    const first = finalizeOpenProviderRetry(ingest, "Pi exited during retry.");
    expect(first).toMatchObject([
      {
        type: "provider_retry",
        cell: { status: "gave_up", message: "Pi exited during retry." },
        collapseLatestAssistantError: false,
      },
    ]);
    expect(finalizeOpenProviderRetry(ingest)).toEqual([]);
  });

  it("process-exit finalization pairs the latest positive message ordinal", () => {
    const ingest = createIngestState();
    ingestPiEvent(ingest, {
      type: "message_end",
      message: { ...(assistantMessage([]) as Record<string, unknown>), stopReason: "error" },
    } as unknown as PiInboundEvent);
    ingestPiEvent(ingest, {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 2_000,
      errorMessage: "temporary outage",
    } as unknown as PiInboundEvent);
    const finalized = finalizeOpenProviderRetry(ingest);
    expect(finalized).toMatchObject([
      {
        type: "provider_retry",
        cell: { status: "gave_up", collapsedMessageCounts: [1] },
        collapseLatestAssistantError: true,
      },
    ]);
  });

  it("retains only the newest 50 retry cards", () => {
    const ingest = createIngestState();
    let state = emptyTranscript();
    for (let index = 0; index < 55; index += 1) {
      for (const event of ingestPiEvent(ingest, {
        type: "auto_retry_end",
        success: true,
        attempt: 1,
      } as unknown as PiInboundEvent)) {
        state = reduceTranscript(state, event);
      }
    }
    const retries = state.cells.filter((cell) => cell.kind === "provider_retry");
    expect(retries).toHaveLength(50);
    expect(retries[0]?.id).toBe("provider-retry-6");
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

describe("answerable UI requests (the pending/attention chokepoint)", () => {
  it("accepts only the methods anything can answer", () => {
    for (const method of ["select", "confirm", "input", "editor"]) {
      expect(isAnswerableUiRequest(method)).toBe(true);
    }
    // pi's context-usage meter ticks through this same channel several times a
    // turn. Nothing can answer it, so the server must not record it as pending:
    // it would keep the needs-attention badge on and, via pendingExtensionUi,
    // pin idle parking and resource refresh OFF for the session's whole life.
    // Real-pi evidence: session-failure/session-attention failed exactly this
    // way on a developer machine where pi emits the meter.
    for (const method of ["setStatus", "notify", "widget", ""]) {
      expect(isAnswerableUiRequest(method)).toBe(false);
    }
  });

  it("keeps a passive setStatus out of the transcript entirely", () => {
    const ingest = createIngestState();
    const events = ingestPiEvent(ingest, {
      type: "extension_ui_request",
      id: "status-1",
      method: "setStatus",
      statusKey: "context-progress",
      statusText: "ctx 7/100k",
    } as unknown as PiInboundEvent);
    expect(events).toEqual([]);
  });
});
