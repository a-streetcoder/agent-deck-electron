// A2: the execution-node tree, a pure projection of the event log (VISION_ORCHESTRATION
// principles 1, 2, 7). One structure for the timeline, the deck and the loop views.
// The tree holds facts and references only: a turn carries its Pi entry ids and tool
// call refs, and the web JOINS them with the transcript cells of the same session
// (user cells by entryId, tool cells by toolCallId, assistant cells by position);
// message, reasoning and tool content never come from here. Tool call ids are only
// unique inside a session, so toolCall keys carry the session: `toolCall:<session>/<id>`.
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
import { SUBAGENT_RESULT_READ } from "./subagentDelta.ts";
import type { DeckRun } from "./transcript.ts";
import { eventLabel, type TurnToolCallRef } from "./turnRefs.ts";

export type NodeStatus = "pending" | "running" | "done" | "error" | "stopped" | "interrupted";

export interface ExecutionNode {
  /** `${type}:${id}` (toolCall: `toolCall:${sessionId}/${id}`), unique in the tree. */
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
  /** The session the node belongs to: the event's sessionId, else its agent actor's. */
  sessionId?: string;
  startedAt: string;
  updatedAt: string;
  /** The ts of the event that made the status terminal. */
  endedAt?: string;
  /** The store pruned the record (subagent.run.removed, session.removed, ...); history stays. */
  removed?: true;
  /** Only referenced (as a parent) by the events in view; its own events are not. */
  placeholder?: true;
  /** session: forked from this session (the fork is its own root, never a child). */
  forkedFrom?: string;
  /** session: the sessions forked from this one, for "forked to" link rows. */
  forks?: { sessionId: string; label: string }[];
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
  /** human (A8): the request, and its answer or expiry once settled. */
  human?: HumanNodeFacts;
}

