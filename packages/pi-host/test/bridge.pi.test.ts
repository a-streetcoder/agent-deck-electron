import { mkdtempSync } from "node:fs";
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
import { writeBridgeExtension, type BridgeWireCall } from "../src/bridge.ts";
import { buildLaunchArgs } from "../src/launchPlan.ts";
import { PiSession } from "../src/PiSession.ts";
import { resolvePiBinary } from "../src/resolve.ts";
import { serveBridge } from "./serveBridge.ts";

/**
 * Foundational bridge proof (permanent CI guard): a REAL pi binary advertises
 * an app-managed tool from a generated bridge extension, the model calls it,
 * the tool's execute() round-trips over Pi's stdio to our (stand-in) app side,
 * and the result flows back into the model's next turn. Memory, MCP, and the
 * subagent bridge all sit on exactly this mechanism, so if it breaks they all
 * break — this test exists so that can't happen silently.
 */

let mock: MockProviderServer;
let session: PiSession;
const bridgeCalls: BridgeWireCall[] = [];
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-bridge-it-"));

beforeAll(async () => {
  // The model calls the bridge tool on the first turn, then answers with text
  // once the tool result is in the transcript (a "tool" role message present).
  mock = await startMockProvider({
    toolCall: (_lastUser, body) => {
      const hasToolResult = body.messages.some((m) => m.role === "tool");
      return hasToolResult ? null : { name: "agent_deck_echo", arguments: { message: "ping" } };
    },
    reply: () => "The echo tool has spoken across the bridge.",
  });

  const mockExt = writeMockProviderExtension(mock.baseUrl);
  const bridgeExt = writeBridgeExtension({
    tools: [
      {
        name: "agent_deck_echo",
        label: "Echo",
        description: "Echo a message back through the Agent Deck bridge.",
        parameters: {
          type: "object",
          properties: { message: { type: "string", description: "Text to echo." } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    ],
  });

  session = new PiSession({
    binPath: resolvePiBinary().path,
    args: buildLaunchArgs({
      kind: "parent",
      extensions: [mockExt, bridgeExt],
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
    }),
    cwd,
    env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
    requestTimeoutMs: 45_000,
  });
  // Stand-in "app-side engine": records each bridge call, echoes the message.
  serveBridge(session, (call) => {
    bridgeCalls.push(call);
    return { body: { content: `echoed: ${String(call.params.message ?? "")}` } };
  });
  session.start();
});

afterAll(async () => {
  await session.stop();
  await mock.close();
});

describe("real pi + generated bridge extension: app-managed tool round-trip", () => {
  it("routes a tool call to the app endpoint and feeds the result back to the model", async () => {
    const idle = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no idle. stderr: ${session.stderr}`)),
        50_000,
      );
      session.on("event", (piEvent) => {
        if (piEvent.type === "agent_end") {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    await session.prompt("use the echo tool");
    await idle;

    // The app side received exactly the call pi should have made.
    expect(bridgeCalls.length).toBe(1);
    expect(bridgeCalls[0]).toMatchObject({
      tool: "agent_deck_echo",
      params: { message: "ping" },
    });
    expect(typeof bridgeCalls[0]!.toolCallId).toBe("string");
    expect(bridgeCalls[0]!.toolCallId.length).toBeGreaterThan(0);

    // pi fed the tool result back to the model: the follow-up provider request
    // carries a "tool" role message with our echoed content.
    expect(mock.requests.length).toBeGreaterThanOrEqual(2);
    const followUp = mock.requests[mock.requests.length - 1]!;
    const toolMessages = followUp.messages.filter((m) => m.role === "tool");
    expect(toolMessages.length).toBeGreaterThan(0);
    expect(JSON.stringify(toolMessages)).toContain("echoed: ping");
  });
});
