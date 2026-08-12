import type { RpcCommand } from "@earendil-works/pi-coding-agent";

/** Keep the accepted level type pinned to Pi's `set_thinking_level` command. */
export type ThinkingLevel = Extract<RpcCommand, { type: "set_thinking_level" }>["level"];

/** The legacy-safe ladder used when older servers omit per-model metadata. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
/** All values accepted by pinned Pi; `max` is presented only from model metadata. */
export const PI_THINKING_LEVELS = [
  ...THINKING_LEVELS,
  "max",
] as const satisfies readonly ThinkingLevel[];

/**
 * The thinking levels a model can actually use.
 *
 * New catalogs carry Pi's exact `getSupportedThinkingLevels()` result. Older
 * servers exposed only `reasoning`, so missing metadata deliberately retains
 * the previous safe ladder (which does not guess that `max` is supported).
 */
export function thinkingLevelsForModel(
  reasoning: boolean | undefined,
  supportedThinkingLevels?: readonly ThinkingLevel[],
): ThinkingLevel[] {
  if (reasoning === false) return ["off"];
  return supportedThinkingLevels ? [...supportedThinkingLevels] : [...THINKING_LEVELS];
}
