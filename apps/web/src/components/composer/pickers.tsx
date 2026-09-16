import { AppTextField } from "@/design-system/components/AppTextField";
import { ControlButton } from "@/design-system/components/NativeControls";
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Bot, Brain, ChevronDown, Cpu, Search, Square } from "lucide-react";
import type { SessionModelInfo } from "@agent-deck/contracts";
import { THINKING_LEVELS, type AgentInfo, type ThinkingLevel } from "@agent-deck/domain";
import { cn } from "@/lib/cn";
import { sectionHeaderClass } from "@/design-system/styles";
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
    "flex min-h-control-sm items-center gap-control-gap rounded-capsule border px-control-x-sm text-detail font-medium outline-none transition-colors",
    "focus-visible:ring-2 focus-visible:ring-primary/30 disabled:cursor-not-allowed disabled:opacity-55",
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

export function AgentChip({
  currentName,
  agents,
  projectScoped,
  onSelect,
  disabled = false,
}: {
  currentName: string | null;
  agents: readonly Pick<AgentInfo, "description" | "filePath" | "name" | "scope" | "whenToUse">[];
  projectScoped: boolean;
  onSelect: (name: string | null) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const ref = useDismiss(() => setOpen(false));
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const prioritizedAgents = [...agents].sort((left, right) => {
    if (left.name === currentName) return -1;
    if (right.name === currentName) return 1;
    if (projectScoped) {
      const leftAssigned = left.scope !== "builtin";
      const rightAssigned = right.scope !== "builtin";
      if (leftAssigned !== rightAssigned) return leftAssigned ? -1 : 1;
    }
    return 0;
  });
  const matchingAgents = normalizedQuery
    ? prioritizedAgents.filter((agent) =>
        `${agent.name} ${agent.scope} ${agent.description ?? ""} ${agent.whenToUse ?? ""}`
          .toLocaleLowerCase()
          .includes(normalizedQuery),
      )
    : prioritizedAgents;
  const visibleAgents = normalizedQuery ? matchingAgents : matchingAgents.slice(0, 12);
  const hiddenCount = matchingAgents.length - visibleAgents.length;

  const select = (name: string | null): void => {
    if (disabled) return;
    setOpen(false);
    onSelect(name);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  return (
    <div className="relative" ref={ref}>
      <ControlButton
        ref={triggerRef}
        data-testid="agent-picker"
        className={chipClass(open)}
        title="Agent"
        aria-haspopup="dialog"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (open) {
            setOpen(false);
            return;
          }
          setOpen(true);
          requestAnimationFrame(() => searchRef.current?.focus());
        }}
      >
        <Bot size={12} />
        <span className="max-w-[16ch] truncate" data-testid="agent-chip-label">
          {currentName ?? "Orchestrator"}
        </span>
        <ChevronDown size={11} className="opacity-60" />
      </ControlButton>
      {open ? (
        <div
          data-testid="agent-menu"
          role="dialog"
          aria-label="Choose agent"
          className="absolute bottom-full left-0 z-20 mb-1.5 flex max-h-96 w-72 flex-col overflow-hidden rounded-xl border border-border-strong bg-surface-elevated shadow-elevated"
        >
          <div className="border-b border-border-subtle p-2">
            <AppTextField
              ref={searchRef}
              size="sm"
              value={query}
              onChange={setQuery}
              leadingIcon={<Search aria-hidden />}
              placeholder="Search agents"
              aria-label="Search agents"
              showClear
            />
          </div>
          <div className="min-h-0 overflow-y-auto p-1.5">
            <ControlButton
              data-testid="agent-option-default"
              className={cn(
                "flex w-full items-start gap-2 rounded-lg px-2 py-2 text-left",
                currentName === null
                  ? "bg-selection text-text-primary"
                  : "text-text-secondary hover:bg-hover",
              )}
              onClick={() => select(null)}
            >
              <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-icon bg-accent/20 text-accent">
                <Bot size={12} aria-hidden />
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex items-center justify-between gap-2 text-label font-medium">
                  <span>Orchestrator</span>
                  <span className="text-micro font-medium text-accent">Default</span>
                </span>
                <span className="mt-0.5 block text-detail text-text-muted">
                  Runs the conversation and delegates to specialists.
                </span>
              </span>
            </ControlButton>
            <div className={cn(sectionHeaderClass, "px-2 pb-1 pt-3 text-text-muted")}>
              {projectScoped ? "Available for this project" : "All agents"}
            </div>
            <div role="listbox" aria-label="Agents">
              {visibleAgents.map((agent) => (
                <ControlButton
                  key={agent.filePath}
                  role="option"
                  aria-selected={agent.name === currentName}
                  data-testid={`agent-option-${agent.name}`}
                  className={cn(
                    "flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-detail",
                    agent.name === currentName
                      ? "bg-selection text-text-primary"
                      : "text-text-secondary hover:bg-hover",
                  )}
                  onClick={() => select(agent.name)}
                >
                  <span className="truncate">{agent.name}</span>
                  <span className="shrink-0 text-micro text-text-muted">{agent.scope}</span>
                </ControlButton>
              ))}
            </div>
            {visibleAgents.length === 0 ? (
              <div className="px-2 py-3 text-caption text-text-muted">No matching agents.</div>
            ) : hiddenCount > 0 ? (
              <div className="px-2 py-2 text-detail text-text-muted">
                Search to find {hiddenCount} more agent{hiddenCount === 1 ? "" : "s"}.
              </div>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
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
              <div className="flex items-center gap-1.5 px-2 pb-0.5 pt-1.5 text-micro font-medium text-text-muted">
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
          "flex h-9 w-9 items-center justify-center rounded-full bg-primary text-on-accent shadow-capsule transition-all hover:bg-primary-hover disabled:opacity-40",
        )}
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
