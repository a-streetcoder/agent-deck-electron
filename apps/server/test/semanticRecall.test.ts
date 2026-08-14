import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { EmbedderUnavailableError, writeMemory, type Embedder } from "@agent-deck/memory";
import { describe, expect, it, vi } from "vitest";
import { SemanticRecallCoordinator } from "../src/semanticRecall.ts";

function store() {
  const value = {
    baseDir: mkdtempSync(path.join(tmpdir(), "semantic-recall-")),
    projectPath: "/project",
  };
  writeMemory(value, {
    type: "context",
    title: "OAuth token",
    summary: "login token location",
    body: "The login token is in auth.json.",
  });
  return value;
}

const validEmbedder: Embedder = {
  async embed(texts) {
    return texts.map((_, index) => (index === 0 ? [1, 0] : [0.9, 0.1]));
  },
};

describe("SemanticRecallCoordinator", () => {
  it("keeps status and preference changes passive, then coalesces explicit initialization", async () => {
    let requested = false;
    let release!: (embedder: Embedder) => void;
    const create = vi.fn(() => new Promise<Embedder>((resolve) => (release = resolve)));
    const coordinator = new SemanticRecallCoordinator(() => requested, undefined, create);

    expect(coordinator.getStatus()).toMatchObject({ readiness: "not_requested", mode: "lexical" });
    requested = true;
    coordinator.preferenceChanged(true);
    expect(coordinator.getStatus()).toMatchObject({ readiness: "not_checked", mode: "lexical" });
    expect(create).not.toHaveBeenCalled();

    const first = coordinator.check();
    const second = coordinator.check();
    expect(coordinator.getStatus().readiness).toBe("checking");
    coordinator.preferenceChanged(true);
    expect(coordinator.getStatus().readiness).toBe("checking");
    const third = coordinator.check();
    expect(create).toHaveBeenCalledTimes(1);
    release(validEmbedder);
    expect(await first).toMatchObject({ readiness: "ready", mode: "semantic" });
    expect(await second).toMatchObject({ readiness: "ready", mode: "semantic" });
    expect(await third).toMatchObject({ readiness: "ready", mode: "semantic" });
  });

  it.each(["success", "failure"] as const)(
    "discards a semantic %s when the preference is disabled mid-embed",
    async (outcome) => {
      let requested = true;
      let embeddingStarted!: () => void;
      const started = new Promise<void>((resolve) => (embeddingStarted = resolve));
      let settle!: (vectors: number[][]) => void;
      let fail!: (error: Error) => void;
      const pendingEmbedding = new Promise<number[][]>((resolve, reject) => {
        settle = resolve;
        fail = reject;
      });
      const embedder: Embedder = {
        embed: vi.fn(async () => {
          embeddingStarted();
          return pendingEmbedding;
        }),
      };
      const coordinator = new SemanticRecallCoordinator(() => requested, embedder);
      const memoryStore = store();

      const pendingRecall = coordinator.recall(memoryStore, "oauth token");
      await started;
      requested = false;
      if (outcome === "success")
        settle([
          [1, 0],
          [0.9, 0.1],
        ]);
      else fail(new Error("private runtime failure"));

      const result = await pendingRecall;
      expect(result.hits[0]?.record.title).toBe("OAuth token");
      expect(result.recall).toMatchObject({ readiness: "not_requested", mode: "lexical" });
      expect(coordinator.getStatus()).toMatchObject({
        readiness: "not_requested",
        mode: "lexical",
      });

      requested = true;
      expect(coordinator.getStatus()).toMatchObject({ readiness: "ready", mode: "semantic" });
    },
  );

  it("automatically retries a transient initialization failure on the next active recall", async () => {
    const create = vi
      .fn<() => Promise<Embedder>>()
      .mockRejectedValueOnce(new Error("transient model download failure"))
      .mockResolvedValue(validEmbedder);
    const coordinator = new SemanticRecallCoordinator(() => true, undefined, create);
    const memoryStore = store();

    const first = await coordinator.recall(memoryStore, "oauth token");
    expect(first.recall).toMatchObject({
      readiness: "error",
      mode: "lexical_fallback",
      reason: "initialization_failed",
    });
    expect(first.hits[0]?.record.title).toBe("OAuth token");

    const second = await coordinator.recall(memoryStore, "oauth token");
    expect(second.recall).toMatchObject({ readiness: "ready", mode: "semantic", reason: null });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("retries an initialization failure on an explicit check", async () => {
    const create = vi
      .fn<() => Promise<Embedder>>()
      .mockRejectedValueOnce(new Error("transient initialization failure"))
      .mockResolvedValue(validEmbedder);
    const coordinator = new SemanticRecallCoordinator(() => true, undefined, create);

    expect(await coordinator.check()).toMatchObject({
      readiness: "error",
      reason: "initialization_failed",
    });
    expect(await coordinator.check()).toMatchObject({
      readiness: "ready",
      mode: "semantic",
      reason: null,
    });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("returns only safe unavailable metadata and retries only on an explicit check", async () => {
    const create = vi
      .fn<() => Promise<Embedder>>()
      .mockRejectedValueOnce(new EmbedderUnavailableError("private /Users/name/model path"))
      .mockResolvedValue(validEmbedder);
    const coordinator = new SemanticRecallCoordinator(() => true, undefined, create);

    const first = await coordinator.recall(store(), "oauth token");
    expect(first.recall).toEqual({
      readiness: "unavailable",
      mode: "lexical_fallback",
      reason: "optional_dependency_missing",
      message:
        "Semantic ranking is unavailable because its optional component is not installed. Recall is using lexical fallback.",
    });
    expect(JSON.stringify(first.recall)).not.toContain("/Users/name");
    await coordinator.recall(store(), "oauth token");
    expect(create).toHaveBeenCalledTimes(1);

    expect(await coordinator.check()).toMatchObject({ readiness: "ready", mode: "semantic" });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it.each([
    {
      failure: async (): Promise<number[][]> => [[Number.NaN], [1]],
      reason: "invalid_embedding",
    },
    {
      failure: async (): Promise<number[][]> => Promise.reject(new Error("private transcript")),
      reason: "embedding_failed",
    },
  ] as const)(
    "preserves $reason through explicit checks until a successful recall",
    async ({ failure, reason }) => {
      let shouldFail = true;
      const embedder: Embedder = {
        embed: async (texts) => (shouldFail ? failure() : validEmbedder.embed(texts)),
      };
      const coordinator = new SemanticRecallCoordinator(() => true, embedder);
      const memoryStore = store();
      const result = await coordinator.recall(memoryStore, "oauth token");
      expect(result.hits[0]?.record.title).toBe("OAuth token");
      expect(result.recall).toMatchObject({
        readiness: "error",
        mode: "lexical_fallback",
        reason,
      });
      expect(JSON.stringify(result.recall)).not.toContain("private transcript");

      expect(await coordinator.check()).toMatchObject({ readiness: "error", reason });
      shouldFail = false;
      expect(await coordinator.recall(memoryStore, "oauth token")).toMatchObject({
        recall: { readiness: "ready", mode: "semantic", reason: null },
      });
    },
  );
});
