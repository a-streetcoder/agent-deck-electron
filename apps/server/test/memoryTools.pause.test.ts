import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { graphemeCount, listMemories } from "@agent-deck/memory";
import { describe, expect, it, vi } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import { registerMemoryTools } from "../src/memoryTools.ts";

const call = (tool: string, params: Record<string, unknown>) => ({
  sessionId: "session-a",
  token: "token-a",
  tool,
  toolCallId: `call-${tool}`,
  params,
});

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("live agent memory pause guards", () => {
  it("denies every model memory operation immediately and restores without re-registration", async () => {
    const bridge = new BridgeRegistry();
    let enabled = false;
    const search = vi.fn(async () => ({
      hits: [],
      recall: {
        readiness: "not_requested" as const,
        mode: "lexical" as const,
        reason: null,
        message: "lexical",
      },
    }));
    registerMemoryTools(
      bridge,
      mkdtempSync(path.join(tmpdir(), "agent-deck-memory-tools-")),
      () => "/project",
      search,
      undefined,
      () => enabled,
    );

    const cases = [
      call("agent_deck_memory_write", {
        type: "decision",
        title: "Title",
        summary: "Summary",
        body: "Body",
      }),
      call("agent_deck_memory_search", { query: "Title" }),
      call("agent_deck_memory_mark_stale", { id: "memory-id" }),
    ];
    for (const request of cases) {
      await expect(bridge.dispatch(request, { token: "token-a" })).resolves.toEqual({
        content: "Agent Deck memory is paused",
        isError: true,
      });
    }
    expect(search).not.toHaveBeenCalled();

    enabled = true;
    const restored = await bridge.dispatch(cases[0]!, { token: "token-a" });
    expect(restored.isError).not.toBe(true);
    expect(restored.content).toContain("Stored memory");
  });

  it("applies the latest total grapheme budget after asynchronous ranking", async () => {
    const bridge = new BridgeRegistry();
    let budget = 6000;
    const search = vi.fn(async () => ({
      hits: ["One", "Two"].map((title, index) => ({
        record: {
          id: `memory-${index}`,
          type: "decision" as const,
          scope: "project" as const,
          status: "active" as const,
          useCount: 0,
          title,
          summary: "summary",
          body: "👨‍👩‍👧‍👦".repeat(2000),
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
          tags: [],
        },
        score: 1,
        sharedTerms: ["memory"],
      })),
      recall: {
        readiness: "not_requested" as const,
        mode: "lexical" as const,
        reason: null,
        message: "lexical",
      },
    }));
    registerMemoryTools(
      bridge,
      mkdtempSync(path.join(tmpdir(), "agent-deck-memory-tools-budget-")),
      () => "/project",
      search,
      undefined,
      () => true,
      () => budget,
    );

    budget = 1000;
    const result = await bridge.dispatch(call("agent_deck_memory_search", { query: "memory" }), {
      token: "token-a",
    });
    expect(graphemeCount(result.content)).toBeLessThanOrEqual(1000);
    expect(result.details).toMatchObject({ hits: 2 });
  });

  it("discards ranked search hits when a pause lands while ranking is in flight", async () => {
    const bridge = new BridgeRegistry();
    let enabled = true;
    const pending = deferred<{
      hits: Array<{
        record: {
          id: string;
          type: "decision";
          scope: "project";
          status: "active";
          title: string;
          summary: string;
          body: string;
          createdAt: string;
          updatedAt: string;
          tags: string[];
          useCount: number;
        };
        score: number;
        sharedTerms: string[];
      }>;
      recall: {
        readiness: "ready";
        mode: "semantic";
        reason: null;
        message: string;
      };
    }>();
    const search = vi.fn(() => pending.promise);
    registerMemoryTools(
      bridge,
      mkdtempSync(path.join(tmpdir(), "agent-deck-memory-tools-race-")),
      () => "/project",
      search,
      undefined,
      () => enabled,
    );

    const result = bridge.dispatch(call("agent_deck_memory_search", { query: "secret hit" }), {
      token: "token-a",
    });
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    enabled = false;
    pending.resolve({
      hits: [
        {
          record: {
            id: "memory-a",
            type: "decision",
            scope: "project",
            useCount: 0,
            status: "active",
            title: "Should not leak",
            summary: "private summary",
            body: "private ranked body",
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
            tags: [],
          },
          score: 1,
          sharedTerms: ["secret"],
        },
      ],
      recall: {
        readiness: "ready",
        mode: "semantic",
        reason: null,
        message: "Semantic ranking ready.",
      },
    });

    await expect(result).resolves.toEqual({
      content: "Agent Deck memory is paused",
      isError: true,
    });
  });

  it("discards ranked results when project authorization changes in flight", async () => {
    const bridge = new BridgeRegistry();
    let projectPath = "/project-a";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const search = vi.fn(async () => {
      await gate;
      return {
        hits: [],
        recall: {
          readiness: "ready" as const,
          mode: "semantic" as const,
          reason: null,
          message: "ready",
        },
      };
    });
    registerMemoryTools(
      bridge,
      mkdtempSync(path.join(tmpdir(), "agent-deck-memory-tools-owner-race-")),
      () => projectPath,
      search,
    );

    const result = bridge.dispatch(call("agent_deck_memory_search", { query: "memory" }), {
      token: "token-a",
    });
    await vi.waitFor(() => expect(search).toHaveBeenCalledTimes(1));
    projectPath = "/project-b";
    release();
    await expect(result).resolves.toEqual({
      content: "Memory project access changed; retry the search.",
      isError: true,
    });
  });
});

describe("memory provenance (MEM-11)", () => {
  const setup = (sourceAgent: (sessionId: string) => string | undefined) => {
    const bridge = new BridgeRegistry();
    const baseDir = mkdtempSync(path.join(tmpdir(), "agent-deck-mem-provenance-"));
    const projectPath = mkdtempSync(path.join(tmpdir(), "mem-provenance-project-"));
    registerMemoryTools(
      bridge,
      baseDir,
      () => projectPath,
      undefined,
      undefined,
      () => true,
      () => 6000,
      sourceAgent,
    );
    return { bridge, store: { baseDir, projectPath } };
  };

  const write = async (bridge: BridgeRegistry, title: string) =>
    await bridge.dispatch(
      call("agent_deck_memory_write", {
        type: "decision",
        title,
        summary: `${title} summary`,
        body: `${title} body`,
      }),
      { token: "token-a" },
    );

  it("stamps the writing agent on a delegated child's memory", async () => {
    const { bridge, store } = setup(() => "reviewer");
    const result = await write(bridge, "Child wrote this");
    expect(result.isError).not.toBe(true);
    const record = listMemories(store).find((entry) => entry.title === "Child wrote this")!;
    // Native passes the run's agent name for a delegated write
    // (AppViewModel.swift:6303) so the Memory detail can show its Source row.
    expect(record.sourceAgentName).toBe("reviewer");
  });

  it("leaves a parent session's own memory unattributed, as native does", async () => {
    const { bridge, store } = setup(() => undefined);
    await write(bridge, "Parent wrote this");
    const record = listMemories(store).find((entry) => entry.title === "Parent wrote this")!;
    // Native passes nil for the parent's own write (AppViewModel.swift:6297) —
    // even when that parent IS a named agent chat, so provenance means "a
    // delegated run authored this", not "some agent was involved".
    expect(record.sourceAgentName).toBeUndefined();
  });
});
