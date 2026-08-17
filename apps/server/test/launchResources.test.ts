import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { projectMemoryDir } from "@agent-deck/memory";
import { describe, expect, it } from "vitest";
import { fingerprintLaunchResources, resolveLaunchResources } from "../src/launchResources.ts";
import { resolveInstructionsFile } from "../src/routes/shared.ts";

describe("MCP master launch policy", () => {
  it("changes ordinary, named, and no-project fingerprints while emptying paused server/direct policy", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-mcp-policy-launch-"));
    const projectPath = path.join(root, "project");
    mkdirSync(projectPath);
    const project = { id: "project", path: projectPath };
    let enabled = true;
    const context = {
      projects: {
        find: (predicate: (candidate: typeof project) => boolean) =>
          predicate(project) ? project : undefined,
      },
      settings: {
        get: () => ({
          defaultSkills: [],
          defaultPromptTemplates: [],
          disabledSkills: [],
          defaultThinking: null,
        }),
      },
      resolveNamedAgent: () => ({
        status: "ok" as const,
        agent: {
          body: "Named",
          systemPromptMode: "replace" as const,
          skillDirs: [],
          extensions: [],
          mcpServers: ["named-server"],
          mcpDirectTools: ["search"],
        },
      }),
      enabledExtensionPaths: () => [],
      injectedCommands: { enabledExtensionPaths: () => [] },
      scanSkillCandidatesFor: () => [],
      rootsFor: (projectId?: string) => ({
        home: root,
        projectPath: projectId ? projectPath : undefined,
      }),
      resourceHome: () => root,
      agentMemoryEnabled: () => false,
      memoryBaseDir: path.join(root, "memory"),
      mcpAssignments: {
        defaultServerNames: () => ["ordinary-default"],
        projectServerNames: () => ["ordinary-project"],
      },
      mcpPolicy: { enabled: () => enabled },
      effectiveMcpConfigs: () => ({
        valid: true,
        configs: [
          { id: "ordinary-default", command: "default" },
          { id: "ordinary-project", command: "project" },
          { id: "named-server", command: "named" },
        ],
      }),
    } as unknown as Parameters<typeof resolveLaunchResources>[0];
    const resolveAll = () => ({
      ordinary: resolveLaunchResources(context, { projectId: project.id }, {}),
      named: resolveLaunchResources(context, { projectId: project.id, agentName: "named" }, {}),
      noProject: resolveLaunchResources(context, {}, {}),
    });

    const on = resolveAll();
    expect(on.ordinary.mcpServerIds).toEqual(["ordinary-default", "ordinary-project"]);
    expect(on.named.mcpServerIds).toEqual(["named-server"]);
    expect(on.noProject.mcpServerIds).toEqual([]);

    enabled = false;
    const off = resolveAll();
    expect(off.ordinary.mcpServerIds).toEqual([]);
    expect(off.named.mcpServerIds).toEqual([]);
    expect(off.noProject.mcpServerIds).toEqual([]);
    expect(off.named.fingerprint).not.toBe(on.named.fingerprint);
    expect(off.ordinary.fingerprint).not.toBe(on.ordinary.fingerprint);
    expect(off.noProject.fingerprint).not.toBe(on.noProject.fingerprint);

    enabled = true;
    const restored = resolveAll();
    expect(restored.ordinary.fingerprint).toBe(on.ordinary.fingerprint);
    expect(restored.named.fingerprint).toBe(on.named.fingerprint);
    expect(restored.noProject.fingerprint).toBe(on.noProject.fingerprint);
  });
});

