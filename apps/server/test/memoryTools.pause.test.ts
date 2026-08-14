import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
});
