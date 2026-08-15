import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InjectedCommandRecord, SlashUniverseItem } from "@agent-deck/contracts";
import type { LoopDefinition, PromptInfo, SkillInfo } from "@agent-deck/domain";
import { registerSessionRoutes } from "../src/routes/sessions.ts";
import type { ServerContext } from "../src/context.ts";
import {
  assembleSlashUniverse,
  assembleSlashUniverseForSession,
  EMPTY_SLASH_UNIVERSE,
} from "../src/slashUniverse.ts";

vi.mock("@agent-deck/resources", () => ({
  scanPrompts: vi.fn(() => []),
  scanLoops: vi.fn(() => []),
}));

function skill(overrides: Partial<SkillInfo> & Pick<SkillInfo, "name">): SkillInfo {
  return {
    description: "",
    scope: "global",
    filePath: `/tmp/${overrides.name}/SKILL.md`,
    baseDir: `/tmp/${overrides.name}`,
    disableModelInvocation: false,
    body: `${overrides.name} body`,
    ...overrides,
  };
}

function prompt(overrides: Partial<PromptInfo> & Pick<PromptInfo, "name">): PromptInfo {
  return {
    scope: "global",
    filePath: `/tmp/${overrides.name}.md`,
    body: `${overrides.name} body`,
    invocation: `/${overrides.name}`,
    ...overrides,
  };
}

function command(
  overrides: Partial<InjectedCommandRecord> & Pick<InjectedCommandRecord, "id" | "slashName">,
): InjectedCommandRecord {
  return {
    title: overrides.slashName.slice(1),
    description: "",
    source: "built-in",
    status: "enabled",
    ...overrides,
  };
}

function loop(
  overrides: Partial<LoopDefinition> & Pick<LoopDefinition, "id" | "name">,
): LoopDefinition {
  return {
    description: "",
    goal: `${overrides.name} goal`,
    structure: "singleAgent",
    maxIterations: 3,
    validationCommand: "",
    writeTarget: "artifactMarkdown",
    source: "user",
    availability: "allProjects",
    projectPaths: [],
    filePath: `/tmp/${overrides.id}.md`,
    launchContextScope: "firstIterationOnly",
    ...overrides,
  };
}

const settings = {
  defaultSkills: ["review"],
  disabledSkills: ["hidden"],
  defaultPromptTemplates: ["daily"],
  disabledBuiltinPromptNames: ["bundled-off"],
};

describe("assembleSlashUniverse", () => {
  it("returns an empty universe when the session has no project", () => {
    expect(
      assembleSlashUniverse(
        {
          commands: [command({ id: "built-in:help", slashName: "/help" })],
          skills: [skill({ name: "review" })],
          prompts: [prompt({ name: "daily" })],
          loops: [loop({ id: "nightly", name: "Nightly" })],
        },
        settings,
        undefined,
      ),
    ).toEqual(EMPTY_SLASH_UNIVERSE);
  });

  it("omits disabled skills and builtin prompts and marks assigned names active", () => {
    const universe = assembleSlashUniverse(
      {
        commands: [],
        skills: [
          skill({ name: "hidden", body: "should not appear" }),
          skill({ name: "review", scope: "project", description: "Review skill" }),
          skill({ name: "extra", scope: "global" }),
        ],
        prompts: [
          prompt({ name: "bundled-off", scope: "builtin", body: "disabled builtin" }),
          prompt({ name: "daily", scope: "global", description: "Daily prompt" }),
          prompt({ name: "extra-prompt", scope: "library" }),
        ],
        loops: [],
      },
      settings,
      { path: "/tmp/project", assignedSkills: [], assignedPrompts: [] },
    );

    expect(universe.skills.map((item) => item.id)).toEqual([
      "skill:global:extra",
      "skill:project:review",
    ]);
    expect(universe.skills.find((item) => item.skillName === "review")).toMatchObject({
      isActive: true,
      scopeLabel: "Project",
      description: "Review skill",
      body: "review body",
    });
    expect(universe.skills.find((item) => item.skillName === "extra")?.isActive).toBe(false);
    expect(universe.prompts.map((item) => item.id)).toEqual([
      "prompt:global:daily",
      "prompt:library:extra-prompt",
    ]);
    expect(universe.prompts.find((item) => item.displayName === "daily")?.isActive).toBe(true);
    expect(universe.prompts.find((item) => item.displayName === "extra-prompt")?.isActive).toBe(
      false,
    );
    expect(JSON.stringify(universe)).not.toContain("/tmp/");
  });

  it("includes only enabled injected commands and keeps them path-free", () => {
    const universe = assembleSlashUniverse(
      {
        commands: [
          command({
            id: "built-in:help",
            slashName: "/help",
            title: "Help",
            description: "Show help",
          }),
          command({
            id: "library:dead",
            slashName: "/dead",
            title: "Dead",
            source: "library",
            status: "disabled",
          }),
          command({
            id: "library:ship",
            slashName: "/ship",
            title: "Ship",
            source: "library",
          }),
        ],
        skills: [],
        prompts: [],
        loops: [],
      },
      settings,
      { path: "/tmp/project" },
    );

    expect(universe.commands.map((item) => item.id)).toEqual([
      "command:built-in:help",
      "command:library:ship",
    ]);
    expect(universe.commands[0]).toMatchObject({
      slashName: "/help",
      scopeLabel: "Built-in",
      isActive: true,
    });
    expect(universe.commands[1]?.scopeLabel).toBe("Library");
    expect(universe.commands.every((item) => !("filePath" in item))).toBe(true);
  });

  it("prepends Create New Loop and filters loops by project availability", () => {
    const universe = assembleSlashUniverse(
      {
        commands: [],
        skills: [],
        prompts: [],
        loops: [
          loop({
            id: "other",
            name: "Other Project",
            availability: "projectPaths",
            projectPaths: ["/tmp/other"],
          }),
          loop({ id: "zebra", name: "Zebra" }),
          loop({
            id: "alpha",
            name: "Alpha",
            description: "First loop",
            availability: "projectPaths",
            projectPaths: ["/tmp/project"],
          }),
        ],
      },
      settings,
      { path: "/tmp/project" },
    );

    expect(universe.loops.map((item) => item.id)).toEqual([
      "loop:create-new",
      "loop:alpha",
      "loop:zebra",
    ]);
    expect(universe.loops[0]).toMatchObject({
      displayName: "Create New Loop…",
      scopeLabel: "Unsaved",
      isActive: true,
    });
    expect(universe.loops.find((item) => item.loopId === "alpha")).toMatchObject({
      description: "First loop",
      searchText: "Alpha goal",
      isActive: true,
    });
  });
});

