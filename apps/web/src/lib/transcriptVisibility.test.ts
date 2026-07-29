import { DEFAULT_TRANSCRIPT_VISIBILITY } from "@agent-deck/contracts";
import type { AssistantCell, ToolCell, TranscriptCell } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { isTranscriptCellVisible, visibleAssistantBlocks } from "./transcriptVisibility.ts";

const hidden = {
  showThinking: false,
  showWebActivity: false,
  showDiffs: false,
  showImages: false,
  showMemoryCards: false,
  showMCPCards: false,
};

function tool(toolName: string): ToolCell {
  return {
    kind: "tool",
    id: `tool-${toolName}`,
    toolCallId: `call-${toolName}`,
    toolName,
    args: {},
    status: "done",
    result: "ok",
  };
}

describe("transcript visibility projection", () => {
  it("hides thinking-only cells without mutating mixed assistant output", () => {
    const mixed: AssistantCell = {
      kind: "assistant",
      id: "assistant",
      streaming: false,
      blocks: [
        { kind: "thinking", contentIndex: 0, text: "private reasoning", done: true },
        { kind: "text", contentIndex: 1, text: "visible answer", done: true },
      ],
    };
    const thinkingOnly: AssistantCell = {
      ...mixed,
      id: "thinking-only",
      blocks: [mixed.blocks[0]!],
    };

    expect(isTranscriptCellVisible(mixed, hidden)).toBe(true);
    expect(isTranscriptCellVisible(thinkingOnly, hidden)).toBe(false);
    expect(visibleAssistantBlocks(mixed.blocks, hidden)).toEqual([mixed.blocks[1]]);
    expect(mixed.blocks).toHaveLength(2);
  });

  it("does not leave a header-only row for hidden thinking followed by empty text", () => {
    const cell: AssistantCell = {
      kind: "assistant",
      id: "thinking-empty-text",
      streaming: true,
      blocks: [
        { kind: "thinking", contentIndex: 0, text: "reasoning", done: true },
        { kind: "text", contentIndex: 1, text: " \n ", done: false },
      ],
    };

    expect(isTranscriptCellVisible(cell, hidden)).toBe(false);
    expect(visibleAssistantBlocks(cell.blocks, hidden)).toEqual([]);
  });

  it("never hides fatal turn errors or actionable transcript cells", () => {
    const fatal: AssistantCell = {
      kind: "assistant",
      id: "fatal",
      blocks: [],
      streaming: false,
      errorMessage: "Provider unavailable",
    };
    const question: TranscriptCell = {
      kind: "question",
      id: "question",
      requestId: "request",
      method: "confirm",
      title: "Continue?",
      answered: false,
    };

    expect(isTranscriptCellVisible(fatal, hidden)).toBe(true);
    expect(isTranscriptCellVisible(question, hidden)).toBe(true);
  });

  it("gates exact web, diff, memory, and MCP cards while retaining generic tools", () => {
    for (const name of ["web_search", "web_fetch", "fetch_content", "get_search_content"]) {
      expect(isTranscriptCellVisible(tool(name), hidden), name).toBe(false);
    }
    expect(isTranscriptCellVisible(tool("edit"), hidden)).toBe(false);
    expect(isTranscriptCellVisible(tool("write"), hidden)).toBe(false);
    expect(isTranscriptCellVisible(tool("agent_deck_memory_search"), hidden)).toBe(false);
    expect(isTranscriptCellVisible(tool("mcp__github__search"), hidden)).toBe(false);

    expect(isTranscriptCellVisible(tool("read"), hidden)).toBe(true);
    expect(isTranscriptCellVisible(tool("bash"), hidden)).toBe(true);
    expect(isTranscriptCellVisible(tool("unknown_extension_tool"), hidden)).toBe(true);
  });

  it("defaults every category to visible", () => {
    expect(isTranscriptCellVisible(tool("web_search"), DEFAULT_TRANSCRIPT_VISIBILITY)).toBe(true);
    expect(isTranscriptCellVisible(tool("edit"), DEFAULT_TRANSCRIPT_VISIBILITY)).toBe(true);
    expect(
      isTranscriptCellVisible(tool("agent_deck_memory_write"), DEFAULT_TRANSCRIPT_VISIBILITY),
    ).toBe(true);
    expect(
      isTranscriptCellVisible(tool("mcp__github__search"), DEFAULT_TRANSCRIPT_VISIBILITY),
    ).toBe(true);
  });
});
