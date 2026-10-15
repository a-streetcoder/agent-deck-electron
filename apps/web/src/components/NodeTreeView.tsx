import { ControlButton } from "@/design-system/components/NativeControls";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  affectedRegion,
  eventLabel,
  failedVerifications,
  humanKindLabel,
  memoryToolCardLabel,
  openHumanNodes,
  projectNodeTree,
  PROMPT_LABEL_MAX_CHARS,
  type AffectedRegion,
  type AssistantCell,
  type EventEnvelope,
  type FailedVerification,
  type ExecutionNode,
  type NodeStatus,
  type ToolCell,
  type TranscriptCell,
  type UserCell,
} from "@agent-deck/domain";
import { toolPresentation } from "@/components/transcript/toolPresentation";
import { mirroredTranscript, useAppStore } from "../state/store.ts";
import type { ProjectEventPage } from "../state/projectLog.ts";
import { rollbackToCheckpoint, sendPrompt, switchToSession } from "../state/wsBridge.ts";
import { actorLabel, formatEventTime } from "./ActivityList.tsx";
import { VerdictChip } from "./VerdictChip.tsx";

/**
 * A2: the open session's execution-node tree, projected from the session's FULL event
 * history (GET /events?sessionId=, paged), not the project tail. The log holds
 * references only; a turn's messages, reasoning and tool calls are resolved here
 * against the open session's transcript cells (user cells by entryId, tool cells by
 * toolCallId, assistant cells by position after the turn's user message).
 */

const PAGE_LIMIT = 1_000;
// ponytail: 20 pages (20k events) per pull; the cursor resumes on the next nudge.
const MAX_PAGES = 20;

