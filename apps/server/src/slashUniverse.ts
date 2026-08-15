import type {
  InjectedCommandRecord,
  ProjectMeta,
  SlashUniverse,
  SlashUniverseItem,
} from "@agent-deck/contracts";
import {
  isLoopAvailableInProject,
  type LoopDefinition,
  type PromptInfo,
  type ResourceScope,
  type SkillInfo,
} from "@agent-deck/domain";
import { scanLoops, scanPrompts } from "@agent-deck/resources";
import type { ServerContext } from "./context.ts";

const SCOPE_LABELS: Record<ResourceScope, string> = {
  builtin: "Builtin",
  global: "Global",
  library: "Library",
  project: "Project",
  package: "Package",
};

const CREATE_NEW_LOOP: SlashUniverseItem = {
  kind: "loop",
  id: "loop:create-new",
  displayName: "Create New Loop…",
  description: "Configure and launch an unsaved loop for this transcript.",
  scopeLabel: "Unsaved",
  isActive: true,
};

export const EMPTY_SLASH_UNIVERSE: SlashUniverse = {
  commands: [],
  prompts: [],
  skills: [],
  loops: [],
};

export interface SlashUniverseCatalogs {
  commands: InjectedCommandRecord[];
  skills: SkillInfo[];
  prompts: PromptInfo[];
  loops: LoopDefinition[];
}

export interface SlashUniverseSettings {
  defaultSkills: readonly string[];
  disabledSkills: readonly string[];
  defaultPromptTemplates: readonly string[];
  disabledBuiltinPromptNames: readonly string[];
}

export interface SlashUniverseProject {
  path: string;
  assignedSkills?: readonly string[];
  assignedPrompts?: readonly string[];
}

/** Pure catalog snapshot. No project → empty universe (native general-chat rule). */
export function assembleSlashUniverse(
  catalogs: SlashUniverseCatalogs,
  settings: SlashUniverseSettings,
  project: SlashUniverseProject | undefined,
): SlashUniverse {
  if (!project) return EMPTY_SLASH_UNIVERSE;

  const disabledSkills = new Set(settings.disabledSkills);
  const activeSkillNames = new Set([...settings.defaultSkills, ...(project.assignedSkills ?? [])]);
  const disabledBuiltinPrompts = new Set(settings.disabledBuiltinPromptNames);
  const activePromptNames = new Set([
    ...settings.defaultPromptTemplates,
    ...(project.assignedPrompts ?? []),
  ]);

  const skills: SlashUniverseItem[] = [];
  const seenSkills = new Set<string>();
  for (const skill of catalogs.skills) {
    if (disabledSkills.has(skill.name)) continue;
    if (seenSkills.has(skill.name)) continue;
    seenSkills.add(skill.name);
    skills.push({
      kind: "skill",
      id: `skill:${skill.scope}:${skill.name}`,
      displayName: skill.name,
      ...(nonEmpty(skill.description) ? { description: skill.description } : {}),
      scopeLabel: SCOPE_LABELS[skill.scope],
      isActive: activeSkillNames.has(skill.name),
      skillName: skill.name,
      body: skill.body,
    });
  }
  skills.sort(compareDisplayName);

  const prompts: SlashUniverseItem[] = [];
  const seenPrompts = new Set<string>();
  for (const prompt of catalogs.prompts) {
    if (prompt.scope === "builtin" && disabledBuiltinPrompts.has(prompt.name)) continue;
    if (seenPrompts.has(prompt.name)) continue;
    seenPrompts.add(prompt.name);
    prompts.push({
      kind: "prompt",
      id: `prompt:${prompt.scope}:${prompt.name}`,
      displayName: prompt.name,
      ...(nonEmpty(prompt.description) ? { description: prompt.description } : {}),
      scopeLabel: SCOPE_LABELS[prompt.scope],
      isActive: activePromptNames.has(prompt.name),
      body: prompt.body,
    });
  }
  prompts.sort(compareDisplayName);

  const commands = catalogs.commands
    .filter((command) => command.status === "enabled")
    .map(
      (command): SlashUniverseItem => ({
        kind: "command",
        id: `command:${command.id}`,
        displayName: command.title,
        ...(nonEmpty(command.description) ? { description: command.description } : {}),
        scopeLabel: command.source === "built-in" ? "Built-in" : "Library",
        isActive: true,
        slashName: command.slashName,
      }),
    )
    .toSorted((a, b) =>
      (a.slashName ?? a.displayName).localeCompare(b.slashName ?? b.displayName, undefined, {
        sensitivity: "accent",
      }),
    );

  const savedLoops = catalogs.loops
    .filter((loop) => isLoopAvailableInProject(loop, project.path))
    .toSorted((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "accent" }))
    .map(
      (loop): SlashUniverseItem => ({
        kind: "loop",
        id: `loop:${loop.id}`,
        displayName: loop.name,
        ...(nonEmpty(loop.description) ? { description: loop.description } : {}),
        ...(nonEmpty(loop.goal) ? { searchText: loop.goal } : {}),
        scopeLabel: loop.source === "builtin" ? "Built-in" : "User",
        isActive: true,
        loopId: loop.id,
      }),
    );

  return {
    commands,
    prompts,
    skills,
    loops: [CREATE_NEW_LOOP, ...savedLoops],
  };
}

export function assembleSlashUniverseForSession(
  ctx: Pick<
    ServerContext,
    "injectedCommands" | "skillStore" | "settings" | "projects" | "rootsFor"
  >,
  session: { meta: { projectId?: string } },
): SlashUniverse {
  const projectId = session.meta.projectId;
  if (!projectId) return EMPTY_SLASH_UNIVERSE;
  const project = ctx.projects.find((candidate: ProjectMeta) => candidate.id === projectId);
  if (!project) return EMPTY_SLASH_UNIVERSE;

  const settings = ctx.settings.get();
  return assembleSlashUniverse(
    {
      commands: ctx.injectedCommands.list(),
      skills: ctx.skillStore.listSkills(projectId),
      prompts: scanPrompts(ctx.rootsFor(projectId), undefined, settings.externalPromptPaths ?? []),
      loops: scanLoops(ctx.rootsFor()),
    },
    {
      defaultSkills: settings.defaultSkills ?? [],
      disabledSkills: settings.disabledSkills ?? [],
      defaultPromptTemplates: settings.defaultPromptTemplates ?? [],
      disabledBuiltinPromptNames: settings.disabledBuiltinPromptNames ?? [],
    },
    {
      path: project.path,
      assignedSkills: project.assignedSkills,
      assignedPrompts: project.assignedPrompts,
    },
  );
}

function nonEmpty(value: string | undefined): value is string {
  return Boolean(value && value.trim());
}

function compareDisplayName(a: SlashUniverseItem, b: SlashUniverseItem): number {
  return a.displayName.localeCompare(b.displayName, undefined, { sensitivity: "accent" });
}