/** What the tree keeps of a human node: the request and how it settled. */
export interface HumanNodeFacts {
  kind?: string;
  prompt?: string;
  options?: string[];
  expiresAt?: string;
  /** Who answered (any member on the shared server). */
  by?: EventActor;
  answer?: string;
  /** The timeout policy fired: "default" answered with the default, "blocked" did not. */
  expired?: "default" | "blocked";
  /** Closed without an answer. */
  cancelledReason?: string;
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

/** A node's key; tool call ids are qualified by their session. */
export const nodeKey = (ref: StoredNodeRef, sessionId?: string): string =>
  ref.type === "toolCall" && sessionId
    ? `toolCall:${sessionId}/${ref.id}`
    : `${ref.type}:${ref.id}`;

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

const TURN_OUTCOME: Record<string, NodeStatus> = {
  completed: "done",
  failed: "error",
  cancelled: "stopped",
};

const PLACEHOLDER_LABEL: Record<string, string> = {
  subagentRun: "run not in view",
  toolCall: "tool call not in view",
  turn: "turn not in view",
  session: "session not in view",
};

/** A legacy child record has no status: infer it from its timestamps and error. */
function childStatus(child: PublicLoopChild): NodeStatus {
  if (child.status) return CHILD_STATUS[child.status] ?? "running";
  if (child.error) return "error";
  if (child.endedAt) return "done";
  return child.startedAt ? "running" : "pending";
}

interface ParentRef {
  key: string;
  ref: StoredNodeRef;
  sessionId?: string;
}

interface Draft extends ExecutionNode {
  order: number;
  /** Parent from an explicit `parent` ref (first wins), from causation, from the session. */
  explicitParent?: ParentRef;
  causeParent?: string;
  sessionParent?: string;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

const sessionOf = (event: NodeTreeEvent): string | undefined =>
  event.sessionId ?? (event.actor.type === "agent" ? event.actor.sessionId : undefined);

/**
 * Fold events (ascending by seq) into the execution-node tree. Kinds and node types
 * this build does not know still make nodes (status "running" until a known kind says
 * otherwise), so a newer writer's log stays readable. Deterministic: the same events
 * give the same tree, children ordered by their first event.
 *
 * Restart rule: server.started interrupts open supervisor requests, running turns and
 * running placeholders (memory-only work never completes after a restart). A reader of
 * a filtered log must include server.started (GET /events?sessionId= does).
 */
export function projectNodeTree(
  events: Iterable<NodeTreeEvent>,
  scope: NodeTreeScope = {},
): NodeTree {
  const drafts = new Map<string, Draft>();
  // Event id -> the subject it was about: a causationId points at an event.
  const subjectOfEvent = new Map<string, string>();
  // The node order at each server.started: placeholders older than one are interrupted.
  const restarts: { order: number; ts: string }[] = [];
  let order = 0;

  const touch = (ref: StoredNodeRef, event: NodeTreeEvent, sessionId?: string): Draft => {
    const key = nodeKey(ref, sessionId);
    let node = drafts.get(key);
    if (!node) {
      node = {
        key,
        ref: { type: ref.type, id: ref.id },
        children: [],
        status: "running",
        label: ref.type,
        actor: event.actor,
        ...(sessionId ? { sessionId } : {}),
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
  const sessionNode = (sessionId: string, event: NodeTreeEvent): Draft =>
    drafts.get(nodeKey({ type: "session", id: sessionId })) ??
    touch({ type: "session", id: sessionId }, event, sessionId);

  for (const event of events) {
    // A parent's read cursor (A3) is not a step of the run: no node, no updatedAt bump.
    if (event.kind === SUBAGENT_RESULT_READ) continue;
    const session = sessionOf(event);
    const node = touch(event.subject, event, session);
    node.sessionId ??= session;
    subjectOfEvent.set(event.id, node.key);
    const parent = event.parent;
    if (event.kind === "session.created" && parent?.type === "session") {
      // A fork is a session of its own: a link row on the source, never its child.
      node.forkedFrom ??= parent.id;
    } else if (parent && !node.explicitParent) {
      node.explicitParent = {
        key: nodeKey(parent, session),
        ref: parent,
        ...(session ? { sessionId: session } : {}),
      };
    }
    if (event.causationId && !node.causeParent) {
      const cause = subjectOfEvent.get(event.causationId);
      if (cause && cause !== node.key) node.causeParent = cause;
    }
    if (event.sessionId && node.ref.type !== "session") {
      node.sessionParent ??= sessionNode(event.sessionId, event).key;
    }
    const payload = (event.payload ?? {}) as Record<string, unknown>;
    const ts = event.ts;

    switch (event.kind) {
      case "server.started":
        node.label = "Server started";
        restarts.push({ order: node.order, ts });
        // The restart rule: memory-only work open at a restart never completes.
        for (const other of drafts.values()) {
          if (other.ref.type === "supervisorRequest" && other.status === "pending") {
            setStatus(other, "interrupted", ts);
          } else if (other.ref.type === "turn" && other.status === "running") {
            setStatus(other, "interrupted", ts);
          } else if (
            other.ref.type === "human" &&
            other.status === "pending" &&
            other.human?.kind !== "loopApproval"
          ) {
            // A loop checkpoint is durable; every other wait died with the process.
            setStatus(other, "interrupted", ts);
          }
        }
        break;
      case "writer.acquired":
        // A8: a writer takeover; the previous writer's waits died with it (as the
        // supervisor projection already reads it). Its turns are left as they are.
        node.label = "Writer acquired";
        for (const other of drafts.values()) {
          if (other.status !== "pending") continue;
          if (
            other.ref.type === "supervisorRequest" ||
            (other.ref.type === "human" && other.human?.kind !== "loopApproval")
          ) {
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
        setStatus(node, TURN_OUTCOME[String(payload.outcome)] ?? "done", ts);
        for (const call of node.toolCalls) {
          const tool = touch({ type: "toolCall", id: call.id }, event, node.sessionId);
          tool.label = call.name || "tool";
          tool.isError = call.isError === true;
          tool.explicitParent ??= { key: node.key, ref: node.ref };
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
        // A Human Approval pause is stopped/humanInputRequired: it waits on a person.
        const paused = run.status === "stopped" && run.stopReason === "humanInputRequired";
        setStatus(node, paused ? "pending" : (LOOP_STATUS[run.status] ?? "running"), ts);
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
        node.label = child.agentName ? `${child.phase}: ${child.agentName}` : child.phase;
        setStatus(node, childStatus(child), ts);
        break;
      }
      case "human.requested": {
        const prompt = str(payload.prompt);
        node.human = {
          ...(str(payload.kind) ? { kind: str(payload.kind) } : {}),
          ...(prompt ? { prompt } : {}),
          ...(Array.isArray(payload.options)
            ? { options: payload.options.filter((o): o is string => typeof o === "string") }
            : {}),
          ...(str(payload.expiresAt) ? { expiresAt: str(payload.expiresAt) } : {}),
        };
        node.label = (prompt && eventLabel(prompt)) || "Waiting on a person";
        setStatus(node, "pending", ts);
        break;
      }
      case "human.answered":
        // The first settlement wins: a late duplicate never rewrites who answered.
        if (node.status !== "pending" && node.status !== "running") break;
        node.human = {
          ...node.human,
          by: (payload.by as EventActor | undefined) ?? event.actor,
          ...(typeof payload.answer === "string" ? { answer: payload.answer } : {}),
        };
        setStatus(node, "done", ts);
        break;
      case "human.expired": {
        if (node.status !== "pending" && node.status !== "running") break;
        const usedDefault = payload.then === "default";
        node.human = {
          ...node.human,
          expired: usedDefault ? "default" : "blocked",
          ...(usedDefault && typeof payload.answer === "string" ? { answer: payload.answer } : {}),
        };
        setStatus(node, usedDefault ? "done" : "stopped", ts);
        break;
      }
      case "human.cancelled":
        if (node.status !== "pending" && node.status !== "running") break;
        node.human = { ...node.human, cancelledReason: str(payload.reason) ?? "Cancelled" };
        setStatus(node, "stopped", ts);
        break;
      case "subagent.run.removed":
      case "loop.run.removed": {
        node.removed = true;
        // A8: eviction counts a waiting approval as terminal; nobody can answer it now.
        const approval = drafts.get(nodeKey({ type: "human", id: node.ref.id }));
        if (event.kind === "loop.run.removed" && approval?.status === "pending") {
          approval.human = { ...approval.human, cancelledReason: "The loop run was removed." };
          setStatus(approval, "stopped", ts);
        }
        break;
      }
      // loop.timeline / loop.artifact / loop.review / loop.run.userAction: facts on an
      // existing node that the detail panes read from the stores; no status change.
    }
  }

  // Link: explicit parent, else the cause's subject, else the session. A parent that
  // only exists as a reference (a toolCall no completed turn listed yet, a run whose
  // events are not in view) becomes a placeholder node under the session.
  const placeholders: Draft[] = [];
  for (const node of [...drafts.values()]) {
    const explicit = node.explicitParent;
    const target = explicit?.key ?? node.causeParent ?? node.sessionParent;
    if (!target || target === node.key) continue;
    if (!drafts.has(target) && explicit) {
      const placeholder: Draft = {
        key: target,
        ref: { type: explicit.ref.type, id: explicit.ref.id },
        children: [],
        status: "running",
        label: PLACEHOLDER_LABEL[explicit.ref.type] ?? `${explicit.ref.type} not in view`,
        actor: node.actor,
        ...(explicit.sessionId ? { sessionId: explicit.sessionId } : {}),
        startedAt: node.startedAt,
        updatedAt: node.startedAt,
        order: node.order - 0.5,
        placeholder: true,
      };
      if (node.sessionParent && node.sessionParent !== target) {
        placeholder.parent = node.sessionParent;
      }
      drafts.set(target, placeholder);
      placeholders.push(placeholder);
    }
    if (drafts.has(target)) node.parent = target;
  }
  // A cycle (a corrupt or hand-edited log) would hide nodes: a node whose ancestors
  // lead back to itself is detached; a node that only leads INTO a cycle keeps its parent.
  for (const node of drafts.values()) {
    const seen = new Set<string>();
    for (let up = node.parent; up && !seen.has(up); up = drafts.get(up)?.parent) {
      if (up === node.key) {
        delete node.parent;
        break;
      }
      seen.add(up);
    }
  }
  // Forks: a link row on the source; the fork stays its own root.
  for (const node of drafts.values()) {
    if (!node.forkedFrom) continue;
    const source = drafts.get(nodeKey({ type: "session", id: node.forkedFrom }));
    if (source) (source.forks ??= []).push({ sessionId: node.ref.id, label: node.label });
  }

  const sorted = [...drafts.values()].sort((a, b) => a.order - b.order);
  const roots: Draft[] = [];
  for (const node of sorted) {
    const parent = node.parent ? drafts.get(node.parent) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  // Placeholders have no events of their own: a finished root closes them, and so do
  // children that all finished; otherwise a later restart interrupts them.
  const rootOf = (node: Draft): Draft => {
    let top = node;
    for (let i = 0; top.parent && i < drafts.size; i += 1) top = drafts.get(top.parent) ?? top;
    return top;
  };
  for (const placeholder of placeholders) {
    const root = rootOf(placeholder);
    const childrenDone =
      placeholder.children.length > 0 &&
      placeholder.children.every((child) => TERMINAL.has(child.status));
    const restart = restarts.find((entry) => entry.order > placeholder.order);
    if (root !== placeholder && TERMINAL.has(root.status)) {
      setStatus(placeholder, "done", root.endedAt ?? root.updatedAt);
    } else if (childrenDone) {
      const cut = placeholder.children.some((child) => child.status === "interrupted");
      setStatus(placeholder, cut ? "interrupted" : "done", placeholder.updatedAt);
    } else if (restart) {
      setStatus(placeholder, "interrupted", restart.ts);
    }
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
  const shown: ExecutionNode[] = scoped ? (root ? [root] : []) : roots;
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
 * supervisorRequest children. Not wired to DeckPanel yet: that waits for a
 * session-scoped full read (the web's project tail drops older runs).
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
