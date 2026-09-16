import type { AppColorTheme } from "@agent-deck/contracts";
import { DEFAULT_THEME_ID } from "@agent-deck/contracts";
import { BUILT_IN_THEMES } from "../design-system/themes";
import { THEME_CHANGE_EVENT } from "../design-system/theme";

export type ResolvedTheme = "light" | "dark";

const CACHE_KEY = "agent-deck:active-color-theme";
const SURFACE_VARS = [
  "--color-surface",
  "--color-surface-elevated",
  "--color-surface-subtle",
  "--color-surface-stroke",
  "--color-code-block-fill",
  "--color-terminal-background",
] as const;

let activeTheme: AppColorTheme = BUILT_IN_THEMES.find((item) => item.id === DEFAULT_THEME_ID)!;

function channel(hex: string, offset: number): number {
  return Number.parseInt(hex.slice(offset, offset + 2), 16);
}

function mix(hex: string, target: number, amount: number): string {
  const channels = [1, 3, 5].map((offset) =>
    Math.round(channel(hex, offset) + (target - channel(hex, offset)) * amount),
  );
  return `#${channels.map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function applyResolvedTheme(resolved: ResolvedTheme): void {
  const root = document.documentElement;
  const value = activeTheme;
  const vars: Record<string, string> = {
    "--color-brand-accent": value.accent,
    "--color-brand-accent-bright": mix(value.accent, 255, 0.3),
    "--color-brand-accent-deep": mix(value.accent, 0, 0.33),
    "--color-brand-accent-shadow": mix(value.accent, 0, 0.72),
    "--color-brand-action": mix(value.accent, 0, resolved === "dark" ? 0.5 : 0.42),
    "--color-brand-action-hover": mix(value.accent, 0, resolved === "dark" ? 0.43 : 0.34),
    "--color-selection-fill": `color-mix(in srgb, ${value.accent} 22%, transparent)`,
    "--color-selection-stroke": `color-mix(in srgb, ${value.accent} 32%, transparent)`,
    "--color-info": value.accent,
    "--color-success": value.diffAdded,
    "--color-danger": value.error,
    "--color-info-subtle": `color-mix(in srgb, ${value.accent} 14%, transparent)`,
    "--color-success-subtle": `color-mix(in srgb, ${value.diffAdded} 14%, transparent)`,
    "--color-danger-subtle": `color-mix(in srgb, ${value.error} 14%, transparent)`,
    "--color-role-assistant": value.assistant,
    "--color-role-user": value.accent,
    "--color-role-thinking": value.thinking,
    "--color-role-tool": value.tool,
    "--color-role-error": value.error,
    "--color-role-success": value.diffAdded,
    "--color-role-stderr": value.stderr,
    "--color-diff-added": value.diffAdded,
    "--color-diff-removed": value.error,
    "--color-diff-added-subtle": `color-mix(in srgb, ${value.diffAdded} 14%, transparent)`,
    "--color-diff-removed-subtle": `color-mix(in srgb, ${value.error} 14%, transparent)`,
    "--color-source-builtin": value.sourceBuiltin,
    "--color-source-library": value.sourceLibrary,
    "--color-source-project": value.sourceProject,
    "--color-source-global": value.accent,
    "--color-source-project-subtle": `color-mix(in srgb, ${value.sourceProject} 10%, transparent)`,
    "--color-source-project-stroke": `color-mix(in srgb, ${value.sourceProject} 18%, transparent)`,
    "--color-glass-tint": `color-mix(in srgb, ${value.accent} 55%, transparent)`,
    "--color-terminal-cursor": value.accent,
    "--color-terminal-selection": `color-mix(in srgb, ${value.accent} 25%, transparent)`,
    "--color-terminal-red": value.error,
    "--color-terminal-green": value.diffAdded,
    "--color-terminal-yellow": value.tool,
    "--color-terminal-blue": value.accent,
    "--color-terminal-magenta": value.assistant,
    "--color-terminal-cyan": value.thinking,
  };
  Object.entries(vars).forEach(([name, color]) => root.style.setProperty(name, color));
  if (resolved === "dark") {
    root.style.setProperty("--color-surface", value.background);
    root.style.setProperty("--color-surface-elevated", value.surface);
    root.style.setProperty("--color-surface-subtle", mix(value.surface, 255, 0.06));
    root.style.setProperty("--color-surface-stroke", value.stroke);
    root.style.setProperty("--color-code-block-fill", value.background);
    root.style.setProperty("--color-terminal-background", value.background);
  } else {
    SURFACE_VARS.forEach((name) => root.style.removeProperty(name));
  }
  root.dataset.theme = resolved;
  root.dataset.colorTheme = value.id;
  root.style.colorScheme = resolved;
  window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: resolved }));
}

export function applyColorTheme(value: AppColorTheme): void {
  activeTheme = value;
  localStorage.setItem(CACHE_KEY, JSON.stringify({ value }));
  applyResolvedTheme(window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
}

/** Follow the host OS appearance and keep every mounted theme adapter in sync. */
export function installSystemTheme(): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (): void => {
    const theme: ResolvedTheme = query.matches ? "dark" : "light";
    applyResolvedTheme(theme);
  };
  try {
    const cached = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as {
      value?: AppColorTheme;
    } | null;
    if (cached?.value) {
      activeTheme = cached.value;
    }
  } catch {
    // Ignore a corrupt renderer cache; persisted server settings reconcile below.
  }
  apply();
  query.addEventListener("change", apply);
  const controller = new AbortController();
  void fetch("/settings", { signal: controller.signal })
    .then((response) => (response.ok ? response.json() : Promise.reject(new Error("settings"))))
    .then(
      (body: {
        settings: {
          selectedThemeID: string;
          customThemes: AppColorTheme[];
        };
      }) => {
        const all = [...BUILT_IN_THEMES, ...(body.settings.customThemes ?? [])];
        const selected =
          all.find((item) => item.id === body.settings.selectedThemeID) ?? activeTheme;
        applyColorTheme(selected);
      },
    )
    .catch(() => undefined);
  return () => {
    controller.abort();
    query.removeEventListener("change", apply);
  };
}
