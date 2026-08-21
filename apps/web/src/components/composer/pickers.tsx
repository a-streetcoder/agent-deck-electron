import { ControlButton } from "@/design-system/components/NativeControls";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Brain, ChevronDown, Cpu, Square } from "lucide-react";
import type { SessionModelInfo } from "@agent-deck/contracts";
import { THINKING_LEVELS, type ThinkingLevel } from "@agent-deck/domain";
import { cn } from "@/lib/cn";
import { ProviderLogo } from "../ProviderLogo.tsx";

/**
 * Composer footer chips + send button, styled per the native composer footer
 * (PiAgentComposerFooterBar): glass capsule chips for model and thinking,
 * and a prominent circular send/stop button with a symbol swap.
 */

export type PiModelInfo = SessionModelInfo;

export interface PiComposerState {
  provider?: string;
  modelId?: string;
  thinkingLevel: string;
}

export function chipClass(active = false): string {
  return cn(
    "flex items-center gap-1.5 rounded-capsule border px-2.5 py-1 text-detail font-medium transition-colors",
    active
      ? "border-selection-stroke bg-selection text-text-primary"
      : "border-border-subtle bg-surface text-text-secondary hover:border-border-strong hover:text-text-primary",
  );
}

function useDismiss(onDismiss: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onMouse = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onDismiss();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onDismiss();
        // Return focus to the trigger (first button inside the wrapper).
        ref.current?.querySelector("button")?.focus();
      }
    };
    document.addEventListener("mousedown", onMouse);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onMouse);
      document.removeEventListener("keydown", onKey);
    };
  }, [onDismiss]);
  return ref;
}

