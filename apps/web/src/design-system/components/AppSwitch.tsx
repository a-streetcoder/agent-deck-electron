import { forwardRef, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "../../lib/cn";

export type AppSwitchProps = {
  checked: boolean;
  onCheckedChange: (next: boolean) => void;
  disabled?: boolean;
  children?: ReactNode;
  "aria-label"?: string;
  "aria-describedby"?: string;
  "aria-busy"?: boolean;
  className?: string;
  id?: string;
  "data-testid"?: string;
};

export const AppSwitch = forwardRef<HTMLButtonElement, AppSwitchProps>(function AppSwitch(
  {
    checked,
    onCheckedChange,
    disabled,
    children,
    className,
    id,
    "aria-label": ariaLabel,
    "aria-describedby": ariaDescribedBy,
    "aria-busy": ariaBusy,
    "data-testid": testId,
  },
  ref,
) {
  const toggle = () => {
    if (disabled) return;
    onCheckedChange(!checked);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      toggle();
    }
  };

  return (
    <label
      className={cn(
        "inline-flex items-center gap-2 text-label text-text-primary",
        disabled && "opacity-disabled",
        className,
      )}
    >
      <button
        ref={ref}
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={ariaLabel}
        aria-describedby={ariaDescribedBy}
        aria-busy={ariaBusy}
        data-testid={testId}
        disabled={disabled}
        onClick={toggle}
        onKeyDown={onKeyDown}
        className={cn(
          "inline-flex h-switch-track-h w-switch-track-w shrink-0 items-center rounded-capsule px-0.5",
          "transition-colors duration-fast ease-standard",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:ring-offset-1 focus-visible:ring-offset-surface",
          checked
            ? "justify-end border border-transparent bg-accent"
            : "justify-start border border-border-strong bg-surface-subtle",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "size-switch-thumb rounded-capsule shadow-capsule",
            checked ? "bg-text-on-accent" : "bg-surface-elevated",
          )}
        />
      </button>
      {children}
    </label>
  );
});
