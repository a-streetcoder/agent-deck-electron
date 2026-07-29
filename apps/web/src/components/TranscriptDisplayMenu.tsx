import {
  coerceTranscriptVisibility,
  type TranscriptVisibilitySettings,
} from "@agent-deck/contracts";
import { Brain, Eye, FileDiff, Globe, Image, Lightbulb, Plug, RotateCw } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { ControlButton } from "@/design-system/components/NativeControls";
import { cn } from "@/lib/cn";
import { useAppStore } from "../state/store.ts";

type VisibilityKey = keyof TranscriptVisibilitySettings;

interface DisplayOption {
  key: VisibilityKey;
  label: string;
  description: string;
  Icon: LucideIcon;
}

const OPTIONS: readonly DisplayOption[] = [
  {
    key: "showThinking",
    label: "Thinking",
    description: "Show Pi reasoning blocks",
    Icon: Lightbulb,
  },
  {
    key: "showWebActivity",
    label: "Web activity",
    description: "Show searches and fetched or read links",
    Icon: Globe,
  },
  {
    key: "showDiffs",
    label: "Diffs",
    description: "Show file changes in chat",
    Icon: FileDiff,
  },
  {
    key: "showImages",
    label: "Images",
    description: "Show inline image previews in transcripts",
    Icon: Image,
  },
  {
    key: "showMemoryCards",
    label: "Memory",
    description: "Show memory activity cards in the transcript",
    Icon: Brain,
  },
  {
    key: "showMCPCards",
    label: "MCP",
    description: "Show MCP tool call cards in the transcript",
    Icon: Plug,
  },
];

interface SettingsResponse {
  settings?: {
    piAgentTranscriptVisibility?: unknown;
  };
}

