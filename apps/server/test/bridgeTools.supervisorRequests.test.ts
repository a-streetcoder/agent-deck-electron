import { describe, expect, it } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import { registerSupervisorListBridgeTool } from "../src/bridgeTools.ts";
import { SupervisorLog } from "../src/supervisor.ts";

function harness(): { bridge: BridgeRegistry; supervisor: SupervisorLog } {
  const bridge = new BridgeRegistry();
  const supervisor = new SupervisorLog();
  registerSupervisorListBridgeTool(bridge, supervisor);
  return { bridge, supervisor };
}

describe("list_supervisor_requests bridge tool", () => {
  it("returns only this parent's pending rows with the exact portable shape and title fallback", async () => {
    const { bridge, supervisor } = harness();
    supervisor.record({
      id: "pending-decision",
      parentSessionId: "parent-a",
      cellId: "run-a",
      method: "need_decision",
      message: "Choose a format",
    });
    supervisor.record({
      id: "pending-interview",
      parentSessionId: "parent-a",
      cellId: "run-b",
      method: "interview_request",
      title: "Clarify scope",
      message: "Which modules?",
    });
    supervisor.record({
      id: "progress",
      parentSessionId: "parent-a",
      cellId: "run-c",
      method: "progress_update",
      message: "Halfway done",
    });
    const answered = supervisor.record({
      id: "answered",
      parentSessionId: "parent-a",
      cellId: "run-d",
      method: "need_decision",
      message: "Old blocker",
    });
    supervisor.markAnswered(answered.id, "Resolved");
    const cancelled = supervisor.record({
      id: "cancelled",
      parentSessionId: "parent-a",
      cellId: "run-e",
      method: "interview_request",
      message: "Expired blocker",
    });
    supervisor.markCancelled(cancelled.id, "Child ended");
    supervisor.record({
      id: "other-parent",
      parentSessionId: "parent-b",
      cellId: "run-f",
      method: "need_decision",
      message: "Private to B",
    });

    const result = await bridge.dispatch(
      {
        tool: "list_supervisor_requests",
        params: {},
        sessionId: "parent-a",
        toolCallId: "tool-call",
        token: "token",
      },
      { token: "token" },
    );

    expect(result).toEqual({
      content: JSON.stringify([
        {
          requestID: "pending-decision",
          kind: "need_decision",
          title: "Decision needed",
          message: "Choose a format",
          runID: "run-a",
        },
        {
          requestID: "pending-interview",
          kind: "interview_request",
          title: "Clarify scope",
          message: "Which modules?",
          runID: "run-b",
        },
      ]),
    });
  });

  it("returns [] when this parent has no pending requests and rejects non-empty args", async () => {
    const { bridge, supervisor } = harness();
    supervisor.record({
      parentSessionId: "another-parent",
      cellId: "another-run",
      method: "need_decision",
      message: "Not visible",
    });

    await expect(
      bridge.dispatch(
        {
          tool: "list_supervisor_requests",
          params: {},
          sessionId: "parent",
          toolCallId: "empty",
          token: "token",
        },
        { token: "token" },
      ),
    ).resolves.toEqual({ content: "[]" });

    const invalid = await bridge.dispatch(
      {
        tool: "list_supervisor_requests",
        params: { unexpected: true },
        sessionId: "parent",
        toolCallId: "invalid",
        token: "token",
      },
      { token: "token" },
    );
    expect(invalid.isError).toBe(true);
    expect(invalid.content).toContain("Invalid list_supervisor_requests arguments");
  });

  it("registers a strict empty-object schema with parent supervision guidance", () => {
    const { bridge } = harness();
    const spec = bridge.specs().find((candidate) => candidate.name === "list_supervisor_requests");
    expect(spec).toMatchObject({
      parameters: { type: "object", properties: {}, additionalProperties: false },
    });
    expect(spec?.description).toContain("pending questions and decisions");
    expect(spec?.promptSnippet).toContain("review pending");
  });
});
