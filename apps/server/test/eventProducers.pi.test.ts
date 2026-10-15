import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
  type MockProviderServer,
} from "@agent-deck/testkit";
import {
  isLoopRunTerminal,
  parseEventLine,
  projectLoopRuns,
  projectSubagentRuns,
  splitJsonl,
  type EventEnvelope,
  type LoopRun,
  type PublicLoopRun,
  type PublicSubagentRun,
} from "@agent-deck/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";
import { LoopEngine } from "../src/loopEngine.ts";
import { CAPABILITY_FIELDS, SubagentRunStore } from "../src/subagentRunStore.ts";

/**
 * A1b2 against real Pi: one managed_subagent run (fresh, continued, then removed with
 * its parent session) and one makerChecker loop. The store commit points emit diff
 * events; the log's projection must equal each store's public view after every
 * commit. With AGENT_DECK_RECORD_EVENT_FIXTURES=1 the run also rewrites the domain
 * fixtures: per commit the public state and how many events the log held by then,
 * plus the events, with ids, timestamps and durations mapped to stable values.
 */

process.env.AGENT_DECK_TEST = "1";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../../packages/domain/test/fixtures/events",
);

let mock: MockProviderServer;
let server: AgentDeckServer;
let projectId: string;
let base: string;
let continueId: string | undefined;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-events-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const piEnv = { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" };

interface Commit<T> {
  /** Events of the store's kinds in the log once the commit returned. */
  events: number;
  runs: T[];
}
const subagentStates: Commit<PublicSubagentRun>[] = [];
const loopStates: Commit<PublicLoopRun>[] = [];

function systemText(request: ChatCompletionRequest): string {
  return request.messages
    .filter((m) => m.role === "developer" || m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

function logEvents(prefix: string): EventEnvelope[] {
  const dir = path.join(dataDir, "events");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => splitJsonl(readFileSync(path.join(dir, name), "utf8")).lines)
    .map((line) => parseEventLine(line))
    .filter((event): event is EventEnvelope => event?.kind.startsWith(prefix) ?? false);
}

/** Map uuids, timestamps and durations to stable values so re-recording does not churn. */
function stable(text: string): string {
  const ids = new Map<string, string>();
  const withIds = text.replace(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
    (id) => {
      if (!ids.has(id)) {
        ids.set(id, `00000000-0000-4000-8000-${String(ids.size + 1).padStart(12, "0")}`);
      }
      return ids.get(id)!;
    },
  );
  // One fixed instant: collisions between real timestamps vary from run to run.
  return withIds
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g, "2026-01-01T00:00:00.000Z")
    .replace(/("durationMs":\s*)\d+/g, (_match, key: string) => `${key}1000`);
}

function record(name: string, states: unknown[], events: EventEnvelope[]): void {
  if (process.env.AGENT_DECK_RECORD_EVENT_FIXTURES !== "1") return;
  mkdirSync(FIXTURES, { recursive: true });
  const separator = "\n<<<events>>>\n";
  const text = stable(
    `${JSON.stringify(states, null, 2)}${separator}${events.map((event) => JSON.stringify(event)).join("\n")}`,
  );
  const [statesText, eventsText] = text.split(separator) as [string, string];
  writeFileSync(path.join(FIXTURES, `${name}.states.json`), `${statesText}\n`);
  writeFileSync(path.join(FIXTURES, `${name}.jsonl`), `${eventsText}\n`);
}

/** Same rules as the domain fixture scan, with the server's own capability list. */
function expectNoSecrets(events: EventEnvelope[]): void {
  const text = JSON.stringify(events);
  for (const field of CAPABILITY_FIELDS) expect(text).not.toContain(`"${field}"`);
  for (const root of [dataDir, tmpHome, cwd]) {
    expect(text).not.toContain(JSON.stringify(root).slice(1, -1));
  }
}

beforeAll(async () => {
  const agentsDir = path.join(tmpHome, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "Maker.md"),
    "---\nname: Maker\ntools: read, grep\n---\nMake the requested change.\n",
  );
  writeFileSync(
    path.join(agentsDir, "Checker.md"),
    "---\nname: Checker\ntools: read, grep\n---\nReview only.\n",
  );
  process.env.AGENT_DECK_PI_ENV = JSON.stringify(piEnv);
  mock = await startMockProvider({
    chunkDelayMs: 5,
    toolCall: (lastUser, body) => {
      if (systemText(body).includes("focused subagent launched by Agent Deck")) return null;
      // Delegate once per prompt: not again after this prompt's tool result.
      if (body.messages.at(-1)?.role === "tool") return null;
      if (lastUser.includes("delegate the summary task")) {
        return { name: "managed_subagent", arguments: { task: "Summarize the meeting notes." } };
      }
      if (lastUser.includes("follow up on the summary") && continueId) {
        return {
          name: "managed_subagent",
          arguments: { task: "Shorten the meeting summary.", continueSubagentID: continueId },
        };
      }
      return null;
    },
    reply: (message) => {
      if (message.includes("Summarize the meeting notes.")) {
        return "CHILD_SUBAGENT_SENTINEL: three bullet summary.";
      }
      if (message.includes("Shorten the meeting summary.")) return "CHILD_FOLLOW_UP: one bullet.";
      if (message.includes("exact first non-empty line must be APPROVE")) {
        return "APPROVE\nChecker streamed concrete evidence before approving.";
      }
      if (message.includes("exact first non-empty line must be SUCCESS")) {
        return "SUCCESS\nEvaluator streamed independent evidence of completion.";
      }
      if (message.includes("summary")) return "Delegated and done.";
      return "MAKER_RAW_OUTPUT streamed several ordered implementation words.";
    },
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);

  type CommitFn = (this: SubagentRunStore, candidate: unknown) => void;
  const proto = SubagentRunStore.prototype as unknown as { commit: CommitFn };
  const commit = proto.commit;
  vi.spyOn(proto, "commit").mockImplementation(function (this: SubagentRunStore, candidate) {
    commit.call(this, candidate);
    subagentStates.push({ events: logEvents("subagent.").length, runs: this.publicRuns() });
  });
  type Persist = (this: LoopEngine) => void;
  const loopProto = LoopEngine.prototype as unknown as { persist: Persist };
  const persist = loopProto.persist;
  vi.spyOn(loopProto, "persist").mockImplementation(function (this: LoopEngine) {
    persist.call(this);
    // Constructor persists run before the log sinks exist; they hold no runs here.
    loopStates.push({ events: logEvents("loop.").length, runs: this.publicRuns() });
  });

  server = await startServer({ dataDir });
  base = `http://127.0.0.1:${server.port}`;
  const created = (await (
    await fetch(`${base}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: cwd }),
    })
  ).json()) as { project: { id: string } };
  projectId = created.project.id;
});

afterAll(async () => {
  vi.restoreAllMocks();
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("diff producers (real pi)", () => {
  it("a managed_subagent run: created, finished, continued, finished again, removed", async () => {
    const response = await fetch(`${base}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startImmediately: true,
        cwd,
        projectId,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: piEnv,
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };
    const live = server.sessions.get(session.id)!;
    await live.prompt("delegate the summary task");
    await server.receipts.waitFor("idle", session.id);
    continueId = subagentStates.at(-1)!.runs[0]!.id;
    await live.prompt("follow up on the summary");
    await expect.poll(() => logEvents("subagent.run.finished").length, { timeout: 60_000 }).toBe(2);
    await server.receipts.waitFor("idle", session.id);

    const finished = logEvents("subagent.run.finished");
    const created = logEvents("subagent.run.created");
    expect(created).toHaveLength(1);
    expect(created[0]?.parent?.type).toBe("toolCall");
    expect(created[0]?.projectId).toBe(projectId);
    expect(
      finished.map((event) => (event.payload as { result: { summary: string } }).result.summary),
    ).toEqual([
      expect.stringContaining("CHILD_SUBAGENT_SENTINEL"),
      expect.stringContaining("CHILD_FOLLOW_UP"),
    ]);
    // Each turn's finished names the tool call of that turn; the parent edge stays.
    const turnCalls = finished.map(
      (event) => (event.payload as { run: PublicSubagentRun }).run.turnToolCallId,
    );
    expect(new Set(turnCalls).size).toBe(2);
    expect(turnCalls[0]).toBe(created[0]?.parent?.id);

    const deleted = await fetch(`${base}/sessions/${session.id}`, { method: "DELETE" });
    expect(deleted.ok).toBe(true);
    const events = logEvents("subagent.");
    expect(events.at(-1)?.kind).toBe("subagent.run.removed");
    for (const state of subagentStates) {
      expect([...projectSubagentRuns(events.slice(0, state.events)).values()]).toEqual(state.runs);
    }
    expectNoSecrets(events);
    record("managed-subagent", [{ events: 0, runs: [] }, ...subagentStates], events);
  });

  it("a makerChecker loop reaches the log as run / iteration / child / artifact facts", async () => {
    const put = await fetch(`${base}/loops`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "maker-checker-events",
        goal: "Deliver reviewed work.",
        structure: "makerChecker",
        makerName: "Maker",
        checkerName: "Checker",
        checkerRubric: "Require concrete evidence.",
        validationCommand: "exit 0",
        maxIterations: 2,
      }),
    });
    expect(put.ok).toBe(true);
    const catalog = (await (await fetch(`${base}/loops`)).json()) as {
      loops: Array<{ id: string; name: string }>;
    };
    const loop = catalog.loops.find((candidate) => candidate.name === "maker-checker-events")!;
    const before = loopStates.length;
    const res = await fetch(`${base}/loops/${encodeURIComponent(loop.id)}/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        projectId,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: piEnv,
        currentCheckoutConfirmed: true,
      }),
    });
    expect(res.status).toBe(201);
    const { run } = (await res.json()) as { run: LoopRun };
    const getRun = async (): Promise<LoopRun> =>
      ((await (await fetch(`${base}/loops/runs/${run.id}`)).json()) as { run: LoopRun }).run;
    await expect
      .poll(async () => (await getRun()).status, { timeout: 90_000, interval: 200 })
      .toSatisfy(isLoopRunTerminal);
    expect((await getRun()).status).toBe("completed");

    const events = logEvents("loop.");
    const kinds = new Set(events.map((event) => event.kind));
    for (const kind of [
      "loop.run.started",
      "loop.iteration.started",
      "loop.timeline.appended",
      "loop.child.upserted",
      "loop.artifact.upserted",
      "loop.run.finished",
    ]) {
      expect(kinds).toContain(kind);
    }
    expect(events.at(-1)?.kind).toBe("loop.run.finished");
    const states = [loopStates[before - 1] ?? { events: 0, runs: [] }, ...loopStates.slice(before)];
    for (const state of states) {
      expect([...projectLoopRuns(events.slice(0, state.events)).values()]).toEqual(state.runs);
    }
    expect(JSON.stringify(events)).not.toContain("MAKER_RAW_OUTPUT");
    expectNoSecrets(events);
    record("loop-makerChecker", states, events);
  });
});
