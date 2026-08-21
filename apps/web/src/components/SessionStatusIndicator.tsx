import { selectedSessionStatus } from "@/lib/sessionStatus";
import { useAppStore } from "../state/store.ts";

/**
 * Selected-chat Pi/WS status. Live transport and activity outrank durable
 * terminal metadata; `agent_end` must not erase a persisted failure.
 */
export function SessionStatusIndicator({ attachTestId }: { attachTestId: boolean }) {
  const connection = useAppStore((state) => state.connection);
  const agentStatus = useAppStore((state) => state.transcript.agentStatus);
  const session = useAppStore((state) => state.session);
  const parkedStatus =
    connection === "open" &&
    agentStatus !== "running" &&
    session?.status !== "failed" &&
    Boolean(session?.parkedAt);
  const statusLabel = parkedStatus
    ? "Parked · resumes on next command"
    : selectedSessionStatus(connection, agentStatus, session?.status);
  const statusToken = parkedStatus ? "parked" : statusLabel;
  const statusColor =
    connection !== "open"
      ? "var(--color-warning)"
      : agentStatus === "running"
        ? "var(--color-brand-accent)"
        : session?.status === "failed"
          ? "var(--color-danger)"
          : "var(--color-success)";

  return (
    <div
      className="flex items-center gap-1.5"
      data-testid={attachTestId ? "status-indicator" : undefined}
      data-status={statusToken}
      role={attachTestId ? "status" : undefined}
      aria-live={attachTestId ? "polite" : undefined}
      aria-atomic={attachTestId ? "true" : undefined}
    >
      <span
        className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
        style={{ background: statusColor }}
      />
      <span className="max-w-[16ch] truncate text-detail text-text-secondary">{statusLabel}</span>
    </div>
  );
}
