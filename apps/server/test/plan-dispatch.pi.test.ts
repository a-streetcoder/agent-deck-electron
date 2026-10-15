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
import { startServer } from "../src/index.ts";

/**
 * A5 against real Pi: the parent sets a plan with two independent items assigned to a
 * named agent and one item that depends on both. The server dispatches the two, then,
 * once both are done, the third with their results, and logs plan.item.dispatched with
 * the event that made each item ready as its cause.
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
  payload: { itemId?: string; runId?: string };
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

it("runs two independent assigned items, then the dependent one", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-plan-dispatch-"));
  const home = path.join(root, "home");
  const agentsDir = path.join(home, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "worker-bot.md"),
    "---\nname: worker-bot\ndescription: Does one plan item\ntools: read\n---\n\nDo the plan item.\n",
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
              dependsOn: ["a", "b"],
            },
          ],
        },
      };
    },
    reply: (_user, body) => {
      if (!isChild(body)) return "Plan set.";
      const system = systemText(body);
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
          "done",
        ]),
      { timeout: 90_000, interval: 250 },
    );

    const events = loggedEvents(dataDir);
    const dispatched = events.filter((e) => e.kind === "plan.item.dispatched");
    expect(dispatched.map((e) => e.payload.itemId)).toEqual(["a", "b", "c"]);
    const plan = managed.snapshot().state.plan;
    expect(plan.map((item) => item.runId)).toEqual(dispatched.map((e) => e.payload.runId));
    // a and b are caused by the agent's plan event; c by the finish that made it ready.
    const planSet = events.find((e) => e.kind === "plan.changed")!;
    expect(dispatched[0]?.causationId).toBe(planSet.id);
    expect(dispatched[1]?.causationId).toBe(planSet.id);
    const finishes = events.filter(
      (e) =>
        e.kind === "subagent.run.finished" &&
        [dispatched[0]?.payload.runId, dispatched[1]?.payload.runId].includes(e.subject.id),
    );
    expect(finishes).toHaveLength(2);
    expect(finishes.map((e) => e.id)).toContain(dispatched[2]?.causationId);
    // c started only after both finished, and its task carried both results.
    expect(dispatched[2]!.seq).toBeGreaterThan(Math.max(...finishes.map((e) => e.seq)));
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
