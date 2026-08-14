import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { writeBridgeExtension } from "../src/bridge.ts";

describe("generated recall bridge", () => {
  it("persists only versioned recalled source metadata after a nonempty recall", () => {
    const file = writeBridgeExtension({
      endpoint: "http://127.0.0.1:1234/bridge",
      sessionId: "session-a",
      token: "token-a",
      tools: [],
      recall: true,
    });
    try {
      const source = readFileSync(file, "utf8");
      expect(source).toContain("pendingRecall = { version: 1, memories: recalled };");
      expect(source).toContain('pi.appendEntry("agent-deck.memory-recall", recall);');
      expect(source).toContain("if (block)");
      expect(source).toContain("if (recalled.length > 0)");
      expect(source).toContain(
        'if (!event.message || event.message.role !== "assistant" || !pendingRecall) return;',
      );
      const append = source.match(/pi\.appendEntry\([^;]+;/)?.[0] ?? "";
      expect(append).not.toMatch(/query|body|path|projectId/);
    } finally {
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  it("preserves a nonempty prompt block but skips the entry for malformed metadata", async () => {
    const file = writeBridgeExtension({
      endpoint: "http://127.0.0.1:1234/bridge",
      sessionId: "session-a",
      token: "token-a",
      tools: [],
      recall: true,
    });
    try {
      const source = readFileSync(file, "utf8");
      const extension = new Function(
        source.replace("export default function (pi)", "return function (pi)"),
      )() as (pi: {
        registerTool(): void;
        appendEntry: ReturnType<typeof vi.fn>;
        on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
      }) => void;
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const appendEntry = vi.fn();
      extension({
        registerTool: vi.fn(),
        appendEntry,
        on: (event, handler) => handlers.set(event, handler),
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            content: "recall-block",
            recalled: [
              { id: "decision-a", title: "Decision A", type: "decision", body: "forbidden" },
            ],
          }),
        })),
      );

      const result = (await handlers.get("before_agent_start")!(
        { prompt: "question", systemPrompt: "base" },
        { getSystemPrompt: () => "base" },
      )) as { systemPrompt: string };

      expect(result.systemPrompt).toBe("base\n\nrecall-block");
      expect(result.systemPrompt.split("recall-block")).toHaveLength(2);
      await handlers.get("message_start")!({ message: { role: "assistant" } }, {});
      expect(appendEntry).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });

  it("appends valid pending evidence once before the first assistant entry and clears stale data", async () => {
    const file = writeBridgeExtension({
      endpoint: "http://127.0.0.1:1234/bridge",
      sessionId: "session-a",
      token: "token-a",
      tools: [],
      recall: true,
    });
    try {
      const source = readFileSync(file, "utf8");
      const extension = new Function(
        source.replace("export default function (pi)", "return function (pi)"),
      )() as (pi: {
        registerTool(): void;
        appendEntry: ReturnType<typeof vi.fn>;
        on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void;
      }) => void;
      const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
      const appendEntry = vi.fn();
      extension({
        registerTool: vi.fn(),
        appendEntry,
        on: (event, handler) => handlers.set(event, handler),
      });
      const fetch = vi.fn(async () => ({
        ok: true,
        json: async () => ({
          content: "recall-block",
          recalled: [{ id: "decision-a", title: "Decision A", type: "decision" }],
        }),
      }));
      vi.stubGlobal("fetch", fetch);

      const result = (await handlers.get("before_agent_start")!(
        { prompt: "question", systemPrompt: "base" },
        { getSystemPrompt: () => "base" },
      )) as { systemPrompt: string };
      expect(result.systemPrompt).toBe("base\n\nrecall-block");
      expect(result.systemPrompt.split("recall-block")).toHaveLength(2);
      expect(appendEntry).not.toHaveBeenCalled();

      await handlers.get("message_start")!({ message: { role: "user" } }, {});
      expect(appendEntry).not.toHaveBeenCalled();
      await handlers.get("message_start")!({ message: { role: "assistant" } }, {});
      await handlers.get("message_start")!({ message: { role: "assistant" } }, {});
      expect(appendEntry).toHaveBeenCalledTimes(1);
      expect(appendEntry).toHaveBeenCalledWith("agent-deck.memory-recall", {
        version: 1,
        memories: [{ id: "decision-a", title: "Decision A", type: "decision" }],
      });

      // A later before_agent_start clears any unconsumed prior payload before
      // fetching. If that fetch fails, a later turn cannot append stale data.
      await handlers.get("before_agent_start")!(
        { prompt: "queued", systemPrompt: "base" },
        { getSystemPrompt: () => "base" },
      );
      fetch.mockRejectedValueOnce(new Error("bridge down"));
      await handlers.get("before_agent_start")!(
        { prompt: "replacement", systemPrompt: "base" },
        { getSystemPrompt: () => "base" },
      );
      await handlers.get("message_start")!({ message: { role: "assistant" } }, {});
      expect(appendEntry).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
      rmSync(dirname(file), { recursive: true, force: true });
    }
  });
});
