import type { PiInboundEvent } from "@agent-deck/pi-host";

export interface ChildRunLifecycle {
  settled: boolean;
  error?: string;
}

/** Pi 0.82.0 owns retries: agent_end (even willRetry:false) is only a
 * low-level boundary. agent_settled follows retry/compaction/queued work.
 * Keep failed partial output visible, but never use it as proof of success.
 */
export function ingestChildRunLifecycle(state: ChildRunLifecycle, event: PiInboundEvent): void {
  const assistant =
    event.type === "message_end" && event.message.role === "assistant"
      ? event.message
      : event.type === "agent_end"
        ? event.messages?.findLast((message) => message.role === "assistant")
        : undefined;
  if (assistant?.role === "assistant") {
    state.error =
      assistant.stopReason === "error"
        ? assistant.errorMessage || "The provider failed to complete the subagent turn."
        : assistant.stopReason === "aborted"
          ? assistant.errorMessage || "Subagent turn was aborted."
          : undefined;
  }
  if (event.type === "auto_retry_end" && !event.success) {
    state.error = event.finalError || state.error || "Subagent provider retries failed.";
  }
  // auto_retry_end.success is not terminal, and Pi emits it even for an
  // aborted assistant. Only a later real assistant response clears its error.
  if (event.type === "agent_settled") state.settled = true;
}
