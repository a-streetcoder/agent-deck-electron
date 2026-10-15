import { ControlButton } from "@/design-system/components/NativeControls";
import { useEffect, useMemo, useRef, useState } from "react";
import { deckRunDetail, deckRuns, type DeckRun, type DeckRunDetail } from "@agent-deck/domain";
import { RunMeta } from "./RunMeta.tsx";
import { useAppStore } from "../state/store.ts";

/**
 * The deck: a per-session activity panel that aggregates the session's native
 * subagent runs (native activity-sidebar "Deck Agents"). v1 derives everything
 * from the transcript's subagent + supervisor cells (deckRuns) — no server state.
 * Renders nothing when there are no runs, so it only claims width when active.
 */

const STATUS_LABEL: Record<DeckRun["status"], string> = {
  running: "Running",
  done: "Done",
  error: "Failed",
  stopped: "Stopped",
  interrupted: "Interrupted",
};

const STATUS_COLOR: Record<DeckRun["status"], string> = {
  running: "var(--color-brand-accent, var(--color-accent))",
  done: "var(--color-diff-added)",
  error: "var(--color-role-tool)",
  stopped: "var(--color-text-muted)",
  interrupted: "var(--color-warning)",
};

/** The expanded detail for one run: its full task, streamed output, progress
 * updates, and any supervisor requests it raised. */
function RunDetail({ detail }: { detail: DeckRunDetail }) {
  const cell = detail.cell;
  if (!cell) return null;
  return (
    <div
      className="mt-2 space-y-2 border-t border-border-subtle pt-2"
      data-testid="deck-run-detail"
    >
      <div
        className="max-h-32 overflow-auto whitespace-pre-wrap rounded text-detail text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        data-testid="deck-run-task"
        tabIndex={0}
      >
        {cell.task}
      </div>
      {detail.questions.length > 0 ? (
        <ul className="space-y-1" data-testid="deck-run-questions">
          {detail.questions.map((q) => (
            <li key={q.requestId} className="text-detail" data-testid="deck-run-question">
              <span className="font-medium text-text-primary">{q.title}</span>{" "}
              <span className="text-text-muted">
                {q.answered
                  ? `— answered: ${q.answer ?? ""}`
                  : q.closed
                    ? `— closed: ${q.closedReason ?? ""}`
                    : "— awaiting answer"}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {cell.progress.length > 0 ? (
        <ul className="space-y-0.5" data-testid="deck-run-progress">
          {cell.progress.map((message, i) => (
            <li key={i} className="flex gap-1.5 text-detail text-text-muted">
              <span aria-hidden>→</span>
              <span className="whitespace-pre-wrap">{message}</span>
            </li>
          ))}
        </ul>
      ) : null}
      {cell.text ? (
        <div
          className="max-h-48 overflow-auto whitespace-pre-wrap rounded text-detail text-text-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
          data-testid="deck-run-output"
          tabIndex={0}
        >
          {cell.text}
        </div>
      ) : null}
      {cell.error ? (
        <div className="whitespace-pre-wrap text-detail text-danger" role="alert">
          {cell.error}
        </div>
      ) : null}
    </div>
  );
}

function RunRow({
  run,
  expanded,
  detail,
  onToggle,
}: {
  run: DeckRun;
  expanded: boolean;
  detail: DeckRunDetail | null;
  onToggle: () => void;
}) {
  return (
    <li
      className="rounded-lg border"
      style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface)" }}
      data-testid="deck-run"
      data-status={run.status}
      data-needs-input={run.needsInput ? "true" : "false"}
      data-expanded={expanded ? "true" : "false"}
    >
      <ControlButton
        type="button"
        className="w-full px-3 py-2 text-left"
        aria-expanded={expanded}
        onClick={onToggle}
        data-testid="deck-run-toggle"
      >
        <div className="flex items-center justify-between gap-2">
          <span
            className="rounded-capsule px-2 py-0.5 text-micro font-medium"
            style={{
              color: STATUS_COLOR[run.status],
              border: `1px solid ${STATUS_COLOR[run.status]}`,
            }}
          >
            {STATUS_LABEL[run.status]}
          </span>
          {run.needsInput ? (
            <span
              className="rounded-capsule bg-accent-surface px-2 py-0.5 text-micro font-medium text-text-primary"
              data-testid="deck-run-needs-input"
            >
              Needs input
            </span>
          ) : run.progressCount > 0 ? (
            <span className="text-micro tabular-nums text-text-muted">
              {run.progressCount} update(s)
            </span>
          ) : null}
        </div>
        <div className={`mt-1.5 text-detail text-text-secondary ${expanded ? "" : "line-clamp-3"}`}>
          {run.task}
        </div>
        <RunMeta
          className="mt-1.5"
          model={run.model}
          inputTokens={run.inputTokens}
          outputTokens={run.outputTokens}
          durationMs={run.durationMs}
        />
      </ControlButton>
      {expanded && detail ? (
        <div className="px-3 pb-2">
          <RunDetail detail={detail} />
        </div>
      ) : null}
    </li>
  );
}

export function DeckPanel() {
  // Select the stable transcript reference (it only changes when the store
  // reduces a new event) and derive the runs with useMemo — selecting a
  // freshly-allocated array directly would defeat zustand's snapshot caching.
  const transcript = useAppStore((state) => state.transcript);
  const runs = useMemo(() => deckRuns(transcript), [transcript]);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const previousStatuses = useRef(new Map<string, DeckRun["status"]>());
  useEffect(() => {
    const next = new Map(runs.map((run) => [run.id, run.status]));
    const resumed = runs.find(
      (run) => run.status === "running" && previousStatuses.current.get(run.id) !== "running",
    );
    // Initial fresh runs have no prior row and keep the established Deck state.
    // A retained terminal row that resumes opens once; later deltas do not
    // override a user's explicit collapse while it remains running.
    if (resumed && previousStatuses.current.has(resumed.id)) setExpandedId(resumed.id);
    previousStatuses.current = next;
  }, [runs]);
  // Only the expanded run computes its (cheap) detail; recomputes as the run streams.
  const detail = useMemo(
    () => (expandedId ? deckRunDetail(transcript, expandedId) : null),
    [transcript, expandedId],
  );
  if (runs.length === 0) return null;

  const active = runs.filter((r) => r.status === "running").length;

  return (
    <aside
      className="flex w-72 shrink-0 flex-col overflow-hidden border-l border-border-subtle bg-surface-elevated"
      data-testid="deck-panel"
    >
      <div className="flex items-center justify-between border-b border-border-subtle px-4 py-2.5">
        <span className="text-detail font-semibold text-text-primary">Deck</span>
        <span className="text-caption tabular-nums text-text-muted" data-testid="deck-count">
          {active > 0 ? `${active} active · ` : ""}
          {runs.length}
        </span>
      </div>
      <ul className="flex-1 space-y-2 overflow-y-auto px-3 py-3">
        {runs.map((run) => (
          <RunRow
            key={run.id}
            run={run}
            expanded={run.id === expandedId}
            detail={run.id === expandedId ? detail : null}
            onToggle={() => setExpandedId((id) => (id === run.id ? null : run.id))}
          />
        ))}
      </ul>
    </aside>
  );
}
