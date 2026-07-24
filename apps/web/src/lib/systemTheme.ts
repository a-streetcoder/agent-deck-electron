export type ResolvedTheme = "light" | "dark";

/** Follow the host OS appearance and keep native browser controls in the same scheme. */
export function installSystemTheme(): () => void {
  const query = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = (): void => {
    const theme: ResolvedTheme = query.matches ? "dark" : "light";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  };
  apply();
  query.addEventListener("change", apply);
  return () => query.removeEventListener("change", apply);
}
