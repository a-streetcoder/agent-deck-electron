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
  /**
   * The A5 dispatcher re-dispatches the item and its blocked dependants. generation and
   * runId are what the person saw: the server refuses the retry when the plan moved on.
   */
  | {
      kind: "planItem";
      key: string;
      sessionId: string;
      itemId: string;
      title?: string;
      runId?: string;
      generation?: string;
    }
  /** The existing loop retry (the run again, from its definition snapshot). */
  | { kind: "loopRun"; key: string; runId: string };

export interface FailedVerification {
  /**
   * The failed node: the run a verifier rejected, a blocked item's run (the plan node for
   * an item blocked before its run launched), a FAIL iteration.
   */
  key: string;
  reason: "rejected" | "blocked" | "checkerFail";
  /** False when nothing ran (no region to mark, nothing to restore). */
  ran: boolean;
  /** The failed work wrote to the session's checkout, so its frontier may be restored. */
  restores: boolean;
  retry: NodeRetry;
}

type PlanItem = NonNullable<ExecutionNode["planItems"]>[number];

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

/** A turn a later rollback cut off: a checkpoint taken before it was restored after it began. */
const cutOff = (tree: NodeTree, turn: ExecutionNode): boolean =>
  [...tree.nodes.values()].some(
    (node) =>
      node.sessionId === turn.sessionId &&
      node.checkpoint?.rolledBackAt !== undefined &&
      node.firstEvent < turn.firstEvent &&
      node.checkpoint.rolledBackAt > turn.firstEvent,
  );

/**
 * The failed verifications in the tree that nothing has dealt with yet, in tree order:
 *
 * - a run its verifier rejected (A7). Outside a plan it re-runs its turn, unless a later
 *   rollback cut that turn off; with no turn above it there is nothing to re-run;
 * - a blocked plan item (A5), while it is still blocked: on its run's node, or on the plan
 *   node when it was blocked before a run launched (`ran: false`);
 * - the first checker FAIL iteration of a loop run that can be retried (A9), unless a run
 *   in view is its retry (`retryOf`).
 */
export function failedVerifications(tree: NodeTree): FailedVerification[] {
  const planRuns = new Map<string, { plan: ExecutionNode; item: PlanItem }>();
  const retriedLoops = new Set<string>();
  for (const node of tree.nodes.values()) {
    if (node.loopRun?.retryOf) retriedLoops.add(node.loopRun.retryOf);
    if (node.ref.type !== "plan") continue;
    for (const item of node.planItems ?? [])
      if (item.runId) planRuns.set(item.runId, { plan: node, item });
  }
  const planRetry = (plan: ExecutionNode, item: PlanItem): NodeRetry => ({
    kind: "planItem",
    key: plan.key,
    sessionId: plan.ref.id,
    itemId: item.id,
    ...(item.title ? { title: item.title } : {}),
    ...(item.runId ? { runId: item.runId } : {}),
    ...(plan.planGeneration ? { generation: plan.planGeneration } : {}),
  });
  const out: FailedVerification[] = [];
  for (const node of tree.nodes.values()) {
    if (node.ref.type === "subagentRun" && node.subagentRun?.role !== "verify") {
      const planned = planRuns.get(node.ref.id);
      const rejected = node.subagentRun?.verdict?.decision === "REJECT";
      if (planned) {
        if (planned.item.status !== "blocked") continue;
        out.push({
          key: node.key,
          reason: rejected ? "rejected" : "blocked",
          ran: true,
          // An isolated item ran in its own worktree: the session's checkout holds nothing of it.
          restores: planned.item.isolated !== true,
          retry: planRetry(planned.plan, planned.item),
        });
      } else if (rejected) {
        let turn: ExecutionNode | undefined;
        for (let up = node.parent; up && !turn; up = tree.nodes.get(up)?.parent) {
          const candidate = tree.nodes.get(up);
          if (candidate?.ref.type === "turn") turn = candidate;
        }
        if (turn?.sessionId && !cutOff(tree, turn)) {
          out.push({
            key: node.key,
            reason: "rejected",
            ran: true,
            restores: true,
            retry: { kind: "turn", key: turn.key, sessionId: turn.sessionId },
          });
        }
      }
    } else if (node.ref.type === "plan") {
      // Blocked before any run launched (the dispatch itself failed): nothing ran.
      for (const item of node.planItems ?? []) {
        if (item.status !== "blocked" || item.runId) continue;
        // A dependant blocked by a blocked dependency runs again with that one's retry.
        const status = new Map(node.planItems!.map((other) => [other.id, other.status]));
        if ((item.dependsOn ?? []).some((id) => status.get(id) === "blocked")) continue;
        out.push({
          key: node.key,
          reason: "blocked",
          ran: false,
          restores: false,
          retry: planRetry(node, item),
        });
      }
    } else if (
      node.ref.type === "loopRun" &&
      node.loopRun &&
      canRetryLoopRun(node.loopRun) &&
      !retriedLoops.has(node.ref.id)
    ) {
      const fail = node.children.find((child) => child.loopIteration?.checkerDecision === "FAIL");
      if (fail) {
        out.push({
          key: fail.key,
          reason: "checkerFail",
          ran: true,
          // A loop runs in its own session: the open session's checkpoints are not its own.
          restores: false,
          retry: { kind: "loopRun", key: node.key, runId: node.ref.id },
        });
      }
    }
  }
  return out;
}
