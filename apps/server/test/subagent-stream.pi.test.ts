import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
  type MockProviderServer,
} from "@agent-deck/testkit";
import type { AssistantCell, ChildTranscriptSnapshot, SubagentCell } from "@agent-deck/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Native subagent streaming (slice A): a parent calls managed_subagent{task};
 * the child's transcript is streamed into the PARENT transcript as a "Subagent"
 * card. This asserts the parent's authoritative transcript ends up with a
 * subagent cell carrying the child's output — WITHOUT changing the tool result
 * the model receives (still the child's final text).
 */

process.env.AGENT_DECK_TEST = "1";

let mock: MockProviderServer;
let server: AgentDeckServer;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-subagent-stream-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const PARENT_TOOL_CALL_ID = "call_managed_subagent_parent";

function systemText(request: ChatCompletionRequest): string {
  return request.messages
    .filter((m) => m.role === "developer" || m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

function isChildRequest(body: ChatCompletionRequest): boolean {
  return systemText(body).includes("focused subagent launched by Agent Deck");
}

beforeAll(async () => {
  mock = await startMockProvider({
    chunkDelayMs: 30,
    toolCall: (_lastUser, body) => {
      if (isChildRequest(body) || body.messages.some((m) => m.role === "tool")) return null;
      return {
        id: PARENT_TOOL_CALL_ID,
        name: "managed_subagent",
        arguments: { task: "Summarize the meeting notes." },
      };
    },
    reply: (_lastUser, body) =>
      isChildRequest(body) ? "CHILD_STREAM_SENTINEL: three bullet summary." : "Delegated and done.",
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
});

describe("managed_subagent: child transcript streams into the parent as a card", () => {
  it("projects the live child transcript without splitting the parent stream, then reconstructs canonical history", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };

    const managed = server.sessions.get(session.id)!;
    const orderedDeltas: Array<{ seq: number; delta: string }> = [];
    const liveSnapshotPromises: Array<Promise<ChildTranscriptSnapshot | undefined>> = [];
    const unsubscribe = managed.bus.subscribe((stamped) => {
      if (stamped.event.type === "subagent_delta") {
        orderedDeltas.push({ seq: stamped.seq, delta: stamped.event.delta });
        // processChild updates the scoped projection before emitting this parent
        // card delta. Reading through the public seam here therefore proves the
        // same pinned-Pi event reached both views without a second consumer.
        liveSnapshotPromises.push(
          server.sessions.subagentTranscript(session.id, stamped.event.cellId, cwd),
        );
      }
    });
    await managed.prompt("delegate the summary task");
    await server.receipts.waitFor("idle", session.id);

    // The PARENT transcript now carries a finished Subagent card with the
    // child's output — the child's transcript surfaced in the parent.
    const subagentCells = managed
      .snapshot()
      .state.cells.filter((c): c is SubagentCell => c.kind === "subagent");
    expect(subagentCells).toHaveLength(1);
    expect(subagentCells[0]!.status).toBe("done");
    expect(subagentCells[0]!.task).toBe("Summarize the meeting notes.");
    expect(subagentCells[0]!.text).toContain("CHILD_STREAM_SENTINEL: three bullet summary.");
    unsubscribe();
    const assistantText = (snapshot: ChildTranscriptSnapshot): string =>
      snapshot.cells
        .filter((cell): cell is AssistantCell => cell.kind === "assistant")
        .flatMap((cell) => cell.blocks)
        .filter((block) => block.kind === "text")
        .map((block) => block.text)
        .join("");
    const liveSnapshots = (await Promise.all(liveSnapshotPromises)).filter(
      (snapshot): snapshot is ChildTranscriptSnapshot => snapshot?.source === "live",
    );
    const liveAssistantUpdates = liveSnapshots
      .map(assistantText)
      .filter((text, index, values) => text.length > 0 && text !== values[index - 1]);
    expect(liveSnapshots.length).toBeGreaterThan(1);
    expect(liveSnapshots.every((snapshot) => snapshot.status === "running")).toBe(true);
    expect(liveAssistantUpdates.length).toBeGreaterThan(1);
    for (let index = 1; index < liveAssistantUpdates.length; index += 1) {
      expect(liveAssistantUpdates[index]!.startsWith(liveAssistantUpdates[index - 1]!)).toBe(true);
    }
    expect(liveAssistantUpdates.at(-1)).toBe("CHILD_STREAM_SENTINEL: three bullet summary.");

    expect(orderedDeltas.length).toBeGreaterThan(1);
    expect(orderedDeltas.map((item) => item.seq)).toEqual(
      [...orderedDeltas].map((item) => item.seq).sort((a, b) => a - b),
    );
    expect(orderedDeltas.map((item) => item.delta).join("")).toBe(
      "CHILD_STREAM_SENTINEL: three bullet summary.",
    );

    const canonical = await server.sessions.subagentTranscript(
      session.id,
      subagentCells[0]!.id,
      cwd,
    );
    expect(canonical?.source).toBe("canonical");
    expect(canonical?.status).toBe("done");
    expect(canonical?.cells.map((cell) => cell.kind)).toEqual(["user", "assistant"]);
    expect(canonical?.cells[0]).toEqual(
      expect.objectContaining({ kind: "user", text: "Summarize the meeting notes." }),
    );
    expect(assistantText(canonical!)).toBe("CHILD_STREAM_SENTINEL: three bullet summary.");

    // The tool result the MODEL receives is unchanged (still the child's text).
    const followUp = mock.requests.find((request) =>
      request.messages.some(
        (message) =>
          message.role === "tool" &&
          "tool_call_id" in message &&
          message.tool_call_id === PARENT_TOOL_CALL_ID,
      ),
    );
    expect(followUp).toBeDefined();
    const toolText = JSON.stringify(
      followUp!.messages.filter(
        (message) =>
          message.role === "tool" &&
          "tool_call_id" in message &&
          message.tool_call_id === PARENT_TOOL_CALL_ID,
      ),
    );
    expect(toolText).toContain("CHILD_STREAM_SENTINEL: three bullet summary.");
  });
});
