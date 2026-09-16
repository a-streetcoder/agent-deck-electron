import type { AppAppearance, AppColorTheme } from "@agent-deck/contracts";
import { AppEmptyState } from "@/design-system/components/AppEmptyState";
import { AppInlineNotice } from "@/design-system/components/AppInlineNotice";
import { AppSegmentedPicker } from "@/design-system/components/AppSegmentedPicker";
import { AppTextField } from "@/design-system/components/AppTextField";
import { Button } from "@/design-system/components/Button";
import { Card } from "@/design-system/components/Card";
import { ControlButton, ControlInput } from "@/design-system/components/NativeControls";
import { PageShell } from "@/design-system/components/PageShell";
import { SectionHero } from "@/design-system/components/SectionHero";
import { BUILT_IN_THEMES, THEME_COLOR_FIELDS, themeSwatches } from "@/design-system/themes";
import { applyAppearance, applyColorTheme } from "@/lib/systemTheme";
import { Check, Copy, Monitor, Moon, RefreshCw, Sun, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

interface ThemeSettings {
  appearance: AppAppearance;
  selectedThemeID: string;
  customThemes: AppColorTheme[];
}

const DEFAULT_THEME = BUILT_IN_THEMES[0]!;

function ThemeCard({
  value,
  selected,
  onSelect,
}: {
  value: AppColorTheme;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <ControlButton
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className="group rounded-lg border border-border-subtle bg-surface-elevated p-3 text-left transition-colors hover:border-border-strong hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus"
    >
      <div className="flex items-center justify-between gap-3">
        <span className="truncate text-label font-medium text-text-primary">{value.name}</span>
        {selected ? <Check className="size-4 shrink-0 text-accent" aria-label="Selected" /> : null}
      </div>
      <div className="mt-3 flex h-5 overflow-hidden rounded-control border border-border-subtle">
        {themeSwatches(value).map((color, index) => (
          <span
            key={`${color}-${index}`}
            className="min-w-0 flex-1"
            style={{ backgroundColor: color }}
          />
        ))}
      </div>
      <div className="mt-2 flex gap-1.5">
        <span
          className="size-4 rounded-full border border-white/10"
          style={{ backgroundColor: value.background }}
        />
        <span
          className="size-4 rounded-full border border-white/10"
          style={{ backgroundColor: value.surface }}
        />
        <span
          className="size-4 rounded-full border border-white/10"
          style={{ backgroundColor: value.stroke }}
        />
      </div>
    </ControlButton>
  );
}

export function ThemesScreen() {
  const [settings, setSettings] = useState<ThemeSettings | null>(null);
  const [editingID, setEditingID] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setMessage(null);
    try {
      const response = await fetch("/settings", { signal });
      if (!response.ok) throw new Error("We couldn’t load themes.");
      const body = (await response.json()) as { settings: ThemeSettings };
      setSettings(body.settings);
    } catch (error) {
      if (!signal?.aborted) setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const themes = useMemo(() => [...BUILT_IN_THEMES, ...(settings?.customThemes ?? [])], [settings]);
  const selected: AppColorTheme =
    themes.find((item) => item.id === settings?.selectedThemeID) ?? DEFAULT_THEME;
  const editing = settings?.customThemes.find((item) => item.id === editingID) ?? null;

  const persist = async (next: ThemeSettings, patch: Partial<ThemeSettings>): Promise<void> => {
    const previous = settings;
    setSettings(next);
    setSaving(true);
    setMessage("Saving…");
    try {
      const response = await fetch("/settings", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!response.ok) throw new Error("We couldn’t save the theme.");
      setMessage("Saved");
    } catch (error) {
      if (previous) {
        setSettings(previous);
        const previousTheme =
          themes.find((item) => item.id === previous.selectedThemeID) ?? selected;
        applyAppearance(previous.appearance);
        applyColorTheme(previousTheme);
      }
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const selectAppearance = (appearance: AppAppearance): void => {
    if (!settings || appearance === settings.appearance) return;
    const next = { ...settings, appearance };
    applyAppearance(appearance);
    void persist(next, { appearance });
  };

  const selectTheme = (value: AppColorTheme): void => {
    if (!settings || value.id === settings.selectedThemeID) return;
    const next = { ...settings, selectedThemeID: value.id };
    applyColorTheme(value);
    void persist(next, { selectedThemeID: value.id });
  };

  const duplicate = (): void => {
    if (!settings) return;
    const copy: AppColorTheme = {
      ...selected,
      id: crypto.randomUUID(),
      name: `${selected.name} Copy`,
      isBuiltIn: false,
    };
    const next = {
      ...settings,
      selectedThemeID: copy.id,
      customThemes: [...settings.customThemes, copy],
    };
    setEditingID(copy.id);
    applyColorTheme(copy);
    void persist(next, { selectedThemeID: copy.id, customThemes: next.customThemes });
  };

  const updateEditing = (patch: Partial<AppColorTheme>): void => {
    if (!settings || !editing) return;
    const customThemes = settings.customThemes.map((item) =>
      item.id === editing.id ? { ...item, ...patch } : item,
    );
    const next = { ...settings, customThemes };
    setSettings(next);
    const changed = customThemes.find((item) => item.id === editing.id)!;
    if (settings.selectedThemeID === editing.id) applyColorTheme(changed);
  };

  const saveEditing = (): void => {
    if (!settings || !editing || !editing.name.trim()) return;
    const customThemes = settings.customThemes.map((item) =>
      item.id === editing.id ? { ...item, name: item.name.trim() } : item,
    );
    void persist({ ...settings, customThemes }, { customThemes });
  };

  const deleteEditing = (): void => {
    if (!settings || !editing) return;
    const customThemes = settings.customThemes.filter((item) => item.id !== editing.id);
    const selectedThemeID =
      settings.selectedThemeID === editing.id ? DEFAULT_THEME.id : settings.selectedThemeID;
    const next = { ...settings, customThemes, selectedThemeID };
    setEditingID(null);
    const replacement = themes.find((item) => item.id === selectedThemeID) ?? DEFAULT_THEME;
    applyColorTheme(replacement);
    void persist(next, { customThemes, selectedThemeID });
  };

  return (
    <PageShell
      width="page"
      testId="themes-screen"
      hero={
        <SectionHero
          imageSrc="/onboarding/pop-hero.jpg"
          title="Themes"
          subtitle="Choose the colors used throughout Agent Deck."
        />
      }
    >
      {loading ? (
        <AppEmptyState heading="Loading themes…" />
      ) : !settings ? (
        <AppInlineNotice
          tone="danger"
          action={
            <Button size="sm" onClick={() => void load()}>
              <RefreshCw size={13} /> Try again
            </Button>
          }
        >
          {message}
        </AppInlineNotice>
      ) : (
        <div className="space-y-5">
          <Card title="Appearance">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-label font-medium text-text-primary">Light and dark mode</p>
                <p className="mt-1 text-caption text-text-muted">
                  Auto follows your computer’s appearance.
                </p>
              </div>
              <AppSegmentedPicker<AppAppearance>
                aria-label="Appearance"
                value={settings.appearance}
                onChange={selectAppearance}
                disabled={saving}
                options={[
                  { id: "auto", label: "Auto", icon: <Monitor /> },
                  { id: "light", label: "Light", icon: <Sun /> },
                  { id: "dark", label: "Dark", icon: <Moon /> },
                ]}
              />
            </div>
          </Card>

          <section aria-labelledby="theme-presets-heading">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2
                  id="theme-presets-heading"
                  className="text-title font-semibold text-text-primary"
                >
                  Presets
                </h2>
                <p className="mt-1 text-caption text-text-muted">
                  Color palettes from the original Agent Deck.
                </p>
              </div>
              <Button size="sm" leadingIcon={<Copy size={14} />} onClick={duplicate}>
                Duplicate selected
              </Button>
            </div>
            <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
              {BUILT_IN_THEMES.map((item) => (
                <ThemeCard
                  key={item.id}
                  value={item}
                  selected={item.id === settings.selectedThemeID}
                  onSelect={() => selectTheme(item)}
                />
              ))}
            </div>
          </section>

          {settings.customThemes.length > 0 ? (
            <section aria-labelledby="custom-themes-heading">
              <h2
                id="custom-themes-heading"
                className="mb-3 text-title font-semibold text-text-primary"
              >
                My themes
              </h2>
              <div className="grid grid-cols-2 gap-3 xl:grid-cols-3">
                {settings.customThemes.map((item) => (
                  <div key={item.id} className="space-y-1.5">
                    <ThemeCard
                      value={item}
                      selected={item.id === settings.selectedThemeID}
                      onSelect={() => selectTheme(item)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      fullWidth
                      onClick={() => setEditingID(item.id)}
                    >
                      Edit
                    </Button>
                  </div>
                ))}
              </div>
            </section>
          ) : null}

          {editing ? (
            <Card
              title="Edit theme"
              headerTrailing={
                <Button
                  size="sm"
                  variant="destructiveOutline"
                  leadingIcon={<Trash2 size={13} />}
                  onClick={deleteEditing}
                >
                  Delete
                </Button>
              }
            >
              <AppTextField
                value={editing.name}
                onChange={(name) => updateEditing({ name })}
                aria-label="Theme name"
              />
              <div className="mt-4 grid grid-cols-2 gap-x-5 gap-y-3 lg:grid-cols-3">
                {THEME_COLOR_FIELDS.map(([key, label]) => (
                  <label
                    key={key}
                    className="flex items-center justify-between gap-3 text-caption text-text-secondary"
                  >
                    <span>{label}</span>
                    <span className="flex items-center gap-2 font-mono text-detail text-text-muted">
                      {String(editing[key]).toUpperCase()}
                      <ControlInput
                        type="color"
                        value={String(editing[key])}
                        onChange={(event) =>
                          updateEditing({ [key]: event.target.value } as Partial<AppColorTheme>)
                        }
                        className="size-7 cursor-pointer rounded-control border border-border-strong bg-transparent p-0.5"
                      />
                    </span>
                  </label>
                ))}
              </div>
              <div className="mt-4 flex justify-end">
                <Button
                  variant="primary"
                  disabled={saving || !editing.name.trim()}
                  onClick={saveEditing}
                >
                  Save theme
                </Button>
              </div>
            </Card>
          ) : null}

          {message ? (
            <p className="text-detail text-text-muted" role="status">
              {message}
            </p>
          ) : null}
        </div>
      )}
    </PageShell>
  );
}
