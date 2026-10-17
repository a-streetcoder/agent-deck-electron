import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BridgeToolContext } from "../src/bridge.ts";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * The bridge substrate, wired into the server (permanent CI guard): an
 * app-managed tool registered on server.bridge is generated into a real pi
 * session, the model calls it, the call rides back on the session's own Pi stdio,
 * the registered handler runs, and the result flows back to the model. This is
 * the mechanism Memory / MCP / subagents plug their tools into.
 */

process.env.AGENT_DECK_TEST = "1";

let mock: MockProviderServer;
let server: AgentDeckServer;
const calls: Array<{ params: Record<string, unknown>; ctx: BridgeToolContext }> = [];

const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-server-bridge-it-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (_lastUser, body) => {
      const hasToolResult = body.messages.some((m) => m.role === "tool");
      return hasToolResult ? null : { name: "agent_deck_echo", arguments: { message: "ping" } };
    },
    reply: () => "The bridge tool answered.",
  });
  server = await startServer({ dataDir });
  // Register BEFORE creating the session — the extension is generated at launch.
  server.bridge.register(
    {
      name: "agent_deck_echo",
      label: "Echo",
      description: "Echo a message back through the Agent Deck bridge.",
      parameters: {
        type: "object",
        properties: { message: { type: "string" } },
        required: ["message"],
        additionalProperties: false,
      },
    },
    (params, ctx) => {
      calls.push({ params, ctx });
      return { content: `echoed: ${String(params.message ?? "")}` };
    },
  );
});

afterAll(async () => {
  await server.close();
  await mock.close();
});

describe("server bridge: app-managed tool round-trip over Pi stdio", () => {
  it("dispatches a real pi tool call to the registered handler and returns the result", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startImmediately: true,
        cwd,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [writeMockProviderExtension(mock.baseUrl)],
        env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };

    // Prompt over REST-less WS-less path: drive via the session directly.
    const managed = server.sessions.get(session.id)!;
    await managed.prompt("use the echo tool");
    await server.receipts.waitFor("idle", session.id);

    // The registered handler ran, tagged with this session's id and pi's args.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual({ message: "ping" });
    expect(calls[0]!.ctx.sessionId).toBe(session.id);
    expect(calls[0]!.ctx.toolCallId.length).toBeGreaterThan(0);

    // pi fed the handler's result back to the model (a role:"tool" follow-up).
    const followUp = mock.requests[mock.requests.length - 1]!;
    const toolMessages = followUp.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThan(0);
    expect(JSON.stringify(toolMessages)).toContain("echoed: ping");

    // The call rode on Pi's stdio as a dialog, which never became a human node.
    const cells = managed.snapshot().state.cells;
    expect(cells.some((cell) => cell.kind === "question")).toBe(false);
    // The extension lives in the session's launch folder (read-only to its sandbox), not /tmp.
    expect(
      readdirSync(path.join(dataDir, "sandbox", session.id, "launch")).some((entry) =>
        entry.startsWith("agent-deck-bridge-ext-"),
      ),
    ).toBe(true);
  });

  it("has no network route: a POST to /bridge reaches no handler", async () => {
    const before = calls.length;
    const response = await fetch(`http://127.0.0.1:${server.port}/bridge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tool: "agent_deck_echo", toolCallId: "x", params: {} }),
    });
    expect(response.status).toBe(404);
    expect(calls).toHaveLength(before);
  });
});
