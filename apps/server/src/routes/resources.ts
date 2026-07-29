import { existsSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import type { ProjectMeta } from "@agent-deck/contracts";
import type { SkillInfo } from "@agent-deck/domain";
import {
  BUILTIN_AGENTS_DIR,
  computeBuiltinOverride,
  deleteAgentFile,
  deletePromptFile,
  mergeWithUnmanagedOverrideFields,
  parseAgentFile,
  readAgentOverrides,
  renameAgentFile,
  ResourceCatalogCapabilityError,
  renamePromptFile,
  resolveSkillSource,
  scanAgents,
  scanExtensions,
  scanPrompts,
  setAgentDisabledFile,
  writeAgentFile,
  writeBuiltinAgentOverride,
  writePromptFile,
  type ResourceRecovery,
} from "@agent-deck/resources";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { RESOURCE_NAME } from "./shared.ts";

const agentEditFields = z.object({
  description: z.string().optional(),
  whenToUse: z.string().optional(),
  model: z.string().optional(),
  fallbackModels: z.array(z.string()).optional(),
  thinking: z.string().optional(),
  systemPromptMode: z.enum(["replace", "append"]).optional(),
  tools: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.array(z.string()).optional(),
  body: z.string().optional(),
});

// Skills are global or project. Project writes are supported now that the shared skill
// engine owns storage (ADR-0002 P3) — the per-route guard below still rejects a project
// scope with no project selected. Agents/prompts stay global-only (engine handles skills).
const writableCatalogScope = z.enum(["global", "project"]);
const writableLibraryScope = z
  .enum(["global", "library", "project"])
  .refine((scope): boolean => scope !== "project", "project resource catalogs are not supported");
const writableAgentScope = z
  .enum(["builtin", "global", "library", "project"])
  .refine((scope): boolean => scope !== "project", "project agent catalogs are not supported");

const agentEditBody = z.object({
  projectId: z.string().optional(),
  scope: writableAgentScope,
  name: RESOURCE_NAME,
  edit: agentEditFields,
});

const skillEditBody = z.object({
  projectId: z.string().optional(),
  scope: writableCatalogScope,
  name: RESOURCE_NAME,
  edit: z.object({
    description: z.string().optional(),
    body: z.string().optional(),
  }),
});

/**
 * REST routes for the resource catalogs — agents, skills (incl. git-imported
 * skill repositories), prompt templates, extensions, and the app-bridge
 * inventory. Moved verbatim from server.ts.
 */
export function registerResourceRoutes(ctx: ServerContext): void {
  const {
    fastify,
    projects,
    settings,
    bridge,
    broadcast,
    resourceHome,
    rootsFor,
    skillStore,
    extensionBridgeConflictAt,
  } = ctx;

  const resourceMutationFailure = (error: unknown): { status: number; error: string } => {
    if (!(error instanceof ResourceCatalogCapabilityError)) {
      return { status: 500, error: error instanceof Error ? error.message : String(error) };
    }
    if (error.code === "RESOURCE_NATIVE_UNAVAILABLE") {
      return {
        status: 503,
        error:
          "Resource changes are unavailable because the native catalog safety component could not load.",
      };
    }
    if (error.code === "RESOURCE_NOT_FOUND") {
      return { status: 404, error: "The resource no longer exists." };
    }
    if (error.code === "RESOURCE_ALREADY_EXISTS") {
      return { status: 409, error: "A resource already exists at that catalog location." };
    }
    if (error.code === "RESOURCE_BUSY") {
      return {
        status: 409,
        error: "The resource is in use by another application. Close it and retry the update.",
      };
    }
    if (error.code === "RESOURCE_RECONCILE_INCOMPLETE") {
      return {
        status: 409,
        error:
          "The resource update was interrupted after it began. Retry the update to finish reconciling the resource safely.",
      };
    }
    if (
      error.code === "RESOURCE_UNSAFE_COMPONENT" ||
      error.code === "RESOURCE_INVALID_PATH" ||
      error.code === "RESOURCE_INVALID_UTF8"
    ) {
      return {
        status: 409,
        error:
          "The resource change was refused because its catalog path is unsafe or linked. Remove the link or choose a portable resource name and try again.",
      };
    }
    // Engine git-collection codes (shared skill engine): GIT is a permanent bad-repo/hostile-shape
    // error (do not retry); STALE means the conflict moved and the caller should re-fetch it.
    if (error.code === "RESOURCE_GIT") {
      // Don't leak the raw engine/git message (may carry paths or credentials) to the renderer.
      return {
        status: 400,
        error: "The git repository couldn't be processed — check the URL and that it's public.",
      };
    }
    if (error.code === "RESOURCE_STALE") {
      return {
        status: 409,
        error: "The conflict changed since it was loaded. Refresh the review and try again.",
      };
    }
    return { status: 500, error: "The resource catalog operation failed." };
  };
  const sendResourceMutationFailure = (
    reply: { status(code: number): { send(body: { error: string }): unknown } },
    error: unknown,
  ): unknown => {
    const failure = resourceMutationFailure(error);
    return reply.status(failure.status).send({ error: failure.error });
  };

  fastify.get("/resources/agents", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    return { agents: scanAgents(rootsFor(projectId)) };
  });

  // Skills carry the app-level disabled flag from settings.
  const enrichSkills = (skills: SkillInfo[]): SkillInfo[] => {
    const disabled = new Set(settings.get().disabledSkills);
    return skills.map((s) => ({ ...s, disabled: disabled.has(s.name) }));
  };

  fastify.get("/resources/skills", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    return { skills: enrichSkills(skillStore.listSkills(projectId)) };
  });

  // Delete a global/project skill (its SKILL.md dir) and forget it everywhere.
  fastify.delete("/resources/skills", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        scope: writableCatalogScope,
        name: RESOURCE_NAME,
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, name } = parsed.data;
    if (scope === "project" && !rootsFor(projectId).projectPath) {
      return reply.status(400).send({ error: "projectId required for project scope" });
    }
    try {
      skillStore.deleteSkill(scope, name, projectId);
      settings.forgetSkill(name);
      for (const project of projects.list()) {
        if (project.assignedSkills?.includes(name)) {
          projects.upsert({
            ...project,
            assignedSkills: project.assignedSkills.filter((s) => s !== name),
          });
        }
      }
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Rename a global/project skill directory (native RenameResourceSheet 7.x),
  // re-pointing every reference (app-level default/disabled lists + per-project
  // assignments) so the rename never silently drops an assignment.
  fastify.post("/resources/skills/rename", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        scope: writableCatalogScope,
        name: RESOURCE_NAME,
        newName: RESOURCE_NAME,
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, name, newName } = parsed.data;
    const roots = rootsFor(projectId);
    if (scope === "project" && !roots.projectPath) {
      return reply.status(400).send({ error: "projectId required for project scope" });
    }
    try {
      skillStore.renameSkill(scope, name, newName, projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "skill_exists") {
        return reply
          .status(409)
          .send({ error: `A ${scope} skill named "${newName}" already exists.` });
      }
      if (message === "skill_not_found") {
        return reply.status(404).send({ error: `No ${scope} skill named "${name}".` });
      }
      return sendResourceMutationFailure(reply, error);
    }
    // Re-point references. A project skill is visible only to its own project; a
    // global one, only where a same-named project skill doesn't shadow it.
    const hasProjectSkill = (projectPath: string): boolean =>
      existsSync(nodePath.join(projectPath, ".pi", "skills", name, "SKILL.md"));
    // The app-level default/disabled lists are FLAT, but a bare skill name
    // resolves per-project (a project skill shadows a global one). So re-point
    // them only when the old name no longer resolves to ANY skill anywhere —
    // then the swap can't misdirect a project that still has its own same-named
    // skill (nor leave a project-scoped default dangling).
    const globalSkillDir = nodePath.join(resourceHome(), ".pi", "agent", "skills");
    const nameStillResolves =
      existsSync(nodePath.join(globalSkillDir, name, "SKILL.md")) ||
      projects.list().some((p) => hasProjectSkill(p.path));
    if (!nameStillResolves) {
      settings.renameSkill(name, newName);
    }
    for (const project of projects.list()) {
      if (!project.assignedSkills?.includes(name)) continue;
      const applies =
        scope === "project" ? project.path === roots.projectPath : !hasProjectSkill(project.path);
      if (!applies) continue;
      projects.upsert({
        ...project,
        assignedSkills: [...new Set(project.assignedSkills.map((s) => (s === name ? newName : s)))],
      });
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Import a local .md file as a skill (native SkillImportSheet Local tab).
  fastify.post("/resources/skills/import", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        scope: writableCatalogScope,
        sourcePath: z.string().min(1),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, sourcePath } = parsed.data;
    const roots = rootsFor(projectId);
    if (scope === "project" && !roots.projectPath) {
      return reply.status(400).send({ error: "projectId required for project scope" });
    }
    let name: string;
    try {
      name = skillStore.importLocalSkill(scope, nodePath.resolve(sourcePath), projectId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "skill_exists") {
        return reply.status(409).send({ error: `A ${scope} skill of that name already exists.` });
      }
      if (message === "not_a_markdown_file") {
        return reply.status(400).send({ error: "Pick an existing .md file to import." });
      }
      if (message === "invalid_skill_name") {
        return reply
          .status(400)
          .send({ error: "Couldn't derive a valid skill name from the file." });
      }
      return sendResourceMutationFailure(reply, error);
    }
    broadcast({ type: "resources_changed" });
    return { ok: true, name };
  });

  // Import a git repo as a managed collection (shared skill engine): clone → discover →
  // sanitize → materialize into the ordinary catalog, so the scanner reads its skills like any
  // other. Global scope only — the engine tracks collection state under home and listGitRepos
  // can't resolve a project collection's root, so a project-scoped import is REFUSED (not
  // silently redirected to global).
  fastify.post("/resources/skills/import-git", async (request, reply) => {
    const parsed = z
      .object({
        url: z.string().trim().min(1).max(2000),
        scope: z.enum(["global", "project"]).optional(),
        projectId: z.string().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    if (parsed.data.scope === "project") {
      return reply.status(400).send({
        error: "Project-scoped git collections aren't supported; import at global scope.",
      });
    }
    const source = resolveSkillSource(parsed.data.url);
    if (!source) {
      return reply.status(400).send({ error: "Couldn't understand that repository reference." });
    }
    try {
      const result = skillStore.importGitRepo(source.cloneUrl, source.ref, source.subdir);
      broadcast({ type: "resources_changed" });
      return { imported: result.skills, skipped: [] as string[], repoId: result.collectionId };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  // The git-repo collections a user synced skills from. The engine materializes their skills
  // into the ordinary catalog; these routes only manage the upstream connection.
  fastify.get("/resources/skill-repos", async (_request, reply) => {
    try {
      return {
        repos: skillStore.listGitRepos().map((r) => ({
          id: r.collectionId,
          remoteUrl: r.url,
          ref: r.gitRef,
          subdir: r.subpath,
          scope: r.scope,
          skillNames: r.skills,
          // Engine collections are managed collections — the UI's delete label keys off this to
          // match `forgetGitRepo(id, true)` ("remove its managed skill collection").
          storageMode: "collection-v1" as const,
          available: true,
        })),
      };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  const recoveryTokenParam = z.object({ token: z.string().min(1).max(512) });

  fastify.get("/resources/skill-recoveries", async (_request, reply) => {
    try {
      return { recoveries: skillStore.listRecoveries() };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  fastify.post("/resources/skill-recoveries/:token/restore", async (request, reply) => {
    const parsed = recoveryTokenParam.safeParse(request.params);
    if (!parsed.success) return reply.status(400).send({ error: "invalid recovery token" });
    try {
      const recovery = skillStore.restoreRecovery(parsed.data.token);
      broadcast({ type: "resources_changed" });
      return { ok: true, recovery };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  fastify.get("/resources/skill-recoveries/:token/trash-path", async (request, reply) => {
    const parsed = recoveryTokenParam.safeParse(request.params);
    const supplied = request.headers["x-agent-deck-desktop-recovery-token"];
    const expected = process.env.AGENT_DECK_DESKTOP_RECOVERY_TOKEN;
    if (!parsed.success) return reply.status(400).send({ error: "invalid recovery token" });
    if (!expected || supplied !== expected) return reply.status(403).send({ error: "forbidden" });
    try {
      return { path: skillStore.recoveryPath(parsed.data.token) };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  fastify.post("/resources/skill-recoveries/:token/acknowledge", async (request, reply) => {
    const parsed = recoveryTokenParam.safeParse(request.params);
    const supplied = request.headers["x-agent-deck-desktop-recovery-token"];
    const expected = process.env.AGENT_DECK_DESKTOP_RECOVERY_TOKEN;
    if (!parsed.success) return reply.status(400).send({ error: "invalid recovery token" });
    if (!expected || supplied !== expected) return reply.status(403).send({ error: "forbidden" });
    try {
      skillStore.acknowledgeRecovery(parsed.data.token);
      return { ok: true };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  // One conflicted skill's per-file detail for the UI. A collection with no base snapshot
  // (imported before per-file support) can't answer per-path — surface a whole-skill conflict so
  // the UI offers a single Take Mine / Take Remote choice (resolve via the whole-skill form).
  const buildMergeConflict = (
    collectionId: string,
    name: string,
  ): {
    name: string;
    mergeId: string;
    wholeSkill: boolean;
    paths: { path: string; local: string; remote: string }[];
  } => {
    try {
      const detail = skillStore.conflictPaths(collectionId, name);
      return {
        name,
        mergeId: detail.mergeId,
        wholeSkill: false,
        paths: detail.paths.map((p) => ({
          path: p.path,
          local: p.localKind,
          remote: p.remoteKind,
        })),
      };
    } catch {
      // No per-path detail: either a base-less collection (RESOURCE_NOT_FOUND — the documented
      // "no base snapshot" case) or a transient detail failure AFTER `syncGitRepo` already
      // applied. Degrade to a whole-skill conflict rather than throw, so the update's applied
      // result is never lost to a detail-construction error (Codex #6). Resolving it uses the
      // whole-skill form.
      return { name, mergeId: "", wholeSkill: true, paths: [] };
    }
  };

  // Preview upstream drift (network fetch; writes nothing).
  fastify.post("/resources/skill-repos/:id/check", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const deltas = skillStore.checkGitRepo(id);
      return {
        updateAvailable: deltas.length > 0,
        deltas: deltas.map((d) => ({ name: d.name, kind: d.kind })),
      };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Pull + apply one-sided changes; both-sides motion comes back as per-skill conflicts the user
  // resolves per file (or whole-skill for a base-less collection).
  fastify.post("/resources/skill-repos/:id/update", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      const { applied, conflicts } = skillStore.syncGitRepo(id);
      const mergeConflicts = conflicts.map((name) => buildMergeConflict(id, name));
      broadcast({ type: "resources_changed" });
      return {
        updated: applied.length > 0 || conflicts.length > 0,
        imported: applied,
        conflicts,
        mergeConflicts,
        recoveries: [] as ResourceRecovery[],
      };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Re-derive a conflict's per-file detail (the UI's refresh after a stale resolve).
  fastify.post("/resources/skill-repos/:id/refresh-merge", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ name: RESOURCE_NAME }).strict().safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    try {
      return { mergeConflict: buildMergeConflict(id, parsed.data.name) };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Settle one conflicted skill: per-file {mergeId, choices}, or whole-skill {resolution} for a
  // base-less collection. A stale mergeId → 409 LEGACY_MERGE_STALE (the UI refreshes and retries).
  const resolveBody = z
    .object({
      name: RESOURCE_NAME,
      mergeId: z.string().min(1).max(128).optional(),
      choices: z
        .array(
          z.object({
            path: z.string().min(1).max(4096),
            resolution: z.enum(["mine", "remote"]),
          }),
        )
        .optional(),
      resolution: z.enum(["mine", "remote"]).optional(),
    })
    .strict();

  fastify.post("/resources/skill-repos/:id/resolve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = resolveBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { name, mergeId, choices, resolution } = parsed.data;
    // Exactly one form: per-path {mergeId, choices} XOR whole-skill {resolution}. Reject mixtures
    // — a stale per-path body carrying `resolution` but missing `choices` must NOT silently become
    // a whole-skill resolve that skips the mergeId staleness check (Codex #4).
    const perPath = mergeId !== undefined && choices !== undefined && resolution === undefined;
    const wholeSkill = resolution !== undefined && mergeId === undefined && choices === undefined;
    if (perPath === wholeSkill) {
      return reply
        .status(400)
        .send({ error: "provide exactly {mergeId, choices} OR {resolution}" });
    }
    try {
      const recoveries = perPath
        ? skillStore.resolveGitConflictPaths(id, name, mergeId!, choices!)
        : skillStore.resolveGitConflict(id, name, resolution === "remote" ? "remote" : "local");
      broadcast({ type: "resources_changed" });
      return { ok: true, recoveries };
    } catch (error) {
      if (error instanceof ResourceCatalogCapabilityError && error.code === "RESOURCE_STALE") {
        return reply.status(409).send({
          code: "LEGACY_MERGE_STALE",
          error: "The conflict changed since it was loaded. Refresh the review and try again.",
        });
      }
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Stop managing a collection but KEEP its skills as ordinary (unmanaged) skills.
  fastify.delete("/resources/skill-repos/:id/record", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      skillStore.forgetGitRepo(id, false);
      broadcast({ type: "resources_changed" });
      return { ok: true, removedRecordOnly: true };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Forget a collection AND remove its skills (displaced to the recovery surface, recoverable),
  // so the same repo can be re-imported cleanly.
  fastify.delete("/resources/skill-repos/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    try {
      skillStore.forgetGitRepo(id, true);
      broadcast({ type: "resources_changed" });
      return { ok: true };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Prompt templates: single .md files pi exposes as /prompt:<name>.
  fastify.get("/resources/prompts", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    return { prompts: scanPrompts(rootsFor(projectId)) };
  });

  const promptWriteBody = z.object({
    projectId: z.string().optional(),
    scope: writableLibraryScope,
    name: RESOURCE_NAME,
    edit: z.object({ description: z.string().max(500).optional(), body: z.string().max(100_000) }),
  });

  fastify.put("/resources/prompts", async (request, reply) => {
    const parsed = promptWriteBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, name, edit } = parsed.data;
    if (scope === "project" && !rootsFor(projectId).projectPath) {
      return reply.status(400).send({ error: "projectId required for project scope" });
    }
    try {
      writePromptFile(rootsFor(projectId), scope, name, edit);
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  fastify.delete("/resources/prompts", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        scope: writableLibraryScope,
        name: RESOURCE_NAME,
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, name } = parsed.data;
    if (scope === "project" && !rootsFor(projectId).projectPath) {
      return reply.status(400).send({ error: "projectId required for project scope" });
    }
    try {
      deletePromptFile(rootsFor(projectId), scope, name);
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
    // Drop the name from the flat default list only if it no longer resolves to
    // any prompt anywhere (another scope may still provide it).
    const globalPromptDir = nodePath.join(resourceHome(), ".pi", "agent", "prompts");
    const globalPromptExists = existsSync(nodePath.join(globalPromptDir, `${name}.md`));
    const stillResolves =
      globalPromptExists ||
      projects
        .list()
        .some((p) => existsSync(nodePath.join(p.path, ".pi", "prompts", `${name}.md`)));
    if (!stillResolves) settings.renameDefaultPromptTemplate(name, null);
    // Drop each project's assignment only if the name no longer resolves FOR THAT
    // project (the global was deleted and it has no own same-named prompt) — a
    // project that still has its own prompt keeps its assignment.
    for (const project of projects.list()) {
      if (!project.assignedPrompts?.includes(name)) continue;
      const resolvesForProject =
        globalPromptExists ||
        existsSync(nodePath.join(project.path, ".pi", "prompts", `${name}.md`));
      if (resolvesForProject) continue;
      projects.upsert({
        ...project,
        assignedPrompts: project.assignedPrompts.filter((p) => p !== name),
      });
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Rename a prompt template on disk (native RenameResourceSheet). Same scope;
  // 409 if the target name is taken, 404 if the source is gone.
  fastify.post("/resources/prompts/rename", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        scope: writableLibraryScope,
        name: RESOURCE_NAME,
        newName: RESOURCE_NAME,
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, name, newName } = parsed.data;
    if (scope === "project" && !rootsFor(projectId).projectPath) {
      return reply.status(400).send({ error: "projectId required for project scope" });
    }
    try {
      renamePromptFile(rootsFor(projectId), scope, name, newName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "prompt_exists") {
        return reply
          .status(409)
          .send({ error: `A ${scope} prompt named "${newName}" already exists.` });
      }
      if (message === "prompt_not_found") {
        return reply.status(404).send({ error: `No ${scope} prompt named "${name}".` });
      }
      return sendResourceMutationFailure(reply, error);
    }
    // Re-point references by which FILE each reference actually resolved to.
    // Prompts resolve GLOBAL-first (unlike skills, where a project skill shadows
    // the global), so:
    //  - A GLOBAL rename: every reference (the app-level defaults + every project
    //    assignment) resolved to that global, so re-point them all.
    //  - A PROJECT rename (in this request's project): only that project's own
    //    reference, and only when NO global of the same name shadowed it (else the
    //    reference resolved to the still-untouched global, not the renamed file).
    const globalPromptDir = nodePath.join(resourceHome(), ".pi", "agent", "prompts");
    const rewriteAssignment = (project: ProjectMeta): void => {
      projects.upsert({
        ...project,
        assignedPrompts: [
          ...new Set((project.assignedPrompts ?? []).map((p) => (p === name ? newName : p))),
        ],
      });
    };
    if (scope === "global" || scope === "library") {
      // A library prompt is effective by name only when no global prompt shadows
      // it. Re-point references only when this rename changed that resolution.
      const globalShadowsLibrary =
        scope === "library" && existsSync(nodePath.join(globalPromptDir, `${name}.md`));
      if (!globalShadowsLibrary) {
        settings.renameDefaultPromptTemplate(name, newName);
        for (const project of projects.list()) {
          if (project.assignedPrompts?.includes(name)) rewriteAssignment(project);
        }
      }
    } else {
      // Project rename: the global (if any) is untouched and would have shadowed
      // the reference, so only re-point this project's own assignment when no
      // global of that name exists. (A project prompt is never an app-level
      // default, so the default list is untouched here.)
      const globalShadows = existsSync(nodePath.join(globalPromptDir, `${name}.md`));
      if (!globalShadows) {
        const own = projects.list().find((p) => p.path === rootsFor(projectId).projectPath);
        if (own?.assignedPrompts?.includes(name)) rewriteAssignment(own);
      }
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Extensions: user-added pi extension files (.ts/.js) merged into every
  // session's --extension list. Enable/disable without removing the entry.
  fastify.get("/resources/extensions", async (request) => {
    const projectId = (request.query as { projectId?: string }).projectId;
    const disabled = new Set(settings.get().disabledExtensions);
    // Merge the manually-added registry with the ones DISCOVERED in the standard
    // pi dirs (global + this project's), so a user sees their existing extensions
    // without adding each by hand. Deduped by absolute path; a discovered file
    // that was also added manually is shown once, marked as added.
    const registry = new Set(settings.get().extensions);
    const discovered = scanExtensions(rootsFor(projectId));
    const scopeByPath = new Map(discovered.map((e) => [e.path, e.scope]));
    const paths = [...new Set([...settings.get().extensions, ...discovered.map((e) => e.path)])];
    return {
      extensions: paths.map((filePath) => ({
        path: filePath,
        name: nodePath.basename(filePath),
        exists: existsSync(filePath),
        disabled: disabled.has(filePath),
        // Where it came from, so the UI can label it (native scope/source).
        scope: scopeByPath.get(filePath) ?? "global",
        source: registry.has(filePath) ? "added" : "discovered",
        // The app-bridge tool this extension re-registers (else null). A
        // conflicting extension is NOT injected (it would crash pi) — the UI
        // warns that the bridge shadows it (native conflict flag).
        bridgeConflict: extensionBridgeConflictAt(filePath),
      })),
    };
  });

  fastify.post("/resources/extensions", async (request, reply) => {
    const parsed = z.object({ path: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const filePath = nodePath.resolve(parsed.data.path);
    if (!existsSync(filePath) || !statSync(filePath).isFile()) {
      return reply.status(400).send({ error: `not a file: ${filePath}` });
    }
    settings.addExtension(filePath);
    broadcast({ type: "resources_changed" });
    return { ok: true, path: filePath };
  });

  fastify.post("/resources/extensions/disabled", async (request, reply) => {
    const parsed = z
      .object({ path: z.string().min(1), disabled: z.boolean() })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    settings.setExtensionDisabled(parsed.data.path, parsed.data.disabled);
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  fastify.delete("/resources/extensions", async (request, reply) => {
    const parsed = z.object({ path: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    settings.removeExtension(parsed.data.path);
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // The app's OWN generated bridge extensions (native "Agent Deck bridges" card):
  // a read-only inventory so a user SEES what Agent Deck injects into pi over the
  // bridge, separate from their own extensions. Live: each group's tools + active
  // state are derived from what's actually registered on the bridge right now, so
  // it reflects real config (memory off, no MCP server, etc.).
  const APP_BRIDGE_GROUPS = [
    {
      id: "memory",
      displayName: "Memory",
      summary: "Stores and recalls durable project memory the agent writes and reads.",
      condition: "When memory is enabled (AGENT_DECK_MEMORY≠0)",
      match: (name: string): boolean => name.startsWith("agent_deck_memory_"),
    },
    {
      id: "ask_user",
      displayName: "Ask user",
      summary: "Lets the parent agent pause for a structured decision from you.",
      condition: "Always on for parent sessions",
      match: (name: string): boolean => name === "ask_user",
    },
    {
      id: "deck_agents",
      displayName: "Deck agents",
      summary:
        "Lets the agent delegate to your named agents (subagents), run them in parallel, and maintain a session plan; a subagent reports back over a supervisor channel.",
      condition: "Always on for parent sessions",
      match: (name: string): boolean =>
        [
          "managed_subagent",
          "managed_parallel",
          "set_session_plan",
          "update_session_plan",
        ].includes(name),
    },
    {
      id: "mcp",
      displayName: "MCP",
      summary: "Proxies your configured MCP servers' tools into sessions as mcp__<server>__<tool>.",
      condition: "When at least one MCP server is connected",
      match: (name: string): boolean => name.startsWith("mcp__"),
    },
  ];
  fastify.get("/runtime/bridges", async () => {
    const specs = bridge.specs();
    return {
      bridges: APP_BRIDGE_GROUPS.map((group) => {
        const toolNames = specs
          .filter((s) => group.match(s.name))
          .map((s) => s.name)
          .sort();
        return {
          id: group.id,
          displayName: group.displayName,
          summary: group.summary,
          condition: group.condition,
          toolNames,
          active: toolNames.length > 0,
        };
      }),
    };
  });

  // Edit-safety contract: builtin agents are NEVER written — edits become a
  // diff vs the pristine builtin at settings.json → subagents.agentOverrides.
  // The UI sends the complete form state, so the computed diff fully replaces
  // any prior override (reverting a field back to base clears it).
  fastify.put("/resources/agents", async (request, reply) => {
    const parsed = agentEditBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, name, edit } = parsed.data;
    const roots = rootsFor(projectId);
    try {
      if (scope === "builtin") {
        const builtinFile = nodePath.join(BUILTIN_AGENTS_DIR, `${name}.md`);
        if (!existsSync(builtinFile)) {
          return reply.status(404).send({ error: `unknown builtin agent: ${name}` });
        }
        const base = parseAgentFile(builtinFile, readFileSync(builtinFile, "utf8"), "builtin");
        // Merge: fields this editor doesn't manage (disabled, native-only keys, …)
        // survive; managed fields are fully recomputed from the form state.
        const merged = mergeWithUnmanagedOverrideFields(
          readAgentOverrides(roots)[name],
          computeBuiltinOverride(base, edit),
        );
        writeBuiltinAgentOverride(roots, name, merged);
      } else {
        if (scope === "project" && !roots.projectPath) {
          return reply.status(400).send({ error: "projectId required for project scope" });
        }
        writeAgentFile(roots, scope, name, edit);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "agent_ambiguous") {
        return reply.status(409).send({
          error: `Both legacy and modern global agents are named "${name}"; choose a unique name before editing.`,
        });
      }
      return sendResourceMutationFailure(reply, error);
    }
    // settings.json isn't under the resource watcher — notify clients directly.
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Toggle an agent's disabled flag: override for builtins, frontmatter for
  // global/library agents.
  fastify.post("/resources/agents/disabled", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        scope: writableAgentScope,
        name: RESOURCE_NAME,
        disabled: z.boolean(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, name, disabled } = parsed.data;
    const roots = rootsFor(projectId);
    try {
      if (scope === "builtin") {
        if (!existsSync(nodePath.join(BUILTIN_AGENTS_DIR, `${name}.md`))) {
          return reply.status(404).send({ error: `unknown builtin agent: ${name}` });
        }
        const existing = readAgentOverrides(roots)[name] ?? {};
        const next = { ...existing };
        if (disabled) next.disabled = true;
        else delete next.disabled;
        writeBuiltinAgentOverride(roots, name, Object.keys(next).length > 0 ? next : null);
      } else {
        if (scope === "project" && !roots.projectPath) {
          return reply.status(400).send({ error: "projectId required for project scope" });
        }
        setAgentDisabledFile(roots, scope, name, disabled);
      }
    } catch (error) {
      if (error instanceof Error && error.message === "agent_ambiguous") {
        return reply.status(409).send({ error: `Agent "${name}" has ambiguous global sources.` });
      }
      return sendResourceMutationFailure(reply, error);
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Delete a custom global/library agent's file. Builtins can't be deleted;
  // "delete" for a builtin means removing its override (reset to pristine).
  fastify.delete("/resources/agents", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        scope: writableAgentScope,
        name: RESOURCE_NAME,
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, name } = parsed.data;
    const roots = rootsFor(projectId);
    try {
      if (scope === "builtin") {
        if (!existsSync(nodePath.join(BUILTIN_AGENTS_DIR, `${name}.md`))) {
          return reply.status(404).send({ error: `unknown builtin agent: ${name}` });
        }
        // "Reset to pristine" — remove the entire override, including any
        // unmanaged keys (mcpServers, …). This is why the UI only offers
        // reset for a builtin that is currently overridden.
        writeBuiltinAgentOverride(roots, name, null);
      } else {
        if (scope === "project" && !roots.projectPath) {
          return reply.status(400).send({ error: "projectId required for project scope" });
        }
        deleteAgentFile(roots, scope, name);
        // A shadowed library copy is not the active source for a bare-name
        // default, so deleting it must not clear that still-valid reference.
        const stillActive =
          scope === "library" &&
          scanAgents(roots).some((agent) => agent.name === name && !agent.shadowed);
        if (!stillActive) {
          for (const project of projects.list()) {
            if (project.defaultAgentName === name) {
              projects.upsert({ ...project, defaultAgentName: undefined });
            }
          }
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === "agent_ambiguous") {
        return reply.status(409).send({ error: `Agent "${name}" has ambiguous global sources.` });
      }
      return sendResourceMutationFailure(reply, error);
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Rename a global/library agent on disk (native RenameResourceSheet 6.5).
  // Builtins can't be renamed (their name is the override key). Any project
  // whose default pointed at the old name is re-pointed at the new one.
  fastify.post("/resources/agents/rename", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        scope: writableLibraryScope,
        name: RESOURCE_NAME,
        newName: RESOURCE_NAME,
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, name, newName } = parsed.data;
    const roots = rootsFor(projectId);
    if (scope === "project" && !roots.projectPath) {
      return reply.status(400).send({ error: "projectId required for project scope" });
    }
    try {
      renameAgentFile(roots, scope, name, newName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "agent_exists") {
        return reply
          .status(409)
          .send({ error: `A ${scope} agent named "${newName}" already exists.` });
      }
      if (message === "agent_ambiguous") {
        return reply.status(409).send({ error: `Agent "${name}" has ambiguous global sources.` });
      }
      if (message === "agent_not_found") {
        return reply.status(404).send({ error: `No ${scope} agent named "${name}".` });
      }
      return sendResourceMutationFailure(reply, error);
    }
    // Re-point project defaults, but ONLY where this rename actually changes the
    // effective default — bare-name resolution respects scope shadowing (a
    // project-scoped agent shadows a same-named global one). Over-broad matching
    // would silently redirect a default onto a different, live agent.
    const hasProjectAgent = (projectPath: string): boolean =>
      existsSync(nodePath.join(projectPath, ".pi", "agents", `${name}.md`)) ||
      existsSync(nodePath.join(projectPath, ".agents", `${name}.md`));
    const libraryWasShadowed =
      scope === "library" &&
      scanAgents(roots).some(
        (agent) => agent.name === name && agent.scope !== "library" && !agent.shadowed,
      );
    for (const project of projects.list()) {
      if (project.defaultAgentName !== name || libraryWasShadowed) continue;
      if (scope === "project") {
        // A project agent is visible only to its own project.
        if (project.path === roots.projectPath) {
          projects.upsert({ ...project, defaultAgentName: newName });
        }
      } else if (!hasProjectAgent(project.path)) {
        // Global rename: skip projects whose own project-scoped agent of that
        // name shadows the global (their default resolves to the project one).
        projects.upsert({ ...project, defaultAgentName: newName });
      }
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  fastify.put("/resources/skills", async (request, reply) => {
    const parsed = skillEditBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, name, edit } = parsed.data;
    const roots = rootsFor(projectId);
    if (scope === "project" && !roots.projectPath) {
      return reply.status(400).send({ error: "projectId required for project scope" });
    }
    try {
      skillStore.writeSkill(scope, name, edit, projectId);
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });
}
