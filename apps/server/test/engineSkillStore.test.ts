import { describe, expect, it, vi } from "vitest";
import { ResourceCatalogCapabilityError } from "@agent-deck/resources";
import type { SkillInfo } from "@agent-deck/domain";
import { EngineSkillStore } from "../src/skills/engineSkillStore.ts";
import type { SkillEngineNative } from "../src/skills/skillEngineNative.ts";

/** A fully-stubbed engine; individual tests override the methods they exercise. */
function fakeEngine(overrides: Partial<SkillEngineNative> = {}): SkillEngineNative {
  return {
    listSkills: vi.fn(() => [] as SkillInfo[]),
    writeSkill: vi.fn(() => "/canonical/.agents/skills/x/SKILL.md"),
    deleteSkill: vi.fn(),
    renameSkill: vi.fn(() => "/canonical/.agents/skills/y/SKILL.md"),
    importLocalSkill: vi.fn(() => "/canonical/.agents/skills/z/SKILL.md"),
    fanOut: vi.fn(() => ["claude-code", "codex"]),
    listRecoveries: vi.fn(() => []),
    restoreRecovery: vi.fn(() => "/canonical/.agents/skills/s/SKILL.md"),
    acknowledgeRecovery: vi.fn(),
    importGitRepo: vi.fn(() => ({ collectionId: "c1", skills: ["a", "b"] })),
    inspectGitRepo: vi.fn(() => ({ collectionId: "c1", skills: [] })),
    discardGitPreview: vi.fn(),
    checkGitRepo: vi.fn(() => []),
    syncGitRepo: vi.fn(() => ({ applied: [], conflicts: [] })),
    conflictPaths: vi.fn(() => ({ mergeId: "m1", paths: [] })),
    resolveGitConflict: vi.fn(() => []),
    resolveGitConflictPaths: vi.fn(() => []),
    forgetGitRepo: vi.fn(),
    listGitRepos: vi.fn(() => []),
    ...overrides,
  };
}

function makeStore(engine: SkillEngineNative, scanResult: SkillInfo[] = []) {
  const scanSkillsFor = vi.fn(() => scanResult);
  const projectRootFor = vi.fn((projectId?: string) =>
    projectId === "proj" ? "/home/proj" : undefined,
  );
  const store = new EngineSkillStore({ engine, scanSkillsFor, home: "/home", projectRootFor });
  return { store, scanSkillsFor, projectRootFor };
}

