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
import { SubagentRunStore } from "../src/subagentRunStore.ts";

/**
 * A1b2 against real Pi: one managed_subagent run and one makerChecker loop. The
 * store commit points emit diff events; the log's projection must equal each store's
 * public view. With AGENT_DECK_RECORD_EVENT_FIXTURES=1 the run also rewrites the
 * domain fixtures (the public state after every commit, and the emitted events).
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
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-events-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const piEnv = { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" };

// The public view after every store commit, recorded from the real commit points.
const subagentStates: PublicSubagentRun[][] = [];
const loopStates: PublicLoopRun[][] = [];

function systemText(request: ChatCompletionRequest): string {
  return request.messages
    .filter((m) => m.role === "developer" || m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

function logEvents(): EventEnvelope[] {
  const dir = path.join(dataDir, "events");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .sort()
    .flatMap((name) => splitJsonl(readFileSync(path.join(dir, name), "utf8")).lines)
    .map((line) => parseEventLine(line))
    .filter((event): event is EventEnvelope => event !== null);
}

function record(name: string, states: unknown[], events: EventEnvelope[]): void {
  if (process.env.AGENT_DECK_RECORD_EVENT_FIXTURES !== "1") return;
  mkdirSync(FIXTURES, { recursive: true });
  writeFileSync(path.join(FIXTURES, `${name}.states.json`), `${JSON.stringify(states, null, 2)}\n`);
  writeFileSync(
    path.join(FIXTURES, `${name}.jsonl`),
    events.map((event) => `${JSON.stringify(event)}\n`).join(""),
  );
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
      if (!lastUser.includes("delegate the summary task")) return null;
      if (systemText(body).includes("focused subagent launched by Agent Deck")) return null;
      if (body.messages.some((m) => m.role === "tool")) return null;
      return { name: "managed_subagent", arguments: { task: "Summarize the meeting notes." } };
    },
    reply: (message) => {
      if (message.includes("Summarize the meeting notes.")) {
        return "CHILD_SUBAGENT_SENTINEL: three bullet summary.";
      }
      if (message.includes("exact first non-empty line must be APPROVE")) {
        return "APPROVE\nChecker streamed concrete evidence before approving.";
      }
      if (message.includes("exact first non-empty line must be SUCCESS")) {
        return "SUCCESS\nEvaluator streamed independent evidence of completion.";
      }
      if (message.includes("delegate the summary task")) return "Delegated and done.";
      return "MAKER_RAW_OUTPUT streamed several ordered implementation words.";
    },
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);

  type Commit = (this: SubagentRunStore, candidate: unknown) => void;
  const proto = SubagentRunStore.prototype as unknown as { commit: Commit };
  const commit = proto.commit;
  vi.spyOn(proto, "commit").mockImplementation(function (this: SubagentRunStore, candidate) {
    commit.call(this, candidate);
    subagentStates.push(this.publicRuns());
  });
  type Persist = (this: LoopEngine) => void;
  const loopProto = LoopEngine.prototype as unknown as { persist: Persist };
  const persist = loopProto.persist;
  vi.spyOn(loopProto, "persist").mockImplementation(function (this: LoopEngine) {
    persist.call(this);
    loopStates.push(this.publicRuns());
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
  it("a managed_subagent run reaches the log as created / finished with its tool call", async () => {
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
    await server.sessions.get(session.id)!.prompt("delegate the summary task");
    await server.receipts.waitFor("idle", session.id);

    const events = logEvents().filter((event) => event.kind.startsWith("subagent.run."));
    const created = events.find((event) => event.kind === "subagent.run.created");
    expect(created?.parent?.type).toBe("toolCall");
    expect(created?.projectId).toBe(projectId);
    const finished = events.find((event) => event.kind === "subagent.run.finished");
    expect(finished?.payload).toMatchObject({
      result: { status: "completed", summary: expect.stringContaining("CHILD_SUBAGENT_SENTINEL") },
    });
    const last = subagentStates.at(-1)!;
    expect(last).toHaveLength(1);
    expect([...projectSubagentRuns(events).values()]).toEqual(last);
    record("managed-subagent", [[], ...subagentStates], events);
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
    const finalRun = await getRun();
    if (finalRun.status !== "completed") console.log(JSON.stringify(finalRun, null, 1));
    expect(finalRun.status).toBe("completed");

    const events = logEvents().filter((event) => event.kind.startsWith("loop."));
    const kinds = new Set(events.map((event) => event.kind));
    for (const kind of [
      "loop.run.started",
      "loop.iteration.started",
      "loop.timeline.appended",
      "loop.child.upserted",
      "loop.artifact.added",
      "loop.run.finished",
    ]) {
      expect(kinds).toContain(kind);
    }
    expect(events.at(-1)?.kind).toBe("loop.run.finished");
    const states = [loopStates[before - 1] ?? [], ...loopStates.slice(before)];
    expect([...projectLoopRuns(events).values()]).toEqual(states.at(-1));
    const text = JSON.stringify(events);
    expect(text).not.toContain("MAKER_RAW_OUTPUT");
    expect(text).not.toContain(JSON.stringify(dataDir).slice(1, -1));
    record("loop-makerChecker", states, events);
  });
});
