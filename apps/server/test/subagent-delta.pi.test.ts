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

// A3 against real Pi: a result hand-back (await_subagents, managed_subagent) counts
// as seen, so the delta right after it is empty; full: true reads the whole run.
process.env.AGENT_DECK_TEST = "1";
const FIRST_PARENT = "spawn, await and look at the delta";
const SECOND_PARENT = "delegate, continue the same child and look again";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

let mock: MockProviderServer;
let server: AgentDeckServer;
const home = mkdtempSync(path.join(tmpdir(), "pi-home-delta-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-subagent-delta-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "deck-subagent-delta-"));
const deltas: Array<Record<string, unknown>> = [];
let childReplies = 0;

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as { text?: string }[]).map((part) => part.text ?? "").join("")
      : JSON.stringify(content);
const isChild = (body: ChatCompletionRequest): boolean =>
  body.messages.some(
    (message) =>
      (message.role === "system" || message.role === "developer") &&
      text(message.content).includes("focused subagent launched by Agent Deck"),
  );
const toolTexts = (body: ChatCompletionRequest): string[] =>
  body.messages.filter((message) => message.role === "tool").map((m) => text(m.content));

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (!predicate()) throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (lastUser, body) => {
      if (isChild(body)) return null;
      const results = toolTexts(body);
      const last = results.at(-1);
      if (last?.includes('"uptoSeq"') && body.messages.at(-1)?.role === "tool") {
        deltas.push(JSON.parse(last) as Record<string, unknown>);
      }
      // Run A: spawned and awaited; run B: managed_subagent, then continued.
      const runA = results[0]?.match(UUID)?.[0] ?? "missing";
      const runB = results[3]?.match(UUID)?.[0] ?? "missing";
      if (lastUser === FIRST_PARENT) {
        switch (results.length) {
          case 0:
            return { name: "spawn_subagent", arguments: { task: "First child task." } };
          case 1:
            return { name: "await_subagents", arguments: { runIds: [runA] } };
          case 2:
            return { name: "subagent_delta", arguments: { runId: runA } };
          default:
            return null;
        }
      }
      if (lastUser === SECOND_PARENT) {
        switch (results.length) {
          case 3:
            return { name: "managed_subagent", arguments: { task: "Second child task." } };
          case 4:
            return {
              name: "managed_subagent",
              arguments: { task: "Third child task.", continueSubagentID: runB },
            };
          case 5:
            return { name: "subagent_delta", arguments: { runId: runB } };
          case 6:
            return { name: "subagent_delta", arguments: { runId: runB, full: true } };
          default:
            return null;
        }
      }
      return null;
    },
    reply: (_lastUser, body) => {
      if (!isChild(body)) return "Parent done.";
      childReplies += 1;
      return ["FIRST", "SECOND", "THIRD"][childReplies - 1] + "_CHILD_RESULT";
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
  it("after a result hand-back the delta holds only what is new; full re-reads the run", async () => {
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
    await waitUntil(() => deltas.length === 1, "the delta after await_subagents");
    await server.receipts.waitFor("idle", session.id);
    await managed.prompt(SECOND_PARENT);
    await waitUntil(() => deltas.length === 3, "the deltas after managed_subagent");
    await server.receipts.waitFor("idle", session.id);

    const [afterAwait, afterManaged, full] = deltas as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    const page = (await (
      await fetch(
        `http://127.0.0.1:${server.port}/events?sessionId=${session.id}&afterSeq=0&limit=1000`,
      )
    ).json()) as { events: EventEnvelope[] };
    const seqs = (kind: string, runId: unknown) =>
      page.events
        .filter((event) => event.kind === kind && event.subject.id === runId)
        .map((event) =>
          kind === SUBAGENT_RESULT_READ
            ? (event.payload as { uptoSeq: number }).uptoSeq
            : event.seq,
        );

    // await_subagents delivered A's result: nothing new, not a full look.
    expect(afterAwait).toMatchObject({ statusNow: "completed", full: false, turnsCompleted: 0 });
    expect(afterAwait.summary).toBeUndefined();
    expect(seqs("subagent.run.finished", afterAwait.runId)).toEqual([afterAwait.sinceSeq]);
    expect(seqs(SUBAGENT_RESULT_READ, afterAwait.runId)).toEqual([afterAwait.sinceSeq]);

    // Both of B's managed_subagent results count as seen the same way.
    expect(afterManaged).toMatchObject({ statusNow: "completed", full: false, turnsCompleted: 0 });
    expect(afterManaged.summary).toBeUndefined();
    const finishedB = seqs("subagent.run.finished", afterManaged.runId);
    expect(finishedB).toHaveLength(2);
    expect(afterManaged.sinceSeq).toBe(finishedB[1]);
    expect(seqs(SUBAGENT_RESULT_READ, afterManaged.runId)).toEqual(finishedB);

    // The whole run: both child turns and the owner's full latest result.
    expect(full).toMatchObject({
      runId: afterManaged.runId,
      statusNow: "completed",
      full: true,
      turnsCompleted: 2,
      summary: "THIRD_CHILD_RESULT",
    });

    // The result card's view: the whole run with the public head.
    const card = (await (
      await fetch(
        `http://127.0.0.1:${server.port}/sessions/${session.id}/subagent-runs/${String(full.runId)}/delta`,
      )
    ).json()) as { delta: Record<string, unknown>; hasEvents: boolean };
    expect(card.hasEvents).toBe(true);
    expect(card.delta).toMatchObject({
      full: true,
      turnsCompleted: 2,
      summaryHead: "THIRD_CHILD_RESULT",
    });
  });
});