const STATUS_LABEL: Record<NodeStatus, string> = {
  pending: "Pending",
  running: "Running",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

const STATUS_COLOR: Record<NodeStatus, string> = {
  pending: "var(--color-text-muted)",
  running: "var(--color-brand-accent, var(--color-accent))",
  done: "var(--color-diff-added)",
  error: "var(--color-role-tool)",
  stopped: "var(--color-text-muted)",
  interrupted: "var(--color-warning)",
};

/** Chips go on nodes that run; leaves (tool calls, messages) and facts do not get one. */
const CHIP_TYPES = new Set([
  "turn",
  "subagentRun",
  "loopRun",
  "loopIteration",
  "loopChild",
  "supervisorRequest",
  "human",
]);

/** A8: how a human node settled, with who answered (any member on the shared server). */
export function humanOutcome(node: ExecutionNode): string | undefined {
  const human = node.human;
  if (!human) return undefined;
  if (human.expired === "default")
    return `Expired: default "${eventLabel(human.answer ?? "")}" used`;
  if (human.expired === "blocked") return "Expired: blocked";
  if (human.by) {
    const answer = human.answer ? `: ${eventLabel(human.answer)}` : "";
    return `Answered by ${actorLabel(human.by)}${answer}`;
  }
  if (human.cancelledReason) return human.cancelledReason;
  return node.status === "pending"
    ? `${humanKindLabel(human.kind)}: waiting on a person`
    : undefined;
}

interface Joins {
  sessionId: string;
  users: Map<string, UserCell>;
  tools: Map<string, ToolCell>;
  /** By user cell id: the assistant cells after it, up to the next user cell. */
  replies: Map<string, AssistantCell[]>;
  mcpServerNames?: Readonly<Record<string, string>>;
}

function joinCells(
  sessionId: string,
  cells: readonly TranscriptCell[],
  mcpServerNames?: Readonly<Record<string, string>>,
): Joins {
  const joins: Joins = {
    sessionId,
    users: new Map(),
    tools: new Map(),
    replies: new Map(),
    ...(mcpServerNames ? { mcpServerNames } : {}),
  };
  let replies: AssistantCell[] | undefined;
  for (const cell of cells) {
    if (cell.kind === "user") {
      replies = [];
      joins.replies.set(cell.id, replies);
      if (cell.entryId) joins.users.set(cell.entryId, cell);
    } else if (cell.kind === "tool") joins.tools.set(cell.toolCallId, cell);
    else if (cell.kind === "assistant") replies?.push(cell);
  }
  return joins;
}

function toolLabel(node: ExecutionNode, joins: Joins): string {
  const cell = node.sessionId === joins.sessionId ? joins.tools.get(node.ref.id) : undefined;
  if (cell) {
    return memoryToolCardLabel(cell) ?? toolPresentation(cell.toolName, joins.mcpServerNames).name;
  }
  return node.placeholder ? node.label : toolPresentation(node.label, joins.mcpServerNames).name;
}

const hasAttachments = (cell: UserCell): boolean =>
  Boolean(cell.images?.length || cell.files?.length || cell.folders?.length || cell.pastes?.length);

interface Leaf {
  key: string;
  kind: "message" | "reasoning";
  text: string;
}

/** A turn's message and reasoning leaves, from the transcript of the same session. */
function turnLeaves(node: ExecutionNode, joins: Joins): Leaf[] {
  if (node.ref.type !== "turn" || node.sessionId !== joins.sessionId) return [];
  const users = (node.entryIds ?? []).flatMap((id) => {
    const cell = joins.users.get(id);
    return cell ? [cell] : [];
  });
  const leaves: Leaf[] = [];
  for (const user of users) {
    const line = eventLabel(user.text, PROMPT_LABEL_MAX_CHARS);
    // The turn row already shows its prompt line: repeat it only when it says more.
    if (line !== node.label || hasAttachments(user)) {
      leaves.push({ key: user.id, kind: "message", text: line || "(attachment)" });
    }
    for (const reply of joins.replies.get(user.id) ?? []) {
      reply.blocks.forEach((block, index) => {
        const text = eventLabel(block.text);
        if (!text) return;
        leaves.push({
          key: `${reply.id}/${index}`,
          kind: block.kind === "thinking" ? "reasoning" : "message",
          text,
        });
      });
    }
  }
  return leaves;
}

/** A8: a supervisor request's row duplicates its human node (same id): show the human one. */
function duplicateRows(nodes: ReadonlyMap<string, ExecutionNode>): ReadonlySet<string> {
  const hidden = new Set<string>();
  for (const node of nodes.values()) {
    if (node.ref.type === "supervisorRequest" && nodes.has(`human:${node.ref.id}`))
      hidden.add(node.key);
  }
  return hidden;
}

const NO_HIDDEN: ReadonlySet<string> = new Set();
/** A10: one failed verification, its marked region and the checkpoint it may restore. */
interface Failure {
  /** Unique in the view: a plan node can carry several items blocked before their run. */
  id: string;
  failure: FailedVerification;
  region?: AffectedRegion;
  /**
   * The frontier checkpoint, when the failed work wrote to the open session's checkout
   * (rollback acts on that one): its label, and the turns that began after it (dropped).
   */
  restore?: { turnIndex: number; label: string; dropped: ExecutionNode[] };
}

/** A10: the marking of every failed verification in view, and the one action. */
interface Marks {
  mark: ReadonlyMap<string, "trusted" | "affected" | "frontier">;
  /** By node key. */
  failures: ReadonlyMap<string, Failure[]>;
  /** A turn is running or a retry is in flight: nothing restores now. */
  busy: boolean;
  /** A subagent or loop run is still working: a restore would rewrite files under it. */
  liveWork: boolean;
  onRetry: (id: string) => void;
}

const NO_MARKS: Marks = {
  mark: new Map(),
  failures: new Map(),
  busy: false,
  liveWork: false,
  onRetry: () => {},
};

const MARK_LABEL = { trusted: "Trusted", affected: "Affected", frontier: "Recovery point" };

const RERUN_TEXT: Record<FailedVerification["retry"]["kind"], string> = {
  turn: "send the turn's prompt again",
  planItem: "re-dispatch the plan item and the items it blocked",
  loopRun: "retry the loop run from its saved definition (it may write to its checkout again)",
};

/** Why the action cannot run now, or undefined when it can. */
function retryBlocker(entry: Failure, state: Pick<Marks, "busy" | "liveWork">): string | undefined {
  if (entry.failure.retry.kind === "turn" && !entry.restore)
    return "No checkpoint before this node to restore.";
  if (state.busy) return "Wait for the running turn to finish.";
  if (entry.restore && state.liveWork)
    return "Wait for the running subagents and loops to finish before restoring files.";
  return undefined;
}

/** A subagent or loop run in the tree is still working. */
const liveWorkIn = (tree: { nodes: ReadonlyMap<string, ExecutionNode> } | null): boolean =>
  [...(tree?.nodes.values() ?? [])].some(
    (node) =>
      !node.placeholder &&
      (node.ref.type === "subagentRun" || node.ref.type === "loopRun") &&
      (node.status === "running" || node.status === "pending"),
  );

/** What the confirm says: what is restored and dropped, then what runs again. */
function confirmText(entry: Failure, joins: Joins): string {
  const { retry } = entry.failure;
  const restore = entry.restore;
  if (!restore) return `Retry from node: ${RERUN_TEXT[retry.kind]}; no checkpoint is restored.`;
  const turns = restore.dropped.length;
  const dropped = `${turns} later turn${turns === 1 ? "" : "s"} and the file changes after it are discarded`;
  let rerun = RERUN_TEXT[retry.kind];
  if (retry.kind === "turn") {
    const first = restore.dropped[0];
    const user = first?.entryIds?.map((id) => joins.users.get(id)).find((cell) => cell);
    rerun = "send the first dropped prompt again";
    if (turns > 1) rerun += ` (only that one: the ${turns - 1} after it are not replayed)`;
    if (user && hasAttachments(user)) rerun += "; its attachments are not re-sent";
  }
  return `Retry from node: restore the checkpoint "${restore.label}" (${dropped}), then ${rerun}.`;
}

const planRetryUrl = (retry: Extract<FailedVerification["retry"], { kind: "planItem" }>) =>
  `/sessions/${encodeURIComponent(retry.sessionId)}/plan/items/${encodeURIComponent(retry.itemId)}/retry`;

async function refusal(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `Retry failed (${response.status}).`);
}

