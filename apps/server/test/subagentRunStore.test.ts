import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SubagentRunStore, type SubagentRunRecord } from "../src/subagentRunStore.ts";

const PARENT_A = randomUUID();
const PARENT_B = randomUUID();

const record = (overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    parentSessionId: PARENT_A,
    task: "inspect the implementation",
    status: "starting",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

describe("SubagentRunStore", () => {
  it("persists independent completed runs and hydrates stable transcript cards", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-runs-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const first = record();
    const second = record({ agent: "reviewer" });
    store.create(first);
    store.create(second);
    const completedAt = new Date().toISOString();
    store.update(first.id, {
      status: "completed",
      updatedAt: completedAt,
      completedAt,
      summary: "first result",
      model: "mock-model",
      inputTokens: 2,
      outputTokens: 3,
      durationMs: 12,
    });
    store.update(second.id, {
      status: "failed",
      updatedAt: completedAt,
      completedAt,
      error: "second failed",
    });

    const restored = new SubagentRunStore(dataDir, vi.fn());
    expect(restored.list(PARENT_A).map((run) => run.id)).toEqual([first.id, second.id]);
    expect(restored.cells(PARENT_A)).toEqual([
      expect.objectContaining({ id: first.id, status: "done", text: "first result" }),
      expect.objectContaining({
        id: second.id,
        status: "error",
        text: "",
        error: "second failed",
      }),
    ]);
  });

  it("atomically corrects active-at-restart records to interrupted", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-interrupt-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ status: "running" });
    store.create(run);

    const restored = new SubagentRunStore(dataDir, vi.fn());
    expect(restored.list(PARENT_A)[0]).toEqual(
      expect.objectContaining({ id: run.id, status: "interrupted" }),
    );
    expect(restored.cells(PARENT_A)[0]).toEqual(
      expect.objectContaining({
        id: run.id,
        status: "interrupted",
        error: "Subagent run was interrupted by an app or server restart.",
      }),
    );
    expect(readdirSync(dataDir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("preserves stopped status and partial output separately from its reason", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-stopped-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record();
    store.create(run);
    const completedAt = new Date().toISOString();
    store.update(run.id, {
      status: "stopped",
      updatedAt: completedAt,
      completedAt,
      summary: "partial output",
      error: "Stopped by parent shutdown.",
    });

    expect(new SubagentRunStore(dataDir, vi.fn()).cells(PARENT_A)[0]).toEqual(
      expect.objectContaining({
        status: "stopped",
        text: "partial output",
        error: "Stopped by parent shutdown.",
      }),
    );
  });

  it("fsyncs the temporary file and containing directory for each committed rename", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-durable-"));
    const syncFile = vi.fn();
    const syncDirectory = vi.fn();
    const store = new SubagentRunStore(dataDir, vi.fn(), { syncFile, syncDirectory });
    store.create(record());

    expect(syncFile).toHaveBeenCalledOnce();
    expect(syncDirectory).toHaveBeenCalledOnce();
    expect(syncDirectory).toHaveBeenCalledWith(dataDir);
  });

  it("retains renamed state in memory when directory fsync fails before a later write", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-directory-sync-"));
    const syncDirectory = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("directory fsync failed");
      })
      .mockImplementation(() => {});
    const store = new SubagentRunStore(dataDir, vi.fn(), {
      syncFile: vi.fn(),
      syncDirectory,
    });
    const first = record();
    const second = record();

    expect(() => store.create(first)).toThrow("directory fsync failed");
    // The rename succeeded before directory fsync failed. A subsequent commit
    // must build on that candidate rather than stale pre-rename memory.
    store.create(second);

    expect(new SubagentRunStore(dataDir, vi.fn()).list(PARENT_A).map((run) => run.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("removes only records owned by the deleted parent", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-remove-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    store.create(record({ parentSessionId: PARENT_A }));
    store.create(record({ parentSessionId: PARENT_B }));
    store.removeParent(PARENT_A);

    const restored = new SubagentRunStore(dataDir, vi.fn());
    expect(restored.list(PARENT_A)).toEqual([]);
    expect(restored.list(PARENT_B)).toHaveLength(1);
  });

  it("quarantines corrupt and tampered persistence without loading it", () => {
    for (const body of ["{broken", JSON.stringify({ version: 1, runs: [{ forged: true }] })]) {
      const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-corrupt-"));
      const file = path.join(dataDir, "subagent-runs.json");
      writeFileSync(file, body);
      const warn = vi.fn();
      const store = new SubagentRunStore(dataDir, warn);

      expect(store.list(PARENT_A)).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
      expect(existsSync(file)).toBe(false);
      expect(readdirSync(dataDir).some((name) => name.includes(".corrupt-"))).toBe(true);
    }
  });
});
