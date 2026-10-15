// A10: node-level retry (VISION_ORCHESTRATION principles 2, 6, 7). Pure marking over the
// A2 tree: a failed verification splits the tree into what can be trusted and what must
// run again, and names the checkpoint to restore before it does. The server and the web
// only act on the result (rollback, plan dispatch, loop retry).
import { canRetryLoopRun } from "./loops.ts";
import { nodeKey, type ExecutionNode, type NodeTree } from "./nodeTree.ts";

export interface AffectedRegion {
  failed: string;
  /** Upstream and unaffected: ended (in log order) before the failed node began. */
  trusted: ReadonlySet<string>;
  /** The failed node, its subtree, its ancestors and everything that began after it. */
  affected: ReadonlySet<string>;
  /**
   * The recovery frontier: the last trusted node with a checkpoint, when restoring that
   * checkpoint loses no trusted work (no trusted node ended after it). Absent otherwise:
   * the region re-runs without a restore.
   */
  frontier?: { key: string; checkpointKey: string; sessionId: string; turnIndex: number };
}

/** How the affected region of a failed node runs again. */
export type NodeRetry =
  /** Roll back to the frontier, then prompt the turn's task again. */
  | { kind: "turn"; key: string; sessionId: string }
  /** The A5 dispatcher re-dispatches the item and its blocked dependants. */
  | { kind: "planItem"; key: string; sessionId: string; itemId: string }
  /** The existing loop retry (the run again, from its definition snapshot). */
  | { kind: "loopRun"; key: string; runId: string };

export interface FailedVerification {
  /** The failed node: the run a verifier rejected, a blocked item's run, a FAIL iteration. */
  key: string;
  reason: "rejected" | "blocked" | "checkerFail";
  retry: NodeRetry;
}

const ancestorsOf = (tree: NodeTree, node: ExecutionNode): Set<string> => {
  const seen = new Set<string>();
  for (let up = node.parent; up && !seen.has(up); up = tree.nodes.get(up)?.parent) seen.add(up);
  return seen;
};

/**
 * The node a checkpoint belongs to: its event's node reference, else (a log written
 * before A10) the turn it hangs under. A safety checkpoint (taken by a rollback) has
 * neither: it holds the state the rollback discarded, never a recovery point.
 */
const checkpointOwner = (tree: NodeTree, node: ExecutionNode): string | undefined => {
  const ref = node.checkpoint?.node;
  if (ref) return nodeKey(ref, node.sessionId);
  const parent = node.parent ? tree.nodes.get(node.parent) : undefined;
  return parent?.ref.type === "turn" ? parent.key : undefined;
};

/**
 * Mark the region a failed node puts in doubt. Order is the fold's (log seq), so equal
 * timestamps and clock skew never reorder anything. A parallel sibling still running when
 * the failed node began counts as affected: the marking errs towards re-running.
 */
export function affectedRegion(tree: NodeTree, failedNodeId: string): AffectedRegion | undefined {
  const failed = tree.nodes.get(failedNodeId);
  if (!failed) return undefined;
  const ancestors = ancestorsOf(tree, failed);
  const inside = new Set<string>();
  const visit = (node: ExecutionNode): void => {
    inside.add(node.key);
    node.children.forEach(visit);
  };
  visit(failed);

  const trusted = new Set<string>();
  const affected = new Set<string>();
  for (const node of tree.nodes.values()) {
    const upstream =
      !inside.has(node.key) &&
      !ancestors.has(node.key) &&
      node.endEvent !== undefined &&
      node.endEvent < failed.firstEvent;
    (upstream ? trusted : affected).add(node.key);
  }

  let best: { node: ExecutionNode; owner: string } | undefined;
  for (const key of trusted) {
    const node = tree.nodes.get(key)!;
    if (!node.checkpoint || node.removed || !node.sessionId) continue;
    const owner = checkpointOwner(tree, node);
    if (!owner || !trusted.has(owner)) continue;
    if (!best || node.endEvent! > best.node.endEvent!) best = { node, owner };
  }
  const lossless =
    best !== undefined &&
    [...trusted].every((key) => tree.nodes.get(key)!.endEvent! <= best!.node.endEvent!);
  return {
    failed: failed.key,
    trusted,
    affected,
    ...(best && lossless
      ? {
          frontier: {
            key: best.owner,
            checkpointKey: best.node.key,
            sessionId: best.node.sessionId!,
            turnIndex: best.node.checkpoint!.turnIndex,
          },
        }
      : {}),
  };
}

/**
 * The failed verifications in the tree, in tree order: a run its verifier rejected (A7),
 * a blocked plan item's run (A5), the first checker FAIL iteration of a loop run that can
 * be retried (A9). A rejected run outside a plan re-runs its turn; one with no turn above
 * it has nothing to re-run and is left out.
 */
export function failedVerifications(tree: NodeTree): FailedVerification[] {
  const planRuns = new Map<string, { sessionId: string; itemId: string; status: string }>();
  for (const node of tree.nodes.values()) {
    if (node.ref.type !== "plan") continue;
    for (const item of node.planItems ?? []) {
      if (item.runId)
        planRuns.set(item.runId, { sessionId: node.ref.id, itemId: item.id, status: item.status });
    }
  }
  const out: FailedVerification[] = [];
  for (const node of tree.nodes.values()) {
    if (node.ref.type === "subagentRun" && node.subagentRun?.role !== "verify") {
      const item = planRuns.get(node.ref.id);
      if (item) {
        if (item.status !== "blocked") continue;
        const rejected = node.subagentRun?.verdict?.decision === "REJECT";
        out.push({
          key: node.key,
          reason: rejected ? "rejected" : "blocked",
          retry: {
            kind: "planItem",
            key: node.key,
            sessionId: item.sessionId,
            itemId: item.itemId,
          },
        });
      } else if (node.subagentRun?.verdict?.decision === "REJECT") {
        let turn: ExecutionNode | undefined;
        for (let up = node.parent; up && !turn; up = tree.nodes.get(up)?.parent) {
          const candidate = tree.nodes.get(up);
          if (candidate?.ref.type === "turn") turn = candidate;
        }
        if (turn?.sessionId) {
          out.push({
            key: node.key,
            reason: "rejected",
            retry: { kind: "turn", key: turn.key, sessionId: turn.sessionId },
          });
        }
      }
    } else if (node.ref.type === "loopRun" && node.loopRun && canRetryLoopRun(node.loopRun)) {
      const fail = node.children.find((child) => child.loopIteration?.checkerDecision === "FAIL");
      if (fail) {
        out.push({
          key: fail.key,
          reason: "checkerFail",
          retry: { kind: "loopRun", key: node.key, runId: node.ref.id },
        });
      }
    }
  }
  return out;
}