/**
 * A10 "Retry from node": restore the frontier checkpoint through the existing rollback
 * (the RPC the Checkpoints panel uses), then re-run the affected region: a turn's prompt
 * again (the first prompt the rollback dropped, as the panel's rerun), a plan item through
 * the dispatcher (the click is the live intent, logged with its actor), a loop through the
 * existing loop retry. Resolves to the success message.
 */
async function retryFromNode(sessionId: string, entry: Failure): Promise<string> {
  const { retry } = entry.failure;
  const json = { "content-type": "application/json" };
  // The plan as the person saw it: the server refuses the retry if it moved on.
  const seen =
    retry.kind === "planItem"
      ? JSON.stringify({ generation: retry.generation ?? null, runId: retry.runId ?? null })
      : "";
  // Before anything destructive: the step after the restore must be able to run.
  if (entry.restore && retry.kind === "planItem") {
    const check = await fetch(`${planRetryUrl(retry)}?dryRun=1`, {
      method: "POST",
      headers: json,
      body: seen,
    });
    if (!check.ok) throw await refusal(check);
  }
  let rolled: Awaited<ReturnType<typeof rollbackToCheckpoint>> | undefined;
  if (entry.restore) rolled = await rollbackToCheckpoint(entry.restore.turnIndex);
  if (retry.kind === "turn") {
    if (!rolled?.nextPrompt) {
      return "Restored the checkpoint; there was no later prompt to send again.";
    }
    await sendPrompt(sessionId, rolled.nextPrompt);
    return rolled.nextPromptHadAttachments
      ? "Restored the checkpoint and sent the prompt again, without its attachments."
      : "Restored the checkpoint and sent the turn's prompt again.";
  }
  const response =
    retry.kind === "planItem"
      ? await fetch(planRetryUrl(retry), { method: "POST", headers: json, body: seen })
      : await fetch(`/loops/runs/${encodeURIComponent(retry.runId)}/retry`, {
          method: "POST",
          headers: json,
          body: JSON.stringify({ currentCheckoutConfirmed: true, fromNode: true }),
        });
  if (!response.ok) throw await refusal(response);
  return retry.kind === "planItem" ? "Plan item queued to run again." : "Loop run retried.";
}

