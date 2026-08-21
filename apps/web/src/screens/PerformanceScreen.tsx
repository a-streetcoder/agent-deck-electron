import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { SectionHero } from "@/design-system/components/SectionHero";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/cn";

interface ParkingSettings {
  piAgentIdleParkingEnabled: boolean;
  piAgentIdleParkingTimeoutMinutes: number;
}

type LoadState = "loading" | "ready" | "error";

export function PerformanceScreen() {
  const [settings, setSettings] = useState<ParkingSettings | null>(null);
  const [minutesDraft, setMinutesDraft] = useState("10");
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async (signal?: AbortSignal): Promise<void> => {
    setLoadState("loading");
    setMessage(null);
    try {
      const response = await fetch("/settings", { signal });
      if (!response.ok) throw new Error("We couldn’t load performance preferences.");
      const data = (await response.json()) as { settings: ParkingSettings };
      setSettings(data.settings);
      setMinutesDraft(String(data.settings.piAgentIdleParkingTimeoutMinutes));
      setLoadState("ready");
    } catch (cause) {
      if (signal?.aborted) return;
      setLoadState("error");
      setMessage(cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const update = async (patch: Partial<ParkingSettings>): Promise<boolean> => {
    if (!settings || saving) return false;
    const previous = settings;
    setSettings({ ...settings, ...patch });
    setSaving(true);
    setMessage("Saving…");
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error("We couldn’t save performance preferences.");
      const data = (await response.json()) as { settings: ParkingSettings };
      setSettings(data.settings);
      setMinutesDraft(String(data.settings.piAgentIdleParkingTimeoutMinutes));
      setMessage("Saved");
      return true;
    } catch (cause) {
      setSettings(previous);
      setMinutesDraft(String(previous.piAgentIdleParkingTimeoutMinutes));
      setMessage(cause instanceof Error ? cause.message : String(cause));
      return false;
    } finally {
      setSaving(false);
    }
  };

  const commitMinutes = (): void => {
    if (!settings || saving) return;
    const value = Number(minutesDraft);
    if (!Number.isInteger(value) || value < 1 || value > 120) {
      setMessage("Enter a whole number from 1 to 120 minutes.");
      return;
    }
    if (value === settings.piAgentIdleParkingTimeoutMinutes) {
      setMessage(null);
      return;
    }
    void update({ piAgentIdleParkingTimeoutMinutes: value });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="performance-screen">
      <SectionHero imageSrc="/onboarding/pop-hero.jpg" title="Performance" />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto max-w-2xl rounded-2xl border border-border-subtle bg-surface-elevated p-4 shadow-card">
          {loadState === "loading" ? (
            <p
              className="text-body text-text-muted"
              role="status"
              data-testid="performance-loading"
            >
              Loading performance preferences…
            </p>
          ) : loadState === "error" ? (
            <div
              className="rounded-xl border border-danger/40 bg-surface p-3"
              data-testid="performance-error"
            >
              <p className="text-body text-danger" role="alert">
                {message}
              </p>
              <ControlButton
                className="mt-3 flex items-center gap-1.5 rounded-md border border-border-strong px-2.5 py-1.5 text-detail text-text-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-focus"
                onClick={() => void load()}
              >
                <RefreshCw size={13} aria-hidden="true" /> Try again
              </ControlButton>
            </div>
          ) : settings ? (
            <div className="space-y-4" data-testid="performance-ready">
              <div className="flex items-start justify-between gap-4 rounded-xl border border-border-subtle bg-surface p-3">
                <div className="min-w-0" id="idle-parking-description">
                  <div className="text-label font-medium text-text-primary">Pause idle chats</div>
                  <p className="mt-1 text-caption text-text-muted">
                    Release an idle chat’s Pi process to save resources. The chat resumes
                    automatically when you send the next command.
                  </p>
                </div>
                <ControlButton
                  role="switch"
                  aria-label="Pause idle chats"
                  aria-describedby="idle-parking-description"
                  aria-checked={settings.piAgentIdleParkingEnabled}
                  data-testid="idle-parking-toggle"
                  disabled={saving}
                  onClick={() =>
                    void update({ piAgentIdleParkingEnabled: !settings.piAgentIdleParkingEnabled })
                  }
                  className={cn(
                    "relative h-6 w-11 shrink-0 rounded-full border transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
                    settings.piAgentIdleParkingEnabled
                      ? "border-accent bg-accent"
                      : "border-border-strong bg-surface-muted",
                  )}
                >
                  <span
                    className={cn(
                      "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                      settings.piAgentIdleParkingEnabled ? "translate-x-5" : "translate-x-0.5",
                    )}
                  />
                </ControlButton>
              </div>
              <label
                className="block rounded-xl border border-border-subtle bg-surface p-3"
                htmlFor="idle-parking-minutes"
              >
                <span className="text-label font-medium text-text-primary">Pause after</span>
                <span
                  id="idle-parking-minutes-help"
                  className="mt-1 block text-caption text-text-muted"
                >
                  Choose how long an idle chat stays ready before its Pi process is released (1–120
                  minutes).
                </span>
                <div className="mt-3 flex items-center gap-2">
                  <ControlInput
                    id="idle-parking-minutes"
                    data-testid="idle-parking-minutes"
                    aria-describedby="idle-parking-minutes-help"
                    type="number"
                    inputMode="numeric"
                    min={1}
                    max={120}
                    step={1}
                    value={minutesDraft}
                    disabled={!settings.piAgentIdleParkingEnabled || saving}
                    onChange={(event) => {
                      setMinutesDraft(event.target.value);
                      setMessage(null);
                    }}
                    onBlur={commitMinutes}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        commitMinutes();
                      }
                      if (event.key === "Escape") {
                        setMinutesDraft(String(settings.piAgentIdleParkingTimeoutMinutes));
                        setMessage(null);
                      }
                    }}
                    className="w-24 rounded-md border border-border-strong bg-surface px-2 py-1.5 text-label text-text-primary outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus disabled:opacity-50"
                  />
                  <span className="text-caption text-text-muted">minutes</span>
                </div>
              </label>
            </div>
          ) : null}

          {loadState === "ready" && message ? (
            <p
              className={cn(
                "mt-3 text-detail",
                message === "Saved" || message === "Saving…" ? "text-text-muted" : "text-danger",
              )}
              role={message === "Saved" || message === "Saving…" ? "status" : "alert"}
              data-testid="performance-save-status"
            >
              {message}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
