import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * Sheet/dialog header chrome: full-bleed bottom hairline and standard padding.
 * Body content must not add a trailing divider.
 */
export const SheetHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function SheetHeader({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "flex shrink-0 items-center gap-2 border-b border-border-subtle px-5 py-3",
          className,
        )}
        {...rest}
      />
    );
  },
);

export default SheetHeader;