describe("injected command launch matrix", () => {
  it("injects plain and named project parents, but not no-project or absent-store launches", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-command-launch-"));
    const projectPath = path.join(root, "project");
    mkdirSync(projectPath);
    const commandPath = path.join(root, "command.ts");
    writeFileSync(commandPath, "export default function () {};");
    const project = { id: "project-1", path: projectPath };
    const settings = {
      defaultSkills: [],
      defaultPromptTemplates: [],
      disabledSkills: [],
      defaultThinking: null,
    };
    const context = {
      projects: {
        find: (predicate: (candidate: typeof project) => boolean) =>
          predicate(project) ? project : undefined,
      },
      settings: { get: () => settings },
      resolveNamedAgent: () => ({
        status: "ok" as const,
        agent: {
          body: "Named parent",
          systemPromptMode: "replace" as const,
          skillDirs: [],
          extensions: [],
          mcpServers: [],
        },
      }),
      enabledExtensionPaths: () => [],
      injectedCommands: { enabledExtensionPaths: () => [commandPath] },
      scanSkillCandidatesFor: () => [],
      rootsFor: (projectId?: string) => ({
        home: root,
        projectPath: projectId ? projectPath : undefined,
      }),
      resourceHome: () => root,
      agentMemoryEnabled: () => false,
      memoryBaseDir: path.join(root, "memory"),
      mcpAssignments: {
        defaultServerNames: () => [],
        projectServerNames: () => [],
      },
    } as unknown as Parameters<typeof resolveLaunchResources>[0];

    const plain = resolveLaunchResources(context, { projectId: project.id }, {});
    expect(plain.plan.kind).toBe("parent");
    expect(plain.plan.extensions).toEqual([commandPath]);

    const named = resolveLaunchResources(
      context,
      { projectId: project.id, agentName: "named" },
      {},
    );
    expect(named.plan.kind).toBe("agent");
    expect(named.plan.extensions).toEqual([commandPath]);

    const noProject = resolveLaunchResources(context, {}, {});
    expect(noProject.plan.extensions).toBeUndefined();

    const absentStore = resolveLaunchResources(
      { ...context, injectedCommands: undefined as never },
      { projectId: project.id },
      {},
    );
    expect(absentStore.plan.extensions).toBeUndefined();
  });

  it("resolves builtin prompts as launchable defaults, shadowed by a user's copy (PRM-02)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-builtin-prompt-"));
    const globalPrompts = path.join(root, ".pi", "agent", "prompts");
    mkdirSync(globalPrompts, { recursive: true });
    // the user customized ONE of the bundled prompts by copying it
    const copyPath = path.join(globalPrompts, "plan-a-feature.md");
    writeFileSync(copyPath, "---\ndescription: my copy\n---\n\nmine\n");
    const settings = {
      defaultSkills: [],
      defaultPromptTemplates: ["plan-a-feature", "review-my-changes"],
      disabledSkills: [],
      defaultThinking: null,
    };
    const context = {
      projects: { find: () => undefined },
      settings: { get: () => settings },
      enabledExtensionPaths: () => [],
      scanSkillCandidatesFor: () => [],
      rootsFor: () => ({ home: root }),
      resourceHome: () => root,
      agentMemoryEnabled: () => false,
      memoryBaseDir: path.join(root, "memory"),
    } as unknown as Parameters<typeof resolveLaunchResources>[0];

    const { plan } = resolveLaunchResources(context, {}, {});
    if (plan.kind !== "parent") throw new Error(`expected a parent plan, got ${plan.kind}`);
    expect(plan.promptTemplates).toHaveLength(2);
    // the user's copy wins over the bundled original; the untouched builtin resolves
    // to the app-bundled file so builtin prompts are actually launchable
    expect(plan.promptTemplates).toContain(copyPath);
    expect(
      plan.promptTemplates!.some(
        (p: string) => p.endsWith("review-my-changes.md") && p.includes("builtin-prompts"),
      ),
    ).toBe(true);
  });

  it("a DISABLED builtin never resolves as a default; a user's copy is unaffected (PRM-06)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-disabled-builtin-"));
    const globalPrompts = path.join(root, ".pi", "agent", "prompts");
    mkdirSync(globalPrompts, { recursive: true });
    const copyPath = path.join(globalPrompts, "plan-a-feature.md");
    writeFileSync(copyPath, "---\ndescription: my copy\n---\n\nmine\n");
    const settings = {
      defaultSkills: [],
      // both names are set as defaults; both builtins are DISABLED
      defaultPromptTemplates: ["plan-a-feature", "review-my-changes"],
      disabledSkills: [],
      defaultThinking: null,
      disabledBuiltinPromptNames: ["plan-a-feature", "review-my-changes"],
    };
    const context = {
      projects: { find: () => undefined },
      settings: { get: () => settings },
      enabledExtensionPaths: () => [],
      scanSkillCandidatesFor: () => [],
      rootsFor: () => ({ home: root }),
      resourceHome: () => root,
      agentMemoryEnabled: () => false,
      memoryBaseDir: path.join(root, "memory"),
    } as unknown as Parameters<typeof resolveLaunchResources>[0];

    const { plan } = resolveLaunchResources(context, {}, {});
    if (plan.kind !== "parent") throw new Error(`expected a parent plan, got ${plan.kind}`);
    // the disabled builtin review-my-changes is gone; the USER'S COPY of
    // plan-a-feature still resolves (disable only silences the bundled record)
    expect(plan.promptTemplates).toEqual([copyPath]);
  });

  it("resolves an EXTERNAL prompt reference as a launchable default (PRM-05)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-external-prompt-"));
    const refPath = path.join(root, "kept-outside.md");
    writeFileSync(refPath, "---\ndescription: referenced\n---\n\nbody\n");
    const settings = {
      defaultSkills: [],
      defaultPromptTemplates: ["kept-outside"],
      disabledSkills: [],
      defaultThinking: null,
      externalPromptPaths: [refPath],
    };
    const context = {
      projects: { find: () => undefined },
      settings: { get: () => settings },
      enabledExtensionPaths: () => [],
      scanSkillCandidatesFor: () => [],
      rootsFor: () => ({ home: root }),
      resourceHome: () => root,
      agentMemoryEnabled: () => false,
      memoryBaseDir: path.join(root, "memory"),
    } as unknown as Parameters<typeof resolveLaunchResources>[0];

    const { plan } = resolveLaunchResources(context, {}, {});
    if (plan.kind !== "parent") throw new Error(`expected a parent plan, got ${plan.kind}`);
    expect(plan.promptTemplates).toEqual([refPath]);
  });
});

