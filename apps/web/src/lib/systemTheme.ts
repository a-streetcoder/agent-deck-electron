import { THEME_CHANGE_EVENT } from "../design-system/theme";

export type ResolvedTheme = "light" | "dark";

/** Follow the host OS appearance and keep every mounted theme adapter in sync. */
export function installSystemTheme(): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (): void => {
    const theme: ResolvedTheme = query.matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: theme }));
  };
  apply();
  query.addEventListener("change", apply);
  return () => query.removeEventListener("change", apply);
}
