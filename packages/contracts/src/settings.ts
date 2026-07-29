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
