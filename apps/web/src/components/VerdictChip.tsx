import type { SubagentVerdict } from "@agent-deck/domain";

/** A7: a verifier's verdict on a run: the decision as a chip, then its reason. */

const LABEL: Record<SubagentVerdict["decision"], string> = {
  APPROVE: "Approved",
  REJECT: "Rejected",
  CONTINUE: "Continue",
  ASK_HUMAN: "Ask human",
  missing: "No verdict",
};

const COLOR: Record<SubagentVerdict["decision"], string> = {
  APPROVE: "var(--color-diff-added)",
  REJECT: "var(--color-role-tool)",
  CONTINUE: "var(--color-brand-accent, var(--color-accent))",
  ASK_HUMAN: "var(--color-warning)",
  missing: "var(--color-text-muted)",
};

export function VerdictChip({
  verdict,
  showReason = true,
}: {
  verdict: SubagentVerdict;
  /** False where only a line fits (the reason goes to the tooltip). */
  showReason?: boolean;
}) {
  return (
    <span
      className="flex min-w-0 items-baseline gap-1.5 text-detail"
      data-testid="verdict"
      data-decision={verdict.decision}
      title={showReason ? undefined : verdict.reason}
    >
      <span
        className="shrink-0 rounded-capsule px-1.5 text-micro font-medium"
        style={{ color: COLOR[verdict.decision], border: `1px solid ${COLOR[verdict.decision]}` }}
        data-testid="verdict-chip"
      >
        {LABEL[verdict.decision]}
      </span>
      {showReason && verdict.reason ? (
        <span
          className="min-w-0 whitespace-pre-wrap text-text-secondary"
          data-testid="verdict-reason"
        >
          {verdict.reason}
        </span>
      ) : null}
    </span>
  );
}
