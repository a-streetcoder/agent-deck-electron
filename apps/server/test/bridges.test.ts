import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * The read-only "Agent Deck bridges" inventory (native bridgesCard): GET
 * /runtime/bridges reports which app-generated bridges are injected, derived
 * live from what's actually registered on the bridge (so memory-off / no-MCP is
 * reflected honestly).
 */

process.env.AGENT_DECK_TEST = "1";

let server: AgentDeckServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  delete process.env.AGENT_DECK_MEMORY;
});

async function bridges(): Promise<
  Array<{ id: string; active: boolean; toolNames: string[]; condition: string }>
> {
  const res = await fetch(`http://127.0.0.1:${server!.port}/runtime/bridges`);
  const { bridges } = (await res.json()) as {
    bridges: Array<{ id: string; active: boolean; toolNames: string[]; condition: string }>;
  };
  return bridges;
}

describe("GET /runtime/bridges", () => {
  it("reports memory + deck-agent bridges active with their tools, and no MCP bridge", async () => {
    server = await startServer({ dataDir: mkdtempSync(path.join(tmpdir(), "agent-deck-data-")) });
    const list = await bridges();

    const memory = list.find((b) => b.id === "memory");
    expect(memory?.active).toBe(true);
    expect(memory?.condition).toContain("server memory capability");
    expect(memory?.condition).toContain("Memory automation preference");
    expect(memory?.toolNames).toEqual(
      expect.arrayContaining([
        "agent_deck_memory_write",
        "agent_deck_memory_search",
        "agent_deck_memory_mark_stale",
      ]),
    );

    const askUser = list.find((b) => b.id === "ask_user");
    expect(askUser).toMatchObject({ active: true, toolNames: ["ask_user"] });

    const deckAgents = list.find((b) => b.id === "deck_agents");
    expect(deckAgents?.active).toBe(true);
    expect(deckAgents?.toolNames).toEqual(
      expect.arrayContaining([
        "list_agents",
        "managed_subagent",
        "managed_parallel",
        "spawn_subagent",
        "await_subagents",
        "cancel_subagent",
        "list_supervisor_requests",
        "answer_supervisor_request",
      ]),
    );
    expect(deckAgents?.toolNames).not.toContain("ask_user");

    // MCP runs through Pi native, not a bridge tool.
    expect(list.find((b) => b.id === "mcp")).toBeUndefined();
  });

  it("wires A6: list_agents over the session's project and GET /agents/profiles", async () => {
    server = await startServer({ dataDir: mkdtempSync(path.join(tmpdir(), "agent-deck-data-")) });
    const call = (params: Record<string, unknown>) =>
      server!.bridge.dispatch(
        { tool: "list_agents", params, sessionId: "no-session", toolCallId: "t", token: "token" },
        { token: "token" },
      );
    const listed = await call({});
    expect(listed.isError).toBeUndefined();
    expect(listed.content).toMatch(/^(Loop role defaults|No agents)/);
    expect(await call({ project: "no-such-project" })).toMatchObject({ isError: true });
    const response = await fetch(`http://127.0.0.1:${server.port}/agents/profiles`);
    expect(await response.json()).toEqual({ windowDays: 30, profiles: [] });
  });

  it("reflects a live pause and resume in the memory bridge inventory", async () => {
    server = await startServer({ dataDir: mkdtempSync(path.join(tmpdir(), "agent-deck-data-")) });
    const settingsUrl = `http://127.0.0.1:${server.port}/settings`;
    const patch = async (enabled: boolean): Promise<void> => {
      const response = await fetch(settingsUrl, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentMemoryEnabled: enabled }),
      });
      expect(response.status).toBe(200);
    };

    await patch(false);
    expect((await bridges()).find((item) => item.id === "memory")).toMatchObject({
      active: false,
      toolNames: [],
    });

    await patch(true);
    const resumed = (await bridges()).find((item) => item.id === "memory");
    expect(resumed?.active).toBe(true);
    expect(resumed?.toolNames).toContain("agent_deck_memory_search");
  });

  it("reports the memory bridge and settings capability OFF when memory is disabled", async () => {
    process.env.AGENT_DECK_MEMORY = "0";
    server = await startServer({ dataDir: mkdtempSync(path.join(tmpdir(), "agent-deck-data-")) });
    const memory = (await bridges()).find((b) => b.id === "memory");
    expect(memory?.active).toBe(false);
    expect(memory?.toolNames).toEqual([]);
    const settings = (await (await fetch(`http://127.0.0.1:${server.port}/settings`)).json()) as {
      settings: { agentMemoryEnabled: boolean };
      capabilities: { agentMemory: boolean };
    };
    expect(settings.settings.agentMemoryEnabled).toBe(true);
    expect(settings.capabilities.agentMemory).toBe(false);
  });
});
