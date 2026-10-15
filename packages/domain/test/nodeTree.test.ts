import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEventLine, splitJsonl, type EventEnvelope } from "../src/events.ts";
import {
  loopChildStatus,
  deckRunsFromTree,
  nodesOfType,
  projectNodeTree,
  type ExecutionNode,
  type NodeTree,
  type NodeTreeEvent,
} from "../src/nodeTree.ts";
import { deckRuns, emptyTranscript, type TranscriptCell } from "../src/transcript.ts";

// The A1b recorded logs (see eventDiffs.test.ts), replayed as reducer fixtures.
const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures/events");
const events = (name: string): EventEnvelope[] =>
  splitJsonl(readFileSync(path.join(FIXTURES, `${name}.jsonl`), "utf8")).lines.map(
    (line) => parseEventLine(line)!,
  );

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** The tree as nested [key, status, children] for compact whole-tree assertions. */
type Shape = [string, string, Shape[]?];
const shape = (node: ExecutionNode): Shape =>
  node.children.length
    ? [node.key, node.status, node.children.map(shape)]
    : [node.key, node.status];
const shapes = (tree: NodeTree): Shape[] => tree.roots.map(shape);

describe("projectNodeTree over the recorded logs", () => {
  it("one makerChecker loop run: run > iteration > maker, checker, evaluator", () => {
    const log = events("loop-makerChecker");
    const tree = projectNodeTree(log, { runId: uuid(1) });
    expect(shapes(tree)).toEqual([
      [
        `loopRun:${uuid(1)}`,
        "done",
        [
          [
            `loopIteration:${uuid(4)}`,
            "done",
            [
              [`loopChild:${uuid(6)}`, "done"],
              [`loopChild:${uuid(17)}`, "done"],
              [`loopChild:${uuid(22)}`, "done"],
            ],
          ],
        ],
      ],
    ]);
    const run = tree.roots[0]!;
    expect(run.loopRun).toMatchObject({ status: "completed", currentIteration: 1 });
    expect(run.label).toBe(run.loopRun!.loopName);
    expect(nodesOfType(tree, "loopChild").map((node) => node.loopChild?.phase)).toEqual([
      "maker",
      "checker",
      "evaluator",
    ]);
    for (const child of nodesOfType(tree, "loopChild")) {
      expect(child.label).not.toContain("undefined");
    }
    // The session scope reaches the same run through loop.run.started's parent edge.
    const session = projectNodeTree(log, { sessionId: uuid(2) });
    expect(session.roots[0]!.children.map((node) => node.key)).toEqual([`loopRun:${uuid(1)}`]);
    expect(session.nodes.size).toBe(6);
  });

  it("only the root completes the run; children complete independently", () => {
    const log = events("loop-makerChecker");
    const runFinished = log.findIndex((event) => event.kind === "loop.run.finished");
    const childDone = log.findLastIndex(
      (event) => event.kind === "loop.child.upserted" && event.subject.id === uuid(6),
    );
    // Mid-run: the maker finished, the run and its iteration still run.
    const mid = projectNodeTree(log.slice(0, childDone + 1), { runId: uuid(1) });
    expect(mid.nodes.get(`loopChild:${uuid(6)}`)?.status).toBe("done");
    expect(mid.nodes.get(`loopIteration:${uuid(4)}`)?.status).toBe("running");
    expect(mid.roots[0]!.status).toBe("running");
    // Just before loop.run.finished every child and the iteration are done: the run is not.
    const before = projectNodeTree(log.slice(0, runFinished), { runId: uuid(1) });
    expect(before.roots[0]!.status).toBe("running");
    expect(before.roots[0]!.endedAt).toBeUndefined();
    // A root that finishes does not rewrite a child still running.
    const early = projectNodeTree([...log.slice(0, childDone), log[runFinished]!], {
      runId: uuid(1),
    });
    expect(early.roots[0]!.status).toBe("done");
    expect(early.nodes.get(`loopChild:${uuid(6)}`)?.status).toBe("running");
  });

  it("one managed subagent run: finished, continued, finished again, pruned", () => {
    const tree = projectNodeTree(events("managed-subagent"), { sessionId: uuid(2) });
    // The parent tool call is only a reference here (no turn completed in this log):
    // a placeholder under the session, closed because its only child finished.
    const tool = `toolCall:${uuid(2)}/call_mock_1`;
    expect(shapes(tree)).toEqual([
      [`session:${uuid(2)}`, "running", [[tool, "done", [[`subagentRun:${uuid(1)}`, "done"]]]]],
    ]);
    expect(tree.nodes.get(tool)).toMatchObject({
      placeholder: true,
      label: "tool call not in view",
    });
    const run = tree.nodes.get(`subagentRun:${uuid(1)}`)!;
    expect(run.removed).toBe(true);
    expect(run.subagentRun).toMatchObject({ status: "completed" });
    expect(run.subagentRun?.summary).toBeTypeOf("string");
  });

  it("plan log: turn > tool call > subagent run > progress and the child turn; joins only", () => {
    const tree = projectNodeTree(events("plan"), { sessionId: uuid(5) });
    const run = `subagentRun:${uuid(9)}`;
    expect(shapes(tree)).toEqual([
      [
        `session:${uuid(5)}`,
        "stopped",
        [
          [
            `turn:${uuid(6)}`,
            "done",
            [
              [`plan:${uuid(5)}`, "running"],
              [`toolCall:${uuid(5)}/call_mock_1`, "done"],
              [
                `toolCall:${uuid(5)}/call_mock_2`,
                "done",
                [
                  [
                    run,
                    "done",
                    [
                      [`supervisorRequest:${uuid(11)}`, "done"],
                      // The child's tool call is keyed by the child session.
                      [`turn:${uuid(14)}`, "done", [[`toolCall:${uuid(12)}/call_mock_3`, "done"]]],
                    ],
                  ],
                ],
              ],
              [`checkpoint:${uuid(5)}/0`, "done"],
            ],
          ],
        ],
      ],
    ]);
    const turn = tree.nodes.get(`turn:${uuid(6)}`)!;
    expect(turn.entryIds).toEqual([
      "e0000005",
      "e0000006",
      "e0000007",
      "e0000008",
      "e0000009",
      "e0000010",
    ]);
    expect(turn.toolCalls?.map((call) => call.id)).toEqual(["call_mock_1", "call_mock_2"]);
    expect(turn).toMatchObject({ label: "Plan and delegate", sessionId: uuid(5) });
    expect(turn.actor).toEqual({ type: "user" });
    // The child turn has no sessionId in the log: it belongs to its agent's session.
    expect(tree.nodes.get(`turn:${uuid(14)}`)).toMatchObject({
      actor: { type: "agent" },
      sessionId: uuid(12),
    });
    expect(tree.nodes.get(run)?.removed).toBe(true);
    expect(tree.roots[0]!.removed).toBe(true);
    // A run scope is the run's own subtree.
    expect(projectNodeTree(events("plan"), { runId: uuid(9) }).nodes.size).toBe(4);
  });

  it("is deterministic and unscoped keeps every root (the server node too)", () => {
    const log = events("plan");
    expect(projectNodeTree(log)).toEqual(projectNodeTree(log));
    expect(projectNodeTree(log).roots.map((node) => node.ref.type)).toEqual(["server", "session"]);
  });
});

