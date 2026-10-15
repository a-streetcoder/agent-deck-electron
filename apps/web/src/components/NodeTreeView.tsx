import { ControlButton } from "@/design-system/components/NativeControls";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  eventLabel,
  memoryToolCardLabel,
  projectNodeTree,
  PROMPT_LABEL_MAX_CHARS,
  type AssistantCell,
  type EventEnvelope,
  type ExecutionNode,
  type NodeStatus,
  type ToolCell,
  type TranscriptCell,
  type UserCell,
} from "@agent-deck/domain";
import { toolPresentation } from "@/components/transcript/toolPresentation";
import { useAppStore } from "../state/store.ts";
import type { ProjectEventPage } from "../state/projectLog.ts";
import { switchToSession } from "../state/wsBridge.ts";
import { actorLabel, formatEventTime } from "./ActivityList.tsx";

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
]);

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

const NodeRow = memo(function NodeRow({ node, joins }: { node: ExecutionNode; joins: Joins }) {
  const tool = node.ref.type === "toolCall";
  const leaves = turnLeaves(node, joins);
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
      {tool ? null : (
        <>
          <span className="shrink-0 text-text-muted">{actorLabel(node.actor)}</span>
          <time className="shrink-0 text-text-muted" dateTime={node.startedAt}>
            {formatEventTime(node.startedAt)}
          </time>
        </>
      )}
    </span>
  );
  const nested = leaves.length > 0 || node.children.length > 0;
  return (
    <li
      className="text-detail text-text-secondary"
      data-testid="tree-node"
      data-type={node.ref.type}
      data-status={node.status}
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
            {node.children.map((child) => (
              <NodeRow key={child.key} node={child} joins={joins} />
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
  const sessionId = useAppStore((state) => state.session?.id ?? null);
  const mcpServerNames = useAppStore((state) => state.session?.mcpServerNames);
  const cells = useAppStore((state) => state.transcript.cells);
  const sessions = useAppStore((state) => state.sessions);
  const events = useSessionEvents(sessionId);
  // The tree changes only when events arrive; a streamed token changes only the joins.
  const tree = useMemo(
    () => (sessionId ? projectNodeTree(events, { sessionId }) : null),
    [events, sessionId],
  );
  const joins = useMemo(
    () => joinCells(sessionId ?? "", cells, mcpServerNames),
    [sessionId, cells, mcpServerNames],
  );

  const root = tree?.roots[0];
  const forks = root?.forks ?? [];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="node-tree">
      {root && (root.children.length > 0 || forks.length > 0) ? (
        <ul className="space-y-0.5">
          {root.children.map((node) => (
            <NodeRow key={node.key} node={node} joins={joins} />
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
