import { describe, expect, it } from "vitest";
import { ingestMemoryRecallEntry, parseMemoryRecallEntryData } from "../src/ingest.ts";
import { emptyTranscript, reduceTranscript } from "../src/transcript.ts";

const data = {
  version: 1,
  memories: [{ id: "decision-oauth", title: "OAuth callback", type: "decision" }],
};

describe("memory recall custom entries", () => {
  it("strictly validates the versioned payload", () => {
    expect(parseMemoryRecallEntryData(data)).toEqual(data);
    expect(parseMemoryRecallEntryData({ ...data, query: "secret" })).toBeNull();
    expect(parseMemoryRecallEntryData({ ...data, version: 2 })).toBeNull();
    expect(
      parseMemoryRecallEntryData({
        version: 1,
        memories: [{ ...data.memories[0], body: "private" }],
      }),
    ).toBeNull();
    expect(parseMemoryRecallEntryData({ version: 1, memories: [] })).toBeNull();
    const five = Array.from({ length: 5 }, (_, index) => ({
      id: `memory-${index}`,
      title: `Memory ${index}`,
      type: "decision",
    }));
    expect(parseMemoryRecallEntryData({ version: 1, memories: five })?.memories).toHaveLength(5);
    expect(
      parseMemoryRecallEntryData({
        version: 1,
        memories: [...five, { id: "memory-6", title: "Memory 6", type: "decision" }],
      }),
    ).toBeNull();
  });

  it("derives project identity externally and upserts replay of the same entry", () => {
    const entry = {
      type: "custom",
      id: "entry-1",
      customType: "agent-deck.memory-recall",
      data,
    };
    const events = ingestMemoryRecallEntry(entry, "project-authoritative");
    expect(events).toEqual([
      {
        type: "cell_final",
        cell: {
          kind: "memory_recall",
          id: "memory-recall-entry-1",
          projectId: "project-authoritative",
          memories: data.memories,
        },
      },
    ]);
    let transcript = emptyTranscript();
    transcript = reduceTranscript(transcript, events[0]!);
    transcript = reduceTranscript(transcript, events[0]!);
    expect(transcript.cells).toHaveLength(1);
    expect(ingestMemoryRecallEntry(entry, undefined)).toEqual([]);
  });

  it("ignores malformed and unrelated Pi entries", () => {
    expect(
      ingestMemoryRecallEntry({ type: "custom", id: "x", customType: "other", data }, "project-a"),
    ).toEqual([]);
    expect(
      ingestMemoryRecallEntry(
        {
          type: "custom",
          id: "x",
          customType: "agent-deck.memory-recall",
          data: { version: 1, memories: [{ id: "x", title: "X", type: "unknown" }] },
        },
        "project-a",
      ),
    ).toEqual([]);
  });
});
