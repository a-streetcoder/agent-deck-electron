import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionMeta } from "@agent-deck/contracts";
import {
  projectSupervisor,
  splitJsonl,
  type EventEnvelope,
  type TurnRefs,
} from "@agent-deck/domain";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createEventLog, type EventLog } from "../src/eventLog.ts";
import { createEventProducers, userActor } from "../src/eventProducers.ts";
import type { CheckpointRecord } from "../src/services/checkpoints.ts";
import { makePlanEventService } from "../src/services/planEvents.ts";
import { reportChildTurn } from "../src/services/sessionManager.ts";
import { SupervisorLog } from "../src/supervisor.ts";
import { CAPABILITY_FIELDS } from "../src/subagentRunStore.ts";
import { scanEventLines } from "./fixtures/eventScan.ts";

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
  const events = createEventProducers(log, {
    randomId: () => `id-${++n}`,
    pathPrefixes: () => [
      { prefix: dataDir, placeholder: "<dataDir>" },
      { prefix: "C:\\Users\\Alice", placeholder: "<home>" },
      { prefix: "/srv/projects/acme", placeholder: "<project>" },
    ],
  });
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

const refs = (entryIds: string[] = ["u1", "a1"]): TurnRefs => ({
  entryIds,
  toolCalls: [{ id: "c1", name: "set_session_plan", isError: false }],
  label: "Plan the work",
});