describe("GET /sessions/:id/slash-universe", () => {
  const apps: { close: () => Promise<void> }[] = [];
  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  function makeApp(overrides: {
    session?: { meta: { id: string; projectId?: string } } | undefined;
    project?: { id: string; path: string; assignedSkills?: string[]; assignedPrompts?: string[] };
    listCommands?: () => InjectedCommandRecord[];
    listSkills?: () => SkillInfo[];
    fail?: boolean;
  }) {
    const fastify = Fastify();
    apps.push(fastify);
    const project = overrides.project ?? { id: "project-1", path: "/tmp/project" };
    const session = overrides.session;
    const ctx = {
      fastify,
      sessions: {
        get: (id: string) => (session && session.meta.id === id ? session : undefined),
      },
      index: { list: () => [], find: () => undefined, upsert: () => {}, remove: () => false },
      projects: {
        find: (predicate: (item: typeof project) => boolean) => [project].find(predicate),
      },
      settings: {
        get: () => ({
          defaultSkills: ["review"],
          disabledSkills: ["hidden"],
          defaultPromptTemplates: [],
          disabledBuiltinPromptNames: ["bundled-off"],
          externalPromptPaths: [],
        }),
      },
      injectedCommands: {
        list:
          overrides.listCommands ??
          (() => [command({ id: "built-in:help", slashName: "/help", title: "Help" })]),
      },
      skillStore: {
        listSkills: overrides.fail
          ? () => {
              throw new Error("catalog exploded");
            }
          : (overrides.listSkills ??
            (() => [skill({ name: "review" }), skill({ name: "hidden" })])),
      },
      rootsFor: () => ({ home: "/tmp/home" }),
      bridgeTokens: new Map(),
      askUser: { cancelSession: vi.fn() },
      worktreesRoot: "/tmp/worktrees",
      sessionWorktreeStore: {},
      broadcast: vi.fn(),
      dropDiffCache: vi.fn(),
    } as unknown as ServerContext;
    registerSessionRoutes(ctx);
    return fastify;
  }

  it("returns 404 for an unknown session", async () => {
    const app = makeApp({ session: undefined });
    const response = await app.inject({ method: "GET", url: "/sessions/missing/slash-universe" });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: "unknown session" });
  });

  it("returns an empty universe for a no-project session", async () => {
    const app = makeApp({ session: { meta: { id: "s1" } } });
    const response = await app.inject({ method: "GET", url: "/sessions/s1/slash-universe" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(EMPTY_SLASH_UNIVERSE);
  });

  it("assembles a path-free project universe and fails closed on catalog errors", async () => {
    const ok = makeApp({
      session: { meta: { id: "s1", projectId: "project-1" } },
    });
    const okBody = (
      await ok.inject({ method: "GET", url: "/sessions/s1/slash-universe" })
    ).json() as { commands: SlashUniverseItem[]; skills: SlashUniverseItem[] };
    expect(okBody.commands.map((item) => item.id)).toEqual(["command:built-in:help"]);
    expect(okBody.skills.map((item) => item.skillName)).toEqual(["review"]);
    expect(JSON.stringify(okBody)).not.toContain("/tmp/");
    expect(okBody.commands[0]).not.toHaveProperty("filePath");

    const failing = makeApp({
      session: { meta: { id: "s1", projectId: "project-1" } },
      fail: true,
    });
    const failed = await failing.inject({ method: "GET", url: "/sessions/s1/slash-universe" });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toEqual({ error: "Error: catalog exploded" });
  });

  it("keeps assembleSlashUniverseForSession empty when the project id is unknown", () => {
    expect(
      assembleSlashUniverseForSession(
        {
          injectedCommands: { list: () => [] },
          skillStore: { listSkills: () => [] },
          settings: { get: () => settings },
          projects: { find: () => undefined },
          rootsFor: () => ({ home: "/tmp/home" }),
        } as never,
        { meta: { projectId: "missing" } },
      ),
    ).toEqual(EMPTY_SLASH_UNIVERSE);
  });
});
