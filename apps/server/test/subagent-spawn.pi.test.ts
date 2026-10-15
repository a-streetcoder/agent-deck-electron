import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
  type MockProviderOptions,
} from "@agent-deck/testkit";
import { expect, it, vi } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";
import type { StructuredSubagentResult, SubagentRunRecord } from "../src/subagentRunStore.ts";

/**
 * A4 against real Pi: spawn_subagent returns a run id while the child works,
 * await_subagents collects structured results, cancel_subagent stops a running
 * child, and a parent abort cancels a spawned child nobody awaits.
 */

process.env.AGENT_DECK_TEST = "1";

/** A real absolute path and a long tail: the owning parent gets both back unredacted, uncut. */
const PATH_PROBE = path.join(tmpdir(), "spawn-worktree", "src", "report.ts");
const LONG_TAIL = "x".repeat(4_500);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/;

const systemText = (body: ChatCompletionRequest): string =>
  JSON.stringify(body.messages.filter((m) => m.role === "system" || m.role === "developer"));
const isChild = (body: ChatCompletionRequest): boolean =>
  systemText(body).includes("focused subagent launched by Agent Deck");
const toolTexts = (body: ChatCompletionRequest): string[] =>
  body.messages
    .filter((m) => m.role === "tool")
    .map((m) =>
      typeof m.content === "string"
        ? m.content
        : (m.content as { text?: string }[]).map((part) => part.text ?? "").join(""),
    );
const runIdIn = (text: string | undefined): string => text?.match(UUID)?.[0] ?? "missing";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

