import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEventLine, splitJsonl, type EventEnvelope } from "../src/events.ts";
import {
  deckRunsFromTree,
  nodesOfType,
  projectNodeTree,
  type ExecutionNode,
  type NodeTree,
} from "../src/nodeTree.ts";

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
              [`loopChild:${uuid(11)}`, "done"],
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
    // it becomes a placeholder node under the session, the run under it.
    expect(shapes(tree)).toEqual([
      [
        `session:${uuid(2)}`,
        "running",
        [[`toolCall:call_mock_1`, "running", [[`subagentRun:${uuid(1)}`, "done"]]]],
      ],
    ]);
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
              ["toolCall:call_mock_1", "done"],
              [
                "toolCall:call_mock_2",
                "done",
                [
                  [
                    run,
                    "done",
                    [
                      [`supervisorRequest:${uuid(11)}`, "done"],
                      [`turn:${uuid(14)}`, "done", [["toolCall:call_mock_3", "done"]]],
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
    expect(turn.label).toBe("Plan and delegate");
    expect(turn.actor).toEqual({ type: "user" });
    // The child turn has no sessionId in the log; its edge to the run places it.
    expect(tree.nodes.get(`turn:${uuid(14)}`)?.actor).toMatchObject({ type: "agent" });
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

describe("projectNodeTree rules", () => {
  const base = {
    ts: "2026-01-01T00:00:00.000Z",
    actor: { type: "system" as const },
    sessionId: "s",
    payload: {},
  };

  it("a parent finishing leaves a running child running", () => {
    const tree = projectNodeTree(
      [
        {
          ...base,
          id: "p",
          kind: "turn.prompted",
          subject: { type: "turn", id: "t" },
          parent: { type: "session", id: "s" },
          payload: { mode: "prompt", label: "Go" },
        },
        {
          ...base,
          id: "c",
          kind: "subagent.run.created",
          subject: { type: "subagentRun", id: "r" },
          parent: { type: "toolCall", id: "call" },
          payload: {
            run: {
              id: "r",
              parentSessionId: "s",
              task: "x",
              status: "running",
              createdAt: base.ts,
              updatedAt: base.ts,
            },
          },
        },
        {
          ...base,
          id: "d",
          kind: "session.turn.completed",
          subject: { type: "turn", id: "t" },
          payload: {
            entryIds: ["e1"],
            toolCalls: [{ id: "call", name: "managed_subagent", isError: false }],
            label: "Go",
          },
        },
      ],
      { sessionId: "s" },
    );
    expect(tree.nodes.get("turn:t")?.status).toBe("done");
    expect(tree.nodes.get("subagentRun:r")).toMatchObject({
      status: "running",
      parent: "toolCall:call",
    });
    expect(tree.nodes.get("toolCall:call")?.parent).toBe("turn:t");
  });

  it("causation places a parentless subject; a restart interrupts open requests and turns", () => {
    const tree = projectNodeTree(
      [
        {
          ...base,
          id: "p",
          kind: "turn.prompted",
          subject: { type: "turn", id: "t" },
          parent: { type: "session", id: "s" },
          payload: { mode: "prompt" },
        },
        {
          ...base,
          id: "q",
          kind: "supervisor.request.opened",
          subject: { type: "supervisorRequest", id: "q" },
          causationId: "p",
          payload: { title: "Pick" },
        },
        {
          ...base,
          id: "x",
          kind: "server.started",
          sessionId: undefined,
          subject: { type: "server", id: "boot" },
        },
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

  it("a cycle in a corrupt log keeps every node reachable", () => {
    const tree = projectNodeTree([
      {
        ...base,
        sessionId: undefined,
        id: "1",
        kind: "x.created",
        subject: { type: "a", id: "1" },
        parent: { type: "b", id: "2" },
      },
      {
        ...base,
        sessionId: undefined,
        id: "2",
        kind: "x.created",
        subject: { type: "b", id: "2" },
        parent: { type: "a", id: "1" },
      },
    ]);
    expect(tree.nodes.size).toBe(2);
    expect(tree.roots).toHaveLength(1);
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
});