const NodeRow = memo(function NodeRow({
  node,
  joins,
  hidden = NO_HIDDEN,
  marks = NO_MARKS,
}: {
  node: ExecutionNode;
  joins: Joins;
  hidden?: ReadonlySet<string>;
  marks?: Marks;
}) {
  const tool = node.ref.type === "toolCall";
  const leaves = turnLeaves(node, joins);
  const outcome = humanOutcome(node);
  const mark = marks.mark.get(node.key);
  const failures = marks.failures.get(node.key) ?? [];
  const summary = (
    <span className="flex min-w-0 items-baseline gap-1.5">
      {CHIP_TYPES.has(node.ref.type) ? (
        <span
          className="shrink-0 rounded-capsule px-1.5 text-micro font-medium"
          style={{
            color: STATUS_COLOR[node.status],
            border: `1px solid ${STATUS_COLOR[node.status]}`,
          }}
          data-testid="tree-node-status"
        >
          {STATUS_LABEL[node.status]}
        </span>
      ) : null}
      <span
        className={`min-w-0 truncate ${node.placeholder ? "text-text-muted" : "text-text-primary"}`}
        data-testid="tree-node-label"
      >
        {tool ? toolLabel(node, joins) : node.label}
      </span>
      {node.subagentRun?.verdict ? <VerdictChip verdict={node.subagentRun.verdict} /> : null}
      {mark ? (
        <span className="shrink-0 text-micro text-text-muted" data-testid="tree-node-mark">
          {MARK_LABEL[mark]}
        </span>
      ) : null}
      {failures.map((entry) => {
        const blocker = retryBlocker(entry, marks);
        const { retry } = entry.failure;
        // On the plan node (an item blocked before its run): say which item.
        const item =
          retry.kind === "planItem" && node.ref.type === "plan"
            ? ` ${retry.title ?? retry.itemId}`
            : "";
        return (
          <ControlButton
            key={entry.id}
            className="shrink-0 rounded-capsule border border-border-subtle px-1.5 text-micro text-accent enabled:hover:underline disabled:text-text-muted"
            data-testid="retry-from-node"
            disabled={blocker !== undefined}
            title={blocker ?? `Retry from node: ${RERUN_TEXT[retry.kind]}`}
            onClick={(event) => {
              // Inside a <summary>: the click must not fold the row.
              event.preventDefault();
              event.stopPropagation();
              marks.onRetry(entry.id);
            }}
          >
            Retry from node{item}
          </ControlButton>
        );
      })}
      {tool ? null : (
        <>
          <span className="shrink-0 text-text-muted">{actorLabel(node.actor)}</span>
          <time className="shrink-0 text-text-muted" dateTime={node.startedAt}>
            {formatEventTime(node.startedAt)}
          </time>
        </>
      )}
      {outcome ? (
        <span className="min-w-0 truncate text-text-muted" data-testid="human-outcome">
          {outcome}
        </span>
      ) : null}
    </span>
  );
  const nested = leaves.length > 0 || node.children.length > 0;
  return (
    <li
      className="text-detail text-text-secondary"
      data-testid="tree-node"
      data-type={node.ref.type}
      data-status={node.status}
      {...(mark ? { "data-mark": mark } : {})}
    >
      {nested ? (
        <details open>
          <summary className="cursor-pointer">{summary}</summary>
          <ul className="ml-3 space-y-0.5 border-l border-border-subtle pl-2 pt-0.5">
            {leaves.map((leaf) => (
              <li
                key={leaf.key}
                className={`truncate text-text-muted ${leaf.kind === "reasoning" ? "italic" : ""}`}
                data-testid={`tree-leaf-${leaf.kind}`}
              >
                {leaf.kind === "reasoning" ? `Reasoning: ${leaf.text}` : leaf.text}
              </li>
            ))}
            {node.children
              .filter((child) => !hidden.has(child.key))
              .map((child) => (
                <NodeRow key={child.key} node={child} joins={joins} hidden={hidden} marks={marks} />
              ))}
          </ul>
        </details>
      ) : (
        <div className="pl-3">{summary}</div>
      )}
    </li>
  );
});

/**
 * The session's full event history: pages forward from seq 0 when the session opens,
 * then from its cursor whenever the project log advances (the project_events nudge).
 * A changed logId starts over. Returns a new array only when events arrive.
 */
