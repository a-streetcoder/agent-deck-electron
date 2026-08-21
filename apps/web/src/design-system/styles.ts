import type { CSSProperties } from "react";

/** Uppercase group/index header only. Do not use on chips, status, tags, or panel titles. */
export const sectionHeaderClass = "text-micro font-semibold uppercase tracking-overline";

/** Governed escape hatch for domain-colored avatars and badges. */
export function tintedSurfaceStyle(color: string): CSSProperties {
  return {
    background: `color-mix(in srgb, ${color} 10%, transparent)`,
    border: `1px solid color-mix(in srgb, ${color} 18%, transparent)`,
    color,
  };
}
