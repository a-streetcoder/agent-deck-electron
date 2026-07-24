import type { ResolvedTheme } from "../../lib/systemTheme";

export const SHIKI_THEMES = {
  dark: "github-dark",
  light: "github-light",
} as const;

export function shikiThemeFor(resolvedTheme: ResolvedTheme): string {
  return SHIKI_THEMES[resolvedTheme];
}
