// A8: the human node events next to the existing ones (dual-write), and the opt-in
// timeout policy's expiry on the ask_user tool.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import { projectNodeTree, type EventEnvelope } from "@agent-deck/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AskUserCoordinator, askUserParamsSchema } from "../src/askUserCoordinator.ts";
import { createEventLog, type EventLog } from "../src/eventLog.ts";
import { createEventProducers, userActor } from "../src/eventProducers.ts";
import type { SessionManager } from "../src/SessionManager.ts";
import { SupervisorLog } from "../src/supervisor.ts";

const dirs: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const log of logs.splice(0)) log.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-human-"));
  dirs.push(dataDir);
  const log = createEventLog(dataDir, {
    strict: true,
    warn: () => {},
    projectOf: (sessionId) => (sessionId === "s1" ? "project-1" : null),
  });
  logs.push(log);
  let n = 0;
  const events = createEventProducers(log, { randomId: () => `id-${++n}` });
  const all = (): EventEnvelope[] =>
    log.read({ afterSeq: 0, limit: 1_000 }).events.filter((e) => e.kind !== "server.started");
  const human = (): EventEnvelope[] => all().filter((e) => e.kind.startsWith("human."));
  return { events, all, human };
}

const meta = { id: "s1", cwd: "/tmp", createdAt: "now", projectId: "project-1" } as SessionMeta;
const ALE = userActor({ id: "ale@example.com", name: "Ale" });

describe("human node events", () => {
  it("decision: dual-written with the supervisor events, answered by a member", () => {
    const h = harness();
    const supervisor = new SupervisorLog();
    const asked = supervisor.record({
      id: "req-1",
      parentSessionId: "s1",
      cellId: "run-1",
      method: "need_decision",
      title: "Format",
      message: "JSON or YAML?",
    });
    h.events.supervisorOpened(asked, "child-1", ["JSON", "YAML"]);
    h.events.supervisorAnswered(supervisor.markAnswered("req-1", "JSON")!, ALE);
    const other = supervisor.record({
      parentSessionId: "s1",
      cellId: "run-1",
      method: "interview_request",
      message: "Why?",
    });
    h.events.supervisorOpened(other, "child-1");
    h.events.supervisorCancelled(supervisor.markCancelled(other.id, "The subagent ended.")!);
    // A progress update is not a request: no human node.
    h.events.supervisorOpened(
      supervisor.record({
        parentSessionId: "s1",
        cellId: "run-1",
        method: "progress_update",
        message: "ok",
      }),
      "child-1",
    );
    expect(h.all().map((e) => e.kind)).toEqual([
      "supervisor.request.opened",
      "human.requested",
      "supervisor.request.answered",
      "human.answered",
      "supervisor.request.opened",
      "human.requested",
      "supervisor.request.cancelled",
      "human.cancelled",
      "supervisor.progress.recorded",
    ]);
    const [requested, answered, , cancelled] = h.human();
    expect(requested).toMatchObject({
      projectId: "project-1",
      sessionId: "s1",
      subject: { type: "human", id: "req-1" },
      parent: { type: "subagentRun", id: "run-1" },
      actor: { type: "agent", sessionId: "child-1" },
      payload: {
        kind: "decision",
        prompt: "Format\n\nJSON or YAML?",
        options: ["JSON", "YAML"],
        timeoutPolicy: { type: "none" },
      },
    });
    expect(answered).toMatchObject({
      actor: ALE,
      payload: { by: ALE, answer: "JSON" },
    });
    expect(cancelled).toMatchObject({ payload: { reason: "The subagent ended." } });
  });

  it("extension UI: opens under the running turn, records who answered, withholds sign-in codes", () => {
    const h = harness();
    const hooks = h.events.turnHooks(meta);
    h.events.turnPrompted("s1", ALE, "prompt", "Set up the MCP server");
    hooks.consumed();
    hooks.uiRequested!({ id: "u1", method: "select", title: "Pick", options: ["a", "b"] });
    hooks.uiResolved!("u1", { type: "extension_ui_response", id: "u1", value: "b" }, ALE);
    hooks.uiRequested!({ id: "u2", method: "input", title: 'Waiting for sign-in to "gh". Paste' });
    hooks.uiResolved!("u2", { value: "4/0Ab-very-secret-code" }, ALE);
    hooks.uiRequested!({ id: "u3", method: "confirm", title: "Sure?" });
    hooks.uiResolved!("u3", { cancelled: true }, ALE);
    hooks.uiRequested!({ id: "u4", method: "input", title: "Name" });
    hooks.uiClosed!("u4", "Settled by Pi.");
    const [requested, answered, , secret, , cancelled, , closed] = h.human();
    expect(requested).toMatchObject({
      subject: { type: "human", id: "s1/ui/u1" },
      parent: { type: "turn", id: "id-1" },
      causationId: "id-1",
      payload: { kind: "askUser", prompt: "Pick", options: ["a", "b"] },
    });
    expect(answered).toMatchObject({ actor: ALE, payload: { by: ALE, answer: "b" } });
    expect(secret).toMatchObject({ payload: { answer: "<withheld>" } });
    expect(JSON.stringify(h.all())).not.toContain("very-secret");
    expect(cancelled).toMatchObject({ kind: "human.cancelled", actor: ALE });
    expect(closed).toMatchObject({
      kind: "human.cancelled",
      payload: { reason: "Settled by Pi." },
    });
  });

  it("loop approval: no session, under its run, answered by whoever decided", () => {
    const h = harness();
    h.events.humanRequested({
      id: "run-1",
      kind: "loopApproval",
      prompt: "Ship?",
      options: ["approve", "reject"],
      projectId: "project-1",
      parent: { type: "loopRun", id: "run-1" },
      actor: { type: "system" },
    });
    h.events.humanAnswered({ id: "run-1", projectId: "project-1" }, ALE, "approve");
    const [requested, answered] = h.human();
    expect(requested).toMatchObject({
      projectId: "project-1",
      parent: { type: "loopRun", id: "run-1" },
    });
    expect(requested).not.toHaveProperty("sessionId");
    expect(answered).toMatchObject({
      projectId: "project-1",
      payload: { by: ALE, answer: "approve" },
    });
  });
});

