import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyTranscript } from "@agent-deck/domain";
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
  it("owns bounded per-turn artifacts and deletes only its proven root", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-artifacts-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ source: "single" });
    const allocation = store.prepareTurn(run, "system prompt");
    store.create({
      ...run,
      artifactRootId: allocation.artifactRootId,
      artifactRootToken: allocation.identityToken,
      currentTurnId: allocation.turnId,
    });
    store.writeOutput(run.id, "final output");
    const sessionFile = path.join(allocation.sessionsDirectory, "child.jsonl");
    writeFileSync(sessionFile, "{}\n");
    store.markOwnedSession(run.id, sessionFile);
    const expectedDirectory = realpathSync.native(path.join(dataDir, "Subagent Runs", run.id));
    expect(store.artifactDirectoryForReveal(run.id)).toBe(path.toNamespacedPath(expectedDirectory));
    expect(store.cells(PARENT_A)[0]?.artifactRootId).toBe(run.id);
    store.removeParent(PARENT_A);
    expect(existsSync(path.join(dataDir, "Subagent Runs", run.id))).toBe(false);
  });

  it("retains a valid allocation when metadata commit never happened", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-commit-gap-"));
    const warnings = vi.fn();
    const first = new SubagentRunStore(dataDir, warnings);
    const run = record();
    first.prepareTurn(run, "system");
    const root = path.join(realpathSync(dataDir), "Subagent Runs", run.id);
    expect(existsSync(path.join(root, "manifest.json"))).toBe(true);

    new SubagentRunStore(dataDir, warnings);
    expect(existsSync(root)).toBe(true);
    expect(warnings).toHaveBeenCalledWith(
      expect.stringContaining(`retained unrecorded subagent artifact root ${run.id}`),
    );
  });

  it("marks a contained session owned when an active run is interrupted at restart", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-interrupted-owned-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record();
    const allocation = store.prepareTurn(run, "system");
    const sessionFile = path.join(allocation.sessionsDirectory, "interrupted.jsonl");
    writeFileSync(sessionFile, "{}\n");
    store.create({
      ...run,
      sessionFile,
      artifactRootId: allocation.artifactRootId,
      artifactRootToken: allocation.identityToken,
      currentTurnId: allocation.turnId,
    });

    const reloaded = new SubagentRunStore(dataDir, vi.fn());
    expect(reloaded.get(run.id)).toEqual(
      expect.objectContaining({ status: "interrupted", sessionOwnership: "owned" }),
    );
    expect(reloaded.cells(run.parentSessionId)[0]).toEqual(
      expect.objectContaining({ status: "interrupted", artifactRootId: run.id }),
    );
  });

  it("scopes live transcript projections to the owning parent and invalidates them on deletion", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-live-transcript-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ status: "running" });
    store.create(run);
    store.registerLiveTranscript(run.id);
    const transcript = {
      ...emptyTranscript(),
      cells: [
        { kind: "user" as const, id: "child-user", text: "ordered child input" },
        {
          kind: "subagent" as const,
          id: "nested-child",
          task: "legacy nested run",
          status: "done" as const,
          text: "nested",
          progress: [],
          artifactRootId: randomUUID(),
        },
        {
          kind: "tool" as const,
          id: "tool",
          toolCallId: "call",
          toolName: "test",
          args: { nested: { artifactRootToken: "secret", safe: "kept" } },
          status: "done" as const,
        },
      ],
    };
    store.updateLiveTranscript(run.id, transcript);

    expect(store.liveTranscript(PARENT_B, run.id)).toBeUndefined();
    const snapshot = store.liveTranscript(PARENT_A, run.id)!;
    expect(snapshot.source).toBe("live");
    expect(snapshot.cells[0]).toEqual(
      expect.objectContaining({ kind: "user", text: "ordered child input" }),
    );
    expect(snapshot.cells[1]).not.toHaveProperty("artifactRootId");
    expect(snapshot.cells[2]).toEqual(
      expect.objectContaining({ args: { nested: { safe: "kept" } } }),
    );
    expect(JSON.stringify(snapshot)).not.toMatch(
      /sessionFile|artifactRoot|identityToken|worktree|turnDirectory|sessionsDirectory/,
    );

    store.removeParent(PARENT_A);
    expect(store.liveTranscript(PARENT_A, run.id)).toBeUndefined();
    expect(() => store.updateLiveTranscript(run.id, transcript)).not.toThrow();
  });

  it.each([
    ["completed", "done"],
    ["failed", "error"],
    ["stopped", "stopped"],
    ["interrupted", "interrupted"],
  ] as const)(
    "maps terminal %s transcript metadata without changing identity",
    (status, expected) => {
      const dataDir = mkdtempSync(path.join(tmpdir(), `subagent-terminal-${status}-`));
      const store = new SubagentRunStore(dataDir, vi.fn());
      const completedAt = new Date().toISOString();
      const run = record({ status, completedAt, updatedAt: completedAt });
      store.create(run);
      expect(store.summaryTranscript(run)).toEqual(
        expect.objectContaining({ runId: run.id, status: expected, source: "summary_only" }),
      );
    },
  );

  it("labels legacy retained evidence as summary-only rather than canonical", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-summary-transcript-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const completedAt = new Date().toISOString();
    const run = record({
      status: "completed",
      completedAt,
      updatedAt: completedAt,
      summary: "retained result",
    });
    store.create(run);

    const snapshot = store.summaryTranscript(run);
    expect(snapshot.source).toBe("summary_only");
    expect(snapshot.notice).toMatch(/Full canonical child history is unavailable/);
    expect(snapshot.cells.map((cell) => cell.kind)).toEqual(["user", "assistant"]);
  });

  it("serializes parent deletion against allocation commit", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-delete-allocation-race-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record();
    store.prepareTurn(run, "system");
    store.removeParent(run.parentSessionId);
    expect(() => store.create(run)).toThrow(/deleted during subagent allocation/);
  });

  it("retries metadata removal after a proven root was already deleted", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-delete-retry-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record();
    const allocation = store.prepareTurn(run, "system");
    store.create({
      ...run,
      artifactRootId: allocation.artifactRootId,
      artifactRootToken: allocation.identityToken,
      currentTurnId: allocation.turnId,
    });
    rmSync(path.join(realpathSync(dataDir), "Subagent Runs", run.id), { recursive: true });
    store.removeParent(PARENT_A);
    expect(store.get(run.id)).toBeUndefined();
  });

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

  it("round-trips additive continuation fields while accepting legacy v1 records", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-continuation-fields-"));
    const sessionFile = path.join(dataDir, "child.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const store = new SubagentRunStore(dataDir, vi.fn());
    const current = record({ source: "single", sessionFile });
    store.create(current);
    expect(new SubagentRunStore(dataDir, vi.fn()).get(current.id)).toEqual(
      expect.objectContaining({ source: "single", sessionFile }),
    );

    const legacyDir = mkdtempSync(path.join(tmpdir(), "subagent-legacy-v1-"));
    const legacy = record();
    writeFileSync(
      path.join(legacyDir, "subagent-runs.json"),
      `${JSON.stringify({ version: 1, runs: [legacy] })}\n`,
    );
    const restoredLegacy = new SubagentRunStore(legacyDir, vi.fn()).get(legacy.id)!;
    expect(restoredLegacy.id).toBe(legacy.id);
    expect(restoredLegacy.source).toBeUndefined();
    expect(restoredLegacy.sessionFile).toBeUndefined();
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
