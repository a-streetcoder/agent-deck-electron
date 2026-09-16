import { useSyncExternalStore } from "react";
import type { ResolvedTheme } from "../lib/systemTheme";

export const THEME_CHANGE_EVENT = "agent-deck-theme-change";

export function getResolvedTheme(): ResolvedTheme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function subscribe(listener: () => void): () => void {
  window.addEventListener(THEME_CHANGE_EVENT, listener);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, listener);
}

/** Reactive access to the effective application theme after any user override. */
export function useResolvedTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribe, getResolvedTheme, () => "dark");
}
