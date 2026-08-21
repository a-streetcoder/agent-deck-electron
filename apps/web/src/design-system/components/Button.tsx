import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * Visual variants. Mirrors the macOS app's AppPrimaryButtonStyle,
 * AppSecondaryButtonStyle, AppPillButtonStyle, plus a ghost (transparent)
 * and a destructive (role-error filled) variant.
 */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "pill" | "destructive";

/** sm/md/lg map onto AppKit control sizes mini / small / regular. */
export type ButtonSize = "sm" | "md" | "lg";

/** `on-media` is for controls composited onto photographs / illustrations. */
export type ButtonTone = "default" | "on-media";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  tone?: ButtonTone;
  leadingIcon?: ReactNode;
  trailingIcon?: ReactNode;
  isLoading?: boolean;
  /** Stretches the button to fill its container. */
  fullWidth?: boolean;
  /**
   * Active-state styling used by the pill variant (mirrors
   * AppPillButtonStyle's `isActive`: brand-tinted glass + accent text).
   */
  isActive?: boolean;
}

const baseClasses = [
  "inline-flex items-center justify-center gap-1.5",
  "select-none whitespace-nowrap",
  "font-medium leading-none",
  "border transition-colors duration-150 ease-spring",
  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
  "disabled:opacity-55 disabled:pointer-events-none",
].join(" ");

const sizeClasses: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-detail rounded-md",
  md: "h-8 px-3 text-label rounded-md",
  lg: "h-10 px-4 text-label rounded-lg",
};

/**
 * Variant chrome. Notes on the mapping:
 *
 * - `primary` — capsule background with a top-left → bottom-right gradient
 *   from brandAccentBright → brandAccent (`bg-primary` resolves to the
 *   active theme accent; the hover state simulates accent-bright by
 *   stepping to `bg-primary-hover`). Capsule shadow approximates
 *   `shadow(brandAccent@0.18, radius 5)` from AppPrimaryButtonStyle.
 * - `secondary` — glass capsule chrome via the secondary card tokens.
 * - `ghost` — transparent default with neutral hover wash.
 * - `pill` — translucent glass capsule that brightens with `isActive` to
 *   match AppPillButtonStyle's brandAccent-tint behaviour.
 * - `destructive` — solid role-error capsule (no equivalent in
 *   DesignSystem.swift; matches sheet-level Delete affordances).
 */
const variantClasses: Record<ButtonVariant, string> = {
  primary: cn(
    "border-transparent text-on-accent",
    "bg-primary hover:bg-primary-hover active:opacity-86",
    "shadow-capsule",
  ),
  secondary: cn(
    "bg-surface-elevated text-text-primary",
    "border-border-strong hover:bg-hover",
    "shadow-card",
  ),
  ghost: cn("bg-transparent text-text-primary border-transparent", "hover:bg-hover"),
  pill: cn(
    "rounded-full border-transparent",
    "bg-surface-elevated/80 text-text-primary",
    "hover:bg-hover active:opacity-75",
    "data-[active=true]:bg-primary/20 data-[active=true]:text-accent",
    "data-[active=true]:font-semibold",
  ),
  destructive: cn(
    "border-transparent text-white",
    "bg-danger hover:opacity-90 active:opacity-80",
    "shadow-capsule",
  ),
};

/**
 * On-media overrides. Primary and destructive keep their fills; secondary,
 * ghost, and pill become frosted pills that read on dark photography.
 * Ring offset is dropped so the surface-colored halo does not flash on photos.
 */
const onMediaToneClasses: Record<ButtonVariant, string> = {
  primary: "focus-visible:ring-offset-0",
  secondary: cn(
    "focus-visible:ring-offset-0 shadow-none",
    "bg-media-overlay text-on-media border-on-media/25 hover:bg-media-overlay-strong",
  ),
  ghost: cn(
    "focus-visible:ring-offset-0",
    "bg-media-overlay text-on-media border-on-media/25 hover:bg-media-overlay-strong",
  ),
  pill: cn(
    "focus-visible:ring-offset-0",
    "bg-media-overlay text-on-media border-on-media/25 hover:bg-media-overlay-strong",
    "data-[active=true]:bg-on-media/20 data-[active=true]:text-on-media",
  ),
  destructive: "focus-visible:ring-offset-0 text-on-media",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "secondary",
    size = "md",
    tone = "default",
    leadingIcon,
    trailingIcon,
    isLoading = false,
    fullWidth = false,
    isActive = false,
    className,
    children,
    disabled,
    type = "button",
    ...rest
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      disabled={disabled || isLoading}
      aria-busy={isLoading || undefined}
      data-variant={variant}
      data-size={size}
      data-tone={tone}
      data-active={isActive ? "true" : undefined}
      className={cn(
        baseClasses,
        sizeClasses[size],
        variantClasses[variant],
        tone === "on-media" && onMediaToneClasses[variant],
        fullWidth && "w-full",
        className,
      )}
      {...rest}
    >
      {leadingIcon ? (
        <span className="-ml-0.5 flex shrink-0 items-center">{leadingIcon}</span>
      ) : null}
      <span className={cn(isLoading && "opacity-0")}>{children}</span>
      {trailingIcon && !isLoading ? (
        <span className="-mr-0.5 flex shrink-0 items-center">{trailingIcon}</span>
      ) : null}
      {isLoading ? (
        <span
          className="absolute h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-r-transparent"
          aria-hidden
        />
      ) : null}
    </button>
  );
});

export default Button;
