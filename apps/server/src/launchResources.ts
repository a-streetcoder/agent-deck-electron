import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import nodePath from "node:path";
import type { ProjectMeta } from "@agent-deck/contracts";
import type { PromptInfo } from "@agent-deck/domain";
import { projectMemoryDir } from "@agent-deck/memory";
import { scanPrompts } from "@agent-deck/resources";
import type { LaunchPlan } from "@agent-deck/pi-host";
import { resolveExplicitSkills } from "./agentSkillResolution.ts";
import { asThinkingLevel, type ServerContext } from "./context.ts";
import { finalizeExtensions, resolveInstructionsFile } from "./routes/shared.ts";

/** Durable compatibility inputs needed to recompute catalog-derived launch flags.
 * Values omitted by the request remain live settings/project assignments; values
 * explicitly supplied remain fixed across refreshes. */
export interface LaunchResourceConfigV1 {
  version: 1;
  providerOverride?: string;
  modelOverride?: string;
  extensionsOverride?: string[];
  skillsOverride?: string[];
}

export interface ResolvedLaunchResources {
  plan: LaunchPlan;
  fingerprint: string;
  config: LaunchResourceConfigV1;
  mcpServerIds: string[];
}

export class LaunchResourceResolutionError extends Error {
  constructor(
    message: string,
    readonly statusCode: 404 | 409 = 409,
  ) {
    super(message);
    this.name = "LaunchResourceResolutionError";
  }
}

export interface LaunchResourceRequest {
  cwd?: string;
  projectId?: string;
  agentName?: string;
  provider?: string;
  model?: string;
  extensions?: string[];
  skills?: string[];
}

type ResolverContext = Pick<
  ServerContext,
  | "projects"
  | "settings"
  | "resolveNamedAgent"
  | "enabledExtensionPaths"
  | "injectedCommands"
  | "scanSkillCandidatesFor"
  | "rootsFor"
  | "resourceHome"
  | "memoryEnabled"
  | "memoryBaseDir"
>;

const MAX_FINGERPRINT_DEPTH = 16;
const MAX_FINGERPRINT_FILES = 2_000;
const MAX_FINGERPRINT_BYTES = 20_000_000;

interface HashBudget {
  files: number;
  bytes: number;
}

function hashPath(
  hash: ReturnType<typeof createHash>,
  target: string,
  budget: HashBudget,
  depth = 0,
): void {
  if (depth > MAX_FINGERPRINT_DEPTH)
    throw new Error("A selected launch resource is nested too deeply.");
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error("A selected launch resource is a symbolic link.");
  if (stat.isFile()) {
    budget.files += 1;
    budget.bytes += stat.size;
    if (budget.files > MAX_FINGERPRINT_FILES || budget.bytes > MAX_FINGERPRINT_BYTES)
      throw new Error("Selected launch resources exceed the fingerprint safety limit.");
    hash.update("f\0").update(target).update("\0").update(readFileSync(target));
    return;
  }
  if (!stat.isDirectory()) throw new Error("A selected launch resource is not a regular file.");
  for (const name of readdirSync(target).sort())
    hashPath(hash, nodePath.join(target, name), budget, depth + 1);
}

/** Fingerprint semantic flags plus bytes Pi reads from selected resources. Resume
 * handles are deliberately excluded: they identify conversation, not resources. */