// Synthetic logs for the rules the recordings do not reach.
let counter = 0;
const TS = "2026-01-01T00:00:00.000Z";
function ev(
  kind: string,
  subject: [string, string],
  extra: Partial<Omit<NodeTreeEvent, "subject" | "parent">> & { parent?: [string, string] } = {},
): NodeTreeEvent {
  const { parent, ...rest } = extra;
  counter += 1;
  return {
    id: `e${counter}`,
    ts: TS,
    kind,
    sessionId: "s",
    actor: { type: "system" },
    payload: {},
    subject: { type: subject[0], id: subject[1] },
    ...(parent ? { parent: { type: parent[0], id: parent[1] } } : {}),
    ...rest,
  };
}
const prompted = (turn: string, mode = "prompt", sessionId = "s"): NodeTreeEvent =>
  ev("turn.prompted", ["turn", turn], {
    id: `prompt-${turn}-${mode}`,
    sessionId,
    ...(mode === "prompt" ? { parent: ["session", sessionId] as [string, string] } : {}),
    payload: { mode, label: "Go" },
  });
const completed = (turn: string, payload: Record<string, unknown> = {}, sessionId = "s") =>
  ev("session.turn.completed", ["turn", turn], {
    sessionId,
    payload: { entryIds: [], toolCalls: [], label: "Go", ...payload },
  });
