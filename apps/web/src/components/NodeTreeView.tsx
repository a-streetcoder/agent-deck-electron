import { useEffect, useMemo } from "react";
import {
  eventLabel,
  memoryToolCardLabel,
  projectNodeTree,
  type ExecutionNode,
  type NodeStatus,
  type ToolCell,
  type UserCell,
} from "@agent-deck/domain";
import { toolPresentation } from "@/components/transcript/toolPresentation";
import { useAppStore } from "../state/store.ts";
import { refreshProjectLog } from "../state/wsBridge.ts";
import { actorLabel, formatEventTime } from "./ActivityList.tsx";

/**
 * A2: the open session's execution-node tree, projected from the project event log.
 * The log holds references only; a turn's user messages and every tool call are
 * resolved here against the transcript cells (by entryId / toolCallId) and shown
 * with the transcript's own labels.
 */

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

interface Joins {
  users: Map<string, UserCell>;
  tools: Map<string, ToolCell>;
  mcpServerNames?: Readonly<Record<string, string>>;
}

function nodeLabel(node: ExecutionNode, joins: Joins): string {
  if (node.ref.type !== "toolCall") return node.label;
  const cell = joins.tools.get(node.ref.id);
  if (cell)
    return memoryToolCardLabel(cell) ?? toolPresentation(cell.toolName, joins.mcpServerNames).name;
  return toolPresentation(node.label, joins.mcpServerNames).name;
}

function NodeRow({ node, joins }: { node: ExecutionNode; joins: Joins }) {
  const users = (node.entryIds ?? []).flatMap((id) => {
    const cell = joins.users.get(id);
    return cell ? [cell] : [];
  });
  const summary = (
    <span className="flex min-w-0 items-baseline gap-1.5">
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
      <span className="min-w-0 truncate text-text-primary" data-testid="tree-node-label">
        {nodeLabel(node, joins)}
      </span>
      <span className="shrink-0 text-text-muted">{actorLabel(node.actor)}</span>
      <time className="shrink-0 text-text-muted" dateTime={node.startedAt}>
        {formatEventTime(node.startedAt)}
      </time>
    </span>
  );
  const nested = users.length > 0 || node.children.length > 0;
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
            {users.map((cell) => (
              <li
                key={cell.id}
                className="truncate text-text-muted"
                data-testid="tree-node-message"
              >
                {eventLabel(cell.text)}
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
}

export function NodeTreeView() {
  const sessionId = useAppStore((state) => state.session?.id ?? null);
  const mcpServerNames = useAppStore((state) => state.session?.mcpServerNames);
  const log = useAppStore((state) => state.projectLog);
  const transcript = useAppStore((state) => state.transcript);
  useEffect(() => {
    void refreshProjectLog();
  }, [sessionId]);
  const tree = useMemo(
    () => (sessionId && log ? projectNodeTree(log.events, { sessionId }) : null),
    [log, sessionId],
  );
  const joins = useMemo<Joins>(() => {
    const users = new Map<string, UserCell>();
    const tools = new Map<string, ToolCell>();
    for (const cell of transcript.cells) {
      if (cell.kind === "user" && cell.entryId) users.set(cell.entryId, cell);
      else if (cell.kind === "tool") tools.set(cell.toolCallId, cell);
    }
    return { users, tools, mcpServerNames };
  }, [transcript, mcpServerNames]);

  const root = tree?.roots[0];
  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2" data-testid="node-tree">
      {root && root.children.length > 0 ? (
        <ul className="space-y-0.5">
          {root.children.map((node) => (
            <NodeRow key={node.key} node={node} joins={joins} />
          ))}
        </ul>
      ) : (
        <div className="text-caption text-text-muted">No recorded activity for this session.</div>
      )}
    </div>
  );
}
