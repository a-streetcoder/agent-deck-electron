import type { ReactNode } from "react";
import { cn } from "../../lib/cn";
import { AppScrollView } from "./AppScrollView";

export type PageShellWidth = "page" | "narrow" | "split";

export type PageShellProps = {
  hero?: ReactNode;
  toolbar?: ReactNode | null;
  width?: PageShellWidth;
  children: ReactNode;
  className?: string;
  canvasClassName?: string;
  testId?: string;
};

const canvasWidthClass: Record<Exclude<PageShellWidth, "split">, string> = {
  page: "w-full px-page-x py-page-y",
  narrow: "mx-auto w-full max-w-page-narrow px-page-x py-page-y",
};

/**
 * Shared chrome for sidebar-launched views. Hero and toolbar stay full-bleed;
 * the canvas is not an extra elevated card.
 */
export function PageShell({
  hero,
  toolbar,
  width = "page",
  children,
  className,
  canvasClassName,
  testId,
}: PageShellProps) {
  const split = width === "split";

  return (
    <div
      className={cn("flex min-h-0 flex-1 flex-col bg-surface", className)}
      data-testid={testId}
      data-page-width={width}
    >
      {hero}
      {toolbar}
      {split ? (
        <div className={cn("flex min-h-0 flex-1 flex-col", canvasClassName)}>{children}</div>
      ) : (
        <AppScrollView className="flex-1" contentClassName={cn(canvasWidthClass[width], canvasClassName)}>
          {children}
        </AppScrollView>
      )}
    </div>
  );
}
