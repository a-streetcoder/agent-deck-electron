import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/**
 * Sheet/dialog footer chrome: full-bleed top hairline and standard padding.
 * The divider belongs to this bar, not the last list item.
 */
export const SheetFooter = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function SheetFooter({ className, ...rest }, ref) {
    return (
      <div
        ref={ref}
        className={cn(
          "flex shrink-0 items-center justify-between border-t border-border-subtle px-5 py-3",
          className,
        )}
        {...rest}
      />
    );
  },
);

export default SheetFooter;
