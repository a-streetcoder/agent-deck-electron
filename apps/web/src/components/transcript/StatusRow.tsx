import { forwardRef, type ReactNode } from "react";
import { AlertTriangle, Info, Loader2, RefreshCcw } from "lucide-react";

import { cn } from "@/lib/cn";

export type StatusRowVariant = "info" | "compaction" | "error" | "warning" | "subagent" | "git";

export interface StatusRowProps {
  /** Header label (Compaction / Tool: failed / Subagent Started / …). */
  title: string;
  /** Optional muted detail line below the title. */
  detail?: ReactNode;
  /** Optional short timestamp (e.g. "12:30"). */
  timestamp?: string;
  /** Visual tone — picks the tinted fill, stroke, and icon. */
  variant?: StatusRowVariant;
  /** Trailing slot (e.g. copy button, expand chevron). */
  trailing?: ReactNode;
  /** Set true to show the in-progress spinner instead of the static icon. */
  isSpinning?: boolean;
  className?: string;
}

const VARIANT_TINT: Record<StatusRowVariant, string> = {
  info: "border-border-subtle bg-hover text-text-secondary",
  compaction: "border-accent/35 bg-accent/8 text-accent",
  error: "border-danger/40 bg-danger/10 text-danger",
  warning: "border-warning/40 bg-warning/10 text-warning",
  subagent: "border-accent/25 bg-accent/6 text-text-secondary",
  git: "border-border-subtle bg-surface-elevated text-text-secondary",
};

const VARIANT_ICON: Record<StatusRowVariant, (props: { className: string }) => ReactNode> = {
  info: ({ className }) => <Info className={className} aria-hidden="true" />,
  compaction: ({ className }) => <RefreshCcw className={className} aria-hidden="true" />,
  error: ({ className }) => <AlertTriangle className={className} aria-hidden="true" />,
  warning: ({ className }) => <AlertTriangle className={className} aria-hidden="true" />,
  subagent: ({ className }) => <Info className={className} aria-hidden="true" />,
  git: ({ className }) => <Info className={className} aria-hidden="true" />,
};

/**
 * Inline status row. Used for compaction notices, tool error
 * summaries, git events, and Subagent Started / Captured prompts. Sits
 * full-width inside the transcript timeline.
 */
export const StatusRow = forwardRef<HTMLDivElement, StatusRowProps>(function StatusRow(
  { title, detail, timestamp, variant = "info", trailing, isSpinning = false, className },
  ref,
) {
  const Icon = VARIANT_ICON[variant];
  return (
    <div
      ref={ref}
      data-testid="status-row"
      data-tone={variant}
      className={cn(
        "flex items-center gap-2 rounded-lg border px-3 py-2",
        "text-caption",
        VARIANT_TINT[variant],
        className,
      )}
    >
      {isSpinning ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
      ) : (
        <Icon className="h-3.5 w-3.5" />
      )}
      <span className="font-semibold text-text-primary">{title}</span>
      {detail ? (
        <span className="min-w-0 flex-1 truncate text-text-muted">{detail}</span>
      ) : (
        <span className="flex-1" />
      )}
      {timestamp ? <span className="shrink-0 text-detail text-text-muted">{timestamp}</span> : null}
      {trailing}
    </div>
  );
});

export default StatusRow;
