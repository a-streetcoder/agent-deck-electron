import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";
import { SheetContainer } from "./SheetContainer";

/**
 * Sheet/dialog header chrome: full-bleed bottom hairline.
 * Body content must not add a trailing divider.
 */
export const SheetHeader = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function SheetHeader({ className, children, ...rest }, ref) {
    return (
      <div ref={ref} className="shrink-0 border-b border-border-subtle py-3" {...rest}>
        <SheetContainer className={cn("flex items-center gap-2", className)}>
          {children}
        </SheetContainer>
      </div>
    );
  },
);

export default SheetHeader;
