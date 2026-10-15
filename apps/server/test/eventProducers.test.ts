import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionMeta } from "@agent-deck/contracts";
import { splitJsonl, type EventEnvelope } from "@agent-deck/domain";
import { afterEach, describe, expect, it } from "vitest";
import { createEventLog, type EventLog } from "../src/eventLog.ts";
import { createEventProducers, userActor } from "../src/eventProducers.ts";
import type { CheckpointRecord } from "../src/services/checkpoints.ts";
import { makePlanEventService } from "../src/services/planEvents.ts";
import { SupervisorLog } from "../src/supervisor.ts";
import { capabilityFields, scanEventLines } from "./fixtures/eventScan.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(here, "../../../packages/domain/test/fixtures/events");

const dirs: string[] = [];
const logs: EventLog[] = [];
afterEach(() => {
  for (const log of logs.splice(0)) log.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function harness() {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-producers-"));
  dirs.push(dataDir);
  const log = createEventLog(dataDir, {
    strict: true,
    warn: () => {},
    projectOf: (sessionId) => (sessionId === "s1" ? "project-1" : null),
  });
  logs.push(log);
  let n = 0;
  const events = createEventProducers(log, () => `id-${++n}`);
  const all = (): EventEnvelope[] =>
    log.read({ afterSeq: 0, limit: 1_000 }).events.filter((e) => e.kind !== "server.started");
  const lines = (): string[] =>
    readdirSync(path.join(dataDir, "events"))
      .filter((name) => name.endsWith(".jsonl"))
      .flatMap(
        (name) => splitJsonl(readFileSync(path.join(dataDir, "events", name), "utf8")).lines,
      );
  return { dataDir, log, events, all, lines };
}

const meta = (overrides: Partial<SessionMeta> = {}): SessionMeta =>
  ({
    id: "s1",
    cwd: "/Users/someone/secret-project",
    createdAt: "2026-10-15T10:00:00.000Z",
    updatedAt: "2026-10-15T10:00:00.000Z",
    projectId: "project-1",
    ...overrides,
  }) as SessionMeta;

const checkpoint = (dataDir: string, turnIndex: number): CheckpointRecord => ({
  turnIndex,
  createdAt: "2026-10-15T10:00:00.000Z",
  label: "Plan the work",
  sessionSnapshotPath: path.join(dataDir, "checkpoints", "s1", `${turnIndex}.jsonl`),
  gitRef: `refs/agent-deck/checkpoints/s1/${turnIndex}`,
  cwd: "/Users/someone/secret-project",
  hasFiles: true,
  sourceSize: 10,
  sourceMtimeMs: 1,
});

describe("A1b1 producers", () => {
  it("session.created and session.removed carry the whitelist, the actor and the fork edge", () => {
    const h = harness();
    h.events.sessionCreated(
      meta({ title: "T".repeat(500), agentName: "Writer", createdBy: { id: "a@b.c", name: "A" } }),
      userActor({ id: "a@b.c", name: "A" }),
      "source-session",
    );
    h.events.sessionRemoved(meta(), userActor());
    const [created, removed] = h.all();
    expect(created).toMatchObject({
      kind: "session.created",
      projectId: "project-1",
      subject: { type: "session", id: "s1" },
      parent: { type: "session", id: "source-session" },
      actor: { type: "user", id: "a@b.c", name: "A" },
      payload: { agentName: "Writer", createdBy: { type: "user", id: "a@b.c", name: "A" } },
    });
    expect((created!.payload as { title: string }).title.length).toBeLessThanOrEqual(200);
    expect(created!.payload).not.toHaveProperty("cwd");
    expect(removed).toMatchObject({ kind: "session.removed", actor: { type: "user" } });
  });

  it("turn.prompted opens the turn; the parent completion, plan and checkpoint name it as cause", () => {
    const h = harness();
    h.events.turnPrompted("s1", userActor({ id: "a@b.c" }), "prompt", "Plan the work\nsecret");
    h.events.planChanged("s1", "set", {
      id: "p",
      sessionId: "s1",
      at: "",
      kind: "created",
      items: [{ id: "a", title: "Write the tests", status: "todo" }],
    });
    h.events.turnCompleted(meta(), {
      entryIds: ["u1", "a1"],
      toolCalls: [{ id: "c1", name: "set_session_plan", isError: false }],
      label: "Plan the work",
    });
    h.events.checkpointCreated("s1", checkpoint(h.dataDir, 0));
    const [prompted, plan, completed, created] = h.all();
    expect(prompted).toMatchObject({
      id: "id-1",
      kind: "turn.prompted",
      projectId: "project-1",
      subject: { type: "turn", id: "id-1" },
      parent: { type: "session", id: "s1" },
      actor: { type: "user", id: "a@b.c" },
      payload: { mode: "prompt", label: "Plan the work" },
    });
    expect(plan).toMatchObject({
      kind: "plan.changed",
      actor: { type: "agent", sessionId: "s1" },
      causationId: "id-1",
      payload: { kind: "created", items: [{ id: "a", title: "Write the tests", status: "todo" }] },
    });
    expect(plan!.payload).not.toHaveProperty("at");
    expect(completed).toMatchObject({
      kind: "session.turn.completed",
      subject: { type: "turn", id: "id-1" },
      causationId: "id-1",
      payload: { entryIds: ["u1", "a1"], toolCalls: [{ id: "c1", name: "set_session_plan" }] },
    });
    expect(completed!.parent).toBeUndefined();
    expect(created).toMatchObject({
      kind: "checkpoint.created",
      subject: { type: "checkpoint", id: "s1/0" },
      parent: { type: "turn", id: "id-1" },
      actor: { type: "system" },
      causationId: "id-1",
      payload: {
        turnIndex: 0,
        label: "Plan the work",
        hasFiles: true,
        gitRef: "refs/agent-deck/checkpoints/s1/0",
      },
    });
  });

  it("an unprompted turn is its own node, and a child turn hangs under its subagent run", () => {
    const h = harness();
    const turn = { entryIds: ["u1"], toolCalls: [], label: "loop step" };
    h.events.turnCompleted(meta({ id: "s2", projectId: undefined }), turn);
    h.events.turnPrompted("s1", userActor(), "prompt", "delegate");
    h.events.turnCompleted(meta(), turn, {
      parentSessionId: "s1",
      projectId: "project-1",
      subagentRunId: "run-1",
      childSessionId: "child-1",
      agentName: "Researcher",
    });
    const [loose, , child] = h.all();
    expect(loose).toMatchObject({
      projectId: null,
      sessionId: "s2",
      parent: { type: "session", id: "s2" },
    });
    expect(loose!.causationId).toBeUndefined();
    expect(child).toMatchObject({
      kind: "session.turn.completed",
      projectId: "project-1",
      parent: { type: "subagentRun", id: "run-1" },
      actor: { type: "agent", sessionId: "child-1", agentName: "Researcher" },
      causationId: "id-2",
    });
    expect(child!.sessionId).toBeUndefined();
  });

  it("plan history reports each recorded change once, and nothing for a no-op", () => {
    const h = harness();
    const plans = makePlanEventService({
      dataDir: h.dataDir,
      onRecorded: (event, op) => h.events.planChanged(event.sessionId, op, event),
    });
    const items = [{ id: "a", title: "One", status: "todo" as const }];
    plans.record("s1", "set", [], items);
    plans.record("s1", "update", items, items);
    plans.record("s1", "restore", [], items);
    expect(h.all().map((e) => [e.kind, (e.payload as { kind: string }).kind])).toEqual([
      ["plan.changed", "created"],
    ]);
  });

  it("checkpoint.rolledBack names the target and the safety checkpoint, never paths", () => {
    const h = harness();
    h.events.checkpointRolledBack(
      "s1",
      checkpoint(h.dataDir, 1),
      checkpoint(h.dataDir, 4),
      userActor({ id: "a@b.c" }),
    );
    expect(h.all()[0]).toMatchObject({
      kind: "checkpoint.rolledBack",
      subject: { type: "checkpoint", id: "s1/1" },
      actor: { type: "user", id: "a@b.c" },
      payload: { turnIndex: 1, safetyTurnIndex: 4 },
    });
  });

  it("supervisor requests: opened under the subagent run, answered by a person, cancelled once", () => {
    const h = harness();
    const supervisor = new SupervisorLog();
    const asked = supervisor.record({
      id: "req-1",
      parentSessionId: "s1",
      cellId: "cell-1",
      method: "need_decision",
      message: "Pick one",
    });
    h.events.supervisorOpened(asked, "child-1");
    h.events.supervisorAnswered(supervisor.markAnswered("req-1", "JSON")!, userActor({ id: "a" }));
    const other = supervisor.record({
      parentSessionId: "s1",
      cellId: "cell-1",
      method: "interview_request",
      message: "Why?",
    });
    h.events.supervisorCancelled(supervisor.markCancelled(other.id, "The subagent ended.")!);
    expect(supervisor.markCancelled(other.id, "again")).toBeUndefined();
    expect(supervisor.markAnswered("unknown", "x")).toBeUndefined();
    const [opened, answered, cancelled] = h.all();
    expect(opened).toMatchObject({
      id: "req-1",
      kind: "supervisor.request.opened",
      projectId: "project-1",
      subject: { type: "supervisorRequest", id: "req-1" },
      parent: { type: "subagentRun", id: "cell-1" },
      actor: { type: "agent", sessionId: "child-1" },
      payload: { method: "need_decision", status: "pending", message: "Pick one" },
    });
    expect(answered).toMatchObject({
      kind: "supervisor.request.answered",
      actor: { type: "user", id: "a" },
      causationId: "req-1",
      payload: { response: "JSON" },
    });
    expect(cancelled).toMatchObject({
      kind: "supervisor.request.cancelled",
      actor: { type: "system" },
      payload: { reason: "The subagent ended." },
    });
  });

  it("loop user actions record the person against the run", () => {
    const h = harness();
    h.events.loopUserAction("run-1", "project-1", "discard", userActor({ id: "a" }));
    expect(h.all()[0]).toMatchObject({
      kind: "loop.run.userAction",
      projectId: "project-1",
      subject: { type: "loopRun", id: "run-1" },
      actor: { type: "user", id: "a" },
      payload: { action: "discard" },
    });
  });

  it("secrets scan: a log of every producer holds no capability field, path or raw output", () => {
    const h = harness();
    h.events.sessionCreated(meta(), userActor());
    h.events.turnPrompted("s1", userActor(), "prompt", "x".repeat(10_000));
    h.events.checkpointCreated("s1", checkpoint(h.dataDir, 0));
    h.events.checkpointRolledBack("s1", checkpoint(h.dataDir, 0), null, userActor());
    h.events.supervisorOpened(
      new SupervisorLog().record({
        parentSessionId: "s1",
        cellId: "c",
        method: "progress_update",
        message: "y".repeat(10_000),
      }),
      "child-1",
    );
    expect(capabilityFields()).toContain("artifactRootToken");
    expect(capabilityFields().length).toBeGreaterThan(10);
    expect(scanEventLines(h.lines(), [h.dataDir, "secret-project"])).toEqual([]);
    // The scan itself catches what it looks for.
    const leaky = h
      .lines()[0]!
      .replace('"payload":{', `"payload":{"worktreePath":${JSON.stringify(h.dataDir)},`);
    expect(scanEventLines([leaky], [h.dataDir])).toHaveLength(3);
  });

  it("secrets scan: the recorded fixtures are clean", () => {
    const files = existsSync(FIXTURES)
      ? readdirSync(FIXTURES).filter((name) => name.endsWith(".jsonl"))
      : [];
    expect(files).toContain("plan.jsonl");
    for (const name of files) {
      const { lines } = splitJsonl(readFileSync(path.join(FIXTURES, name), "utf8"));
      expect(lines.length).toBeGreaterThan(0);
      expect(scanEventLines(lines, []), name).toEqual([]);
    }
  });
});
