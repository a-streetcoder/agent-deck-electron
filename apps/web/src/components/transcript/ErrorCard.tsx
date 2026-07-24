import { forwardRef } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";

import { cn } from "@/lib/cn";
import { Button } from "@/design-system/components/Button";
import { AppCopyButton } from "@/design-system/components/AppCopyButton";

export interface ErrorCardProps {
  /** Human-readable error message. Empty falls back to a sentence. */
  message: string;
  /** Optional raw error payload — surfaced via the Copy button. */
  payload?: string;
  /** Optional timestamp string. */
  timestamp?: string;
  /** Re-run the prior turn. */
  onRetry?: () => void;
  className?: string;
}

/**
 * Fatal model / provider error row. Sits left-aligned at reply-cap
 * width. Mirrors `PiAgentNativeErrorRowView`.
 */
export const ErrorCard = forwardRef<HTMLDivElement, ErrorCardProps>(function ErrorCard(
  { message, payload, timestamp, onRetry, className },
  ref,
) {
  const detail = message.trim().length > 0 ? message : "The model provider returned an error.";
  return (
    <div
      ref={ref}
      data-testid="error-card"
      className={cn(
        "rounded-xl border p-3 flex items-start gap-3",
        "border-danger/45 bg-danger/10",
        className,
      )}
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
      <div className="min-w-0 flex-1 flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-caption font-semibold tracking-wide text-text-primary">Error</span>
          {timestamp ? (
            <span className="shrink-0 text-detail text-text-muted">{timestamp}</span>
          ) : null}
        </div>
        <span className="text-caption text-text-secondary">{detail}</span>
        {(onRetry || payload) && (
          <div className="mt-1 flex items-center gap-2">
            {onRetry ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={onRetry}
                aria-label="Retry"
                className="gap-1"
              >
                <RefreshCcw className="h-3 w-3" aria-hidden="true" />
                Retry
              </Button>
            ) : null}
            {payload ? <AppCopyButton text={payload} aria-label="Copy error payload" /> : null}
          </div>
        )}
      </div>
    </div>
  );
});

export default ErrorCard;
