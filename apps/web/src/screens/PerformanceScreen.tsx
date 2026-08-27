import { AppEmptyState } from "@/design-system/components/AppEmptyState";
import { AppInlineNotice } from "@/design-system/components/AppInlineNotice";
import { AppSwitch } from "@/design-system/components/AppSwitch";
import { AppTextField } from "@/design-system/components/AppTextField";
import { Button } from "@/design-system/components/Button";
import { Card } from "@/design-system/components/Card";
import { PageShell } from "@/design-system/components/PageShell";
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
    <PageShell
      width="page"
      testId="performance-screen"
      hero={
        <SectionHero
          imageSrc="/onboarding/pop-hero.jpg"
          title="Performance"
          subtitle="Tune runtime behavior and resource usage."
        />
      }
    >
      {loadState === "loading" ? (
        <AppEmptyState
          data-testid="performance-loading"
          heading="Loading performance preferences…"
        />
      ) : loadState === "error" ? (
        <div data-testid="performance-error">
          <AppInlineNotice
            tone="danger"
            action={
              <Button size="sm" variant="secondary" onClick={() => void load()}>
                <RefreshCw size={13} aria-hidden="true" /> Try again
              </Button>
            }
          >
            {message}
          </AppInlineNotice>
        </div>
      ) : settings ? (
        <div className="space-y-3" data-testid="performance-ready">
          <Card padding="md">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0" id="idle-parking-description">
                <div className="text-label font-medium text-text-primary">Pause idle chats</div>
                <p className="mt-1 text-caption text-text-muted">
                  Release an idle chat’s Pi process to save resources. The chat resumes
                  automatically when you send the next command.
                </p>
              </div>
              <AppSwitch
                aria-label="Pause idle chats"
                aria-describedby="idle-parking-description"
                data-testid="idle-parking-toggle"
                disabled={saving}
                checked={settings.piAgentIdleParkingEnabled}
                onCheckedChange={(next) => void update({ piAgentIdleParkingEnabled: next })}
              />
            </div>
          </Card>
          <Card padding="md">
            <label className="block" htmlFor="idle-parking-minutes">
              <span className="text-label font-medium text-text-primary">Pause after</span>
              <span
                id="idle-parking-minutes-help"
                className="mt-1 block text-caption text-text-muted"
              >
                Choose how long an idle chat stays ready before its Pi process is released (1–120
                minutes).
              </span>
              <div className="mt-3 flex items-center gap-2">
                <AppTextField
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
                  onChange={(next) => {
                    setMinutesDraft(next);
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
                  className="w-24"
                />
                <span className="text-caption text-text-muted">minutes</span>
              </div>
            </label>
          </Card>
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
    </PageShell>
  );
}
