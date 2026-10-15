import { ControlButton } from "@/design-system/components/NativeControls";
import { planDepths, type PlanItemStatus, type SessionPlanItem } from "@agent-deck/domain";
import { ProgressRing } from "./ProgressRing.tsx";
import { useAppStore } from "../state/store.ts";

/**
 * The session's activity plan (native activity-sidebar "Plan" card), driven by a
 * parent agent via set_session_plan / update_session_plan. Shows a done-count,
 * a progress bar, and one row per item with a status glyph — mirroring the
 * native PiAgentCurrentPlanCard. A plan with dependencies (A5) is grouped by
 * topological depth (one header per step, no graph library); assigned items show
 * their agents, the verifier's note and a link to their run's card.
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
  const sessionId = useAppStore((state) => state.session?.id);
  const requestCellNavigation = useAppStore((state) => state.requestCellNavigation);
  const details = [
    item.dependsOn?.length ? `after ${item.dependsOn.join(", ")}` : "",
    item.assignee ? `by ${item.assignee}` : "",
    item.verifiedBy ? `verified by ${item.verifiedBy}` : "",
  ].filter(Boolean);
  return (
    <li
      className="flex items-start gap-2 text-label"
      data-testid="plan-item"
      data-status={item.status}
    >
      <span aria-hidden style={{ color: STATUS_COLOR[item.status] }} className="leading-5">
        {STATUS_GLYPH[item.status]}
      </span>
      <div className="min-w-0">
        <span
          className={muted ? "text-text-muted line-through" : "text-text-primary"}
          style={{ textDecorationColor: "var(--color-text-muted)" }}
        >
          {item.title}
        </span>
        {details.length ? (
          <div className="text-caption text-text-muted">{details.join(" · ")}</div>
        ) : null}
        {item.note ? (
          <div className="text-caption text-text-secondary" data-testid="plan-item-note">
            {item.note}
          </div>
        ) : null}
        {item.runId && sessionId ? (
          <ControlButton
            className="text-caption text-accent hover:underline"
            // The run's subagent card has the run id as its cell id.
            onClick={() => requestCellNavigation(item.runId!, sessionId)}
          >
            Show run
          </ControlButton>
        ) : null}
      </div>
    </li>
  );
}

/** A plan with dependencies: items grouped by topological depth, one header per step. */
function PlanSteps({ plan }: { plan: SessionPlanItem[] }) {
  const depths = planDepths(plan);
  const steps: SessionPlanItem[][] = [];
  for (const item of plan) (steps[depths.get(item.id) ?? 0] ??= []).push(item);
  return (
    <div className="mt-3 space-y-2" data-testid="plan-steps">
      {steps.map((step, depth) => (
        <section key={depth} aria-label={`Step ${depth + 1}`}>
          <div className="text-caption font-semibold text-text-muted">Step {depth + 1}</div>
          <ul className="mt-1 space-y-1.5">
            {step.map((item) => (
              <PlanRow key={item.id} item={item} />
            ))}
          </ul>
        </section>
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
        <PlanSteps plan={plan} />
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
