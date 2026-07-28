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
    restoreRecovery: vi.fn(() => ({ token: "t", skillName: "s" })),
    acknowledgeRecovery: vi.fn(),
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
    expect(engine.writeSkill).toHaveBeenCalledWith("/home", undefined, "global", "helper", "d", "b");
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

  it("routes recovery ops to the engine rooted at home", () => {
    const engine = fakeEngine();
    const { store } = makeStore(engine);

    store.listRecoveries();
    store.restoreRecovery("tok");
    store.acknowledgeRecovery("tok");
    expect(engine.listRecoveries).toHaveBeenCalledWith("/home");
    expect(engine.restoreRecovery).toHaveBeenCalledWith("/home", "tok");
    expect(engine.acknowledgeRecovery).toHaveBeenCalledWith("/home", "tok");
  });
});
