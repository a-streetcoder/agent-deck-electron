import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../../lib/cn";

/** Shared sheet inner width and horizontal padding (`--size-sheet` / `--space-sheet`). */
export const SheetContainer = forwardRef<HTMLDivElement, HTMLAttributes<HTMLDivElement>>(
  function SheetContainer({ className, ...rest }, ref) {
    return (
      <div ref={ref} className={cn("mx-auto w-full max-w-sheet px-sheet", className)} {...rest} />
    );
  },
);

export default SheetContainer;
