// A2: the execution-node tree, a pure projection of the event log (VISION_ORCHESTRATION
// principles 1, 2, 7). One structure for the timeline, the deck and the loop views.
// The tree holds facts and references only: a turn carries its Pi entry ids and tool
// call refs, and the web JOINS them with the transcript cells (user cells by entryId,
// tool cells by toolCallId); message, reasoning and tool content never come from here.
//
// Completion: a node's status comes from the latest event about its own subject. Only
// the root's events complete the run; a parent finishing never changes a child, and a
// child finishing never changes its parent.
import type { EventActor, StoredNodeRef } from "./events.ts";
import type {
  PublicLoopChild,
  PublicLoopIterationSummary,
  PublicLoopRunSummary,
  PublicSubagentRun,
  RunResult,
} from "./eventDiffs.ts";
import type { DeckRun } from "./transcript.ts";
import type { TurnToolCallRef } from "./turnRefs.ts";

export type NodeStatus = "pending" | "running" | "done" | "error" | "stopped" | "interrupted";

export interface ExecutionNode {
  /** `${type}:${id}`, unique in the tree. */
  key: string;
  ref: StoredNodeRef;
  /** The parent's key; absent on a root. */
  parent?: string;
  children: ExecutionNode[];
  status: NodeStatus;
  /** Short human label (turn label, task head, loop name, tool name). */
  label: string;
  /** Who opened the node (its first event's actor). */
  actor: EventActor;
  sessionId?: string;
  startedAt: string;
  updatedAt: string;
  /** The ts of the event that made the status terminal. */
  endedAt?: string;
  /** The store pruned the record (subagent.run.removed, session.removed, ...); history stays. */
  removed?: true;
  /** turn: references into the transcript, joined by the web. */
  entryIds?: string[];
  toolCalls?: TurnToolCallRef[];
  /** turn: the entries could not be read in time. */
  partial?: true;
  /** supervisorRequest: a progress_update (recorded, never a question). */
  progress?: true;
  /** toolCall: from the turn's ref. */
  isError?: boolean;
  /** subagentRun: the latest public run (with the result's summary and error). */
  subagentRun?: PublicSubagentRun;
  /** loopRun: the latest public run summary. */
  loopRun?: PublicLoopRunSummary;
  loopIteration?: PublicLoopIterationSummary;
  loopChild?: PublicLoopChild;
}

export interface NodeTree {
  roots: ExecutionNode[];
  nodes: Map<string, ExecutionNode>;
}

/** What the reducer reads from an envelope (EventEnvelope is a superset). */
export interface NodeTreeEvent {
  id: string;
  ts: string;
  kind: string;
  sessionId?: string;
  subject: StoredNodeRef;
  parent?: StoredNodeRef;
  causationId?: string;
  actor: EventActor;
  payload: unknown;
}

/** Scope the result to one session's subtree, or one loop or subagent run's subtree. */
export type NodeTreeScope = { sessionId?: string; runId?: string };

export const nodeKey = (ref: StoredNodeRef): string => `${ref.type}:${ref.id}`;

const TERMINAL: ReadonlySet<NodeStatus> = new Set(["done", "error", "stopped", "interrupted"]);

const SUBAGENT_STATUS: Record<string, NodeStatus> = {
  starting: "pending",
  running: "running",
  completed: "done",
  failed: "error",
  stopped: "stopped",
  interrupted: "interrupted",
};

const LOOP_STATUS: Record<string, NodeStatus> = {
  running: "running",
  stopping: "running",
  completed: "done",
  failed: "error",
  notAchieved: "error",
  stopped: "stopped",
  interrupted: "interrupted",
};

const CHILD_STATUS: Record<string, NodeStatus> = {
  queued: "pending",
  running: "running",
  completed: "done",
  failed: "error",
  stopped: "stopped",
};

