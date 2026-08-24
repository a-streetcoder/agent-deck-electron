import { forwardRef, type ComponentPropsWithoutRef } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Low-level native controls owned by the design system.
 *
 * These intentionally add no chrome: feature-specific compositions can retain
 * their layout while all native interaction elements pass through one typed,
 * auditable boundary. Prefer Button, IconButton, or TextField when their visual
 * contract fits; use these bases for specialized controls.
 */
export const ControlButton = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<"button">>(
  function ControlButton(props, ref) {
    return <button ref={ref} {...props} />;
  },
);

export const ControlInput = forwardRef<HTMLInputElement, ComponentPropsWithoutRef<"input">>(
  function ControlInput(props, ref) {
    return <input ref={ref} {...props} />;
  },
);

export const ControlTextArea = forwardRef<
  HTMLTextAreaElement,
  ComponentPropsWithoutRef<"textarea">
>(function ControlTextArea(props, ref) {
  return <textarea ref={ref} {...props} />;
});

export interface ControlSelectProps extends Omit<ComponentPropsWithoutRef<"select">, "size"> {
  size?: "sm" | "md" | "lg";
  /** Keep toolbar selects intrinsic; form selects fill their available width. */
  fullWidth?: boolean;
}

const selectSizeClasses: Record<NonNullable<ControlSelectProps["size"]>, string> = {
  sm: "min-h-control-sm px-control-x-sm pe-8 text-detail",
  md: "min-h-control-md px-control-x-md pe-9 text-label",
  lg: "min-h-control-lg px-control-x-lg pe-10 text-label",
};

export const ControlSelect = forwardRef<HTMLSelectElement, ControlSelectProps>(
  function ControlSelect({ className, size = "md", fullWidth = true, ...props }, ref) {
    return (
      <div className={cn("relative block", fullWidth ? "w-full" : "w-fit shrink-0")}>
        <select
          ref={ref}
          className={cn(
            "box-border appearance-none rounded-control border border-border-strong bg-surface-elevated text-text-primary outline-none",
            "transition-colors duration-150 ease-spring focus:border-primary focus:ring-2 focus:ring-primary/30",
            "disabled:pointer-events-none disabled:opacity-55",
            fullWidth ? "w-full" : "w-auto",
            selectSizeClasses[size],
            className,
          )}
          {...props}
        />
        <ChevronDown
          aria-hidden
          size={14}
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-text-muted"
        />
      </div>
    );
  },
);
