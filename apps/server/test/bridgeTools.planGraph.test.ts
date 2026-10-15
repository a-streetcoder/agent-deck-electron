import { applyPlanUpdates, type SessionPlanItem, type SessionPlanUpdate } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import { registerDeckBridgeTools } from "../src/bridgeTools.ts";
import type { SessionManager } from "../src/SessionManager.ts";

/** A5: set_session_plan / update_session_plan accept and validate the graph fields. */
function setup(options: { delegation?: boolean; writable?: boolean } = {}) {
  const knownAgents = ["coder", "reviewer"];
  let plan: SessionPlanItem[] = [];
  const session = {
    meta: { id: "s1" },
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
    delegationAllowed: () => options.delegation ?? true,
    agentResolutionError: (_sessionId: string, name: string) =>
      knownAgents.includes(name) ? undefined : `unknown agent: ${name}`,
  } as unknown as SessionManager;
  const bridge = new BridgeRegistry();
  registerDeckBridgeTools(bridge, sessions, {
    subscribe: () => () => {},
    writable: options.writable ?? true,
  });
  const call = (tool: string, params: Record<string, unknown>) =>
    bridge.dispatch(
      { tool, params, sessionId: "s1", toolCallId: "call", token: "t" },
      { token: "t" },
    ) as Promise<{ content: string; isError?: boolean }>;
  const refused = async (tool: string, params: Record<string, unknown>, pattern: RegExp) => {
    const result = await call(tool, params);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(pattern);
  };
  return {
    call,
    refused,
    plan: () => plan,
    setPlan: (items: SessionPlanItem[]) => (plan = items),
    bridge,
  };
}

describe("plan graph fields on the bridge tools", () => {
  it("stores the graph fields, keeps flat plans valid, and clears with null", async () => {
    const { call, plan, bridge } = setup();
    const spec = bridge.specs().find((s) => s.name === "set_session_plan")!;
    expect(spec.description).toContain("AUTOMATICALLY");
    expect(spec.description).toContain("owner's model budget");
    expect(JSON.stringify(spec.parameters)).toContain("isolated");

    const flat = await call("set_session_plan", { items: [{ title: "One" }, { title: "Two" }] });
    expect(flat.isError).toBeUndefined();
    expect(plan().map((i) => Object.keys(i).sort())).toEqual([
      ["id", "status", "title"],
      ["id", "status", "title"],
    ]);

    const graph = await call("set_session_plan", {
      items: [
        {
          id: "a",
          title: "Build",
          task: "Build the parser",
          assignee: "coder",
          verifiedBy: "reviewer",
          isolated: true,
        },
        { id: "b", title: "Ship", dependsOn: ["a", "a"], assignee: "coder" },
      ],
    });
    expect(graph.isError).toBeUndefined();
    expect(graph.content).toContain("after a; assignee coder");
    expect(plan()).toEqual([
      {
        id: "a",
        title: "Build",
        status: "todo",
        task: "Build the parser",
        assignee: "coder",
        verifiedBy: "reviewer",
        isolated: true,
      },
      { id: "b", title: "Ship", status: "todo", dependsOn: ["a"], assignee: "coder" },
    ]);

    const update = await call("update_session_plan", {
      updates: [{ id: "a", assignee: null, verifiedBy: null, task: null, status: "skipped" }],
    });
    expect(update.isError).toBeUndefined();
    expect(plan()[0]).toEqual({ id: "a", title: "Build", status: "skipped", isolated: true });
  });

  it("re-sending finished work without statuses keeps it done with its run", async () => {
    const { call, plan, setPlan } = setup();
    setPlan([
      { id: "a", title: "Build", status: "done", assignee: "coder", runId: "r1" },
      { id: "b", title: "Ship", status: "blocked", assignee: "coder", runId: "r2" },
    ]);
    await call("set_session_plan", {
      items: [
        { id: "a", title: "Build", assignee: "coder" },
        { id: "b", title: "Ship", assignee: "coder" },
        { id: "c", title: "Docs", assignee: "coder", dependsOn: ["a"] },
      ],
    });
    expect(plan().map((i) => [i.id, i.status, i.runId])).toEqual([
      ["a", "done", "r1"],
      ["b", "todo", undefined],
      ["c", "todo", undefined],
    ]);
  });

  it("refuses cycles, unknown dependencies and agents, self-verification and duplicate graph ids", async () => {
    const { call, plan, refused } = setup();
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
      { items: [{ id: "a", title: "A", assignee: "coder", verifiedBy: "CODER" }] },
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
        { id: "a", title: "A", assignee: "coder", verifiedBy: "reviewer" },
        { id: "b", title: "B", dependsOn: ["a"] },
      ],
    });
    await refused(
      "update_session_plan",
      { updates: [{ id: "a", dependsOn: ["b"] }] },
      /dependency cycle/,
    );
    // Principle 4: only the verifier's APPROVE marks a verified item done.
    await refused(
      "update_session_plan",
      { updates: [{ id: "a", status: "done" }] },
      /only its verifier's APPROVE marks it done/,
    );
    // The refused updates changed nothing.
    expect(plan()[0]).toMatchObject({ status: "todo" });
    expect(plan()[0]?.dependsOn).toBeUndefined();
  });

  it("refuses a new assignment while delegation is off or the log is read-only", async () => {
    const off = setup({ delegation: false });
    await off.refused(
      "set_session_plan",
      { items: [{ title: "A", assignee: "coder" }] },
      /delegation, which is turned off/,
    );
    // A plain checklist still works.
    expect(
      (await off.call("set_session_plan", { items: [{ title: "A" }] })).isError,
    ).toBeUndefined();

    const readOnly = setup({ writable: false });
    await readOnly.call("set_session_plan", { items: [{ id: "a", title: "A" }] });
    await readOnly.refused(
      "update_session_plan",
      { updates: [{ id: "a", assignee: "coder" }] },
      /another Agent Deck process owns the event log/,
    );
  });
});
