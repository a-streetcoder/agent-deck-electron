import type { TranscriptVisibilitySettings } from "@agent-deck/contracts";
import { memoryToolCardLabel, type AssistantBlock, type TranscriptCell } from "@agent-deck/domain";
import { toolPresentation } from "@/components/transcript/toolPresentation";

/**
 * Decide whether a complete transcript cell has any visible presentation.
 * This is intentionally a projection only: the reducer and persisted history
 * always retain every cell.
 */
export function isTranscriptCellVisible(
  cell: TranscriptCell,
  visibility: TranscriptVisibilitySettings,
): boolean {
  if (cell.kind === "assistant") {
    return Boolean(cell.errorMessage) || visibleAssistantBlocks(cell.blocks, visibility).length > 0;
  }
  if (cell.kind === "memory_recall") return visibility.showMemoryCards;
  if (cell.kind !== "tool") return true;

  if (memoryToolCardLabel(cell)) return visibility.showMemoryCards;
  switch (toolPresentation(cell.toolName).variant) {
    case "web":
      return visibility.showWebActivity;
    case "diff":
      return visibility.showDiffs;
    case "mcp":
      return visibility.showMCPCards;
    default:
      return true;
  }
}

/** Thinking blocks disappear entirely while ordinary assistant output remains. */
export function visibleAssistantBlocks(
  blocks: readonly AssistantBlock[],
  visibility: TranscriptVisibilitySettings,
): readonly AssistantBlock[] {
  return blocks.filter(
    (block) =>
      block.text.trim().length > 0 && (block.kind !== "thinking" || visibility.showThinking),
  );
}