export function ModelChip({
  state,
  models,
  onSelect,
  disabled = false,
}: {
  state: PiComposerState | null;
  models: PiModelInfo[];
  onSelect: (model: PiModelInfo) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(() => setOpen(false));
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  const byProvider = new Map<string, PiModelInfo[]>();
  for (const model of models) {
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  }

  return (
    <div className="relative" ref={ref}>
      <ControlButton
        data-testid="model-chip"
        className={chipClass(open)}
        title="Model"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
      >
        {state?.provider ? (
          <ProviderLogo providerId={state.provider} size={13} />
        ) : (
          <Cpu size={12} />
        )}
        <span className="max-w-[16ch] truncate" data-testid="model-chip-label">
          {state?.modelId ?? "model"}
        </span>
        <ChevronDown size={11} className="opacity-60" />
      </ControlButton>
      {open ? (
        <div
          data-testid="model-menu"
          role="listbox"
          aria-label="Model"
          className="absolute bottom-full left-0 z-20 mb-1.5 max-h-72 w-64 overflow-y-auto rounded-xl border border-border-strong bg-surface-elevated p-1.5 shadow-elevated"
        >
          {[...byProvider.entries()].map(([provider, providerModels]) => (
            <div key={provider}>
              <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-micro font-semibold uppercase tracking-overline text-text-muted">
                <ProviderLogo providerId={provider} size={12} className="text-text-secondary" />
                {provider}
              </div>
              {providerModels.map((model) => (
                <ControlButton
                  key={`${model.provider}/${model.id}`}
                  data-testid={`model-option-${model.id}`}
                  className={cn(
                    "block w-full truncate rounded-md px-2 py-1 text-left text-detail",
                    "disabled:cursor-not-allowed disabled:opacity-40",
                    model.id === state?.modelId && model.provider === state?.provider
                      ? "bg-selection text-text-primary"
                      : "text-text-secondary hover:bg-hover",
                  )}
                  disabled={disabled}
                  onClick={() => {
                    if (disabled) return;
                    setOpen(false);
                    onSelect(model);
                  }}
                >
                  {model.id}
                </ControlButton>
              ))}
            </div>
          ))}
          {models.length === 0 ? (
            <div className="px-2 py-2 text-detail text-text-muted">No models available.</div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export function ThinkingChip({
  state,
  levels = THINKING_LEVELS,
  metadataStatus = "known",
  onSelect,
  disabled = false,
}: {
  state: PiComposerState | null;
  /** Exact levels the current model supports, as computed by pinned Pi. */
  levels?: readonly ThinkingLevel[];
  /** Unknown metadata never speculates about availability or opens a stale menu. */
  metadataStatus?: "loading" | "known" | "unavailable";
  onSelect: (level: ThinkingLevel) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const pickerDisabled = disabled || metadataStatus !== "known" || levels.length === 0;
  const ref = useDismiss(() => setOpen(false));
  useEffect(() => {
    if (pickerDisabled) setOpen(false);
  }, [pickerDisabled]);

  const current = state?.thinkingLevel;
  const availabilityKnown = metadataStatus === "known" && levels.length > 0;
  const label =
    current == null
      ? "thinking"
      : metadataStatus === "unavailable" || (metadataStatus === "known" && levels.length === 0)
        ? `${current} · levels unavailable`
        : availabilityKnown && !(levels as readonly string[]).includes(current)
          ? `${current} unavailable`
          : current;
  const title =
    metadataStatus === "loading"
      ? "Thinking levels are loading"
      : metadataStatus === "unavailable" || levels.length === 0
        ? "Thinking levels are unavailable for this model; retry by reopening the session"
        : "Thinking level";

  const openAt = (index: number): void => {
    if (pickerDisabled) return;
    const bounded = Math.max(0, Math.min(index, levels.length - 1));
    setFocusedIndex(bounded);
    setOpen(true);
    requestAnimationFrame(() => optionRefs.current[bounded]?.focus());
  };
  const select = (level: ThinkingLevel): void => {
    if (pickerDisabled) return;
    setOpen(false);
    onSelect(level);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div className="relative" ref={ref}>
      <ControlButton
        ref={triggerRef}
        data-testid="thinking-chip"
        className={cn(
          chipClass(open),
          pickerDisabled &&
            !disabled &&
            "cursor-not-allowed opacity-60 focus-visible:ring-2 focus-visible:ring-accent",
        )}
        title={title}
        aria-label={title}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-disabled={pickerDisabled}
        aria-busy={metadataStatus === "loading" || undefined}
        disabled={disabled}
        onClick={() => {
          if (pickerDisabled) return;
          if (open) setOpen(false);
          else openAt(Math.max(0, levels.indexOf(current as ThinkingLevel)));
        }}
        onKeyDown={(event) => {
          if (pickerDisabled) return;
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            openAt(event.key === "ArrowDown" ? 0 : levels.length - 1);
          }
        }}
      >
        <Brain size={12} />
        <span data-testid="thinking-chip-label" className="max-w-[16ch] truncate" title={label}>
          {label}
        </span>
        <ChevronDown size={11} className="opacity-60" />
      </ControlButton>
      {open ? (
        <div
          data-testid="thinking-menu"
          role="listbox"
          aria-label="Thinking level"
          className="absolute bottom-full left-0 z-20 mb-1.5 w-36 rounded-xl border border-border-strong bg-surface-elevated p-1.5 shadow-elevated"
        >
          {levels.map((level, index) => (
            <ControlButton
              ref={(element) => {
                optionRefs.current[index] = element;
              }}
              key={level}
              role="option"
              aria-selected={level === state?.thinkingLevel}
              tabIndex={index === focusedIndex ? 0 : -1}
              data-testid={`thinking-option-${level}`}
              className={cn(
                "block w-full rounded-md px-2 py-1 text-left text-detail outline-none focus-visible:ring-2 focus-visible:ring-accent",
                level === state?.thinkingLevel
                  ? "bg-selection text-text-primary"
                  : "text-text-secondary hover:bg-hover",
              )}
              onFocus={() => setFocusedIndex(index)}
              onKeyDown={(event) => {
                let next: number | undefined;
                if (event.key === "ArrowDown") next = (index + 1) % levels.length;
                else if (event.key === "ArrowUp")
                  next = (index - 1 + levels.length) % levels.length;
                else if (event.key === "Home") next = 0;
                else if (event.key === "End") next = levels.length - 1;
                else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  select(level);
                  return;
                }
                if (next !== undefined) {
                  event.preventDefault();
                  setFocusedIndex(next);
                  optionRefs.current[next]?.focus();
                }
              }}
              onClick={() => select(level)}
            >
              {level}
            </ControlButton>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SendStopButton({
  running,
  disabled,
  onSend,
  onStop,
}: {
  running: boolean;
  disabled: boolean;
  onSend: () => void;
  onStop: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      {running ? (
        <ControlButton
          data-testid="abort-button"
          className="flex h-9 w-9 items-center justify-center rounded-full shadow-capsule transition-all"
          style={{
            background: "var(--color-role-error)",
            color: "var(--color-text-inverse)",
          }}
          title="Stop current response"
          aria-label="Stop current response"
          onClick={onStop}
        >
          <Square size={13} fill="currentColor" />
        </ControlButton>
      ) : null}
      <ControlButton
        data-testid="send-button"
        className={cn(
          "flex h-9 w-9 items-center justify-center rounded-full shadow-capsule transition-all disabled:opacity-40",
        )}
        style={{
          background:
            "linear-gradient(180deg, var(--color-brand-accent-bright), var(--color-brand-accent))",
          color: "var(--color-text-on-accent)",
        }}
        disabled={disabled}
        title={running ? "Queue input" : "Send"}
        aria-label={running ? "Queue input" : "Send"}
        onClick={onSend}
      >
        <ArrowUp size={16} strokeWidth={2.5} />
      </ControlButton>
    </div>
  );
}