const plan = (id: string) => ({
  id,
  sessionId: "s1",
  at: "",
  kind: "created" as const,
  items: [{ id: "a", title: "Write the tests", status: "todo" as const }],
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
    expect((created!.payload as { title: string }).title).toHaveLength(80);
    expect(created!.payload).not.toHaveProperty("cwd");
    expect(removed).toMatchObject({ kind: "session.removed", actor: { type: "user" } });
  });

  it("ADR 0006: session.created carries the provenance triple, references only", () => {
    const h = harness();
    h.events.sessionCreated(
      meta({
        provenance: {
          kind: "forked",
          from: { sessionId: "source", title: "Secret title", entryId: "e1" },
          by: { user: { id: "a@b.c", name: "A" } },
          at: "2026-10-15T10:00:00.000Z",
          recap: { text: "User:\nsecret recap", truncated: false },
        },
      }),
      userActor({ id: "a@b.c" }),
      "source",
    );
    h.events.sessionCreated(
      meta({
        id: "s2",
        provenance: {
          kind: "imported",
          from: { device: "laptop", localSessionId: "local-1" },
          by: { user: { id: "a@b.c" } },
          at: "2026-10-15T10:00:00.000Z",
        },
      }),
      userActor({ id: "a@b.c" }),
    );
    const [forked, imported] = h.all();
    expect(forked!.payload).toMatchObject({
      provenance: {
        kind: "forked",
        from: { sessionId: "source" },
        by: { user: { type: "user", id: "a@b.c", name: "A" } },
        at: "2026-10-15T10:00:00.000Z",
      },
    });
    expect(JSON.stringify(forked!.payload)).not.toContain("secret");
    expect(imported!.payload).toMatchObject({
      provenance: { kind: "imported", from: { device: "laptop", localSessionId: "local-1" } },
    });
  });

  it("turn.prompted opens the turn; plan, completion and checkpoint name it as cause", () => {
    const h = harness();
    const hooks = h.events.turnHooks(meta());
    h.events.turnPrompted("s1", userActor({ id: "a@b.c" }), "prompt", "Plan the work\nsecret");
    hooks.consumed();
    h.events.planChanged("s1", "set", plan("plan-event-1"));
    const ended = hooks.end();
    hooks.completed(refs(), ended);
    h.events.checkpointCreated("s1", checkpoint(h.dataDir, 0), { turn: ended });
    const [prompted, planned, completed, created] = h.all();
    expect(prompted).toMatchObject({
      id: "id-1",
      kind: "turn.prompted",
      projectId: "project-1",
      subject: { type: "turn", id: "id-1" },
      parent: { type: "session", id: "s1" },
      actor: { type: "user", id: "a@b.c" },
      payload: { mode: "prompt", label: "Plan the work" },
    });
    expect(planned).toMatchObject({
      id: "plan-event-1",
      kind: "plan.changed",
      actor: { type: "agent", sessionId: "s1" },
      causationId: "id-1",
      payload: { kind: "created", items: [{ id: "a", title: "Write the tests", status: "todo" }] },
    });
    expect(planned!.payload).not.toHaveProperty("at");
    expect(completed).toMatchObject({
      kind: "session.turn.completed",
      subject: { type: "turn", id: "id-1" },
      causationId: "id-1",
      payload: { entryIds: ["u1", "a1"], label: "Plan the work" },
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
        hasFiles: true,
        gitRef: "refs/agent-deck/checkpoints/s1/0",
        // A10: the node the checkpoint belongs to.
        node: { type: "turn", id: "id-1" },
      },
    });
  });

  it("A5: plan.changed carries the graph fields; server-written plan events are system and caused", () => {
    const h = harness();
    h.events.planChanged("s1", "set", {
      ...plan("p-graph"),
      items: [
        {
          id: "a",
          title: "Build",
          status: "in_progress",
          assignee: "coder",
          runId: "r1",
          isolated: true,
          task: "The full prompt stays out of the log",
          note: "Rejected text stays out too",
        },
        { id: "b", title: "Ship", status: "todo", dependsOn: ["a"], verifiedBy: "reviewer" },
      ],
    });
    expect(
      h.events.planItemDispatched(
        "s1",
        { itemId: "a", runId: "r1", agentName: "coder", generation: "p-graph" },
        "finish-1",
      ),
    ).toBe(true);
    h.events.planChanged("s1", "system", plan("p-system"), undefined, "finish-1");
    expect(
      h.events.planItemVerified(
        "s1",
        { itemId: "a", runId: "v1", producerRunId: "r1", verdict: "REJECT", reason: "no tests" },
        "finish-1",
      ),
    ).toBe(true);
    const [changed, dispatched, systemChange, verified] = h.all();
    expect((changed!.payload as { items: unknown[] }).items).toEqual([
      {
        id: "a",
        title: "Build",
        status: "in_progress",
        assignee: "coder",
        isolated: true,
        runId: "r1",
      },
      { id: "b", title: "Ship", status: "todo", dependsOn: ["a"], verifiedBy: "reviewer" },
    ]);
    expect(dispatched).toMatchObject({
      kind: "plan.item.dispatched",
      sessionId: "s1",
      subject: { type: "plan", id: "s1" },
      actor: { type: "system" },
      causationId: "finish-1",
      payload: { itemId: "a", runId: "r1", agentName: "coder", generation: "p-graph" },
    });
    expect(systemChange).toMatchObject({
      kind: "plan.changed",
      actor: { type: "system" },
      causationId: "finish-1",
    });
    expect(verified).toMatchObject({
      kind: "plan.item.verified",
      actor: { type: "system" },
      causationId: "finish-1",
      payload: {
        itemId: "a",
        runId: "v1",
        producerRunId: "r1",
        verdict: "REJECT",
        reason: "no tests",
      },
    });
  });

  it("A10: plan.item.retried is the person's intent, its id the cause of what follows", () => {
    const h = harness();
    const id = h.events.planItemRetried(
      "s1",
      { itemId: "a", itemIds: ["a", "b"] },
      userActor({ id: "u1", name: "Ale" }),
    );
    expect(h.all()).toEqual([
      expect.objectContaining({
        id,
        kind: "plan.item.retried",
        subject: { type: "plan", id: "s1" },
        actor: { type: "user", id: "u1", name: "Ale" },
        payload: { itemId: "a", itemIds: ["a", "b"] },
      }),
    ]);
  });

  it("a steer joins the running turn: one turn id, one completion, caused by the steer once Pi takes it", () => {
    const h = harness();
    const hooks = h.events.turnHooks(meta());
    h.events.turnPrompted("s1", userActor(), "prompt", "Write the report");
    hooks.consumed();
    h.events.turnPrompted("s1", userActor(), "steer", "Use bullet points");
    // Queued, not yet taken by Pi: work still belongs to the prompt.
    h.events.planChanged("s1", "set", plan("p1"));
    hooks.consumed();
    h.events.planChanged("s1", "update", plan("p2"));
    hooks.completed(refs(["u1", "a1", "t1", "u2", "a2"]), hooks.end());
    const [prompt, steer, before, after, completed] = h.all();
    expect(steer).toMatchObject({ subject: { type: "turn", id: prompt!.subject.id } });
    expect(steer!.parent).toBeUndefined();
    expect(before!.causationId).toBe(prompt!.id);
    expect(after!.causationId).toBe(steer!.id);
    expect(completed).toMatchObject({
      subject: { type: "turn", id: prompt!.subject.id },
      causationId: steer!.id,
      payload: { entryIds: ["u1", "a1", "t1", "u2", "a2"], label: "Write the report" },
    });
    expect(h.all().filter((e) => e.kind === "session.turn.completed")).toHaveLength(1);
  });

  it("causation is the snapshot taken when the work started, not the latest prompt", () => {
    const h = harness();
    const hooks = h.events.turnHooks(meta());
    h.events.turnPrompted("s1", userActor(), "prompt", "first");
    hooks.consumed();
    const ended = hooks.end();
    // A new prompt lands before the first turn's async reconcile reports.
    h.events.turnPrompted("s1", userActor(), "prompt", "second");
    hooks.consumed();
    hooks.completed(refs(), ended);
    h.events.checkpointCreated("s1", checkpoint(h.dataDir, 0), { turn: ended });
    const [first, second, completed, created] = h.all();
    expect(second!.subject.id).not.toBe(first!.subject.id);
    expect(completed).toMatchObject({ subject: { id: first!.subject.id }, causationId: first!.id });
    expect(created).toMatchObject({ parent: { id: first!.subject.id }, causationId: first!.id });
  });

  it("a rejected prompt is recorded and leaves the running turn as it was", () => {
    const h = harness();
    const hooks = h.events.turnHooks(meta());
    h.events.turnPrompted("s1", userActor(), "prompt", "running");
    hooks.consumed();
    h.events.turnPrompted("s1", userActor(), "steer", "refused").rejected();
    hooks.consumed(); // a user message from elsewhere: the running turn keeps it
    h.events.planChanged("s1", "set", plan("p1"));
    hooks.completed(refs(), hooks.end());
    const [running, refused, rejected, planned, completed] = h.all();
    expect(rejected).toMatchObject({
      kind: "turn.rejected",
      subject: { id: refused!.subject.id },
      causationId: refused!.id,
    });
    expect(planned!.causationId).toBe(running!.id);
    expect(completed!.causationId).toBe(running!.id);
  });

  it("an unprompted turn is its own node, and a child turn hangs under its subagent run", () => {
    const h = harness();
    const loose = h.events.turnHooks(meta({ id: "s2", projectId: undefined }));
    loose.consumed();
    loose.completed({ ...refs(), label: "Loop step C:\\Users\\Bob\\x" }, loose.end());
    const hooks = h.events.turnHooks(meta());
    h.events.turnPrompted("s1", userActor(), "prompt", "delegate");
    hooks.consumed();
    hooks.completed(
      { entryIds: [], toolCalls: [], label: "", partial: true, outcome: "failed" },
      hooks.current(),
      {
        subagentRunId: "run-1",
        childSessionId: "child-1",
        agentName: "Researcher",
        task: "Summarize /home/bob/notes.md\nthe rest of the task",
      },
    );
    const [unprompted, prompted, child] = h.all();
    expect(unprompted).toMatchObject({
      projectId: null,
      sessionId: "s2",
      parent: { type: "session", id: "s2" },
      payload: { label: "Loop step <path>" },
    });
    expect(unprompted!.causationId).toBeUndefined();
    expect(unprompted!.payload).not.toHaveProperty("outcome");
    expect(child).toMatchObject({
      kind: "session.turn.completed",
      projectId: "project-1",
      parent: { type: "subagentRun", id: "run-1" },
      actor: { type: "agent", sessionId: "child-1", agentName: "Researcher" },
      causationId: prompted!.id,
      payload: { entryIds: [], label: "Summarize <path>", partial: true, outcome: "failed" },
    });
    expect(child!.sessionId).toBeUndefined();
  });

  it("a child whose get_entries hangs is reported partial within the bound", async () => {
    const reports: TurnRefs[] = [];
    await Effect.runPromise(reportChildTurn(Effect.never, (turn) => reports.push(turn), 20));
    expect(reports).toEqual([{ entryIds: [], toolCalls: [], label: "", partial: true }]);
  });

  it("plan history reports each recorded change once, with the store's id", () => {
    const h = harness();
    const plans = makePlanEventService({
      dataDir: h.dataDir,
      onRecorded: (event, op) => h.events.planChanged(event.sessionId, op, event),
    });
    const items = [{ id: "a", title: "One", status: "todo" as const }];
    plans.record("s1", "set", [], items);
    plans.record("s1", "update", items, items);
    plans.record("s1", "restore", [], items);
    const stored = plans.list("s1");
    expect(h.all().map((e) => [e.id, e.kind])).toEqual([[stored[0]!.id, "plan.changed"]]);
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

  it("supervisor: progress recorded, a request opened, answered by a person, cancelled once", () => {
    const h = harness();
    const supervisor = new SupervisorLog();
    h.events.supervisorOpened(
      supervisor.record({
        parentSessionId: "s1",
        cellId: "c",
        method: "progress_update",
        message: "half",
      }),
      "child-1",
    );
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
    h.events.supervisorOpened(other, "child-1");
    h.events.supervisorCancelled(supervisor.markCancelled(other.id, "The subagent ended.")!);
    expect(supervisor.markCancelled(other.id, "again")).toBeUndefined();
    expect(supervisor.markAnswered("unknown", "x")).toBeUndefined();
    // A8 human.* events are written next to these (humanNode.test.ts).
    const [progress, opened, answered, , cancelled] = h
      .all()
      .filter((event) => !event.kind.startsWith("human."));
    // The projection A1d reads agrees with SupervisorLog, progress rows included.
    expect(
      [...projectSupervisor(h.all()).values()].map((r) => [r.id, r.status, r.response]),
    ).toEqual(supervisor.list().map((r) => [r.id, r.status, r.response]));
    expect(progress).toMatchObject({
      kind: "supervisor.progress.recorded",
      payload: { status: "recorded" },
    });
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
      payload: { response: "The subagent ended." },
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

  it("free text is redacted and capped: embedded paths, known roots, token-like strings", () => {
    const h = harness();
    const token = "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123";
    h.events.turnPrompted(
      "s1",
      userActor(),
      "prompt",
      `Inspect C:\\Users\\Alice\\private and ${h.dataDir}\\events with ${token} ${"x".repeat(200)}`,
    );
    const supervisor = new SupervisorLog();
    const asked = supervisor.record({
      parentSessionId: "s1",
      cellId: "c",
      method: "need_decision",
      message: `Deploy from /srv/projects/acme/app or \\\\fileserver\\share\\keys? password=hunter2-long`,
    });
    h.events.supervisorOpened(asked, "child-1");
    h.events.supervisorAnswered(
      supervisor.markAnswered(
        asked.id,
        `Use Bearer ${"t".repeat(30)} and /home/carol/secrets/key`,
      )!,
      userActor(),
    );
    const [prompted, opened, answered] = h
      .all()
      .filter((event) => !event.kind.startsWith("human."));
    const label = (prompted!.payload as { label: string }).label;
    expect(label.startsWith("Inspect <home>\\private and <dataDir>\\events with <secret>")).toBe(
      true,
    );
    expect(label.length).toBeLessThanOrEqual(80);
    expect((opened!.payload as { message: string }).message).toBe(
      "Deploy from <project>/app or <path> password=<secret>",
    );
    expect((answered!.payload as { response: string }).response).toBe(
      "Use Bearer <secret> and <path>",
    );
    expect(scanEventLines(h.lines(), [h.dataDir, "Alice", token, "hunter2"])).toEqual([]);
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
    expect(CAPABILITY_FIELDS.has("artifactRootToken")).toBe(true);
    expect(CAPABILITY_FIELDS.size).toBeGreaterThan(10);
    expect(scanEventLines(h.lines(), [h.dataDir, "secret-project"])).toEqual([]);
    // The scan itself catches what it looks for, mid-text too.
    const leaky = h
      .lines()[0]!
      .replace(
        '"payload":{',
        `"payload":{"worktreePath":"x","note":${JSON.stringify(`see ${h.dataDir}`)},`,
      );
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
