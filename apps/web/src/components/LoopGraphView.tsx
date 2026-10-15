import { Fragment } from "react";
import {
  loopChildStatus,
  loopGraph,
  loopGraphColumns,
  type LoopChildRecord,
  type LoopExecutionSnapshot,
  type LoopGraphNode,
  type NodeStatus,
} from "@agent-deck/domain";

/**
 * A9: a loop definition (or run) as its graph: depth columns left to right like the
 * plan panel's steps, no chart library. A run passes its latest iteration's children;
 * each node shows the status the A2 tree gives that loop child (`loopChildStatus`), and a
 * node that never ran in a finished run (an evaluator skipped by a checker FAIL, nodes
 * after a stop) shows "skipped".
 */

const KIND_LABEL: Record<LoopGraphNode["kind"], string> = {
  maker: "Maker",
  checker: "Checker",
  evaluator: "Goal evaluator",
  stage: "Stage",
  branch: "Branch",
  triage: "Triage",
  human: "Human approval",
};

type GraphNodeStatus = NodeStatus | "skipped";

const STATUS_COLOR: Record<GraphNodeStatus, string> = {
  pending: "var(--color-text-muted)",
  running: "var(--color-brand-accent, var(--color-accent))",
  done: "var(--color-diff-added)",
  error: "var(--color-role-tool)",
  stopped: "var(--color-text-muted)",
  interrupted: "var(--color-warning)",
  skipped: "var(--color-text-muted)",
};

type GraphSource = Pick<
  LoopExecutionSnapshot,
  | "graph"
  | "structure"
  | "agentName"
  | "makerName"
  | "checkerName"
  | "pipelineStages"
  | "parallelBranches"
  | "triageAgent"
  | "maxIterations"
>;

export function LoopGraphView({
  loop,
  runChildren,
  finished = false,
}: {
  loop: GraphSource;
  /** The latest iteration's children of a run; absent for a definition. */
  runChildren?: readonly LoopChildRecord[];
  /** The run is terminal: a node without a child was skipped, not pending. */
  finished?: boolean;
}) {
  const graph = loopGraph(loop);
  const checked = loopGraphColumns(graph);
  if ("error" in checked) {
    return (
      <div className="text-caption text-text-secondary" data-testid="loop-graph-error">
        Graph unavailable: {checked.error}
      </div>
    );
  }
  // Stage and branch numbers follow execution order, as in the engine.
  const ordered = checked.columns.flat();
  const position = (node: LoopGraphNode) =>
    ordered.filter((other) => other.kind === node.kind).indexOf(node);
  const statusOf = (node: LoopGraphNode): GraphNodeStatus | undefined => {
    const child = runChildren
      ?.filter((candidate) => candidate.phase === node.kind)
      .find((candidate) =>
        node.kind === "stage"
          ? candidate.stageIndex === position(node)
          : node.kind === "branch"
            ? candidate.branchIndex === position(node)
            : true,
      );
    if (child) return loopChildStatus(child);
    return runChildren ? (finished ? "skipped" : "pending") : undefined;
  };
  const repeats = [
    ...new Set(
      graph.edges
        .filter((edge) => edge.budgeted)
        .map((edge) => {
          const from = graph.nodes.find((node) => node.id === edge.from)!;
          return `${KIND_LABEL[from.kind]} ${edge.when ?? "CONTINUE"}`;
        }),
    ),
  ];
  return (
    <div className="mt-2 text-detail" data-testid="loop-graph">
      <div className="flex items-center gap-2 overflow-x-auto">
        {checked.columns.map((column, depth) => (
          <Fragment key={depth}>
            {depth > 0 ? (
              <span aria-hidden className="text-text-muted">
                →
              </span>
            ) : null}
            <ol className="shrink-0 space-y-1" aria-label={`Step ${depth + 1}`}>
              {column.map((node) => {
                const status = node.kind === "human" ? undefined : statusOf(node);
                const numbered = node.kind === "stage" || node.kind === "branch";
                return (
                  <li
                    key={node.id}
                    data-testid="loop-graph-node"
                    data-node={node.id}
                    data-status={status}
                    className="rounded-lg border border-border-subtle px-2 py-1"
                  >
                    {status ? (
                      <span aria-hidden style={{ color: STATUS_COLOR[status] }}>
                        ●{" "}
                      </span>
                    ) : null}
                    <span className="text-text-primary">
                      {KIND_LABEL[node.kind]}
                      {numbered ? ` ${position(node) + 1}` : ""}
                    </span>
                    {node.agentName ? (
                      <span className="text-text-muted"> · {node.agentName}</span>
                    ) : null}
                    {status ? <span className="sr-only"> ({status})</span> : null}
                  </li>
                );
              })}
            </ol>
          </Fragment>
        ))}
      </div>
      {repeats.length ? (
        <div className="mt-1 text-caption text-text-muted" data-testid="loop-graph-repeat">
          ↻ Next iteration on {repeats.join(" or ")} ·{" "}
          {loop.maxIterations === 0 ? "no iteration limit" : `up to ${loop.maxIterations}`}
        </div>
      ) : null}
    </div>
  );
}
