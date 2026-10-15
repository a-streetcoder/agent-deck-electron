import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
} from "@agent-deck/testkit";
import { expect, it, vi } from "vitest";
import type { SessionMeta } from "@agent-deck/domain";
import { startServer } from "../src/index.ts";

/**
 * A5 against real Pi: the parent sets a plan with two independent items assigned to a
 * named agent and one item that depends on both and is verified by another agent. The
 * server runs the two (one at a time: they share the checkout), then the third with their
 * results, logs plan.item.dispatched with the event that made each item ready as its
 * cause, and the verifier's REJECT blocks the third with the reason as its note.
 */

process.env.AGENT_DECK_TEST = "1";

const systemText = (body: ChatCompletionRequest): string =>
  JSON.stringify(body.messages.filter((m) => m.role === "system" || m.role === "developer"));
const isChild = (body: ChatCompletionRequest): boolean =>
  systemText(body).includes("focused subagent launched by Agent Deck");

interface LoggedEvent {
  id: string;
  seq: number;
  kind: string;
  causationId?: string;
  subject: { id: string };
  actor: { type: string };
  payload: { itemId?: string; runId?: string; verdict?: string; producerRunId?: string };
}

const loggedEvents = (dataDir: string): LoggedEvent[] => {
  const dir = path.join(dataDir, "events");
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(path.join(dir, name), "utf8").split("\n"))
    .filter(Boolean)
    .map((line) => JSON.parse(line) as LoggedEvent)
    .sort((a, b) => a.seq - b.seq);
};

it("runs two independent assigned items, then the dependent one, and applies its verifier's REJECT", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-plan-dispatch-"));
  const home = path.join(root, "home");
  const agentsDir = path.join(home, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "worker-bot.md"),
    "---\nname: worker-bot\ndescription: Does one plan item\ntools: read\n---\n\nDo the plan item.\n",
  );
  writeFileSync(
    path.join(agentsDir, "checker-bot.md"),
    "---\nname: checker-bot\ndescription: Reviews one plan item\n---\n\nReview the result.\n",
  );
  const mock = await startMockProvider({
    toolCall: (_user, body) => {
      if (isChild(body) || body.messages.some((m) => m.role === "tool")) return null;
      if (!JSON.stringify(body.tools ?? []).includes("set_session_plan")) return null;
      return {
        name: "set_session_plan",
        arguments: {
          items: [
            { id: "a", title: "TASK_A: build part A", assignee: "worker-bot" },
            { id: "b", title: "TASK_B: build part B", assignee: "worker-bot" },
            {
              id: "c",
              title: "TASK_C: join A and B",
              assignee: "worker-bot",
              verifiedBy: "checker-bot",
              dependsOn: ["a", "b"],
            },
          ],
        },
      };
    },
    reply: (_user, body) => {
      if (!isChild(body)) return "Plan set.";
      const system = systemText(body);
      if (system.includes("verify: TASK_C")) return "REJECT: the join has no tests";
      if (system.includes("TASK_C")) return "RESULT_C joined";
      return system.includes("TASK_A") ? "RESULT_A ready" : "RESULT_B ready";
    },
  });
  const previousExtensions = process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  const previousEnv = process.env.AGENT_DECK_PI_ENV;
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: home });
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
        env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };
    const managed = server.sessions.get(session.id)!;
    await managed.prompt("Plan and run the work");

    await vi.waitFor(
      () =>
        expect(managed.snapshot().state.plan.map((item) => item.status)).toEqual([
          "done",
          "done",
          "blocked",
        ]),
      { timeout: 90_000, interval: 250 },
    );

    const events = loggedEvents(dataDir);
    const dispatched = events.filter((e) => e.kind === "plan.item.dispatched");
    expect(dispatched.map((e) => e.payload.itemId)).toEqual(["a", "b", "c"]);
    const plan = managed.snapshot().state.plan;
    expect(plan.map((item) => item.runId)).toEqual(dispatched.map((e) => e.payload.runId));
    expect(dispatched.every((e) => e.actor.type === "system")).toBe(true);
    // a is caused by the agent's plan event; b by a's finish (one at a time in the
    // checkout); c by the finish that made it ready (b's).
    const planSet = events.find((e) => e.kind === "plan.changed")!;
    const finishOf = (runId: string | undefined) =>
      events.find((e) => e.kind === "subagent.run.finished" && e.subject.id === runId)!;
    expect(dispatched[0]?.causationId).toBe(planSet.id);
    expect(dispatched[1]?.causationId).toBe(finishOf(dispatched[0]?.payload.runId).id);
    expect(dispatched[1]!.seq).toBeGreaterThan(finishOf(dispatched[0]?.payload.runId).seq);
    expect(dispatched[2]?.causationId).toBe(finishOf(dispatched[1]?.payload.runId).id);
    // The verifier (a durable read-only run) rejected c: blocked with the reason.
    const verified = events.filter((e) => e.kind === "plan.item.verified");
    expect(verified).toHaveLength(1);
    expect(verified[0]?.payload).toMatchObject({
      itemId: "c",
      verdict: "REJECT",
      producerRunId: dispatched[2]?.payload.runId,
    });
    expect(plan[2]?.note).toBe("REJECT: the join has no tests");
    const verifierRun = server.sessions.subagentRunRecord(session.id, verified[0]!.payload.runId!);
    expect(verifierRun).toMatchObject({ status: "completed", agent: "checker-bot" });
    expect(verifierRun?.task).toMatch(/^verify: TASK_C/);
    const verifierRequest = mock.requests.find(
      (r) => isChild(r) && systemText(r).includes("verify: TASK_C"),
    )!;
    expect(systemText(verifierRequest)).toContain("RESULT_C joined");
    const joinRequest = mock.requests.find((r) => isChild(r) && systemText(r).includes("TASK_C"))!;
    expect(systemText(joinRequest)).toContain("RESULT_A ready");
    expect(systemText(joinRequest)).toContain("RESULT_B ready");
  } finally {
    await server.close();
    await mock.close();
    if (previousExtensions === undefined) delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
    else process.env.AGENT_DECK_PROVIDER_EXTENSIONS = previousExtensions;
    if (previousEnv === undefined) delete process.env.AGENT_DECK_PI_ENV;
    else process.env.AGENT_DECK_PI_ENV = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);

