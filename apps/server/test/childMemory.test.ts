import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  graphemeCount,
  writeMemory,
  type MemorySearchHit,
  type MemoryStore,
} from "@agent-deck/memory";
import { describe, expect, it, vi } from "vitest";
import {
  makeChildMemoryRecall,
  registerChildBridgeAccess,
  resolveMemoryProjectPath,
} from "../src/childMemory.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}

function fixture() {
  const baseDir = mkdtempSync(path.join(tmpdir(), "agent-deck-child-memory-"));
  const projectPath = "/canonical/project";
  const record = writeMemory(
    { baseDir, projectPath },
    {
      type: "decision",
      title: "OAuth callback",
      summary: "oauth delegated callback",
      body: "👨‍👩‍👧‍👦".repeat(5000),
      confirmNew: true,
    },
  );
  if (!record.ok) throw new Error(record.message);
  const hit: MemorySearchHit = { record: record.record, score: 1, sharedTerms: ["oauth"] };
  return { baseDir, projectPath, hit };
}

const request = {
  projectId: "project-a",
  agentName: "reviewer",
  agentDescription: "Reviews OAuth implementation",
  task: "Check the OAuth callback",
};

describe("managed child automatic memory context", () => {
  it("removes child token, exact tool allowlist, and project mapping together", () => {
    const tokens = new Map<string, string>();
    const allowedTools = new Map<string, ReadonlySet<string>>();
    const memoryAuthorizations = new Map<string, { projectId: string; projectPath: string }>();
    const dispose = registerChildBridgeAccess({
      sessionId: "child-a",
      token: "token-a",
      toolNames: ["contact_supervisor", "agent_deck_memory_search"],
      authorization: { projectId: "project-a", projectPath: "/canonical/project" },
      tokens,
      allowedTools,
      memoryAuthorizations,
    });
    expect(tokens.get("child-a")).toBe("token-a");
    expect(allowedTools.get("child-a")).toEqual(
      new Set(["contact_supervisor", "agent_deck_memory_search"]),
    );
    expect(memoryAuthorizations.get("child-a")?.projectPath).toBe("/canonical/project");
    dispose();
    expect(tokens.has("child-a")).toBe(false);
    expect(allowedTools.has("child-a")).toBe(false);
    expect(memoryAuthorizations.has("child-a")).toBe(false);
  });

  it("resolves child tools to the canonical parent project, never a worktree, and fails stale", () => {
    const authorizations = new Map([
      ["child-a", { projectId: "project-a", projectPath: "/canonical/project" }],
    ]);
    let registeredPath: string | undefined = "/canonical/project";
    const resolve = () =>
      resolveMemoryProjectPath({
        sessionId: "child-a",
        childAuthorizations: authorizations,
        projectPath: () => registeredPath,
        parentCwd: () => undefined,
      });
    expect(resolve()).toBe("/canonical/project");
    registeredPath = "/replacement/project";
    expect(resolve()).toBeUndefined();
    authorizations.delete("child-a");
    expect(resolve()).toBeUndefined();
  });
  it("uses the same canonical registered store for parent and child tool calls", () => {
    expect(
      resolveMemoryProjectPath({
        sessionId: "parent-a",
        childAuthorizations: new Map(),
        projectPath: () => "/canonical/project",
        parentCwd: () => "/canonical/project",
      }),
    ).toBe("/canonical/project");
  });

  it("uses canonical project identity, index cap policy, max four recall, and 3500 cap", async () => {
    const { baseDir, projectPath, hit } = fixture();
    const recall = vi.fn(async (_store: MemoryStore, _query: string, _limit: number) => ({
      hits: [hit, hit, hit, hit, hit],
    }));
    const callback = makeChildMemoryRecall({
      memoryBaseDir: baseDir,
      settings: { enabled: () => true, characterBudget: () => 20_000 },
      projectPath: (id) => (id === "project-a" ? projectPath : undefined),
      recall,
    });

    const context = await callback(request);
    expect(context).toBeDefined();
    const content = context!.prompt;
    expect(recall).toHaveBeenCalledWith({ baseDir, projectPath }, expect.any(String), 4);
    expect(recall.mock.calls[0]![1]).toBe(
      "reviewer\nReviews OAuth implementation\nCheck the OAuth callback",
    );
    expect(content).toContain("Agent Deck memory policy:");
    expect(content).toContain("Project memory index");
    const recallBlock = content.slice(content.indexOf("<memory-context"));
    expect(graphemeCount(recallBlock)).toBeLessThanOrEqual(3500);
    expect(recallBlock.endsWith("</memory-context>")).toBe(true);
    expect(context!.isStillValid()).toBe(true);
  });

  it("re-proves live authorization immediately before spawn", async () => {
    const { baseDir, projectPath, hit } = fixture();
    let enabled = true;
    const callback = makeChildMemoryRecall({
      memoryBaseDir: baseDir,
      settings: { enabled: () => enabled, characterBudget: () => 6000 },
      projectPath: () => projectPath,
      recall: async () => ({ hits: [hit] }),
    });
    const context = await callback(request);
    expect(context?.isStillValid()).toBe(true);
    enabled = false;
    expect(context?.isStillValid()).toBe(false);
  });

  it("keeps anonymous managed children free of automatic context", async () => {
    const { baseDir, projectPath } = fixture();
    const recall = vi.fn();
    const callback = makeChildMemoryRecall({
      memoryBaseDir: baseDir,
      settings: { enabled: () => true, characterBudget: () => 6000 },
      projectPath: () => projectPath,
      recall,
    });
    expect(await callback({ projectId: "project-a", task: "anonymous task" })).toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
  });

  it.each(["pause", "subagent preference", "project change"])(
    "discards deferred ranking after %s",
    async (change) => {
      const { baseDir, projectPath, hit } = fixture();
      let master = true;
      let subagents = true;
      let livePath: string | undefined = projectPath;
      const pending = deferred<{ hits: MemorySearchHit[] }>();
      const callback = makeChildMemoryRecall({
        memoryBaseDir: baseDir,
        settings: {
          enabled: () => master && subagents,
          characterBudget: () => 6000,
        },
        projectPath: () => livePath,
        recall: () => pending.promise,
      });
      const result = callback(request);
      await Promise.resolve();
      if (change === "pause") master = false;
      if (change === "subagent preference") subagents = false;
      if (change === "project change") livePath = "/replacement/project";
      pending.resolve({ hits: [hit] });
      await expect(result).resolves.toBeUndefined();
    },
  );

  it("fails closed before ranking for a stale project", async () => {
    const recall = vi.fn();
    const callback = makeChildMemoryRecall({
      memoryBaseDir: "/memory",
      settings: { enabled: () => true, characterBudget: () => 6000 },
      projectPath: () => undefined,
      recall,
    });
    await expect(callback(request)).resolves.toBeUndefined();
    expect(recall).not.toHaveBeenCalled();
  });
});
