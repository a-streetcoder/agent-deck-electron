import type { CSSProperties } from "react";

/** Uppercase section/group header used by Sidebar, AppList, and the command palette. */
export const sectionHeaderClass = "text-micro font-semibold uppercase tracking-overline";

/** Governed escape hatch for domain-colored avatars and badges. */
export function tintedSurfaceStyle(color: string): CSSProperties {
  return {
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 18%, transparent)`,
    color,
  };
}
