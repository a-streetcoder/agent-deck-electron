import { ControlButton } from "@/design-system/components/NativeControls";
import { planDepths, type PlanItemStatus, type SessionPlanItem } from "@agent-deck/domain";
import { ProgressRing } from "./ProgressRing.tsx";
import { useAppStore } from "../state/store.ts";

/**
 * The session's activity plan (native activity-sidebar "Plan" card), driven by a
 * parent agent via set_session_plan / update_session_plan. Shows a done-count,
 * a progress bar, and one row per item with a status glyph — mirroring the
 * native PiAgentCurrentPlanCard. A plan with dependencies (A5) renders as a DAG in
 * topological lanes instead: one column per depth, no graph library.
 */

const STATUS_GLYPH: Record<PlanItemStatus, string> = {
  todo: "○",
  in_progress: "◐",
  done: "●",
  blocked: "▲",
  skipped: "—",
};

const STATUS_COLOR: Record<PlanItemStatus, string> = {
  todo: "var(--color-text-muted)",
  in_progress: "var(--color-accent)",
  done: "var(--color-diff-added)",
  blocked: "var(--color-role-tool)",
  skipped: "var(--color-text-muted)",
};

function isComplete(status: PlanItemStatus): boolean {
  return status === "done" || status === "skipped";
}

function PlanRow({ item }: { item: SessionPlanItem }) {
  const muted = isComplete(item.status);
  return (
    <li
      className="flex items-start gap-2 text-label"
      data-testid="plan-item"
      data-status={item.status}
    >
      <span aria-hidden style={{ color: STATUS_COLOR[item.status] }} className="leading-5">
        {STATUS_GLYPH[item.status]}
      </span>
      <span
        className={muted ? "text-text-muted line-through" : "text-text-primary"}
        style={{ textDecorationColor: "var(--color-text-muted)" }}
      >
        {item.title}
      </span>
    </li>
  );
}

/** Scroll the transcript to the dispatched run's subagent card (its cell id is the run id). */
function showRun(runId: string): void {
  [...document.querySelectorAll<HTMLElement>("[data-cell-id]")]
    .find((element) => element.dataset.cellId === runId)
    ?.scrollIntoView({ block: "start" });
}

function PlanNode({ item }: { item: SessionPlanItem }) {
  const details = [
    item.dependsOn?.length ? `after ${item.dependsOn.join(", ")}` : "",
    item.assignee ? `by ${item.assignee}` : "",
    item.verifiedBy ? `verified by ${item.verifiedBy}` : "",
  ].filter(Boolean);
  return (
    <li
      className="rounded-lg border px-2 py-1.5 text-label"
      style={{ borderColor: "var(--color-border-strong)" }}
      data-testid="plan-node"
      data-status={item.status}
    >
      <div className="flex items-start gap-2">
        <span aria-hidden style={{ color: STATUS_COLOR[item.status] }} className="leading-5">
          {STATUS_GLYPH[item.status]}
        </span>
        <span className={isComplete(item.status) ? "text-text-muted" : "text-text-primary"}>
          {item.title}
        </span>
      </div>
      {details.length ? (
        <div className="text-caption text-text-muted">{details.join(" · ")}</div>
      ) : null}
      {item.runId ? (
        <ControlButton
          className="text-caption text-accent hover:underline"
          onClick={() => showRun(item.runId!)}
        >
          Show run
        </ControlButton>
      ) : null}
    </li>
  );
}

function PlanLanes({ plan }: { plan: SessionPlanItem[] }) {
  const depths = planDepths(plan);
  const lanes: SessionPlanItem[][] = [];
  for (const item of plan) (lanes[depths.get(item.id) ?? 0] ??= []).push(item);
  return (
    <div className="mt-3 flex gap-3 overflow-x-auto" data-testid="plan-lanes">
      {lanes.map((lane, depth) => (
        <ol key={depth} className="min-w-40 flex-1 space-y-1.5" aria-label={`Step ${depth + 1}`}>
          {lane.map((item) => (
            <PlanNode key={item.id} item={item} />
          ))}
        </ol>
      ))}
    </div>
  );
}

export function SessionPlanPanel() {
  const plan = useAppStore((state) => state.transcript.plan);
  if (plan.length === 0) return null;

  const done = plan.filter((it) => isComplete(it.status)).length;

  return (
    <section
      className="rounded-xl border px-4 py-3"
      style={{ borderColor: "var(--color-border-strong)", background: "var(--color-surface)" }}
      data-testid="session-plan"
    >
      <div className="flex items-center justify-between">
        <div className="text-detail font-semibold text-text-primary">Plan</div>
        <div className="flex items-center gap-2">
          <span className="text-caption tabular-nums text-text-muted" data-testid="plan-progress">
            {done}/{plan.length}
          </span>
          <ProgressRing done={done} total={plan.length} />
        </div>
      </div>
      {plan.some((item) => item.dependsOn?.length) ? (
        <PlanLanes plan={plan} />
      ) : (
        <ul className="mt-3 space-y-1.5">
          {plan.map((item) => (
            <PlanRow key={item.id} item={item} />
          ))}
        </ul>
      )}
    </section>
  );
}
