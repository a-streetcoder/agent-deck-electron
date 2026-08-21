import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export type AppLabelTagVariant = "default" | "success" | "warning" | "error" | "info" | "neutral";

export interface AppLabelTagProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: AppLabelTagVariant;
  children: ReactNode;
}

/**
 * Status pill. Mirrors the macOS `AppLabelTag` (caption semibold expanded
 * width, 8pt h-pad / 4pt v-pad, 8pt corner radius, stroke at 55% of color,
 * text in the same hue).
 */
const variantClasses: Record<AppLabelTagVariant, string> = {
  default: cn("border-border-strong/55 text-text-primary", "bg-surface-subtle"),
  success: cn("border-diff-added/55 text-diff-added", "bg-diff-added/10"),
  warning: cn("border-warning/55 text-warning", "bg-warning/10"),
  error: cn("border-danger/55 text-danger", "bg-danger/10"),
  info: cn("border-accent/55 text-accent", "bg-accent/10"),
  neutral: cn("border-border-subtle text-text-muted", "bg-transparent"),
};

export const AppLabelTag = forwardRef<HTMLSpanElement, AppLabelTagProps>(function AppLabelTag(
  { variant = "default", className, children, ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      data-variant={variant}
      className={cn(
        "inline-flex items-center gap-1",
        "rounded-md border px-2 py-0.5",
        "text-micro font-medium",
        "select-none whitespace-nowrap",
        variantClasses[variant],
        className,
      )}
      {...rest}
    >
      {children}
    </span>
  );
});

export default AppLabelTag;
