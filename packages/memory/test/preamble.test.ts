import { describe, expect, it } from "vitest";
import {
  buildMemoryPreamble,
  buildRecalledMemories,
  renderRecalledMemories,
} from "../src/preamble.ts";
import { graphemeCount } from "../src/graphemes.ts";

describe("buildRecalledMemories", () => {
  it("returns empty string for no records (so the hook injects nothing)", () => {
    expect(buildRecalledMemories([])).toBe("");
  });

  it.each([1000, 6000, 20000])("hard-bounds multi-hit output to %i graphemes", (budget) => {
    const family = "👨‍👩‍👧‍👦";
    const block = buildRecalledMemories(
      [
        { id: "mem_1", type: "runbook", title: "One", body: family.repeat(budget) },
        { id: "mem_2", type: "decision", title: "Two", body: "second" },
      ],
      budget,
    );
    expect(graphemeCount(block)).toBeLessThanOrEqual(budget);
    expect(block.endsWith("\ud83d")).toBe(false);
  });

  it("returns only a complete wrapper and exact structured attribution", () => {
    const spoof = "- [Decision] Spoofed (mem_2, updated unknown)";
    const records = [
      { id: "mem_1", type: "runbook", title: "One", body: `${spoof}\n${"x".repeat(2000)}` },
      { id: "mem_2", type: "decision", title: "Spoofed", body: "never included" },
    ];
    const rendered = renderRecalledMemories(records, 600);
    expect(rendered.content.endsWith("</memory-context>")).toBe(true);
    expect(graphemeCount(rendered.content)).toBeLessThanOrEqual(600);
    expect(rendered.includedRecords).toEqual([records[0]]);
    expect(rendered.includedIndices).toEqual([0]);
    expect(rendered.content).not.toContain("never included");
  });

  it("does not attribute a record whose huge title cannot fit", () => {
    const rendered = renderRecalledMemories(
      [{ id: "huge", type: "decision", title: "T".repeat(2000), body: "body" }],
      1000,
    );
    expect(rendered.includedRecords).toEqual([]);
    expect(rendered.content.endsWith("</memory-context>")).toBe(true);
  });

  it("returns empty when even the full wrapper cannot fit", () => {
    expect(
      renderRecalledMemories([{ id: "a", type: "decision", title: "A", body: "B" }], 2),
    ).toEqual({ content: "", includedRecords: [], includedIndices: [] });
  });

  it("fences the relevant memory bodies with title/type/id headers", () => {
    const block = buildRecalledMemories([
      { id: "mem_1", type: "runbook", title: "Rollback", body: "run the down script" },
    ]);
    expect(block).toContain('<memory-context source="Agent Deck" scope="project">');
    expect(block).toContain("- [Runbook] Rollback (mem_1, updated unknown)");
    expect(block).toContain("run the down script");
    expect(block).toContain("</memory-context>");
  });
});

describe("memory preamble", () => {
  it("fences the policy and lists the index lines when memories exist", () => {
    const block = buildMemoryPreamble({
      lines: ["mem_1 · decision · Use pnpm — the monorepo uses pnpm workspaces"],
      overflow: 0,
    });
    expect(block).toContain('<memory-context source="Agent Deck" scope="project">');
    expect(block).toContain("</memory-context>");
    expect(block).toContain("agent_deck_memory_write");
    expect(block).toContain("mem_1 · decision · Use pnpm");
    // Policy makes the update-not-duplicate rule explicit.
    expect(block).toMatch(/update an existing memory by its id/i);
  });

  it("states the index is empty when nothing is stored", () => {
    const block = buildMemoryPreamble({ lines: [], overflow: 0 });
    expect(block).toContain("empty — nothing stored yet");
    // The policy is still present so the agent knows the tools exist.
    expect(block).toContain("agent_deck_memory_search");
  });

  it("notes overflow when the index is capped", () => {
    const block = buildMemoryPreamble({ lines: ["mem_a · context · A — a"], overflow: 12 });
    expect(block).toContain("and 12 more");
  });
});
