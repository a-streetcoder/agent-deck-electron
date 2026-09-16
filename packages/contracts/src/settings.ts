/**
 * Global transcript display preferences shared by the settings API and renderer.
 * Every category defaults to visible so older app-settings files migrate
 * additively without changing an existing transcript.
 */
export interface TranscriptVisibilitySettings {
  showThinking: boolean;
  showWebActivity: boolean;
  showDiffs: boolean;
  showImages: boolean;
  showMemoryCards: boolean;
  showMCPCards: boolean;
}

export const DEFAULT_TRANSCRIPT_VISIBILITY: Readonly<TranscriptVisibilitySettings> = {
  showThinking: true,
  showWebActivity: true,
  showDiffs: true,
  showImages: true,
  showMemoryCards: true,
  showMCPCards: true,
};

/** Controls whether the renderer follows the host appearance or overrides it. */
export type AppAppearance = "auto" | "light" | "dark";

/** Persisted color theme shared by the settings API and renderer. */
export interface AppColorTheme {
  id: string;
  name: string;
  isBuiltIn: boolean;
  accent: string;
  assistant: string;
  thinking: string;
  tool: string;
  error: string;
  stderr: string;
  diffAdded: string;
  sourceBuiltin: string;
  sourceLibrary: string;
  sourceProject: string;
  background: string;
  surface: string;
  stroke: string;
}

export const DEFAULT_THEME_ID = "11111111-1111-1111-1111-111111111111";

/** Load a possibly old or partially corrupt persisted value field by field. */
export function coerceTranscriptVisibility(value: unknown): TranscriptVisibilitySettings {
  const record =
    typeof value === "object" && value !== null
      ? (value as Partial<Record<keyof TranscriptVisibilitySettings, unknown>>)
      : {};
  return {
    showThinking:
      typeof record.showThinking === "boolean"
        ? record.showThinking
        : DEFAULT_TRANSCRIPT_VISIBILITY.showThinking,
    showWebActivity:
      typeof record.showWebActivity === "boolean"
        ? record.showWebActivity
        : DEFAULT_TRANSCRIPT_VISIBILITY.showWebActivity,
    showDiffs:
      typeof record.showDiffs === "boolean"
        ? record.showDiffs
        : DEFAULT_TRANSCRIPT_VISIBILITY.showDiffs,
    showImages:
      typeof record.showImages === "boolean"
        ? record.showImages
        : DEFAULT_TRANSCRIPT_VISIBILITY.showImages,
    showMemoryCards:
      typeof record.showMemoryCards === "boolean"
        ? record.showMemoryCards
        : DEFAULT_TRANSCRIPT_VISIBILITY.showMemoryCards,
    showMCPCards:
      typeof record.showMCPCards === "boolean"
        ? record.showMCPCards
        : DEFAULT_TRANSCRIPT_VISIBILITY.showMCPCards,
  };
}