function useSessionEvents(sessionId: string | null): EventEnvelope[] {
  const nudge = useAppStore((state) => state.projectLog?.lastSeq);
  const [events, setEvents] = useState<EventEnvelope[]>([]);
  const cursor = useRef<{ sessionId: string; logId?: string; afterSeq: number } | null>(null);
  const pulling = useRef<Promise<void> | null>(null);
  const dirty = useRef(false);
  // The newest session's pull: a pull still running for the previous one reruns this.
  const latestPull = useRef<() => Promise<void>>(async () => {});

  useEffect(() => {
    cursor.current = sessionId ? { sessionId, afterSeq: 0 } : null;
    setEvents([]);
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const pull = async (): Promise<void> => {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const at = cursor.current;
        if (!at || at.sessionId !== sessionId) return;
        const response = await fetch(
          `/events?sessionId=${encodeURIComponent(sessionId)}&afterSeq=${at.afterSeq}&limit=${PAGE_LIMIT}`,
        );
        if (!response.ok) return;
        const body = (await response.json()) as ProjectEventPage;
        if (cursor.current !== at) return; // the session changed meanwhile
        const replaced = at.logId !== undefined && at.logId !== body.logId;
        if (replaced) {
          cursor.current = { sessionId, logId: body.logId, afterSeq: 0 };
          setEvents([]);
          continue;
        }
        cursor.current = {
          sessionId,
          logId: body.logId,
          afterSeq: body.nextAfterSeq ?? body.lastSeq,
        };
        if (body.events.length > 0) setEvents((previous) => [...previous, ...body.events]);
        if (!body.more) return;
      }
    };
    latestPull.current = pull;
    const run = (): Promise<void> => {
      if (pulling.current) {
        dirty.current = true;
        return pulling.current;
      }
      pulling.current = (async () => {
        try {
          do {
            dirty.current = false;
            await latestPull.current();
          } while (dirty.current);
        } catch {
          // Transient: the next nudge pulls again from the same cursor.
        } finally {
          pulling.current = null;
        }
      })();
      return pulling.current;
    };
    void run();
  }, [sessionId, nudge]);

  return events;
}

