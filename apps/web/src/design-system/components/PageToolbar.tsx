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
    <div className={cn("z-sticky shrink-0 border-b border-border-subtle bg-surface", className)}>
      <div className="flex min-h-page-toolbar flex-wrap items-center gap-2 px-page-x py-2">
        <div className="flex min-w-[12rem] flex-1 flex-wrap items-center gap-2">{leading}</div>
        {trailing ? (
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
            {trailing}
          </div>
        ) : null}
      </div>
      {below ? (
        <div className="flex flex-wrap items-center gap-2 px-page-x pb-2">{below}</div>
      ) : null}
    </div>
  );
}