describe("EngineSkillStore", () => {
  it("reads through the scanner, NEVER the engine's listSkills", () => {
    const skills = [{ name: "a" }] as SkillInfo[];
    const engine = fakeEngine();
    const { store, scanSkillsFor } = makeStore(engine, skills);

    expect(store.listSkills("proj")).toBe(skills);
    expect(scanSkillsFor).toHaveBeenCalledWith("proj");
    expect(engine.listSkills).not.toHaveBeenCalled();
  });

  it("writes global skills through the engine with home root and no project root", () => {
    const engine = fakeEngine();
    const { store } = makeStore(engine);

    const path = store.writeSkill("global", "helper", { description: "d", body: "b" });
    expect(path).toBe("/canonical/.agents/skills/x/SKILL.md");
    expect(engine.writeSkill).toHaveBeenCalledWith(
      "/home",
      undefined,
      "global",
      "helper",
      "d",
      "b",
    );
    // fan-out projects the canonical skill into other tools, rooted at home for global.
    expect(engine.fanOut).toHaveBeenCalledWith("/home", "helper");
  });

  it("resolves the project root for project-scope mutations", () => {
    const engine = fakeEngine();
    const { store } = makeStore(engine);

    store.writeSkill("project", "proj-skill", { body: "b" }, "proj");
    expect(engine.writeSkill).toHaveBeenCalledWith(
      "/home",
      "/home/proj",
      "project",
      "proj-skill",
      undefined,
      "b",
    );
    expect(engine.fanOut).toHaveBeenCalledWith("/home/proj", "proj-skill");
  });

  it("rejects a project-scope mutation when no project root resolves, before touching the engine", () => {
    const engine = fakeEngine();
    const { store } = makeStore(engine); // projectRootFor returns undefined for unknown id

    try {
      store.writeSkill("project", "x", { body: "b" }, "missing");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResourceCatalogCapabilityError);
      expect((error as ResourceCatalogCapabilityError).code).toBe("RESOURCE_INVALID_PATH");
    }
    // the engine must not be touched at all when the root cannot resolve.
    expect(engine.writeSkill).not.toHaveBeenCalled();
    expect(engine.fanOut).not.toHaveBeenCalled();
  });

  it("translates a RESOURCE_* engine error into ResourceCatalogCapabilityError", () => {
    const engine = fakeEngine({
      renameSkill: vi.fn(() => {
        throw new Error("RESOURCE_ALREADY_EXISTS: target exists");
      }),
    });
    const { store } = makeStore(engine);

    try {
      store.renameSkill("global", "a", "b");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResourceCatalogCapabilityError);
      expect((error as ResourceCatalogCapabilityError).code).toBe("RESOURCE_ALREADY_EXISTS");
      expect((error as Error).message).toBe("target exists");
    }
  });

  it("passes through a non-coded engine error unchanged", () => {
    const engine = fakeEngine({
      deleteSkill: vi.fn(() => {
        throw new Error("some panic without a code");
      }),
    });
    const { store } = makeStore(engine);
    expect(() => store.deleteSkill("global", "a")).toThrow("some panic without a code");
  });

  it("does not fail the write when fan-out fails (best-effort projection)", () => {
    const engine = fakeEngine({
      fanOut: vi.fn(() => {
        throw new Error("junction creation denied");
      }),
    });
    const { store } = makeStore(engine);

    // the canonical write succeeded; a fan-out failure must not surface.
    expect(store.writeSkill("global", "helper", { body: "b" })).toBe(
      "/canonical/.agents/skills/x/SKILL.md",
    );
  });

  it("serves recovery from the engine, mapping RecoveryInfo slug -> skillName", () => {
    const engine = fakeEngine({
      listRecoveries: vi.fn(() => [{ token: "tok", slug: "linter", path: "/displaced/linter" }]),
    });
    const { store } = makeStore(engine);

    expect(store.listRecoveries()).toEqual([{ token: "tok", skillName: "linter" }]);
    expect(engine.listRecoveries).toHaveBeenCalledWith("/home");
    expect(store.recoveryPath("tok")).toBe("/displaced/linter");
  });

  it("restoreRecovery recovers the slug from the listing, then restores; throws for unknown token", () => {
    const engine = fakeEngine({
      listRecoveries: vi.fn(() => [{ token: "tok", slug: "fmt", path: "/d/fmt" }]),
    });
    const { store } = makeStore(engine);
    expect(store.restoreRecovery("tok")).toEqual({ token: "tok", skillName: "fmt" });
    expect(engine.restoreRecovery).toHaveBeenCalledWith("/home", "tok");

    const empty = fakeEngine({ listRecoveries: vi.fn(() => []) });
    const { store: store2 } = makeStore(empty);
    expect(() => store2.restoreRecovery("ghost")).toThrow(ResourceCatalogCapabilityError);
    expect(empty.restoreRecovery).not.toHaveBeenCalled();
  });

  it("listGitRepos hides non-global collections the global-only seam can't operate on", () => {
    const engine = fakeEngine({
      listGitRepos: vi.fn(() => [
        { collectionId: "g", url: "u", scope: "global", skills: [] },
        { collectionId: "p", url: "u", scope: "project", skills: [] },
      ]),
    });
    const { store } = makeStore(engine);
    expect(store.listGitRepos().map((r) => r.collectionId)).toEqual(["g"]);
  });

  it("delegates git-repo ops to the engine at global scope", () => {
    const engine = fakeEngine();
    const { store } = makeStore(engine);

    store.importGitRepo("https://x/y.git", "main", "sub");
    expect(engine.importGitRepo).toHaveBeenCalledWith(
      "/home",
      undefined,
      "global",
      "https://x/y.git",
      "main",
      "sub",
      undefined,
    );
    store.syncGitRepo("c1");
    expect(engine.syncGitRepo).toHaveBeenCalledWith("/home", undefined, "c1");
    store.forgetGitRepo("c1", true);
    expect(engine.forgetGitRepo).toHaveBeenCalledWith("/home", undefined, "c1", true);
  });

  it("delegates preview ops (inspect/discard) and threads a selection through import", () => {
    const engine = fakeEngine({
      inspectGitRepo: vi.fn(() => ({
        collectionId: "c1",
        skills: [{ name: "alpha", fileCount: 2, skillMd: "---\nname: Alpha\n---\nbody" }],
      })),
    });
    const { store } = makeStore(engine);

    const preview = store.inspectGitRepo("https://x/y.git", "main", "sub");
    expect(preview.skills[0]?.name).toBe("alpha");
    expect(engine.inspectGitRepo).toHaveBeenCalledWith("/home", "https://x/y.git", "main", "sub");

    store.discardGitPreview("c1");
    expect(engine.discardGitPreview).toHaveBeenCalledWith("/home", "c1");

    store.importGitRepo("https://x/y.git", "main", "sub", ["alpha"]);
    expect(engine.importGitRepo).toHaveBeenCalledWith(
      "/home",
      undefined,
      "global",
      "https://x/y.git",
      "main",
      "sub",
      ["alpha"],
    );
  });

  it("maps git-conflict recoveries (both whole-skill and per-path) to ResourceRecovery", () => {
    const engine = fakeEngine({
      resolveGitConflict: vi.fn(() => [{ token: "t1", slug: "s1", path: "/d/s1" }]),
      resolveGitConflictPaths: vi.fn(() => [{ token: "t2", slug: "s2", path: "/d/s2" }]),
    });
    const { store } = makeStore(engine);

    expect(store.resolveGitConflict("c1", "s1", "remote")).toEqual([
      { token: "t1", skillName: "s1" },
    ]);
    expect(
      store.resolveGitConflictPaths("c1", "s2", "m1", [{ path: "a", resolution: "mine" }]),
    ).toEqual([{ token: "t2", skillName: "s2" }]);
    expect(engine.resolveGitConflictPaths).toHaveBeenCalledWith(
      "/home",
      undefined,
      "c1",
      "s2",
      "m1",
      [{ path: "a", resolution: "mine" }],
    );
  });

  it("translates RESOURCE_STALE from a per-path resolve", () => {
    const engine = fakeEngine({
      resolveGitConflictPaths: vi.fn(() => {
        throw new Error("RESOURCE_STALE: the conflict moved");
      }),
    });
    const { store } = makeStore(engine);
    try {
      store.resolveGitConflictPaths("c1", "s", "stale", []);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ResourceCatalogCapabilityError);
      expect((error as ResourceCatalogCapabilityError).code).toBe("RESOURCE_STALE");
    }
  });
});
