import type { PiInboundEvent } from "@agent-deck/pi-host";
import { describe, expect, it } from "vitest";
import {
  ingestChildRunLifecycle,
  type ChildRunLifecycle,
} from "../src/services/childRunLifecycle.ts";

type Assistant = Extract<PiInboundEvent, { type: "agent_end" }>["messages"][number] & {
  role: "assistant";
};
const message = (stopReason: Assistant["stopReason"], errorMessage?: string): Assistant => ({
  role: "assistant",
  content: [{ type: "text", text: "partial or final text" }],
  api: "openai-completions",
  provider: "mock",
  model: "mock-model",
  stopReason,
  errorMessage,
  timestamp: 0,
  usage: {
    input: 1,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 3,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
});
const end = (stopReason: Assistant["stopReason"], willRetry = false): PiInboundEvent => ({
  type: "agent_end",
  messages: [message(stopReason, stopReason === "error" ? "500 outage" : undefined)],
  willRetry,
});
const retryStart: PiInboundEvent = {
  type: "auto_retry_start",
  attempt: 1,
  maxAttempts: 1,
  delayMs: 1,
  errorMessage: "500 outage",
};
const retrySuccess: PiInboundEvent = { type: "auto_retry_end", success: true, attempt: 1 };
const settled: PiInboundEvent = { type: "agent_settled" };

describe("pinned Pi child lifecycle", () => {
  it.each([
    ["normal success", [end("stop")], undefined],
    ["length completion", [end("length")], undefined],
    ["nonretryable partial error", [end("error")], "500 outage"],
    [
      "recovered retry",
      [
        end("error", true),
        retryStart,
        { type: "message_end", message: message("stop") },
        retrySuccess,
        end("stop"),
      ],
      undefined,
    ],
    [
      "exhausted retry",
      [
        end("error", true),
        retryStart,
        end("error"),
        { type: "auto_retry_end", success: false, attempt: 1, finalError: "exhausted" },
      ],
      "exhausted",
    ],
    [
      "retry cancelled without another agent_end",
      [
        end("error", true),
        retryStart,
        { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
      ],
      "Retry cancelled",
    ],
    [
      "aborted assistant with Pi retry success event",
      [
        end("error", true),
        retryStart,
        { type: "message_end", message: message("aborted") },
        retrySuccess,
        end("aborted"),
      ],
      "Subagent turn was aborted.",
    ],
    [
      "fallback error",
      [
        { type: "message_end", message: message("error") },
        { type: "agent_end", messages: [], willRetry: false },
      ],
      "The provider failed to complete the subagent turn.",
    ],
  ] satisfies Array<[string, PiInboundEvent[], string | undefined]>)(
    "%s waits for settlement and reports truthful status",
    (_name, events, error) => {
      const state: ChildRunLifecycle = { settled: false };
      for (const event of events) {
        ingestChildRunLifecycle(state, event);
        expect(state.settled).toBe(false);
      }
      ingestChildRunLifecycle(state, settled);
      expect(state).toEqual({ settled: true, error });
    },
  );
});
