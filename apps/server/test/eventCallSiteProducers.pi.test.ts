import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEventLine, splitJsonl, type EventEnvelope } from "@agent-deck/domain";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { WebSocket } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";
import { scanEventLines, stableFixtureText } from "./fixtures/eventScan.ts";

/**
 * A1b1 producers against a REAL pi through the full HTTP + WS stack: one user
 * prompt in which the agent sets a plan and delegates to a child that reports
 * progress. The log must hold session.created, turn.prompted, plan.changed,
 * supervisor.progress.recorded, the child's AND the parent's session.turn.completed,
 * checkpoint.created and session.removed, linked by causationId, and pass the
 * secrets scan. AGENT_DECK_RECORD_EVENT_FIXTURES=1 rewrites
 * packages/domain/test/fixtures/events/plan.jsonl from this run.
 */

process.env.AGENT_DECK_TEST = "1";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(here, "../../../packages/domain/test/fixtures/events/plan.jsonl");
const CHILD_OUTPUT = "Child summary: done.";
// Raw tool results never reach the log (the child's final answer is the allowed A4 summary).
const TOOL_RESULTS = ["Progress recorded.", "Plan set ("];

let mock: MockProviderServer;
let server: AgentDeckServer;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-events-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const isChild = (body: ChatCompletionRequest): boolean =>
  body.messages.some(
    (m) =>
      (m.role === "developer" || m.role === "system") &&
      JSON.stringify(m.content).includes("focused subagent launched by Agent Deck"),
  );
const toolResults = (body: ChatCompletionRequest): number =>
  body.messages.filter((m) => m.role === "tool").length;

function logLines(): string[] {
  const dir = path.join(dataDir, "events");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => splitJsonl(readFileSync(path.join(dir, name), "utf8")).lines);
}
const logEvents = (): EventEnvelope[] =>
  logLines()
    .map(parseEventLine)
    .filter((event): event is EventEnvelope => event !== null);

async function waitForKinds(kinds: Record<string, number>): Promise<EventEnvelope[]> {
  for (let i = 0; i < 300; i += 1) {
    const events = logEvents();
    const count = (kind: string) => events.filter((event) => event.kind === kind).length;
    if (Object.entries(kinds).every(([kind, n]) => count(kind) >= n)) return events;
    await sleep(100);
  }
  throw new Error(`event log never reached ${JSON.stringify(kinds)}`);
}

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (_lastUser, body) => {
      if (isChild(body)) {
        return toolResults(body) > 0
          ? null
          : {
              name: "contact_supervisor",
              arguments: { method: "progress_update", message: "halfway" },
            };
      }
      if (toolResults(body) === 0) {
        return {
          name: "set_session_plan",
          arguments: { items: [{ id: "a", title: "Delegate the summary" }] },
        };
      }
      if (toolResults(body) === 1) {
        return { name: "managed_subagent", arguments: { task: "Summarize the notes." } };
      }
      return null;
    },
    reply: (_lastUser, body) => (isChild(body) ? CHILD_OUTPUT : "Planned and delegated."),
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
});

describe("A1b1 producers: one prompted turn through a real pi", () => {
  it("records the turn, its plan, child turn, supervisor request and checkpoint, linked by cause", async () => {
    const created = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startImmediately: true,
        cwd,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
    socket.send(
      JSON.stringify({
        id: 1,
        request: { type: "prompt", sessionId: session.id, message: "Plan and delegate" },
      }),
    );
    await waitForKinds({ "session.turn.completed": 2, "checkpoint.created": 1 });
    socket.close();

    const removed = await fetch(`http://127.0.0.1:${server.port}/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    const events = await waitForKinds({ "session.removed": 1 });

    const one = (kind: string) => {
      const found = events.filter((event) => event.kind === kind);
      expect(found, kind).toHaveLength(1);
      return found[0]!;
    };
    const prompted = one("turn.prompted");
    expect(prompted).toMatchObject({
      sessionId: session.id,
      actor: { type: "user" },
      payload: { mode: "prompt", label: "Plan and delegate" },
    });
    expect(one("session.created")).toMatchObject({ actor: { type: "user" }, projectId: null });
    expect(one("plan.changed")).toMatchObject({
      causationId: prompted.id,
      actor: { type: "agent", sessionId: session.id },
      payload: { kind: "created", items: [{ id: "a", title: "Delegate the summary" }] },
    });
    expect(one("supervisor.progress.recorded")).toMatchObject({
      sessionId: session.id,
      causationId: prompted.id,
      payload: { method: "progress_update", status: "recorded", message: "halfway" },
    });

    const turns = events.filter((event) => event.kind === "session.turn.completed");
    const parentTurn = turns.find((event) => event.sessionId === session.id)!;
    const childTurn = turns.find((event) => event.parent?.type === "subagentRun")!;
    expect(parentTurn).toMatchObject({
      subject: { type: "turn", id: prompted.subject.id },
      causationId: prompted.id,
      payload: { label: "Plan and delegate" },
    });
    const parentPayload = parentTurn.payload as {
      entryIds: string[];
      toolCalls: Array<{ name: string; isError: boolean }>;
    };
    expect(parentPayload.entryIds.length).toBeGreaterThan(2);
    expect(parentPayload.toolCalls.map((call) => call.name)).toEqual([
      "set_session_plan",
      "managed_subagent",
    ]);
    // The child path: a delegated child reports its own turn under its run.
    expect(childTurn).toMatchObject({
      causationId: prompted.id,
      actor: { type: "agent" },
      payload: { label: "Summarize the notes." },
    });
    expect(
      (childTurn.payload as { toolCalls: Array<{ name: string }> }).toolCalls.map((c) => c.name),
    ).toEqual(["contact_supervisor"]);

    expect(one("checkpoint.created")).toMatchObject({
      sessionId: session.id,
      causationId: prompted.id,
      parent: { type: "turn", id: prompted.subject.id },
      payload: { turnIndex: 0, label: "Plan and delegate", hasFiles: false, gitRef: null },
    });
    expect(one("session.removed")).toMatchObject({ sessionId: session.id });

    const lines = logLines();
    expect(scanEventLines(lines, [dataDir, cwd, tmpHome, ...TOOL_RESULTS])).toEqual([]);

    if (process.env.AGENT_DECK_RECORD_EVENT_FIXTURES === "1") {
      mkdirSync(path.dirname(FIXTURE), { recursive: true });
      // Pi entry ids are random 8-hex refs: number them so re-recording does not churn.
      const entryIds = new Map<string, string>();
      const text = lines.join("\n").replace(/"([0-9a-f]{8})"/g, (_match, id: string) => {
        if (!entryIds.has(id)) entryIds.set(id, `e${String(entryIds.size + 1).padStart(7, "0")}`);
        return `"${entryIds.get(id)}"`;
      });
      writeFileSync(FIXTURE, `${stableFixtureText(text)}\n`);
    }
  });
});
