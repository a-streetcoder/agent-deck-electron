import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
import type { SubagentCell } from "@agent-deck/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * managed_parallel end-to-end against real pi: a parent fans out three tasks
 * through a concurrency-two pool. Controlled provider gates prove overlap never
 * exceeds two while every child streams and returns in input order. One task
 * delegates to a NAMED agent (per-task `agent`) — that child adopts its persona.
 */

process.env.AGENT_DECK_TEST = "1";

const PERSONA_SENTINEL = "PERSONA_SENTINEL: You are Reviewer Bot.";

let mock: MockProviderServer;
let server: AgentDeckServer;
let projectId: string;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const project = mkdtempSync(path.join(tmpdir(), "pi-parallel-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const childGates = {
  alpha: deferred(),
  beta: deferred(),
  gamma: deferred(),
};
const twoChildrenStarted = deferred();
const thirdChildStarted = deferred();
let initialChildrenStarted = 0;
let activeInitialChildren = 0;
let maxActiveInitialChildren = 0;

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
    chunkDelayMs: 10,
    beforeResponse: async (_lastUser, body) => {
      const hasToolResult = body.messages.some((m) => m.role === "tool");
      if (!isChildRequest(body) || hasToolResult) return;
      const sys = systemText(body);
      const gate = sys.includes("TASK_ALPHA")
        ? childGates.alpha
        : sys.includes("TASK_BETA")
          ? childGates.beta
          : childGates.gamma;
      initialChildrenStarted += 1;
      activeInitialChildren += 1;
      maxActiveInitialChildren = Math.max(maxActiveInitialChildren, activeInitialChildren);
      if (initialChildrenStarted === 2) twoChildrenStarted.resolve();
      if (initialChildrenStarted === 3) thirdChildStarted.resolve();
      await gate.promise;
      activeInitialChildren -= 1;
    },
    toolCall: (_lastUser, body) => {
      const hasToolResult = body.messages.some((m) => m.role === "tool");
      if (isChildRequest(body)) {
        if (hasToolResult) return null;
        const sys = systemText(body);
        return {
          name: "write",
          arguments: {
            path: "child-output.txt",
            content: sys.includes("TASK_ALPHA")
              ? "alpha isolated\n"
              : sys.includes("TASK_BETA")
                ? "beta isolated\n"
                : "gamma isolated\n",
          },
        };
      }
      if (hasToolResult) return null;
      return {
        name: "managed_parallel",
        arguments: {
          concurrency: 2,
          worktree: true,
          tasks: [
            { task: "TASK_ALPHA: write alpha" },
            { task: "TASK_BETA: write beta", agent: "reviewer-bot" },
            { task: "TASK_GAMMA: write gamma" },
          ],
        },
      };
    },
    // Each child is identified by its task text in the system prompt.
    reply: (_lastUser, body) => {
      const sys = systemText(body);
      if (sys.includes("TASK_ALPHA"))
        return "RESULT_ALPHA_SENTINEL: isolated writer completed with retained evidence.";
      if (sys.includes("TASK_BETA"))
        return "RESULT_BETA_SENTINEL: isolated writer completed with retained evidence.";
      if (sys.includes("TASK_GAMMA"))
        return "RESULT_GAMMA_SENTINEL: isolated writer completed with retained evidence.";
      return "Delegated to parallel subagents.";
    },
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);

  // A named global agent the BETA task delegates to.
  const agentsDir = path.join(tmpHome, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "reviewer-bot.md"),
    `---\nname: reviewer-bot\ndescription: Reviewer\ntools: write\n---\n\n${PERSONA_SENTINEL}\n`,
  );

  execFileSync("git", ["init", "-b", "main"], { cwd: project });
  writeFileSync(path.join(project, "parent-sentinel.txt"), "parent unchanged\n");
  execFileSync("git", ["add", "."], { cwd: project });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Agent Deck Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "initial",
    ],
    { cwd: project },
  );

  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: tmpHome });
  server = await startServer({ dataDir });
  const created = (await (
    await fetch(`http://127.0.0.1:${server.port}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    })
  ).json()) as { project: { id: string } };
  projectId = created.project.id;
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("managed_parallel: fan out subagents and combine results", () => {
  it("runs three children with exact concurrency two and returns ordered results", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: project,
        projectId,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };

    const orderedEvents: Array<{ seq: number; cellId: string; delta: string }> = [];
    const unsubscribe = server.sessions.get(session.id)!.bus.subscribe((stamped) => {
      if (stamped.event.type === "subagent_delta") {
        orderedEvents.push({
          seq: stamped.seq,
          cellId: stamped.event.cellId,
          delta: stamped.event.delta,
        });
      }
    });
    const prompt = server.sessions
      .get(session.id)!
      .prompt("run all three writers in concurrency-two parallel worktrees");
    await twoChildrenStarted.promise;
    expect(initialChildrenStarted).toBe(2);
    expect(activeInitialChildren).toBe(2);
    expect(maxActiveInitialChildren).toBe(2);

    // Free one slot only after both initial requests overlap. The queued third
    // child cannot allocate/start until the first child has fully completed.
    childGates.alpha.resolve();
    await thirdChildStarted.promise;
    expect(initialChildrenStarted).toBe(3);
    expect(activeInitialChildren).toBe(2);
    expect(maxActiveInitialChildren).toBe(2);
    childGates.beta.resolve();
    childGates.gamma.resolve();
    await prompt;
    await server.receipts.waitFor("idle", session.id);

    const childSystems = mock.requests.filter(isChildRequest).map(systemText);
    expect(childSystems.some((s) => s.includes("TASK_ALPHA"))).toBe(true);
    expect(childSystems.some((s) => s.includes("TASK_BETA"))).toBe(true);
    expect(childSystems.some((s) => s.includes("TASK_GAMMA"))).toBe(true);

    unsubscribe();

    // Preserve anonymous + named delegation while all writer children retain
    // ordered, genuinely incremental parent-card deltas.
    const betaChild = childSystems.find((s) => s.includes("TASK_BETA"))!;
    const alphaChild = childSystems.find((s) => s.includes("TASK_ALPHA"))!;
    expect(betaChild).toContain(PERSONA_SENTINEL);
    expect(alphaChild).not.toContain(PERSONA_SENTINEL);
    expect(orderedEvents.length).toBeGreaterThan(2);
    expect(orderedEvents.map((event) => event.seq)).toEqual(
      [...orderedEvents.map((event) => event.seq)].sort((a, b) => a - b),
    );

    // The parent received every result in input order despite scheduler timing.
    const followUp = mock.requests[mock.requests.length - 1]!;
    const toolText = JSON.stringify(followUp.messages.filter((m) => m.role === "tool"));
    const alphaResultIndex = toolText.indexOf("RESULT_ALPHA_SENTINEL");
    const betaResultIndex = toolText.indexOf("RESULT_BETA_SENTINEL");
    const gammaResultIndex = toolText.indexOf("RESULT_GAMMA_SENTINEL");
    expect(alphaResultIndex).toBeGreaterThan(-1);
    expect(betaResultIndex).toBeGreaterThan(alphaResultIndex);
    expect(gammaResultIndex).toBeGreaterThan(betaResultIndex);

    // Three subagent cells and distinct retained detached worktrees. They wrote
    // the same relative path without touching the parent checkout.
    const cells = server.sessions
      .get(session.id)!
      .snapshot()
      .state.cells.filter((c): c is SubagentCell => c.kind === "subagent");
    expect(cells).toHaveLength(3);
    expect(cells.filter((c) => c.agentName === "reviewer-bot")).toHaveLength(1);
    expect(cells.filter((c) => c.agentName === undefined)).toHaveLength(2);
    for (const cell of cells) {
      const deltas = orderedEvents.filter((event) => event.cellId === cell.id);
      expect(deltas.length).toBeGreaterThan(1);
      expect(deltas.map((event) => event.seq)).toEqual(
        [...deltas.map((event) => event.seq)].sort((a, b) => a - b),
      );
      expect(deltas.map((event) => event.delta).join(""), cell.task).toBe(cell.text);
    }
    const durableIds = cells.map((cell) => cell.id);
    expect(new Set(durableIds).size).toBe(3);
    const persisted = JSON.parse(
      readFileSync(path.join(dataDir, "subagent-runs.json"), "utf8"),
    ) as {
      runs: Array<{ id: string; worktreePath?: string; worktreeBaseCommit?: string }>;
    };
    const worktreeRuns = persisted.runs.filter((run) => durableIds.includes(run.id));
    const worktreePaths = worktreeRuns.map((run) => run.worktreePath!);
    expect(new Set(worktreePaths).size).toBe(3);
    expect(worktreeRuns.every((run) => Boolean(run.worktreeBaseCommit))).toBe(true);
    expect(
      new Set(
        worktreePaths.map((worktreePath) =>
          readFileSync(path.join(worktreePath, "child-output.txt"), "utf8"),
        ),
      ).size,
    ).toBe(3);
    expect(existsSync(path.join(project, "child-output.txt"))).toBe(false);
    expect(readFileSync(path.join(project, "parent-sentinel.txt"), "utf8")).toBe(
      "parent unchanged\n",
    );

    // Completed generic runs and their worktree ownership proof survive a full server restart.
    // exactly once alongside Pi's canonical parent history.
    await server.close();
    server = await startServer({ dataDir });
    const resumed = await fetch(`http://127.0.0.1:${server.port}/sessions/${session.id}/resume`, {
      method: "POST",
    });
    expect(resumed.status).toBe(200);
    const hydrated = server.sessions
      .get(session.id)!
      .snapshot()
      .state.cells.filter((c): c is SubagentCell => c.kind === "subagent");
    expect(hydrated).toHaveLength(3);
    // Parallel allocation order is intentionally scheduler-dependent; restart
    // must preserve the same identities, not impose a new ordering contract.
    expect(hydrated.map((cell) => cell.id)).toEqual(expect.arrayContaining(durableIds));
    expect(hydrated.map((cell) => cell.text)).toEqual(
      expect.arrayContaining([
        "RESULT_ALPHA_SENTINEL: isolated writer completed with retained evidence.",
        "RESULT_BETA_SENTINEL: isolated writer completed with retained evidence.",
        "RESULT_GAMMA_SENTINEL: isolated writer completed with retained evidence.",
      ]),
    );
    const deleted = await fetch(`http://127.0.0.1:${server.port}/sessions/${session.id}`, {
      method: "DELETE",
    });
    expect(deleted.status).toBe(200);
    expect(worktreePaths.every((worktreePath) => !existsSync(worktreePath))).toBe(true);
    const afterDelete = JSON.parse(
      readFileSync(path.join(dataDir, "subagent-runs.json"), "utf8"),
    ) as { runs: Array<{ id: string }> };
    expect(afterDelete.runs.some((run) => durableIds.includes(run.id))).toBe(false);
  });
});
