import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";
import { SheetContainer } from "./SheetContainer";

export interface SheetFooterProps extends HTMLAttributes<HTMLDivElement> {
  /** Leading slot (typically Back). */
  leading?: ReactNode;
  /** Trailing slot (typically the primary CTA). Stays on the right when leading is absent. */
  trailing?: ReactNode;
}

/**
 * Sheet/dialog footer chrome: full-bleed top hairline.
 * The divider belongs to this bar, not the last list item.
 */
export const SheetFooter = forwardRef<HTMLDivElement, SheetFooterProps>(function SheetFooter(
  { leading, trailing, className, children, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn("w-full shrink-0 border-t border-border-subtle py-4", className)}
      {...rest}
    >
      <SheetContainer
        className={cn("flex items-center", leading ? "justify-between" : "justify-end")}
      >
        {leading ? <div className="flex items-center">{leading}</div> : null}
        {trailing ? (
          <div className={cn("flex items-center", !leading && "ml-auto")}>{trailing}</div>
        ) : null}
        {children}
      </SheetContainer>
    </div>
  );
});

export default SheetFooter;
