import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type DetailHeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  leading?: ReactNode;
  trailing?: ReactNode;
  className?: string;
};

export function DetailHeader({ title, subtitle, leading, trailing, className }: DetailHeaderProps) {
  return (
    <header
      className={cn(
        "flex shrink-0 items-center gap-3 border-b border-border-subtle bg-surface px-page-x py-3",
        className,
      )}
    >
      {leading ? <div className="shrink-0">{leading}</div> : null}
      <div className="min-w-0 flex-1">
        <h3 className="truncate text-title font-semibold tracking-title text-text-primary">
          {title}
        </h3>
        {subtitle ? (
          <div className="truncate text-caption text-text-secondary">{subtitle}</div>
        ) : null}
      </div>
      {trailing ? <div className="flex shrink-0 items-center gap-2">{trailing}</div> : null}
    </header>
  );
}