describe("agent memory launch resources", () => {
  it("removes the memory input and changes the fingerprint while paused, then restores it", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-memory-launch-"));
    const projectPath = path.join(root, "project");
    mkdirSync(projectPath);
    const project = { id: "project-1", path: projectPath };
    let enabled = true;
    const context = {
      projects: {
        find: (predicate: (candidate: typeof project) => boolean) =>
          predicate(project) ? project : undefined,
      },
      settings: {
        get: () => ({
          defaultSkills: [],
          defaultPromptTemplates: [],
          disabledSkills: [],
          defaultThinking: null,
        }),
      },
      enabledExtensionPaths: () => [],
      injectedCommands: { enabledExtensionPaths: () => [] },
      scanSkillCandidatesFor: () => [],
      rootsFor: (projectId?: string) => ({
        home: root,
        projectPath: projectId ? projectPath : undefined,
      }),
      resourceHome: () => root,
      agentMemoryEnabled: () => enabled,
      memoryBaseDir: path.join(root, "memory"),
      mcpAssignments: {
        defaultServerNames: () => [],
        projectServerNames: () => [],
      },
    } as unknown as Parameters<typeof resolveLaunchResources>[0];

    const active = resolveLaunchResources(context, { projectId: project.id }, {});
    enabled = false;
    const paused = resolveLaunchResources(context, { projectId: project.id }, {});
    enabled = true;
    const resumed = resolveLaunchResources(context, { projectId: project.id }, {});

    const compatibilityFingerprint = fingerprintLaunchResources(
      active.plan,
      [
        resolveInstructionsFile(path.join(root, ".pi", "agent")),
        resolveInstructionsFile(projectPath),
        projectMemoryDir(path.join(root, "memory"), projectPath),
      ],
      {
        memoryEnabled: true,
        mcpEnabled: true,
        defaultMcpServers: [],
        assignedMcpServers: [],
        effectiveMcpServerIds: [],
      },
    );
    expect(active.fingerprint).toBe(compatibilityFingerprint);
    expect(paused.fingerprint).not.toBe(active.fingerprint);
    expect(resumed.fingerprint).toBe(active.fingerprint);
    expect(paused.plan).toEqual(active.plan);
  });
});