async function withParent(
  options: MockProviderOptions,
  body: (ctx: {
    server: AgentDeckServer;
    sessionId: string;
    dataDir: string;
    requests: ChatCompletionRequest[];
  }) => Promise<void>,
): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-spawn-"));
  const mock = await startMockProvider(options);
  const previous = process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  const dataDir = path.join(root, "data");
  const server = await startServer({ dataDir });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startImmediately: true,
        cwd: root,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: { HOME: root, USERPROFILE: root, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };
    await body({ server, sessionId: session.id, dataDir, requests: mock.requests });
  } finally {
    await server.close();
    await mock.close();
    if (previous === undefined) delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
    else process.env.AGENT_DECK_PROVIDER_EXTENSIONS = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const storedRuns = (dataDir: string): SubagentRunRecord[] =>
  (
    JSON.parse(readFileSync(path.join(dataDir, "subagent-runs.json"), "utf8")) as {
      runs: SubagentRunRecord[];
    }
  ).runs;

const loggedEvents = (
  dataDir: string,
): { kind: string; subject: { id: string }; payload: { result?: { summary?: string } } }[] => {
  const dir = path.join(dataDir, "events");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(path.join(dir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line));
};

it("spawns two children, cancels one, and awaits both with structured results", async () => {
  const betaGate = deferred();
  const betaStarted = deferred();
  await withParent(
    {
      chunkDelayMs: 5,
      beforeResponse: async (_user, body) => {
        if (isChild(body) && systemText(body).includes("TASK_BETA")) {
          betaStarted.resolve();
          await betaGate.promise;
        }
        // Cancel only once beta is mid-run (its card is open, its provider call pending).
        if (!isChild(body) && toolTexts(body).length === 2) await betaStarted.promise;
      },
      toolCall: (_user, body) => {
        if (isChild(body)) return null;
        if (!JSON.stringify(body.tools ?? []).includes("spawn_subagent")) return null;
        const results = toolTexts(body);
        switch (results.length) {
          case 0:
            return { name: "spawn_subagent", arguments: { task: "TASK_ALPHA: report" } };
          case 1:
            return { name: "spawn_subagent", arguments: { task: "TASK_BETA: wait" } };
          case 2:
            return { name: "cancel_subagent", arguments: { runId: runIdIn(results[1]) } };
          case 3:
            return {
              name: "await_subagents",
              arguments: { runIds: [runIdIn(results[0]), runIdIn(results[1])] },
            };
          default:
            return null;
        }
      },
      reply: (_user, body) =>
        isChild(body) ? `ALPHA_RESULT_SENTINEL ${PATH_PROBE} ${LONG_TAIL}` : "parent finished",
    },
    async ({ server, sessionId, dataDir, requests }) => {
      const managed = server.sessions.get(sessionId)!;
      try {
        await managed.prompt("Spawn, cancel and await");
        const final = await vi.waitFor(
          () => {
            const request = requests.find((r) => !isChild(r) && toolTexts(r).length === 4);
            expect(request).toBeDefined();
            return request!;
          },
          { timeout: 60_000 },
        );
        const [spawnA, spawnB, cancel, awaited] = toolTexts(final);
        const alphaId = runIdIn(spawnA);
        const betaId = runIdIn(spawnB);
        expect(JSON.parse(spawnA!)).toEqual({ runId: alphaId });
        expect(JSON.parse(spawnB!)).toEqual({ runId: betaId });
        expect(JSON.parse(cancel!)).toEqual({ status: "stopped" });
        const outcome = JSON.parse(awaited!) as {
          results: StructuredSubagentResult[];
          timedOut: boolean;
        };
        expect(outcome.timedOut).toBe(false);
        const [alpha, beta] = outcome.results;
        expect(alpha).toMatchObject({ id: alphaId, status: "completed", model: MOCK_MODEL_ID });
        // Full private summary: longer than the 4,000-char public head, real path intact.
        expect(alpha?.summary).toBe(`ALPHA_RESULT_SENTINEL ${PATH_PROBE} ${LONG_TAIL}`);
        expect(alpha?.durationMs).toBeGreaterThanOrEqual(0);
        expect(alpha).toHaveProperty("tokens");
        expect(alpha).not.toHaveProperty("artifacts");
        expect(beta).toMatchObject({ id: betaId, status: "stopped" });
        expect(beta?.error).toContain("stopped");

        const records = storedRuns(dataDir);
        expect(Object.fromEntries(records.map((r) => [r.id, r.status]))).toEqual({
          [alphaId]: "completed",
          [betaId]: "stopped",
        });
        // Each run hangs under the spawn call that created it (A1 tree edge).
        expect(new Set(records.map((r) => r.parentToolCallId)).size).toBe(2);
        const finished = loggedEvents(dataDir).filter((e) => e.kind === "subagent.run.finished");
        expect(finished.map((e) => e.subject.id).sort()).toEqual([alphaId, betaId].sort());
        // The log keeps the public view: a capped head with the path redacted.
        const logged = finished.find((e) => e.subject.id === alphaId)?.payload.result?.summary;
        expect(logged?.length).toBeLessThan(alpha!.summary!.length);
        expect(logged).not.toContain(PATH_PROBE);
        // The cancelled child never produced output after the stop.
        betaGate.resolve();
        await new Promise((resolve) => setTimeout(resolve, 500));
        const cards = managed.snapshot().state.cells.filter((c) => c.kind === "subagent");
        expect(cards.map((c) => [c.id, c.status])).toEqual([
          [alphaId, "done"],
          [betaId, "stopped"],
        ]);
      } finally {
        betaGate.resolve();
      }
    },
  );
});

it("a parent abort cancels a spawned child that nobody awaits", async () => {
  const childGate = deferred();
  const parentGate = deferred();
  await withParent(
    {
      beforeResponse: async (_user, body) => {
        if (isChild(body)) await childGate.promise;
        else if (toolTexts(body).length > 0) await parentGate.promise;
      },
      toolCall: (_user, body) => {
        if (isChild(body) || toolTexts(body).length > 0) return null;
        if (!JSON.stringify(body.tools ?? []).includes("spawn_subagent")) return null;
        return { name: "spawn_subagent", arguments: { task: "TASK_ORPHAN: wait" } };
      },
      reply: (_user, body) => (isChild(body) ? "FORBIDDEN_AFTER_ABORT" : "parent finished"),
    },
    async ({ server, sessionId, dataDir, requests }) => {
      const managed = server.sessions.get(sessionId)!;
      try {
        await managed.prompt("Spawn and move on");
        // The spawn call returned (its result reached the parent model) while the
        // child is still waiting on the provider.
        await vi.waitFor(
          () => {
            expect(requests.filter(isChild)).toHaveLength(1);
            expect(requests.some((r) => !isChild(r) && toolTexts(r).length === 1)).toBe(true);
          },
          { timeout: 30_000 },
        );
        expect(storedRuns(dataDir).map((r) => r.status)).toEqual(["running"]);
        await managed.abort();
        await vi.waitFor(
          () => expect(storedRuns(dataDir).map((r) => r.status)).toEqual(["stopped"]),
          {
            timeout: 20_000,
          },
        );
        expect(managed.isRunning).toBe(true);
        childGate.resolve();
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(requests.filter(isChild)).toHaveLength(1);
        const cards = managed.snapshot().state.cells.filter((c) => c.kind === "subagent");
        expect(cards.map((c) => c.status)).toEqual(["stopped"]);
        expect(cards[0]?.text ?? "").not.toContain("FORBIDDEN_AFTER_ABORT");
      } finally {
        childGate.resolve();
        parentGate.resolve();
      }
    },
  );
});
