import { randomUUID } from "node:crypto";
import { mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { SessionManager } from "../src/SessionManager.ts";
import { buildSubagentTaskPrompt } from "../src/services/sessionManager.ts";
import { ReceiptBus } from "../src/receipts.ts";
import type { ServerRuntime } from "../src/runtime.ts";
import { SubagentRunStore, type SubagentRunRecord } from "../src/subagentRunStore.ts";

function setup(overrides: Partial<SubagentRunRecord> = {}) {
  const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-continue-service-"));
  const sessionFile = path.join(dataDir, "child.jsonl");
  writeFileSync(sessionFile, "{}\n");
  const parentId = randomUUID();
  const run: SubagentRunRecord = {
    id: randomUUID(),
    parentSessionId: parentId,
    task: "first task",
    status: "completed",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    summary: "first result",
    source: "single",
    sessionFile,
    ...overrides,
  };
  const store = new SubagentRunStore(dataDir, vi.fn());
  store.create(run);
  const manager = new SessionManager(undefined as unknown as ServerRuntime, new ReceiptBus(false));
  const runChildAgent = vi.fn().mockResolvedValue({ runId: run.id, text: "second result" });
  (manager as unknown as { subagentRuns: SubagentRunStore }).subagentRuns = store;
  (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(parentId, {
    runChildAgent,
  });
  return { manager, parentId, run, sessionFile, runChildAgent, store };
}

describe("SessionManager managed_subagent continuation eligibility", () => {
  it("adds read-first hints to fresh and continuation prompts without weakening assignment boundaries", () => {
    const fresh = buildSubagentTaskPrompt("inspect", ["AGENTS.md", "src/main.ts"], false);
    expect(fresh).toContain("only active assignment for this fresh child session");
    expect(fresh).toContain("hints, not injected truth");
    expect(fresh).toContain("has not preloaded their contents");
    expect(fresh).toContain("AGENTS.md\nsrc/main.ts");
    expect(fresh).toMatch(/Task:\ninspect$/);

    const continuation = buildSubagentTaskPrompt("follow up", ["docs/guide.md"], true);
    expect(continuation).toContain("prior child messages are available");
    expect(continuation).toContain("task below is the only active assignment");
    expect(buildSubagentTaskPrompt("unchanged", [], true)).toBe("unchanged");
  });

  it("reuses the stable run and Pi --session input after same-parent validation", async () => {
    const { manager, parentId, run, sessionFile, runChildAgent } = setup();
    await expect(
      manager.runManagedSubagent(parentId, "authoritative follow-up", undefined, run.id),
    ).resolves.toEqual({ runId: run.id, text: "second result" });
    expect(runChildAgent).toHaveBeenCalledWith(
      "authoritative follow-up",
      undefined,
      undefined,
      undefined,
      {
        source: "single",
        declaredReads: [],
        runId: run.id,
        resumeSessionPath: sessionFile,
      },
    );
  });

  it("forwards declared reads on continuation and resolves omission to an empty latest-turn list", async () => {
    const { manager, parentId, run, runChildAgent } = setup();
    await manager.runManagedSubagent(parentId, "follow up", undefined, run.id, [
      "AGENTS.md",
      "src/main.ts",
    ]);
    expect(runChildAgent).toHaveBeenLastCalledWith(
      "follow up",
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ declaredReads: ["AGENTS.md", "src/main.ts"] }),
    );
    await manager.runManagedSubagent(parentId, "another follow up", undefined, run.id);
    expect(runChildAgent).toHaveBeenLastCalledWith(
      "another follow up",
      undefined,
      undefined,
      undefined,
      expect.objectContaining({ declaredReads: [] }),
    );
  });

  it("preserves the original named agent when continuation omits agent", async () => {
    const { manager, parentId, run, runChildAgent } = setup({ agent: "reviewer" });
    await manager.runManagedSubagent(parentId, "follow up", undefined, run.id);
    expect(runChildAgent).toHaveBeenCalledWith(
      "follow up",
      "reviewer",
      undefined,
      undefined,
      expect.objectContaining({ runId: run.id }),
    );
  });

  it("allows an explicit continuation agent to replace the original", async () => {
    const { manager, parentId, run, runChildAgent } = setup({ agent: "reviewer" });
    await manager.runManagedSubagent(parentId, "follow up", "writer", run.id);
    expect(runChildAgent).toHaveBeenCalledWith(
      "follow up",
      "writer",
      undefined,
      undefined,
      expect.objectContaining({ runId: run.id }),
    );
  });

  it.each(["completed", "failed", "stopped", "interrupted"] as const)(
    "allows an eligible %s single run",
    async (status) => {
      const { manager, parentId, run, runChildAgent } = setup({ status });
      await manager.runManagedSubagent(parentId, "follow up", undefined, run.id);
      expect(runChildAgent).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["parallel", { source: "parallel" as const }, /only single/],
    ["active", { status: "running" as const, completedAt: undefined }, /still active/],
    ["legacy", { source: undefined, sessionFile: undefined }, /only single/],
    ["missing file", { sessionFile: path.join(tmpdir(), randomUUID()) }, /missing or inaccessible/],
  ])("rejects %s records before child launch", async (_label, overrides, message) => {
    const { manager, parentId, run, runChildAgent } = setup(overrides);
    await expect(
      manager.runManagedSubagent(parentId, "follow up", undefined, run.id),
    ).rejects.toThrow(message);
    expect(runChildAgent).not.toHaveBeenCalled();
  });

  it.each([
    ["relative", "child.jsonl", /not absolute/],
    ["directory", tmpdir(), /not a regular file/],
  ])("rejects an invalid %s session path", async (_label, sessionFile, message) => {
    const { manager, parentId, run, runChildAgent } = setup({ sessionFile });
    await expect(
      manager.runManagedSubagent(parentId, "follow up", undefined, run.id),
    ).rejects.toThrow(message);
    expect(runChildAgent).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a final symlink without taking ownership of its target",
    async () => {
      const { manager, parentId, run, sessionFile, runChildAgent } = setup();
      const link = `${sessionFile}.link`;
      symlinkSync(sessionFile, link);
      const stored = (manager as unknown as { subagentRuns: SubagentRunStore }).subagentRuns;
      stored.update(run.id, { sessionFile: link });

      await expect(
        manager.runManagedSubagent(parentId, "follow up", undefined, run.id),
      ).rejects.toThrow(/not a regular file/);
      expect(runChildAgent).not.toHaveBeenCalled();
      expect(() => writeFileSync(sessionFile, "still-owned-by-pi\n")).not.toThrow();
    },
  );

  it("rejects cross-parent IDs before child launch", async () => {
    const { manager, run, runChildAgent } = setup();
    const otherParent = randomUUID();
    (manager as unknown as { sessions: Map<string, unknown> }).sessions.set(otherParent, {
      runChildAgent,
    });
    await expect(
      manager.runManagedSubagent(otherParent, "follow up", undefined, run.id),
    ).rejects.toThrow(/different parent/);
    expect(runChildAgent).not.toHaveBeenCalled();
  });

  it("claims a run so concurrent duplicate continuation cannot reach a second prompt", async () => {
    const { manager, parentId, run, runChildAgent } = setup();
    let release!: () => void;
    runChildAgent.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ runId: run.id, text: "done" });
        }),
    );
    const first = manager.runManagedSubagent(parentId, "first follow-up", undefined, run.id);
    await expect(
      manager.runManagedSubagent(parentId, "duplicate", undefined, run.id),
    ).rejects.toThrow(/already being continued/);
    expect(runChildAgent).toHaveBeenCalledOnce();
    release();
    await first;
    await manager.runManagedSubagent(parentId, "after release", undefined, run.id);
    expect(runChildAgent).toHaveBeenCalledTimes(2);
  });

  it("releases a continuation claim exactly once after child launch failure", async () => {
    const { manager, parentId, run, runChildAgent } = setup();
    runChildAgent.mockRejectedValueOnce(new Error("spawn failed"));
    await expect(
      manager.runManagedSubagent(parentId, "failing follow-up", undefined, run.id),
    ).rejects.toThrow("spawn failed");

    await manager.runManagedSubagent(parentId, "retry after failure", undefined, run.id);
    expect(runChildAgent).toHaveBeenCalledTimes(2);
  });
});