interface Draft extends ExecutionNode {
  order: number;
  /** Parent from an explicit `parent` ref (first wins), from causation, from the session. */
  explicitParent?: string;
  causeParent?: string;
  sessionParent?: string;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * Fold events (ascending by seq) into the execution-node tree. Kinds and node types
 * this build does not know still make nodes (status "running" until a known kind says
 * otherwise), so a newer writer's log stays readable. Deterministic: the same events
 * give the same tree, children ordered by their first event.
 */
export function projectNodeTree(
  events: Iterable<NodeTreeEvent>,
  scope: NodeTreeScope = {},
): NodeTree {
  const drafts = new Map<string, Draft>();
  // Event id -> the subject it was about: a causationId points at an event.
  const subjectOfEvent = new Map<string, string>();
  let order = 0;

  const touch = (ref: StoredNodeRef, event: NodeTreeEvent): Draft => {
    const key = nodeKey(ref);
    let node = drafts.get(key);
    if (!node) {
      node = {
        key,
        ref: { type: ref.type, id: ref.id },
        children: [],
        status: "running",
        label: ref.type,
        actor: event.actor,
        startedAt: event.ts,
        updatedAt: event.ts,
        order: order++,
      };
      drafts.set(key, node);
    }
    node.updatedAt = event.ts;
    return node;
  };
  const setStatus = (node: Draft, status: NodeStatus, ts: string): void => {
    node.status = status;
    if (TERMINAL.has(status)) node.endedAt = ts;
    else delete node.endedAt;
  };
  const sessionNode = (sessionId: string, event: NodeTreeEvent): Draft => {
    const key = nodeKey({ type: "session", id: sessionId });
    return drafts.get(key) ?? touch({ type: "session", id: sessionId }, event);
  };

  for (const event of events) {
    const node = touch(event.subject, event);
    subjectOfEvent.set(event.id, node.key);
    if (event.parent && !node.explicitParent) node.explicitParent = nodeKey(event.parent);
    if (event.causationId && !node.causeParent) {
      const cause = subjectOfEvent.get(event.causationId);
      if (cause && cause !== node.key) node.causeParent = cause;
    }
    if (event.sessionId) {
      node.sessionId ??= event.sessionId;
      if (node.ref.type !== "session") {
        node.sessionParent ??= sessionNode(event.sessionId, event).key;
      }
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const ts = event.ts;

    switch (event.kind) {
      case "server.started":
        node.label = "Server started";
        // The restart rule: memory-only work open at a restart never completes.
        for (const other of drafts.values()) {
          if (other.ref.type === "supervisorRequest" && other.status === "pending") {
            setStatus(other, "interrupted", ts);
          } else if (other.ref.type === "turn" && other.status === "running") {
            setStatus(other, "interrupted", ts);
          }
        }
        break;
      case "session.created":
        node.label = str(payload.title) ?? "Session";
        setStatus(node, "running", ts);
        break;
      case "session.removed":
        node.removed = true;
        setStatus(node, "stopped", ts);
        break;
      case "turn.prompted":
        if (node.label === "turn") node.label = str(payload.label) ?? "Turn";
        setStatus(node, "running", ts);
        break;
      case "turn.rejected":
        // A rejected steer leaves the turn it joined running; a rejected prompt never ran.
        if (payload.mode === "prompt") setStatus(node, "error", ts);
        break;
      case "session.turn.completed": {
        node.label = str(payload.label) ?? node.label;
        node.entryIds = Array.isArray(payload.entryIds)
          ? payload.entryIds.filter((id): id is string => typeof id === "string")
          : [];
        node.toolCalls = Array.isArray(payload.toolCalls)
          ? (payload.toolCalls as TurnToolCallRef[]).filter(
              (call) => call && typeof call.id === "string",
            )
          : [];
        if (payload.partial === true) node.partial = true;
        setStatus(node, "done", ts);
        for (const call of node.toolCalls) {
          const tool = touch({ type: "toolCall", id: call.id }, event);
          tool.label = call.name || "tool";
          tool.isError = call.isError === true;
          tool.explicitParent ??= node.key;
          if (node.sessionId) tool.sessionId ??= node.sessionId;
          setStatus(tool, call.isError ? "error" : "done", ts);
        }
        break;
      }
      case "plan.changed": {
        node.label = "Plan";
        const items = Array.isArray(payload.items) ? (payload.items as { status?: unknown }[]) : [];
        const open = items.some((item) => item.status !== "done" && item.status !== "skipped");
        setStatus(node, open ? "running" : "done", ts);
        break;
      }
      case "checkpoint.created":
      case "checkpoint.rolledBack":
        node.label = str(payload.label) ?? "Checkpoint";
        setStatus(node, "done", ts);
        break;
      case "supervisor.progress.recorded":
        node.label = str(payload.message) ?? "Progress";
        node.progress = true;
        setStatus(node, "done", ts);
        break;
      case "supervisor.request.opened":
        node.label = str(payload.title) ?? str(payload.method) ?? "Request";
        setStatus(node, "pending", ts);
        break;
      case "supervisor.request.answered":
        setStatus(node, "done", ts);
        break;
      case "supervisor.request.cancelled":
        if (node.status !== "done") setStatus(node, "stopped", ts);
        break;
      case "subagent.run.created":
      case "subagent.run.updated":
      case "subagent.run.finished": {
        const run = payload.run as PublicSubagentRun | undefined;
        if (!run) break;
        const result = payload.result as RunResult | undefined;
        node.subagentRun = {
          ...run,
          ...(result?.summary !== undefined ? { summary: result.summary } : {}),
          ...(result?.summaryBytes !== undefined ? { summaryBytes: result.summaryBytes } : {}),
          ...(result?.error !== undefined ? { error: result.error } : {}),
        };
        node.label = run.agent ? `${run.agent}: ${run.task}` : run.task;
        setStatus(node, SUBAGENT_STATUS[run.status] ?? "running", ts);
        break;
      }
      case "loop.run.started":
      case "loop.run.updated":
      case "loop.run.finished": {
        const run = payload.run as PublicLoopRunSummary | undefined;
        if (!run) break;
        node.loopRun = run;
        node.label = run.loopName;
        setStatus(node, LOOP_STATUS[run.status] ?? "running", ts);
        break;
      }
      case "loop.iteration.started":
      case "loop.iteration.updated": {
        const iteration = payload.iteration as PublicLoopIterationSummary | undefined;
        if (!iteration) break;
        node.loopIteration = iteration;
        node.label = `Iteration ${iteration.index}`;
        setStatus(node, iteration.endedAt ? "done" : "running", ts);
        break;
      }
      case "loop.child.upserted": {
        const child = payload.child as PublicLoopChild | undefined;
        if (!child) break;
        node.loopChild = child;
        node.label = `${child.phase}: ${child.agentName}`;
        setStatus(node, CHILD_STATUS[child.status ?? "queued"] ?? "running", ts);
        break;
      }
      case "subagent.run.removed":
      case "loop.run.removed":
        node.removed = true;
        break;
      // loop.timeline / loop.artifact / loop.review / loop.run.userAction: facts on an
      // existing node that the detail panes read from the stores; no status change.
    }
  }

  // Link: explicit parent, else the cause's subject, else the session. A parent that
  // only exists as a reference (a toolCall no completed turn listed yet) becomes a
  // node of its own under the session, so nothing is lost while the turn runs.
  for (const node of [...drafts.values()]) {
    const target = node.explicitParent ?? node.causeParent ?? node.sessionParent;
    if (!target || target === node.key) continue;
    if (!drafts.has(target)) {
      const [type, ...rest] = target.split(":");
      const placeholder: Draft = {
        key: target,
        ref: { type: type!, id: rest.join(":") },
        children: [],
        status: "running",
        label: type!,
        actor: node.actor,
        startedAt: node.startedAt,
        updatedAt: node.startedAt,
        order: node.order - 0.5,
        ...(node.sessionParent && target !== node.sessionParent
          ? { sessionParent: node.sessionParent, sessionId: node.sessionId }
          : {}),
      };
      drafts.set(target, placeholder);
      const up = placeholder.sessionParent;
      if (up && up !== target) placeholder.parent = up;
    }
    node.parent = target;
  }
  // A cycle (a corrupt or hand-edited log) would hide nodes: its entry point becomes a root.
  for (const node of drafts.values()) {
    const seen = new Set([node.key]);
    for (let up = node.parent; up; up = drafts.get(up)?.parent) {
      if (seen.has(up)) {
        delete node.parent;
        break;
      }
      seen.add(up);
    }
  }

  const sorted = [...drafts.values()].sort((a, b) => a.order - b.order);
  const roots: ExecutionNode[] = [];
  for (const node of sorted) {
    const parent = node.parent ? drafts.get(node.parent) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  for (const node of sorted) {
    delete (node as Partial<Draft>).order;
    delete (node as Partial<Draft>).explicitParent;
    delete (node as Partial<Draft>).causeParent;
    delete (node as Partial<Draft>).sessionParent;
  }

  const rootKey = scope.runId
    ? [`loopRun:${scope.runId}`, `subagentRun:${scope.runId}`].find((key) => drafts.has(key))
    : scope.sessionId
      ? `session:${scope.sessionId}`
      : undefined;
  const scoped = scope.runId !== undefined || scope.sessionId !== undefined;
  const root = rootKey ? drafts.get(rootKey) : undefined;
  const shown = scoped ? (root ? [root] : []) : roots;
  const nodes = new Map<string, ExecutionNode>();
  const visit = (node: ExecutionNode): void => {
    nodes.set(node.key, node);
    node.children.forEach(visit);
  };
  shown.forEach(visit);
  return { roots: shown, nodes };
}

/** Every node of a type in the tree, depth first. */
export function nodesOfType(tree: NodeTree, type: string): ExecutionNode[] {
  return [...tree.nodes.values()].filter((node) => node.ref.type === type);
}

const DECK_STATUS: Record<string, DeckRun["status"]> = {
  starting: "running",
  running: "running",
  completed: "done",
  failed: "error",
  stopped: "stopped",
  interrupted: "interrupted",
};

/**
 * The deck rows from the tree: one per subagentRun node (pruned ones too, as the
 * transcript keeps their cards), with progress and open requests from its
 * supervisorRequest children. The expanded detail still reads the transcript cell.
 */
export function deckRunsFromTree(tree: NodeTree): DeckRun[] {
  return nodesOfType(tree, "subagentRun").flatMap((node) => {
    const run = node.subagentRun;
    if (!run) return [];
    const requests = node.children.filter((child) => child.ref.type === "supervisorRequest");
    return [
      {
        id: run.id,
        task: run.task,
        status: DECK_STATUS[run.status] ?? "running",
        progressCount: requests.filter((child) => child.progress).length,
        needsInput: requests.some((child) => child.status === "pending"),
        model: run.model,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        durationMs: run.durationMs,
        error: run.error,
      },
    ];
  });
}