describe("MCP launch resource policy", () => {
  it("fingerprints configured default union explicit assignment, while named agents use only their list", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-mcp-launch-"));
    const project = { id: "project", path: root, assignedMcpServers: ["explicit", "stale"] };
    let defaults = ["default", "stale"];
    const context = {
      projects: { find: () => project },
      settings: {
        get: () => ({
          defaultSkills: [],
          defaultMcpServers: defaults,
          defaultPromptTemplates: [],
          disabledSkills: [],
          defaultThinking: null,
        }),
      },
      resolveNamedAgent: () => ({
        status: "ok" as const,
        agent: {
          body: "named",
          systemPromptMode: "replace" as const,
          skillDirs: [],
          extensions: [],
          mcpServers: ["named", "stale"],
        },
      }),
      effectiveMcpConfigs: () => ({
        valid: true,
        configs: ["default", "explicit", "named"].map((id) => ({ id, command: "mock" })),
      }),
      enabledExtensionPaths: () => [],
      injectedCommands: { enabledExtensionPaths: () => [] },
      scanSkillCandidatesFor: () => [],
      rootsFor: () => ({ home: root, projectPath: root }),
      resourceHome: () => root,
      agentMemoryEnabled: () => false,
      memoryBaseDir: path.join(root, "memory"),
      mcpAssignments: {
        defaultServerNames: () => defaults,
        projectServerNames: () => project.assignedMcpServers,
      },
    } as unknown as Parameters<typeof resolveLaunchResources>[0];

    const ordinary = resolveLaunchResources(context, { projectId: project.id }, {});
    expect(ordinary.mcpServerIds).toEqual(["default", "explicit"]);
    const named = resolveLaunchResources(
      context,
      { projectId: project.id, agentName: "agent" },
      {},
    );
    expect(named.mcpServerIds).toEqual(["named"]);
    expect(named.fingerprint).not.toBe(ordinary.fingerprint);
    const before = ordinary.fingerprint;
    defaults = [];
    expect(resolveLaunchResources(context, { projectId: project.id }, {}).fingerprint).not.toBe(
      before,
    );
  });
});

describe("launch resource fingerprint", () => {
  it("tracks selected resource bytes but ignores resume identity and unrelated UI files", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-launch-fingerprint-"));
    const skill = path.join(root, "skill");
    mkdirSync(skill);
    writeFileSync(path.join(skill, "SKILL.md"), "first");
    const instructions = path.join(root, "AGENTS.md");
    writeFileSync(instructions, "rules one");
    const plan = {
      kind: "parent" as const,
      skills: [skill],
      resumeSessionPath: path.join(root, "conversation-a.jsonl"),
    };
    const initial = fingerprintLaunchResources(plan, [instructions]);
    expect(
      fingerprintLaunchResources(
        { ...plan, resumeSessionPath: path.join(root, "conversation-b.jsonl") },
        [instructions],
      ),
    ).toBe(initial);

    writeFileSync(path.join(root, "avatar.png"), "ui only");
    expect(fingerprintLaunchResources(plan, [instructions])).toBe(initial);
    writeFileSync(path.join(skill, "SKILL.md"), "second");
    expect(fingerprintLaunchResources(plan, [instructions])).not.toBe(initial);
  });

  it("fails closed for required symlinks but stably skips unsafe optional candidates", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-launch-symlink-"));
    const target = path.join(root, "target.md");
    const linked = path.join(root, "linked.md");
    writeFileSync(target, "content");
    symlinkSync(target, linked);
    expect(() => fingerprintLaunchResources({ kind: "parent", extensions: [linked] }, [])).toThrow(
      "required launch resource",
    );
    expect(fingerprintLaunchResources({ kind: "parent" }, [linked])).toBe(
      fingerprintLaunchResources({ kind: "parent" }, [linked]),
    );
  });

  it("bounds aggregate selected resource traversal", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-launch-bounded-"));
    for (let index = 0; index <= 2_000; index += 1) {
      writeFileSync(path.join(root, `${index}.md`), "x");
    }
    expect(() => fingerprintLaunchResources({ kind: "parent", skills: [root] }, [])).toThrow(
      "required launch resource",
    );
  });

  it("tracks applicable instruction bytes", () => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-launch-instructions-"));
    const instructions = path.join(root, "AGENTS.md");
    writeFileSync(instructions, "one");
    const before = fingerprintLaunchResources({ kind: "parent" }, [instructions]);
    writeFileSync(instructions, "two");
    expect(fingerprintLaunchResources({ kind: "parent" }, [instructions])).not.toBe(before);
  });
});
