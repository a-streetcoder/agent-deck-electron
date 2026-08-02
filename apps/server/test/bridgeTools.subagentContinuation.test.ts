import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import { registerDeckBridgeTools } from "../src/bridgeTools.ts";
import type { SessionManager } from "../src/SessionManager.ts";
import { ChildRunError } from "../src/services/sessionManager.ts";

const dispatch = async (bridge: BridgeRegistry, tool: string, params: Record<string, unknown>) =>
  await bridge.dispatch(
    {
      tool,
      params,
      sessionId: randomUUID(),
      toolCallId: "tool-call",
      token: "test-token",
    },
    { token: "test-token" },
  );

describe("managed_subagent continuation bridge contract", () => {
  it("advertises isolation/stable-ID semantics and returns the durable ID", async () => {
    const runId = randomUUID();
    const sessions = {
      runManagedSubagent: vi.fn().mockResolvedValue({ runId, text: "latest result" }),
    } as unknown as SessionManager;
    const bridge = new BridgeRegistry();
    registerDeckBridgeTools(bridge, sessions);

    const spec = bridge.specs().find((candidate) => candidate.name === "managed_subagent")!;
    expect(spec.description).toContain("stable Deck run ID");
    expect(spec.description).toContain("never the parent conversation");
    expect((spec.parameters.properties as Record<string, unknown>).continueSubagentID).toBeTruthy();

    const response = await dispatch(bridge, "managed_subagent", {
      task: "follow up",
      continueSubagentID: runId,
    });
    expect(sessions.runManagedSubagent).toHaveBeenCalledWith(
      expect.any(String),
      "follow up",
      undefined,
      runId,
    );
    expect(response).toEqual({ content: `Deck subagent ID: ${runId}\n\nlatest result` });
  });

  it("includes the stable ID when an accepted run later fails", async () => {
    const runId = randomUUID();
    const failure = new ChildRunError(runId, new Error("child exited"));
    const sessions = {
      runManagedSubagent: vi.fn().mockRejectedValue(failure),
    } as unknown as SessionManager;
    const bridge = new BridgeRegistry();
    registerDeckBridgeTools(bridge, sessions);

    const response = await dispatch(bridge, "managed_subagent", { task: "fail later" });
    expect(response.isError).toBe(true);
    expect(response.content).toContain(`Deck subagent ID: ${runId}`);
    expect(response.content).toContain("child exited");
  });

  it("rejects unexpected properties to match additionalProperties:false", async () => {
    const sessions = { runManagedSubagent: vi.fn() } as unknown as SessionManager;
    const bridge = new BridgeRegistry();
    registerDeckBridgeTools(bridge, sessions);

    const response = await dispatch(bridge, "managed_subagent", {
      task: "follow up",
      unexpected: true,
    });
    expect(response.isError).toBe(true);
    expect(sessions.runManagedSubagent).not.toHaveBeenCalled();
  });

  it("rejects malformed continuation IDs before invoking the service", async () => {
    const sessions = { runManagedSubagent: vi.fn() } as unknown as SessionManager;
    const bridge = new BridgeRegistry();
    registerDeckBridgeTools(bridge, sessions);

    const response = await dispatch(bridge, "managed_subagent", {
      task: "follow up",
      continueSubagentID: "not-a-uuid",
    });
    expect(response.isError).toBe(true);
    expect(response.content).not.toContain("not-a-uuid");
    expect(sessions.runManagedSubagent).not.toHaveBeenCalled();
  });

  it("does not present unknown or cross-parent caller IDs as accepted runs", async () => {
    for (const message of ["unknown Deck subagent ID", "different parent session"]) {
      const requestedId = randomUUID();
      const sessions = {
        runManagedSubagent: vi.fn().mockRejectedValue(new Error(message)),
      } as unknown as SessionManager;
      const bridge = new BridgeRegistry();
      registerDeckBridgeTools(bridge, sessions);
      const response = await dispatch(bridge, "managed_subagent", {
        task: "follow up",
        continueSubagentID: requestedId,
      });
      expect(response.isError).toBe(true);
      expect(response.content).not.toContain(requestedId);
      expect(response.content).not.toContain("Deck subagent ID:");
    }
  });

  it("keeps managed_parallel fresh-only and marks every child parallel", async () => {
    const sessions = {
      get: vi.fn().mockReturnValue({ isRunning: true }),
      runSubagent: vi.fn().mockResolvedValue("result"),
    } as unknown as SessionManager;
    const bridge = new BridgeRegistry();
    registerDeckBridgeTools(bridge, sessions);

    const spec = bridge.specs().find((candidate) => candidate.name === "managed_parallel")!;
    expect((spec.parameters.properties as Record<string, unknown>).worktree).toBeTruthy();

    await dispatch(bridge, "managed_parallel", { tasks: [{ task: "one" }] });
    expect(sessions.runSubagent).toHaveBeenLastCalledWith(
      expect.any(String),
      "one",
      undefined,
      undefined,
      undefined,
      "parallel",
      false,
    );
    await dispatch(bridge, "managed_parallel", {
      tasks: [{ task: "isolated" }],
      worktree: true,
    });
    expect(sessions.runSubagent).toHaveBeenLastCalledWith(
      expect.any(String),
      "isolated",
      undefined,
      undefined,
      undefined,
      "parallel",
      true,
    );
  });
});
