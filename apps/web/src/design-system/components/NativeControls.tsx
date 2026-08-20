import { forwardRef, type ComponentPropsWithoutRef } from "react";
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
    return <select ref={ref} className={cn(className, "pe-8")} {...props} />;
  },
);
