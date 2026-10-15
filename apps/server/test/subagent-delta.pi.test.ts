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
import { SUBAGENT_RESULT_READ, type EventEnvelope } from "@agent-deck/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

// A3: a parent delegates, reads the delta, continues the same child and reads it
// again; the second delta holds only the continuation.
process.env.AGENT_DECK_TEST = "1";
const FIRST_PARENT = "delegate and look at the delta";
const SECOND_PARENT = "continue the child and look again";

let mock: MockProviderServer;
let server: AgentDeckServer;
const home = mkdtempSync(path.join(tmpdir(), "pi-home-delta-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-subagent-delta-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "deck-subagent-delta-"));
const deltas: Array<Record<string, unknown>> = [];
let childReplies = 0;

const text = (content: unknown): string =>
  typeof content === "string" ? content : JSON.stringify(content);
const isChild = (body: ChatCompletionRequest): boolean =>
  body.messages.some(
    (message) =>
      (message.role === "system" || message.role === "developer") &&
      text(message.content).includes("focused subagent launched by Agent Deck"),
  );
const runIdIn = (body: ChatCompletionRequest): string | undefined =>
  /Deck subagent ID: ([0-9a-f-]{36})/i.exec(JSON.stringify(body.messages))?.[1];

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (!predicate()) throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (lastUser, body) => {
      if (isChild(body)) return null;
      const last = body.messages.at(-1);
      if (last?.role === "tool") {
        const result = text(last.content);
        if (result.includes('"uptoSeq"')) {
          deltas.push(JSON.parse(result) as Record<string, unknown>);
          return null;
        }
        if (result.includes("Deck subagent ID:")) {
          // The newest managed_subagent result names the run.
          return { name: "subagent_delta", arguments: { runId: runIdIn(body) } };
        }
        return null;
      }
      if (lastUser === FIRST_PARENT) {
        return { name: "managed_subagent", arguments: { task: "First child task." } };
      }
      if (lastUser === SECOND_PARENT) {
        return {
          name: "managed_subagent",
          arguments: { task: "Second child task.", continueSubagentID: runIdIn(body) },
        };
      }
      return null;
    },
    reply: (_lastUser, body) => {
      if (!isChild(body)) return "Parent done.";
      childReplies += 1;
      return childReplies === 1 ? "FIRST_CHILD_RESULT" : "SECOND_CHILD_RESULT";
    },
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({
    HOME: home,
    USERPROFILE: home,
    PI_SKIP_VERSION_CHECK: "1",
  });
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("subagent_delta real-Pi", () => {
  it("a parent awaiting the same child twice sees the delta shrink to the new turn", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startImmediately: true,
        cwd,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    const { session } = (await response.json()) as { session: { id: string } };
    const managed = server.sessions.get(session.id)!;

    await managed.prompt(FIRST_PARENT);
    await waitUntil(() => deltas.length === 1, "the first delta");
    await server.receipts.waitFor("idle", session.id);
    await managed.prompt(SECOND_PARENT);
    await waitUntil(() => deltas.length === 2, "the second delta");

    const [first, second] = deltas as [Record<string, unknown>, Record<string, unknown>];
    expect(first).toMatchObject({
      sinceSeq: 0,
      full: true,
      statusNow: "completed",
      turnsCompleted: 1,
      summaryHead: "FIRST_CHILD_RESULT",
      filesTouched: [],
    });
    expect(second).toMatchObject({
      sinceSeq: first.uptoSeq,
      full: false,
      statusThen: "completed",
      statusNow: "completed",
      turnsCompleted: 1,
      summaryHead: "SECOND_CHILD_RESULT",
    });
    expect(second.uptoSeq as number).toBeGreaterThan(first.uptoSeq as number);
    expect(JSON.stringify(second)).not.toContain("FIRST_CHILD_RESULT");

    const runId = first.runId as string;
    const page = (await (
      await fetch(
        `http://127.0.0.1:${server.port}/events?sessionId=${session.id}&afterSeq=0&limit=1000`,
      )
    ).json()) as { events: EventEnvelope[] };
    const reads = page.events.filter((event) => event.kind === SUBAGENT_RESULT_READ);
    expect(reads.map((event) => [event.sessionId, event.subject.id, event.payload])).toEqual([
      [session.id, runId, { uptoSeq: first.uptoSeq }],
      [session.id, runId, { uptoSeq: second.uptoSeq }],
    ]);

    // The result card's view: the whole run, both turns, cursor untouched.
    const card = (await (
      await fetch(
        `http://127.0.0.1:${server.port}/sessions/${session.id}/subagent-runs/${runId}/delta`,
      )
    ).json()) as { delta: Record<string, unknown>; hasEvents: boolean };
    expect(card.hasEvents).toBe(true);
    expect(card.delta).toMatchObject({ full: true, turnsCompleted: 2 });
  });
});