export function TranscriptDisplayMenu() {
  const visibility = useAppStore((state) => state.transcriptVisibility);
  const loaded = useAppStore((state) => state.transcriptVisibilityLoaded);
  const loadError = useAppStore((state) => state.transcriptVisibilityLoadError);
  const setVisibility = useAppStore((state) => state.setTranscriptVisibility);
  const setLoaded = useAppStore((state) => state.setTranscriptVisibilityLoaded);
  const setLoadError = useAppStore((state) => state.setTranscriptVisibilityLoadError);
  const [open, setOpen] = useState(false);
  const [loadPending, setLoadPending] = useState(false);
  const [pendingKey, setPendingKey] = useState<VisibilityKey | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const loadGeneration = useRef(0);
  const loadInFlight = useRef(false);
  const mutationPending = useRef(false);

  const load = useCallback(async (): Promise<void> => {
    if (loadInFlight.current || mutationPending.current) return;
    loadInFlight.current = true;
    const generation = ++loadGeneration.current;
    setLoadPending(true);
    setError(null);
    try {
      const response = await fetch("/settings");
      if (!response.ok) throw new Error(`Settings request failed (${response.status})`);
      const data = (await response.json()) as SettingsResponse;
      if (generation !== loadGeneration.current) return;
      setVisibility(coerceTranscriptVisibility(data.settings?.piAgentTranscriptVisibility));
      setLoaded(true);
      setLoadError(null);
    } catch (cause) {
      if (generation === loadGeneration.current) {
        setLoadError(
          cause instanceof Error ? cause.message : "Transcript settings could not be loaded",
        );
      }
    } finally {
      loadInFlight.current = false;
      if (generation === loadGeneration.current) setLoadPending(false);
    }
  }, [setLoadError, setLoaded, setVisibility]);

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => {
      panelRef.current?.querySelector<HTMLButtonElement>('[role="switch"]:not(:disabled)')?.focus();
    });
    const dismiss = (event: MouseEvent): void => {
      if (wrapperRef.current && !wrapperRef.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const toggle = async (key: VisibilityKey): Promise<void> => {
    if (!loaded || loadInFlight.current || mutationPending.current) return;
    mutationPending.current = true;
    const previous = useAppStore.getState().transcriptVisibility;
    const next = { ...previous, [key]: !previous[key] };
    setVisibility(next);
    setPendingKey(key);
    setError(null);
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ piAgentTranscriptVisibility: { [key]: next[key] } }),
      });
      if (!response.ok) throw new Error(`Settings update failed (${response.status})`);
      const data = (await response.json()) as SettingsResponse;
      setVisibility(coerceTranscriptVisibility(data.settings?.piAgentTranscriptVisibility));
      setLoadError(null);
    } catch (cause) {
      setVisibility(previous);
      setError(cause instanceof Error ? cause.message : "Transcript settings could not be saved");
    } finally {
      mutationPending.current = false;
      setPendingKey(null);
    }
  };

  return (
    <div ref={wrapperRef} className="relative [-webkit-app-region:no-drag]">
      <ControlButton
        ref={triggerRef}
        type="button"
        className={cn(
          "rounded-md p-1.5 transition-colors hover:bg-hover",
          open ? "bg-selection text-accent" : "text-text-muted",
        )}
        title="Choose what appears in the agent transcript"
        aria-label="Transcript display"
        aria-haspopup="dialog"
        aria-expanded={open}
        data-testid="transcript-display-trigger"
        onClick={() => setOpen((value) => !value)}
      >
        <Eye aria-hidden="true" className="h-4 w-4" />
      </ControlButton>

      {open ? (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Transcript display"
          aria-busy={loadPending || pendingKey !== null}
          data-testid="transcript-display-menu"
          className="absolute right-0 top-full z-30 mt-1.5 w-80 rounded-xl border border-border-strong bg-surface-elevated p-2 shadow-elevated"
        >
          <div className="px-2 pb-2 pt-1 text-label font-semibold text-text-primary">
            Transcript display
          </div>
          {loaded ? (
            <div className="space-y-0.5">
              {OPTIONS.map(({ key, label, description, Icon }) => {
                const descriptionId = `transcript-display-${key}-description`;
                return (
                  <div
                    key={key}
                    className="flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-hover"
                  >
                    <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-text-muted" />
                    <div className="min-w-0 flex-1">
                      <div className="text-label font-medium text-text-primary">{label}</div>
                      <div id={descriptionId} className="text-detail text-text-muted">
                        {description}
                      </div>
                    </div>
                    <ControlButton
                      type="button"
                      role="switch"
                      aria-checked={visibility[key]}
                      aria-label={label}
                      aria-describedby={descriptionId}
                      disabled={loadPending || pendingKey !== null}
                      data-testid={`transcript-display-${key}`}
                      onClick={() => void toggle(key)}
                      className={cn(
                        "relative mt-0.5 h-6 w-11 shrink-0 rounded-capsule transition-colors disabled:opacity-50",
                        visibility[key] ? "bg-accent" : "bg-border-strong",
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-0.5 h-5 w-5 rounded-full bg-white transition-all",
                          visibility[key] ? "left-[22px]" : "left-0.5",
                        )}
                      />
                    </ControlButton>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="px-2 py-3 text-detail text-text-muted">
              {loadPending || !loadError
                ? "Loading transcript preferences…"
                : "Preferences are unavailable."}
            </div>
          )}
          {error || loadError ? (
            <div className="mx-2 mt-1 flex items-center justify-between gap-3 rounded-md bg-danger-subtle px-2 py-1.5">
              <span role="alert" className="min-w-0 text-detail text-danger">
                {error ?? loadError}
              </span>
              {loadError ? (
                <ControlButton
                  type="button"
                  className="flex shrink-0 items-center gap-1 text-detail font-medium text-text-primary"
                  disabled={loadPending || pendingKey !== null}
                  onClick={() => void load()}
                >
                  <RotateCw aria-hidden="true" className="h-3 w-3" />
                  Retry
                </ControlButton>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
