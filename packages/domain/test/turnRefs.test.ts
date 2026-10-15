import { describe, expect, it } from "vitest";
import { EVENT_LABEL_MAX_CHARS, eventLabel, turnRefsFromEntries } from "../src/turnRefs.ts";

const message = (id: string, message: Record<string, unknown>) => ({
  type: "message",
  id,
  parentId: null,
  message,
});

describe("turnRefsFromEntries", () => {
  it("references the last turn only: entry ids from its user message, tool calls from results", () => {
    const chain = [
      message("u1", { role: "user", content: "first turn" }),
      message("a1", { role: "assistant", content: [{ type: "text", text: "done" }] }),
      message("u2", { role: "user", content: [{ type: "text", text: "\n  Plan the work\nmore" }] }),
      message("a2", { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "read" }] }),
      message("t1", {
        role: "toolResult",
        toolCallId: "c1",
        toolName: "read",
        isError: true,
        content: [{ type: "text", text: "RAW TOOL OUTPUT" }],
      }),
      { type: "model_change", id: "m1", parentId: "t1" },
      message("a3", { role: "assistant", content: [{ type: "text", text: "ok" }] }),
    ];
    const turn = turnRefsFromEntries(chain);
    expect(turn).toEqual({
      entryIds: ["u2", "a2", "t1", "m1", "a3"],
      toolCalls: [{ id: "c1", name: "read", isError: true }],
      label: "Plan the work",
    });
    // References only: no message content is copied.
    expect(JSON.stringify(turn)).not.toContain("RAW TOOL OUTPUT");
  });

  it("returns null without a user message and caps the label", () => {
    expect(turnRefsFromEntries([message("a1", { role: "assistant", content: [] })])).toBeNull();
    expect(eventLabel("x".repeat(1_000))).toHaveLength(EVENT_LABEL_MAX_CHARS);
  });
});
