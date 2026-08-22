import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type AppInlineNoticeTone = "neutral" | "warning" | "danger" | "success";

export type AppInlineNoticeProps = {
  tone?: AppInlineNoticeTone;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
};

const toneClass: Record<AppInlineNoticeTone, string> = {
  neutral: "border-border-subtle bg-surface-subtle text-text-secondary",
  warning: "border-warning/30 bg-warning-subtle text-warning",
  danger: "border-danger/30 bg-danger-subtle text-danger",
  success: "border-success/30 bg-success-subtle text-success",
};

export function AppInlineNotice({
  tone = "neutral",
  children,
  action,
  className,
}: AppInlineNoticeProps) {
  const alert = tone === "warning" || tone === "danger";
  return (
    <div
      role={alert ? "alert" : "status"}
      className={cn(
        "flex items-start gap-3 rounded-lg border px-3 py-2 text-caption",
        toneClass[tone],
        className,
      )}
    >
      <div className="min-w-0 flex-1">{children}</div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}