function askHarness() {
  const h = harness();
  const cells: { requestId: string }[] = [];
  const answers: unknown[] = [];
  const closes: unknown[] = [];
  const session = {
    openAskUser: (cell: { requestId: string }) => cells.push(cell),
    answerAskUser: (...args: unknown[]) => answers.push(args),
    closeAskUser: (...args: unknown[]) => closes.push(args),
    onExit: () => () => {},
  };
  const sessions = { get: (id: string) => (id === "s1" ? session : undefined) };
  const coordinator = new AskUserCoordinator(
    sessions as unknown as SessionManager,
    () => "token",
    h.events,
  );
  return { ...h, coordinator, cells, answers, closes };
}

describe("ask_user tool: human node and timeout policy", () => {
  it("default none: the request stays open past any policy time; the answer records the member", async () => {
    vi.useFakeTimers();
    const h = askHarness();
    const result = h.coordinator.ask(
      "s1",
      "token",
      askUserParamsSchema.parse({ question: "Deploy?", options: ["Ship", "Wait"], timeout: 600 }),
    );
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(h.human().map((e) => e.kind)).toEqual(["human.requested"]);
    expect(h.human()[0]).toMatchObject({ payload: { timeoutPolicy: { type: "none" } } });
    expect(h.human()[0]!.payload).not.toHaveProperty("expiresAt");
    expect(h.coordinator.answer("s1", h.cells[0]!.requestId, { selections: ["Ship"] }, ALE)).toBe(
      "ok",
    );
    expect((await result).details).toEqual({ status: "answered", selections: ["Ship"] });
    expect(h.human()[1]).toMatchObject({
      kind: "human.answered",
      payload: { by: ALE, answer: "Ship" },
    });
  });

  it("expire then default: the run continues with the default answer", async () => {
    vi.useFakeTimers();
    const h = askHarness();
    const result = h.coordinator.ask(
      "s1",
      "token",
      askUserParamsSchema.parse({
        question: "Deploy?",
        options: ["Ship", "Wait"],
        timeoutPolicy: { afterMinutes: 2, then: "default", default: "Wait" },
      }),
    );
    await vi.advanceTimersByTimeAsync(119_000);
    expect((await Promise.race([result, Promise.resolve("open")])) === "open").toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await result).details).toEqual({
      status: "answered",
      selections: ["Wait"],
      defaulted: true,
    });
    expect(h.answers).toEqual([[h.cells[0]!.requestId, { selections: ["Wait"] }]]);
    expect(h.human().map((e) => e.kind)).toEqual(["human.requested", "human.expired"]);
    expect(h.human()[1]).toMatchObject({ payload: { then: "default", answer: "Wait" } });
    // A late answer finds nothing pending and writes nothing.
    expect(h.coordinator.answer("s1", h.cells[0]!.requestId, { selections: ["Ship"] }, ALE)).toBe(
      "missing",
    );
    const tree = projectNodeTree(h.all());
    expect(tree.nodes.get(`human:${h.cells[0]!.requestId}`)).toMatchObject({
      status: "done",
      human: { expired: "default", answer: "Wait" },
    });
  });

  it("expire then blocked: the call returns timed_out and the node is marked blocked", async () => {
    vi.useFakeTimers();
    const h = askHarness();
    const result = h.coordinator.ask(
      "s1",
      "token",
      askUserParamsSchema.parse({
        question: "Deploy?",
        timeoutPolicy: { afterMinutes: 0.5, then: "blocked" },
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect((await result).details).toMatchObject({ status: "timed_out" });
    expect(h.closes).toHaveLength(1);
    // Expired, not also cancelled.
    expect(h.human().map((e) => e.kind)).toEqual(["human.requested", "human.expired"]);
    expect(projectNodeTree(h.all()).nodes.get(`human:${h.cells[0]!.requestId}`)).toMatchObject({
      status: "stopped",
      human: { expired: "blocked" },
    });
  });

  it("the tool's own timeout without a policy closes the node as cancelled", async () => {
    vi.useFakeTimers();
    const h = askHarness();
    const result = h.coordinator.ask(
      "s1",
      "token",
      askUserParamsSchema.parse({ question: "Deploy?", timeout: 1 }),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect((await result).details).toMatchObject({ status: "timed_out" });
    expect(h.human().map((e) => e.kind)).toEqual(["human.requested", "human.cancelled"]);
  });
});