it("a restart settles the interrupted item on resume and dispatches nothing new", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-plan-restart-"));
  const home = path.join(root, "home");
  const agentsDir = path.join(home, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "worker-bot.md"),
    "---\nname: worker-bot\ndescription: Does one plan item\ntools: read\n---\n\nDo the plan item.\n",
  );
  let releaseSlow!: () => void;
  const slowGate = new Promise<void>((resolve) => (releaseSlow = resolve));
  const mock = await startMockProvider({
    beforeResponse: async (_user, body) => {
      if (isChild(body) && systemText(body).includes("TASK_SLOW")) await slowGate;
    },
    toolCall: (_user, body) => {
      if (isChild(body) || body.messages.some((m) => m.role === "tool")) return null;
      if (!JSON.stringify(body.tools ?? []).includes("set_session_plan")) return null;
      return {
        name: "set_session_plan",
        arguments: {
          items: [
            { id: "s", title: "TASK_SLOW: long work", assignee: "worker-bot" },
            { id: "t", title: "TASK_NEXT: after the slow one", assignee: "worker-bot" },
          ],
        },
      };
    },
    reply: (_user, body) => (isChild(body) ? "child result" : "Plan set."),
  });
  const previousExtensions = process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  const previousEnv = process.env.AGENT_DECK_PI_ENV;
  const extension = writeMockProviderExtension(mock.baseUrl);
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = extension;
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: home });
  const env = { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" };
  const dataDir = path.join(root, "data");
  let server = await startServer({ dataDir });
  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startImmediately: true,
        cwd: root,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [extension],
        env,
      }),
    });
    const { session } = (await response.json()) as { session: { id: string } };
    const managed = server.sessions.get(session.id)!;
    await managed.prompt("Plan the work");
    await vi.waitFor(
      () =>
        expect(managed.snapshot().state.plan.map((i) => i.status)).toEqual(["in_progress", "todo"]),
      { timeout: 60_000, interval: 100 },
    );
    await server.receipts.waitFor("idle", session.id);
    // The server goes down while the slow item runs: its plan still says in_progress.
    await server.close();
    releaseSlow();
    server = await startServer({ dataDir });
    const meta = (
      JSON.parse(readFileSync(path.join(dataDir, "sessions.json"), "utf8")) as SessionMeta[]
    ).find((candidate) => candidate.id === session.id)!;
    expect(meta.plan?.map((i) => i.status)).toEqual(["in_progress", "todo"]);
    const resumed = await server.sessions.resume(
      meta,
      {
        kind: "parent",
        resumeSessionPath: meta.piSessionFile,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [extension],
      },
      env,
    );
    // The restore's settle pass: the interrupted run blocks its item; t is not started
    // (no live intent of the session's agent in this process).
    await vi.waitFor(
      () => expect(resumed.snapshot().state.plan.map((i) => i.status)).toEqual(["blocked", "todo"]),
      { timeout: 20_000, interval: 100 },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(mock.requests.some((r) => isChild(r) && systemText(r).includes("TASK_NEXT"))).toBe(
      false,
    );
  } finally {
    releaseSlow();
    await server.close();
    await mock.close();
    if (previousExtensions === undefined) delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
    else process.env.AGENT_DECK_PROVIDER_EXTENSIONS = previousExtensions;
    if (previousEnv === undefined) delete process.env.AGENT_DECK_PI_ENV;
    else process.env.AGENT_DECK_PI_ENV = previousEnv;
    rmSync(root, { recursive: true, force: true });
  }
}, 120_000);