export function fingerprintLaunchResources(
  plan: LaunchPlan,
  instructionCandidates: readonly string[],
  bridgePolicy?: unknown,
): string {
  const semantic = { ...plan } as LaunchPlan & { resumeSessionPath?: string; sessionDir?: string };
  delete semantic.resumeSessionPath;
  delete semantic.sessionDir;
  const hash = createHash("sha256")
    .update(JSON.stringify(semantic))
    .update(JSON.stringify(bridgePolicy ?? null));
  const requiredPaths = new Set<string>();
  const optionalPaths = new Set<string>();
  if (plan.kind === "parent") {
    for (const path of plan.skills ?? []) requiredPaths.add(path);
    for (const path of plan.promptTemplates ?? []) requiredPaths.add(path);
    for (const path of plan.extensions ?? []) requiredPaths.add(path);
    for (const path of plan.appendSystemPrompts ?? []) requiredPaths.add(path);
  } else if (plan.kind === "agent") {
    for (const path of plan.skills ?? []) requiredPaths.add(path);
    for (const path of plan.extensions ?? []) requiredPaths.add(path);
  }
  for (const path of instructionCandidates) {
    try {
      lstatSync(path);
      optionalPaths.add(path);
    } catch {
      // A missing candidate is represented by the candidate-name list below.
    }
  }
  hash.update(JSON.stringify([...instructionCandidates]));
  const budget: HashBudget = { files: 0, bytes: 0 };
  for (const path of [...requiredPaths].sort()) {
    try {
      hashPath(hash, path, budget);
    } catch {
      throw new Error("A required launch resource could not be read safely.");
    }
  }
  for (const path of [...optionalPaths].sort()) {
    try {
      hashPath(hash, path, budget);
    } catch {
      hash.update("optional-skipped\0").update(path).update("\0");
    }
  }
  return hash.digest("hex");
}

