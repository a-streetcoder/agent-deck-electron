import { applyPlanUpdates, type SessionPlanItem, type SessionPlanUpdate } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import { registerDeckBridgeTools } from "../src/bridgeTools.ts";
import type { SessionManager } from "../src/SessionManager.ts";

/** A5: set_session_plan / update_session_plan accept and validate the graph fields. */
function setup(knownAgents = ["coder", "reviewer"]) {
  let plan: SessionPlanItem[] = [];
  const session = {
    get plan() {
      return plan;
    },
    setPlan: (items: SessionPlanItem[]) => {
      plan = items;
    },
    updatePlan: (updates: SessionPlanUpdate[]) => {
      plan = applyPlanUpdates(plan, updates);
    },
  };
  const sessions = {
    get: () => session,
    agentResolutionError: (_sessionId: string, name: string) =>
      knownAgents.includes(name) ? undefined : `unknown agent: ${name}`,
  } as unknown as SessionManager;
  const bridge = new BridgeRegistry();
  registerDeckBridgeTools(bridge, sessions);
  const call = (tool: string, params: Record<string, unknown>) =>
    bridge.dispatch(
      { tool, params, sessionId: "s1", toolCallId: "call", token: "t" },
      { token: "t" },
    ) as Promise<{ content: string; isError?: boolean }>;
  return { call, plan: () => plan, bridge };
}

describe("plan graph fields on the bridge tools", () => {
  it("stores dependsOn, assignee and verifiedBy, and keeps flat plans valid", async () => {
    const { call, plan, bridge } = setup();
    const spec = bridge.specs().find((s) => s.name === "set_session_plan")!;
    expect(JSON.stringify(spec.parameters)).toContain("verifiedBy");

    const flat = await call("set_session_plan", { items: [{ title: "One" }, { title: "Two" }] });
    expect(flat.isError).toBeUndefined();
    expect(plan().map((i) => Object.keys(i).sort())).toEqual([
      ["id", "status", "title"],
      ["id", "status", "title"],
    ]);

    const graph = await call("set_session_plan", {
      items: [
        { id: "a", title: "Build", assignee: "coder", verifiedBy: "reviewer" },
        { id: "b", title: "Ship", dependsOn: ["a", "a"], assignee: "coder" },
      ],
    });
    expect(graph.isError).toBeUndefined();
    expect(graph.content).toContain("after a; assignee coder");
    expect(plan()).toEqual([
      { id: "a", title: "Build", status: "todo", assignee: "coder", verifiedBy: "reviewer" },
      { id: "b", title: "Ship", status: "todo", dependsOn: ["a"], assignee: "coder" },
    ]);

    const update = await call("update_session_plan", {
      updates: [{ id: "b", assignee: "reviewer", status: "skipped" }],
    });
    expect(update.isError).toBeUndefined();
    expect(plan()[1]).toMatchObject({ assignee: "reviewer", status: "skipped" });
  });

  it("refuses cycles, unknown dependencies and agents, self-verification and duplicate graph ids", async () => {
    const { call, plan } = setup();
    const refused = async (tool: string, params: Record<string, unknown>, pattern: RegExp) => {
      const result = await call(tool, params);
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(pattern);
    };
    await refused(
      "set_session_plan",
      {
        items: [
          { id: "a", title: "A", dependsOn: ["b"] },
          { id: "b", title: "B", dependsOn: ["a"] },
        ],
      },
      /dependency cycle: a -> b -> a/,
    );
    await refused(
      "set_session_plan",
      { items: [{ id: "a", title: "A", dependsOn: ["x"] }] },
      /unknown item x/,
    );
    await refused(
      "set_session_plan",
      { items: [{ id: "a", title: "A", assignee: "coder", verifiedBy: "coder" }] },
      /verifiedBy must differ from assignee/,
    );
    await refused(
      "set_session_plan",
      { items: [{ title: "A", assignee: "ghost" }] },
      /unknown agent: ghost/,
    );
    await refused(
      "set_session_plan",
      {
        items: [
          { id: "a", title: "A" },
          { id: "a", title: "B", dependsOn: ["a"] },
        ],
      },
      /duplicate item id a/,
    );
    expect(plan()).toEqual([]);

    await call("set_session_plan", {
      items: [
        { id: "a", title: "A" },
        { id: "b", title: "B", dependsOn: ["a"] },
      ],
    });
    await refused(
      "update_session_plan",
      { updates: [{ id: "a", dependsOn: ["b"] }] },
      /dependency cycle/,
    );
    // The refused update changed nothing.
    expect(plan()[0]?.dependsOn).toBeUndefined();
  });
});