const runEvent = (kind: string, id: string, status: string, parent?: [string, string]) =>
  ev(kind, ["subagentRun", id], {
    ...(parent ? { parent } : {}),
    payload: {
      run: { id, parentSessionId: "s", task: "x", status, createdAt: TS, updatedAt: TS },
    },
  });
const serverStarted = (): NodeTreeEvent =>
  ev("server.started", ["server", `boot-${counter}`], { sessionId: undefined });
const loopRun = (status: string, stopReason?: string) =>
  ev("loop.run.updated", ["loopRun", "L"], {
    payload: {
      run: {
        id: "L",
        loopName: "Loop",
        status,
        ...(stopReason ? { stopReason } : {}),
        currentIteration: 1,
        maxIterations: 3,
        startedAt: TS,
        updatedAt: TS,
      },
    },
  });

describe("projectNodeTree rules", () => {
  it("a parent finishing leaves a running child running", () => {
    const tree = projectNodeTree(
      [
        prompted("t"),
        runEvent("subagent.run.created", "r", "running", ["toolCall", "call"]),
        completed("t", { toolCalls: [{ id: "call", name: "managed_subagent", isError: false }] }),
      ],
      { sessionId: "s" },
    );
    expect(tree.nodes.get("turn:t")?.status).toBe("done");
    expect(tree.nodes.get("subagentRun:r")).toMatchObject({
      status: "running",
      parent: "toolCall:s/call",
    });
    expect(tree.nodes.get("toolCall:s/call")?.parent).toBe("turn:t");
  });

  it("A7: a verifier is a child of its producer; the verdict lands on the producer's run", () => {
    const verdict = { decision: "REJECT", reason: "no tests", verifierRunId: "v" };
    const verified = ev("subagent.run.verified", ["subagentRun", "p"], {
      payload: {
        run: {
          id: "p",
          parentSessionId: "s",
          task: "x",
          status: "completed",
          createdAt: TS,
          updatedAt: TS,
          verdict,
        },
        verdict: "REJECT",
      },
    });
    const tree = projectNodeTree(
      [
        runEvent("subagent.run.created", "p", "running"),
        runEvent("subagent.run.finished", "p", "completed"),
        runEvent("subagent.run.created", "v", "running", ["subagentRun", "p"]),
        runEvent("subagent.run.finished", "v", "completed"),
        verified,
      ],
      { sessionId: "s" },
    );
    expect(tree.nodes.get("subagentRun:v")?.parent).toBe("subagentRun:p");
    expect(tree.nodes.get("subagentRun:p")).toMatchObject({
      status: "done",
      subagentRun: { verdict },
    });
  });

  it("two sessions reusing a tool call id do not merge", () => {
    const tool = (id: string) => [{ id, name: "bash", isError: id === "x" }];
    const log = [
      prompted("t1", "prompt", "a"),
      completed("t1", { toolCalls: tool("call_1") }, "a"),
      prompted("t2", "prompt", "b"),
      completed("t2", { toolCalls: tool("call_1") }, "b"),
    ];
    const a = projectNodeTree(log, { sessionId: "a" });
    const b = projectNodeTree(log, { sessionId: "b" });
    expect(a.nodes.get("toolCall:a/call_1")).toMatchObject({ parent: "turn:t1", sessionId: "a" });
    expect(b.nodes.get("toolCall:b/call_1")).toMatchObject({ parent: "turn:t2", sessionId: "b" });
    expect(a.nodes.has("toolCall:b/call_1")).toBe(false);
  });

  it("causation places a parentless subject; a restart interrupts open requests and turns", () => {
    const tree = projectNodeTree(
      [
        prompted("t"),
        ev("supervisor.request.opened", ["supervisorRequest", "q"], {
          causationId: "prompt-t-prompt",
          payload: { title: "Pick" },
        }),
        serverStarted(),
      ],
      { sessionId: "s" },
    );
    expect(tree.nodes.get("supervisorRequest:q")).toMatchObject({
      parent: "turn:t",
      status: "interrupted",
      label: "Pick",
    });
    expect(tree.nodes.get("turn:t")?.status).toBe("interrupted");
  });

  it("a filtered log without server.started keeps a dead turn running; with it, interrupted", () => {
    // What GET /events?projectId= returns without includeServerEvents, then with it.
    const withoutMarkers = [prompted("t"), ev("plan.changed", ["plan", "s"])];
    expect(projectNodeTree(withoutMarkers, { sessionId: "s" }).nodes.get("turn:t")?.status).toBe(
      "running",
    );
    const withMarkers = [...withoutMarkers, serverStarted()];
    expect(projectNodeTree(withMarkers, { sessionId: "s" }).nodes.get("turn:t")).toMatchObject({
      status: "interrupted",
      endedAt: TS,
    });
  });

  it("a turn that never completes stays running; outcomes map to done, error, stopped", () => {
    const tree = projectNodeTree(
      [
        prompted("open"),
        prompted("ok"),
        completed("ok", { outcome: "completed" }),
        prompted("bad"),
        completed("bad", { outcome: "failed" }),
        prompted("stop"),
        completed("stop", { outcome: "cancelled" }),
        prompted("old"),
        completed("old"),
      ],
      { sessionId: "s" },
    );
    const status = (id: string) => tree.nodes.get(`turn:${id}`)?.status;
    expect([status("open"), status("ok"), status("bad"), status("stop"), status("old")]).toEqual([
      "running",
      "done",
      "error",
      "stopped",
      "done",
    ]);
  });

  it("a steer joins its turn; a rejected steer leaves it running, a rejected prompt fails", () => {
    const tree = projectNodeTree(
      [
        prompted("t"),
        prompted("t", "steer"),
        ev("turn.rejected", ["turn", "t"], { payload: { mode: "steer" } }),
        prompted("r"),
        ev("turn.rejected", ["turn", "r"], { payload: { mode: "prompt" } }),
      ],
      { sessionId: "s" },
    );
    expect(tree.roots[0]!.children.map((node) => [node.key, node.status])).toEqual([
      ["turn:t", "running"],
      ["turn:r", "error"],
    ]);
  });

  it("a cancelled request stops; an answered one stays answered when cancelled late", () => {
    const tree = projectNodeTree(
      [
        ev("supervisor.request.opened", ["supervisorRequest", "a"]),
        ev("supervisor.request.cancelled", ["supervisorRequest", "a"]),
        ev("supervisor.request.opened", ["supervisorRequest", "b"]),
        ev("supervisor.request.answered", ["supervisorRequest", "b"]),
        ev("supervisor.request.cancelled", ["supervisorRequest", "b"]),
      ],
      { sessionId: "s" },
    );
    expect(tree.nodes.get("supervisorRequest:a")?.status).toBe("stopped");
    expect(tree.nodes.get("supervisorRequest:b")?.status).toBe("done");
  });

  it("loop statuses: humanInputRequired waits, notAchieved fails", () => {
    const status = (event: NodeTreeEvent) =>
      projectNodeTree([event], { runId: "L" }).roots[0]?.status;
    expect(status(loopRun("stopped", "humanInputRequired"))).toBe("pending");
    expect(status(loopRun("stopped", "userStopped"))).toBe("stopped");
    expect(status(loopRun("notAchieved", "maxIterationsReached"))).toBe("error");
  });

  it("a legacy loop child without status is inferred from endedAt and error", () => {
    const child = (id: string, fields: Record<string, unknown>) =>
      ev("loop.child.upserted", ["loopChild", id], {
        parent: ["loopIteration", "I"],
        payload: { runId: "L", iterationId: "I", child: { id, phase: "maker", ...fields } },
      });
    const tree = projectNodeTree([
      child("queued", {}),
      child("started", { startedAt: TS }),
      child("ended", { startedAt: TS, endedAt: TS, agentName: "Builder" }),
      child("failed", { startedAt: TS, endedAt: TS, error: "boom" }),
    ]);
    const node = (id: string) => tree.nodes.get(`loopChild:${id}`)!;
    expect(["queued", "started", "ended", "failed"].map((id) => node(id).status)).toEqual([
      "pending",
      "running",
      "done",
      "error",
    ]);
    expect(node("queued").label).toBe("maker");
    expect(node("ended").label).toBe("maker: Builder");
  });

  it("a fork is its own root and a link row on its source, not a nested session", () => {
    const log = [
      ev("session.created", ["session", "s"], { payload: { title: "Source" } }),
      runEvent("subagent.run.created", "r", "running"),
      ev("session.created", ["session", "f"], {
        sessionId: "f",
        parent: ["session", "s"],
        payload: { title: "Fork" },
      }),
      ev("subagent.run.created", ["subagentRun", "fr"], {
        sessionId: "f",
        payload: {
          run: { id: "fr", parentSessionId: "f", task: "y", status: "running" },
        },
      }),
    ];
    const source = projectNodeTree(log, { sessionId: "s" });
    expect(source.roots[0]!.forks).toEqual([{ sessionId: "f", label: "Fork" }]);
    expect(nodesOfType(source, "session")).toHaveLength(1);
    expect(deckRunsFromTree(source).map((run) => run.id)).toEqual(["r"]);
    const fork = projectNodeTree(log, { sessionId: "f" });
    expect(fork.roots[0]!.forkedFrom).toBe("s");
    expect(fork.roots[0]!.parent).toBeUndefined();
    expect(deckRunsFromTree(fork).map((run) => run.id)).toEqual(["fr"]);
  });

  it("placeholders close with a finished root or a later restart", () => {
    // A run whose own events are out of view: its request references it.
    const request = ev("supervisor.request.opened", ["supervisorRequest", "q"], {
      parent: ["subagentRun", "gone"],
    });
    const restarted = projectNodeTree([request, serverStarted()], { sessionId: "s" });
    expect(restarted.nodes.get("subagentRun:gone")).toMatchObject({
      placeholder: true,
      label: "run not in view",
      status: "interrupted",
    });
    const closed = projectNodeTree([request, ev("session.removed", ["session", "s"])], {
      sessionId: "s",
    });
    expect(closed.nodes.get("subagentRun:gone")?.status).toBe("done");
    const open = projectNodeTree([request], { sessionId: "s" });
    expect(open.nodes.get("subagentRun:gone")?.status).toBe("running");
  });

  it("a cycle detaches only the nodes inside it", () => {
    const tree = projectNodeTree([
      ev("x.created", ["a", "1"], { sessionId: undefined, parent: ["b", "2"] }),
      ev("x.created", ["b", "2"], { sessionId: undefined, parent: ["a", "1"] }),
      ev("x.created", ["c", "3"], { sessionId: undefined, parent: ["a", "1"] }),
    ]);
    expect(tree.nodes.size).toBe(3);
    expect(tree.roots.map((node) => node.key)).toEqual(["a:1"]);
    expect(tree.nodes.get("c:3")?.parent).toBe("a:1");
  });
});

