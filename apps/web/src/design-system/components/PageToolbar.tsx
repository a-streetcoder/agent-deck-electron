import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type PageToolbarProps = {
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Optional second row for wrapping facets / filters. */
  below?: ReactNode;
  className?: string;
};

/**
 * Full-bleed chrome under {@link SectionHero}. Do not use unused Toolbar.tsx.
 */
export function PageToolbar({ leading, trailing, below, className }: PageToolbarProps) {
  return (
    <div
      className={cn(
        "z-sticky shrink-0 border-b border-border-subtle bg-surface",
        className,
      )}
    >
      <div className="flex h-page-toolbar min-h-page-toolbar items-center gap-2 px-page-x">
        <div className="flex min-w-0 flex-1 items-center gap-2">{leading}</div>
        {trailing ? (
          <div className="flex shrink-0 items-center gap-2">{trailing}</div>
        ) : null}
      </div>
      {below ? <div className="px-page-x pb-2">{below}</div> : null}
    </div>
  );
}
