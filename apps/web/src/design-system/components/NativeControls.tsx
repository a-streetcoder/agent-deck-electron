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

export const ControlSelect = forwardRef<HTMLSelectElement, ComponentPropsWithoutRef<"select">>(
  function ControlSelect({ className, ...props }, ref) {
    return (
      <div className="relative block w-full">
        <select ref={ref} className={cn("w-full appearance-none", className, "pe-8")} {...props} />
        <ChevronDown
          aria-hidden
          size={16}
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-text-muted"
        />
      </div>
    );
  },
);