describe("deckRunsFromTree", () => {
  it("one row per subagent run with its progress count and open requests", () => {
    const tree = projectNodeTree(events("plan"), { sessionId: uuid(5) });
    expect(deckRunsFromTree(tree)).toEqual([
      expect.objectContaining({
        id: uuid(9),
        task: "Summarize the notes.",
        status: "done",
        progressCount: 1,
        needsInput: false,
        model: "mock-model",
        durationMs: 1000,
      }),
    ]);
  });

  it("side by side with deckRuns(transcript) for the same recorded run", () => {
    // The transcript the plan run leaves in the parent session (hand-built from the
    // same run: no recorded transcript exists yet): its subagent card and the progress.
    const cells: TranscriptCell[] = [
      {
        kind: "subagent",
        id: uuid(9),
        task: "Summarize the notes.",
        status: "done",
        text: "Child summary: done.",
        progress: ["halfway"],
        model: "mock-model",
        inputTokens: 1,
        outputTokens: 3,
        durationMs: 1000,
      },
    ];
    const fromTranscript = deckRuns({ ...emptyTranscript(), cells });
    const fromTree = deckRunsFromTree(projectNodeTree(events("plan"), { sessionId: uuid(5) }));
    // The measured gap: none for a run that both sources hold in full.
    expect(fromTree).toEqual(fromTranscript);
    // A tree read that misses the run's own events (the web's moving tail) loses the row.
    const tail = events("plan").filter((event) => !event.kind.startsWith("subagent.run."));
    expect(deckRunsFromTree(projectNodeTree(tail, { sessionId: uuid(5) }))).toEqual([]);
  });
});

describe("loopChildStatus (shared with the Loops graph view)", () => {
  it("maps known statuses, falls back to running, and infers legacy records", () => {
    expect(loopChildStatus({ status: "queued" })).toBe("pending");
    expect(loopChildStatus({ status: "completed" })).toBe("done");
    expect(loopChildStatus({ status: "paused" as never })).toBe("running");
    expect(loopChildStatus({ error: "boom" })).toBe("error");
    expect(loopChildStatus({ endedAt: "t" })).toBe("done");
    expect(loopChildStatus({ startedAt: "t" })).toBe("running");
    expect(loopChildStatus({})).toBe("pending");
  });
});
