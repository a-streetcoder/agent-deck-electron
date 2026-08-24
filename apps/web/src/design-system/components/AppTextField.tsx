import {
  forwardRef,
  useCallback,
  useRef,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { cn } from "../../lib/cn";

export type AppTextFieldSize = "sm" | "md" | "lg";

export interface AppTextFieldProps
  extends Omit<InputHTMLAttributes<HTMLInputElement>, "size" | "value" | "onChange" | "onSubmit"> {
  /** Controlled value. */
  value: string;
  /** Controlled onChange; receives the new string value. */
  onChange: (next: string) => void;
  /** Visual size: matches macOS controlSize small / regular / large. */
  size?: AppTextFieldSize;
  /** Optional leading icon (e.g. a lucide-react Search). */
  leadingIcon?: ReactNode;
  /** Optional trailing slot (key hint, status pip, etc). */
  trailing?: ReactNode;
  /**
   * Render a clear button when `value` is non-empty. Calls
   * `onChange('')` and refocuses the input.
   */
  showClear?: boolean;
  /** Aria label for the clear button. Defaults to "Clear". */
  clearLabel?: string;
  /**
   * Optional submit callback fired on Enter. The host can prevent default
   * by calling `event.preventDefault()` inside it.
   */
  onSubmit?: (value: string) => void;
}

const sizeClasses: Record<AppTextFieldSize, string> = {
  sm: "min-h-control-sm px-control-x-sm text-detail",
  md: "min-h-control-md px-control-x-md text-label tracking-ui",
  lg: "min-h-control-lg px-control-x-lg text-label tracking-ui",
};

/**
 * Controlled text input that mirrors the macOS `AppTextField`:
 *
 *  - 1pt subtle stroke at rest, 2pt brand-accent stroke on focus
 *  - 6pt corner radius (rounded-sm in the cross-platform tokens)
 *  - leading icon + trailing slot + optional clear button
 *  - Escape blurs (Cmd+. in the original; we use the web idiom)
 */
export const AppTextField = forwardRef<HTMLInputElement, AppTextFieldProps>(function AppTextField(
  {
    value,
    onChange,
    size = "md",
    leadingIcon,
    trailing,
    showClear = false,
    clearLabel = "Clear",
    onSubmit,
    onKeyDown,
    className,
    disabled,
    ...rest
  },
  ref,
) {
  const inputRef = useRef<HTMLInputElement | null>(null);

  const setRefs = useCallback(
    (node: HTMLInputElement | null) => {
      inputRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.currentTarget.blur();
      }
      if (event.key === "Enter") {
        onSubmit?.(event.currentTarget.value);
      }
      onKeyDown?.(event);
    },
    [onKeyDown, onSubmit],
  );

  const handleClear = useCallback(() => {
    onChange("");
    // Keep focus on the input after clearing so subsequent typing works.
    inputRef.current?.focus();
  }, [onChange]);

  const showClearButton = showClear && value.length > 0 && !disabled;

  return (
    <div
      className={cn(
        "group box-border flex w-full items-center gap-control-gap rounded-control border",
        "border-border-strong bg-surface-elevated text-text-primary",
        "transition-colors duration-150 ease-spring",
        "focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/30",
        disabled && "opacity-55",
        sizeClasses[size],
        className,
      )}
    >
      {leadingIcon ? (
        <span className="flex shrink-0 items-center text-text-muted [&_svg]:h-3.5 [&_svg]:w-3.5">
          {leadingIcon}
        </span>
      ) : null}
      <input
        ref={setRefs}
        type="text"
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        className={cn("min-w-0 flex-1 bg-transparent outline-none placeholder:text-text-muted")}
        {...rest}
      />
      {showClearButton ? (
        <button
          type="button"
          aria-label={clearLabel}
          onClick={handleClear}
          className={cn(
            "-mr-1 inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-control",
            "text-text-muted hover:bg-hover hover:text-text-primary",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
          )}
        >
          <X className="h-3 w-3" aria-hidden />
        </button>
      ) : null}
      {trailing ? (
        <span className="flex shrink-0 items-center text-text-muted">{trailing}</span>
      ) : null}
    </div>
  );
});

export default AppTextField;