export function resolveLaunchResources(
  ctx: ResolverContext,
  request: LaunchResourceRequest,
  defaults: { provider?: string; model?: string; extensions?: string[] },
  existingConfig?: LaunchResourceConfigV1,
): ResolvedLaunchResources {
  const project: ProjectMeta | undefined = request.projectId
    ? ctx.projects.find((item) => item.id === request.projectId)
    : undefined;
  if (request.projectId && !project) throw new Error("The session project no longer exists.");
  const config: LaunchResourceConfigV1 = existingConfig ?? {
    version: 1,
    ...(request.provider !== undefined ? { providerOverride: request.provider } : {}),
    ...(request.model !== undefined ? { modelOverride: request.model } : {}),
    ...(request.extensions !== undefined ? { extensionsOverride: [...request.extensions] } : {}),
    ...(request.skills !== undefined ? { skillsOverride: [...request.skills] } : {}),
  };
  let provider = config.providerOverride ?? defaults.provider;
  let model = config.modelOverride;
  if (model === undefined) {
    const defaultModel = ctx.settings.get().defaultModel;
    if (defaultModel) {
      const separator = defaultModel.indexOf(":");
      if (separator > 0) {
        if (config.providerOverride === undefined) provider = defaultModel.slice(0, separator);
        model = defaultModel.slice(separator + 1);
      } else model = defaultModel;
    }
  }
  model ??= defaults.model;
  const baseExtensions = config.extensionsOverride ?? defaults.extensions ?? [];
  // Injected slash commands are an app-owned parent-session capability, not a
  // user extension or model-facing tool grant. They bypass user loading mode and
  // named-agent extension allowlists, but only for sessions attached to a real
  // project. Helpers, managed children, Loops, and no-project launches never use
  // this resolver/project gate.
  // Narrow legacy route embedders may provide a pre-CMD context; production
  // always binds the store, while their absent optional capability means none.
  const injectedCommands = project ? (ctx.injectedCommands?.enabledExtensionPaths() ?? []) : [];
  const base = finalizeExtensions([
    ...baseExtensions,
    ...(request.agentName ? [] : ctx.enabledExtensionPaths(request.projectId)),
    ...injectedCommands,
  ]);

  let plan: LaunchPlan;
  let namedBridgePolicy: unknown;
  if (request.agentName) {
    const resolved = ctx.resolveNamedAgent(request.agentName, request.projectId);
    if (resolved.status !== "ok") {
      if (resolved.status === "not_found")
        throw new LaunchResourceResolutionError(`unknown agent: ${request.agentName}`, 404);
      if (resolved.status === "disabled")
        throw new LaunchResourceResolutionError(`agent is disabled: ${request.agentName}`);
      throw new LaunchResourceResolutionError(resolved.error);
    }
    const agent = resolved.agent;
    namedBridgePolicy = {
      mcpServers: agent.mcpServers ?? [],
      mcpDirectTools: agent.mcpDirectTools ?? [],
    };
    plan = {
      kind: "agent",
      systemPrompt: { mode: agent.systemPromptMode, text: agent.body },
      tools: agent.tools,
      extensions: finalizeExtensions([...base, ...agent.extensions]),
      skills: agent.skillDirs,
      provider,
      model: agent.model ?? model,
      thinking: asThinkingLevel(agent.thinking) ?? ctx.settings.get().defaultThinking ?? undefined,
    };
  } else {
    let skills = config.skillsOverride;
    if (skills === undefined) {
      const names = [...ctx.settings.get().defaultSkills, ...(project?.assignedSkills ?? [])];
      const resolved = resolveExplicitSkills({
        skillNames: names,
        candidates: ctx.scanSkillCandidatesFor(request.projectId),
        disabledSkills: new Set(ctx.settings.get().disabledSkills),
        strict: false,
      });
      if (resolved.status === "error") throw new Error(resolved.message);
      skills = resolved.skillDirs.length ? resolved.skillDirs : undefined;
    }
    const promptsByName = new Map<string, PromptInfo>();
    for (const prompt of scanPrompts(ctx.rootsFor(request.projectId))) {
      if (!promptsByName.has(prompt.name)) promptsByName.set(prompt.name, prompt);
    }
    const promptTemplates = [
      ...new Set([
        ...ctx.settings.get().defaultPromptTemplates,
        ...(project?.assignedPrompts ?? []),
      ]),
    ]
      .map((name) => promptsByName.get(name)?.filePath)
      .filter((path): path is string => Boolean(path));
    plan = {
      kind: "parent",
      provider,
      model,
      thinking: ctx.settings.get().defaultThinking ?? undefined,
      extensions: base.length ? base : undefined,
      skills,
      promptTemplates: promptTemplates.length ? promptTemplates : undefined,
    };
  }
  const roots = ctx.rootsFor(request.projectId);
  const effectiveCwd = request.cwd ?? roots.projectPath;
  // Narrow route tests and legacy embedders may predate resourceHome on their
  // injected context; roots.home is the same authoritative value.
  const home =
    (typeof ctx.resourceHome === "function" ? ctx.resourceHome() : ctx.rootsFor().home) ??
    homedir();
  const append = [
    effectiveCwd ? nodePath.join(effectiveCwd, ".pi", "APPEND_SYSTEM.md") : undefined,
    nodePath.join(home, ".pi", "agent", "APPEND_SYSTEM.md"),
  ].find((candidate) => {
    if (!candidate) return false;
    try {
      return lstatSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  const instructions = [
    resolveInstructionsFile(nodePath.join(home, ".pi", "agent")),
    ...(effectiveCwd ? [resolveInstructionsFile(effectiveCwd)] : []),
    ...(append ? [append] : []),
    ...(ctx.memoryEnabled && effectiveCwd
      ? [projectMemoryDir(ctx.memoryBaseDir, effectiveCwd)]
      : []),
  ];
  const projectMcp = new Set(project?.assignedMcpServers ?? []);
  const mcpServerIds = request.agentName
    ? ((namedBridgePolicy as { mcpServers?: string[] } | undefined)?.mcpServers ?? []).filter(
        (id) => projectMcp.has(id),
      )
    : [];
  return {
    plan,
    config,
    mcpServerIds,
    fingerprint: fingerprintLaunchResources(plan, instructions, {
      memoryEnabled: ctx.memoryEnabled,
      assignedMcpServers: project?.assignedMcpServers ?? [],
      named: namedBridgePolicy,
    }),
  };
}