export function NodeTreeView() {
  // SRV-12c2: a pointer's tree is its server session's, from the mirror's events.
  const pointer = useAppStore((state) => state.session?.sharedTo?.serverSessionId ?? null);
  const localId = useAppStore((state) => state.session?.id ?? null);
  const sessionId = pointer ?? localId;
  const mcpServerNames = useAppStore((state) => state.session?.mcpServerNames);
  const cells = useAppStore((state) => mirroredTranscript(state).cells);
  const sessions = useAppStore((state) => state.sessions);
  const localEvents = useSessionEvents(pointer ? null : localId);
  // The mirror keeps only the tree it reduced, not the events.
  const mirrorTree = useAppStore((state) =>
    state.sharedMirror?.sessionId === localId ? state.sharedMirror.tree : null,
  );
  // The tree changes only when events arrive; a streamed token changes only the joins.
  const localTree = useMemo(
    () => (!pointer && sessionId ? projectNodeTree(localEvents, { sessionId }) : null),
    [localEvents, sessionId, pointer],
  );
  const tree = pointer ? mirrorTree : localTree;
  const joins = useMemo(
    () => joinCells(sessionId ?? "", cells, mcpServerNames),
    [sessionId, cells, mcpServerNames],
  );

  const root = tree?.roots[0];
  const forks = root?.forks ?? [];
  // A8: open human nodes first; they also stay in place below.
  const waiting = useMemo(() => (tree ? openHumanNodes(tree) : []), [tree]);
  const hidden = useMemo(() => (tree ? duplicateRows(tree.nodes) : NO_HIDDEN), [tree]);
  // A pointer acts on nothing here: its retries stay off.
  const running = useAppStore(
    (state) => state.transcript.agentStatus === "running" || Boolean(state.session?.sharedTo),
  );
  const [retrying, setRetrying] = useState(false);
  const failures = useMemo(() => {
    const out: Failure[] = [];
    if (!tree) return out;
    for (const failure of failedVerifications(tree)) {
      const region = failure.ran ? affectedRegion(tree, failure.key) : undefined;
      const frontier = failure.restores ? region?.frontier : undefined;
      const checkpoint = frontier ? tree.nodes.get(frontier.checkpointKey) : undefined;
      const retry = failure.retry;
      // The session's own turns that began after the checkpoint: the rollback drops them.
      const dropped = (tree.roots[0]?.children ?? []).filter(
        (node) =>
          node.ref.type === "turn" &&
          node.sessionId === sessionId &&
          checkpoint?.endEvent !== undefined &&
          node.firstEvent > checkpoint.endEvent,
      );
      out.push({
        id: `${failure.key}#${retry.kind === "planItem" ? retry.itemId : ""}`,
        failure,
        ...(region ? { region } : {}),
        ...(frontier && checkpoint && frontier.sessionId === sessionId
          ? { restore: { turnIndex: frontier.turnIndex, label: checkpoint.label, dropped } }
          : {}),
      });
    }
    return out;
  }, [tree, sessionId]);
  // The latest state, for the re-check once the confirm closes.
  const latest = useRef({ tree, retrying });
  latest.current = { tree, retrying };
  const onRetry = useCallback(
    (id: string) => {
      const entry = failures.find((candidate) => candidate.id === id);
      if (!entry || !sessionId) return;
      if (!window.confirm(confirmText(entry, joins))) return;
      // The dialog may have stayed open while a turn or a run started: check again.
      const now = latest.current;
      const blocker = retryBlocker(entry, {
        busy: now.retrying || useAppStore.getState().transcript.agentStatus === "running",
        liveWork: liveWorkIn(now.tree),
      });
      if (blocker) {
        useAppStore.getState().pushToast({ kind: "error", message: blocker });
        return;
      }
      setRetrying(true);
      void retryFromNode(sessionId, entry)
        .then((message) => useAppStore.getState().pushToast({ kind: "success", message }))
        .catch((error: unknown) =>
          useAppStore.getState().pushToast({
            kind: "error",
            message: error instanceof Error ? error.message : String(error),
          }),
        )
        .finally(() => setRetrying(false));
    },
    [failures, sessionId, joins],
  );
  const marks = useMemo<Marks>(() => {
    const mark = new Map<string, "trusted" | "affected" | "frontier">();
    const byNode = new Map<string, Failure[]>();
    for (const entry of failures)
      byNode.set(entry.failure.key, [...(byNode.get(entry.failure.key) ?? []), entry]);
    const regions = failures.flatMap((entry) => (entry.region ? [entry.region] : []));
    // Affected by any failure wins over trusted by another; a frontier shows only where a
    // restore is offered.
    for (const region of regions) for (const key of region.trusted) mark.set(key, "trusted");
    for (const region of regions) for (const key of region.affected) mark.set(key, "affected");
    for (const entry of failures) {
      if (entry.restore && entry.region?.frontier) mark.set(entry.region.frontier.key, "frontier");
    }
    return {
      mark,
      failures: byNode,
      busy: running || retrying,
      liveWork: liveWorkIn(tree),
      onRetry,
    };
  }, [tree, failures, running, retrying, onRetry]);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="node-tree">
      {waiting.length > 0 ? (
        <ul
          className="mb-2 space-y-0.5"
          data-testid="open-human-nodes"
          aria-label="Waiting on a person"
        >
          {waiting.map((node) => (
            <NodeRow key={node.key} node={node} joins={joins} marks={marks} />
          ))}
        </ul>
      ) : null}
      {root && (root.children.length > 0 || forks.length > 0) ? (
        <ul className="space-y-0.5">
          {root.children
            .filter((node) => !hidden.has(node.key))
            .map((node) => (
              <NodeRow key={node.key} node={node} joins={joins} hidden={hidden} marks={marks} />
            ))}
          {forks.map((fork) => {
            const meta = sessions.find((candidate) => candidate.id === fork.sessionId);
            const title = meta?.title?.trim() || fork.label;
            return (
              <li key={fork.sessionId} className="pl-3 text-detail" data-testid="tree-fork">
                {meta ? (
                  <ControlButton
                    className="text-left text-accent hover:underline"
                    onClick={() => void switchToSession(meta)}
                  >
                    Forked to {title}
                  </ControlButton>
                ) : (
                  <span className="text-text-muted">Forked to {title}</span>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        <div className="text-caption text-text-muted">No recorded activity for this session.</div>
      )}
    </div>
  );
}
