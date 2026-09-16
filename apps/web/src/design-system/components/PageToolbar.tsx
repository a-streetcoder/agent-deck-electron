import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export type PageToolbarProps = {
  leading?: ReactNode;
  trailing?: ReactNode;
  /** Optional second row for wrapping facets / filters. */
  below?: ReactNode;
  className?: string;
  /** Page gutters for full-width screens; panel gutters inside master panes. */
  inset?: "page" | "panel";
};

/**
 * Full-bleed chrome under {@link SectionHero}. Do not use unused Toolbar.tsx.
 */
export function PageToolbar({
  leading,
  trailing,
  below,
  className,
  inset = "page",
}: PageToolbarProps) {
  const insetClass = inset === "panel" ? "px-4" : "px-page-x";
  return (
    <div className={cn("z-sticky shrink-0 border-b border-border-subtle bg-surface", className)}>
      <div className={cn("flex min-h-page-toolbar flex-wrap items-center gap-3 py-2", insetClass)}>
        <div className="flex min-w-[12rem] flex-1 flex-wrap items-center gap-2">{leading}</div>
        {trailing ? (
          <div className="ml-auto flex shrink-0 flex-wrap items-center justify-end gap-2">
            {trailing}
          </div>
        ) : null}
      </div>
      {below ? (
        <div className={cn("flex flex-wrap items-center gap-2 pb-2", insetClass)}>{below}</div>
      ) : null}
    </div>
  );
}
