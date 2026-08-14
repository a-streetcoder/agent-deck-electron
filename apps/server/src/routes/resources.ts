import { existsSync, readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { ProjectMeta } from "@agent-deck/contracts";
import {
  AGENT_EXTENSION_MAX_ITEMS,
  AGENT_EXTENSION_MAX_LENGTH,
  AGENT_OUTPUT_MAX_LENGTH,
  agentConfigurationWarnings,
  normalizeAgentOutput,
  validateAgentDefaultReadsForAuthoring,
  validateAgentExtensionsForAuthoring,
  type AgentInfo,
  type SkillInfo,
} from "@agent-deck/domain";
import {
  BUILTIN_AGENTS_DIR,
  computeBuiltinOverride,
  deleteAgentFile,
  deletePromptFile,
  enumerateCodexPluginSkills,
  mergeWithUnmanagedOverrideFields,
  materializeBuiltinAgentOverrideContent,
  parseAgentFile,
  readAgentOverrides,
  renameAgentFile,
  ResourceCatalogCapabilityError,
  renamePromptFile,
  resolveCodexPluginSkillRefs,
  resolveSkillSource,
  scanAgents,
  scanPackageSkillLocations,
  scanExtensions,
  scanPrompts,
  setAgentDisabledFile,
  writeAgentFile,
  writeBuiltinAgentOverride,
  writePromptFile,
  type ResourceRecovery,
} from "@agent-deck/resources";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import { curateProjectAgents } from "../agentCuration.ts";
import { AgentAvatarStoreError } from "../agentAvatars.ts";
import type { ServerContext } from "../context.ts";
import { InjectedCommandError } from "../injectedCommands.ts";
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
  extensions: z
    .array(z.string().max(AGENT_EXTENSION_MAX_LENGTH))
    .max(AGENT_EXTENSION_MAX_ITEMS)
    .nullable()
    .optional(),
  mcpServers: z.array(z.string()).optional(),
  // Writer/scanner/runtime sanitization is deliberately entry-by-entry so one
  // unsafe manually authored path does not erase its safe peers.
  defaultReads: z.array(z.string()).optional(),
  defaultExpectedOutcome: z
    .union([
      z.enum(["reportOnly", "editFilesInWorktree", "writeProjectFile", "directProjectWrites"]),
      z.literal(""),
    ])
    .optional(),
  defaultProgress: z.boolean().optional(),
  interactive: z.boolean().optional(),
  maxSubagentDepth: z.union([z.number().int().min(0), z.literal("")]).optional(),
  // Prompt-adjacent metadata: one bounded advisory value, never a multiline
  // prompt fragment or control sequence. Empty remains the explicit clear.
  output: z
    .string()
    .trim()
    .max(AGENT_OUTPUT_MAX_LENGTH)
    .refine(
      (value) => value === "" || normalizeAgentOutput(value) !== undefined,
      "output must be a single line",
    )
    .optional(),
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
  /** Create a custom agent from immutable builtin bytes. The existing PUT route
   * remains the sole write path; the writer claims the destination exclusively. */
  createFromBuiltin: RESOURCE_NAME.optional(),
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

/** Engine preview → renderer payload: display name/description derive from SKILL.md
 * frontmatter via the pinned Pi parser — the same one the scanner uses, never a second YAML
 * dialect; folder-name fallback on unparseable/absent frontmatter. Shared by the git and
 * local-folder inspect routes so both feed one preview dialog. */
function toSkillPreviews(
  skills: { name: string; fileCount: number; skillMd?: string }[],
): { name: string; displayName: string; description?: string; extraFileCount: number }[] {
  return skills.map((s) => {
    let displayName = s.name;
    let description: string | undefined;
    if (s.skillMd) {
      try {
        const { frontmatter } = parseFrontmatter(s.skillMd);
        const fmName = frontmatter["name"];
        const fmDesc = frontmatter["description"];
        if (typeof fmName === "string" && fmName.trim()) displayName = fmName.trim();
        if (typeof fmDesc === "string" && fmDesc.trim()) description = fmDesc.trim();
      } catch {
        // unparseable frontmatter → folder-name fallback, same as the scanner's posture
      }
    }
    return {
      name: s.name,
      displayName,
      description,
      // extra material beyond SKILL.md itself (native shows a reference-file badge)
      extraFileCount: Math.max(0, s.fileCount - 1),
    };
  });
}

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
    agentAvatars,
    extensionBridgeConflictAt,
    injectedCommands,
    scanSkillCandidatesFor,
    createAgentWarningContext,
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

  const avatarIdentity = (scope: AgentInfo["scope"], name: string, projectId?: string) => ({
    scope,
    name,
    projectId: scope === "project" ? projectId : undefined,
  });
  const enrichAgentAvatars = (agents: AgentInfo[], projectId?: string): AgentInfo[] =>
    agents.map((agent) => {
      const avatar = agentAvatars.assignment(avatarIdentity(agent.scope, agent.name, projectId));
      return avatar
        ? { ...agent, avatarUrl: `/agent-avatars/${avatar.id}?v=${avatar.blobHash}` }
        : agent;
    });

  fastify.get("/resources/agents", async (request) => {
    const { projectId, includeUnassigned } = request.query as {
      projectId?: string;
      includeUnassigned?: string;
    };
    const warningContext = createAgentWarningContext(projectId);
    const agents = enrichAgentAvatars(scanAgents(rootsFor(projectId)), projectId).map((agent) => ({
      ...agent,
      warnings: agentConfigurationWarnings(agent, warningContext),
    }));
    const project = projectId ? projects.find((item) => item.id === projectId) : undefined;
    return {
      agents: includeUnassigned === "true" ? agents : curateProjectAgents(project, agents),
    };
  });

  // Opaque app-owned avatar reads. The id is derived from managed identity, not
  // a path; v binds stale cached URLs to the exact current blob.
  fastify.get("/agent-avatars/:avatarId", async (request, reply) => {
    const { avatarId } = request.params as { avatarId: string };
    const version = (request.query as { v?: unknown }).v;
    const image = agentAvatars.read(avatarId);
    const notFound = () =>
      reply
        .code(404)
        .headers({
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; sandbox",
          "referrer-policy": "no-referrer",
          "cross-origin-resource-policy": "same-origin",
        })
        .send();
    if (!image || version !== image.blobHash) return notFound();
    return reply
      .headers({
        "content-type": image.mimeType,
        "content-length": String(image.data.length),
        "cache-control": "private, max-age=31536000, immutable",
        "x-content-type-options": "nosniff",
        "content-security-policy": "default-src 'none'; sandbox",
        "referrer-policy": "no-referrer",
        "cross-origin-resource-policy": "same-origin",
      })
      .send(image.data);
  });

  // 15,000,000 decoded bytes canonically expand to 20,000,000 base64
  // characters. Keep this exception route-local and leave Fastify's global
  // request limit unchanged.
  const AVATAR_IMPORT_BODY_LIMIT = 20_100_000;
  const avatarMutationBody = z.object({
    projectId: z.string().optional(),
    scope: z.enum(["builtin", "global", "library", "project"]),
    name: RESOURCE_NAME,
    mimeType: z.enum(["image/png", "image/jpeg", "image/gif", "image/webp"]),
    data: z.string().max(20_000_000),
  });

  fastify.put(
    "/resources/agents/avatar",
    { bodyLimit: AVATAR_IMPORT_BODY_LIMIT },
    async (request, reply) => {
      const parsed = avatarMutationBody.safeParse(request.body);
      if (!parsed.success)
        return reply
          .status(400)
          .send({ error: "Choose a PNG, JPEG, GIF, or WebP image up to 15 MB." });
      const { projectId, scope, name, mimeType, data } = parsed.data;
      if (scope === "project" && !projects.find((project) => project.id === projectId))
        return reply.status(400).send({ error: "projectId required for project scope" });
      const exists = scanAgents(rootsFor(projectId)).some(
        (agent) => agent.scope === scope && agent.name === name,
      );
      if (!exists) return reply.status(404).send({ error: "The agent no longer exists." });
      try {
        agentAvatars.assign(avatarIdentity(scope, name, projectId), {
          type: "image",
          mimeType,
          data,
        });
      } catch (error) {
        if (error instanceof AgentAvatarStoreError) {
          return reply.status(409).send({ error: error.message });
        }
        return reply.status(400).send({
          error: "That file is not a valid supported image or exceeds the 15 MB/dimension limits.",
        });
      }
      broadcast({ type: "resources_changed" });
      return { ok: true };
    },
  );

  fastify.delete("/resources/agents/avatar", async (request, reply) => {
    const parsed = avatarMutationBody.omit({ mimeType: true, data: true }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, name } = parsed.data;
    if (scope === "project" && !projects.find((project) => project.id === projectId))
      return reply.status(400).send({ error: "projectId required for project scope" });
    try {
      agentAvatars.remove(avatarIdentity(scope, name, projectId));
    } catch (error) {
      if (error instanceof AgentAvatarStoreError)
        return reply.status(409).send({ error: error.message });
      return sendResourceMutationFailure(reply, error);
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Skills carry the app-level disabled flag from settings.
  const enrichSkills = (skills: SkillInfo[]): SkillInfo[] => {
    const disabled = new Set(settings.get().disabledSkills);
    return skills.map((s) => ({ ...s, disabled: disabled.has(s.name) }));
  };

  fastify.get("/resources/skills", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    // SKL-08: surface package-resolution warnings (a configured package that silently
    // contributes nothing is exactly what the user needs to hear about). The locations pass
    // is metadata-only — no skill files are loaded twice.
    const { warnings } = scanPackageSkillLocations(rootsFor(projectId));
    // SKL-09: plugin refs re-resolve every request — a ref gone stale (plugin removed,
    // version dropped the skill) warns here instead of silently vanishing from the catalog.
    const refs = settings.get().codexPluginSkillRefs;
    const pluginResolution = resolveCodexPluginSkillRefs(resourceHome(), refs);
    return {
      skills: enrichSkills(skillStore.listSkills(projectId)),
      packageWarnings: warnings,
      codexPluginRefs: refs,
      codexPluginWarnings: pluginResolution.warnings,
    };
  });

  // Diagnostic candidate view: preserve true same-priority duplicate names
  // after normal project/global catalog precedence, so editor and launch agree.
  fastify.get("/resources/skills/visibility", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    return { skills: enrichSkills(scanSkillCandidatesFor(projectId)) };
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
      // The engine speaks RESOURCE_* codes; the legacy writer's string matches ("skill_exists"
      // etc.) had been unreachable dead branches since the engine swap — removed (review finding).
      name = skillStore.importLocalSkill(scope, nodePath.resolve(sourcePath), projectId);
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
    broadcast({ type: "resources_changed" });
    return { ok: true, name };
  });

  // Local-path routes work on arbitrary user filesystem paths, so an UNCODED exception (raw IO
  // error text) must not reach the renderer verbatim — it can carry absolute paths the generic
  // 500 fallback would otherwise leak (review, Codex). Coded RESOURCE_* errors keep their
  // sanitized mapping.
  const sendLocalPathFailure = (
    reply: { status(code: number): { send(body: { error: string }): unknown } },
    error: unknown,
    generic: string,
  ): unknown => {
    if (error instanceof ResourceCatalogCapabilityError) {
      return sendResourceMutationFailure(reply, error);
    }
    return reply.status(500).send({ error: generic });
  };

  // Known external skill sources (SKL-07/10): the folders other tools keep skills in — Claude
  // and Codex, global and per-project (native's knownSkillSources). Existence-checked so the
  // client only scans folders that are actually there; `CODEX_HOME` is honored like Codex does.
  // The plugin-cache pass (SKL-09) is deliberately NOT here — it needs reference semantics.
  fastify.get("/resources/skills/known-sources", async () => {
    const home = resourceHome();
    const codexHome = process.env.CODEX_HOME?.trim() || nodePath.join(home, ".codex");
    const sources: { path: string; label: string; provider: "claude" | "codex" }[] = [];
    const seen = new Set<string>();
    const add = (dir: string, label: string, provider: "claude" | "codex"): void => {
      // dedupe by resolved path: CODEX_HOME can alias a project folder, and a duplicate root
      // would mint duplicate candidate ids downstream (review, Codex); first label wins
      const resolved = nodePath.resolve(dir);
      if (seen.has(resolved)) return;
      if (existsSync(resolved)) {
        seen.add(resolved);
        sources.push({ path: resolved, label, provider });
      }
    };
    add(nodePath.join(home, ".claude", "skills"), "Claude · Global", "claude");
    add(nodePath.join(codexHome, "skills"), "Codex · Global", "codex");
    for (const project of projects.list()) {
      if (project.enabled === false || project.hidden) continue;
      add(nodePath.join(project.path, ".claude", "skills"), `Claude · ${project.name}`, "claude");
      add(nodePath.join(project.path, ".codex", "skills"), `Codex · ${project.name}`, "codex");
    }
    return { sources };
  });

  // Codex plugin skills (SKL-09): what the plugin cache offers right now, plus the refs the
  // user already holds. REFERENCE semantics — importing records a ref, never copies files, so
  // the skill version-follows Codex's active plugin version.
  fastify.get("/resources/skills/codex-plugin-catalog", async () => {
    const { items, warnings } = enumerateCodexPluginSkills(resourceHome());
    return { items, warnings, refs: settings.get().codexPluginSkillRefs };
  });

  const pluginRefShape = z.object({
    marketplace: z.string().trim().min(1).max(200),
    plugin: z.string().trim().min(1).max(200),
    relPath: z.string().trim().min(1).max(500),
  });

  fastify.post("/resources/skills/codex-plugin-refs", async (request, reply) => {
    const parsed = z
      .object({ refs: z.array(pluginRefShape).min(1).max(100) })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    // Accept only refs that resolve RIGHT NOW (active plugin, contained, SKILL.md present) —
    // recording a dead ref would mint a permanent warning the user never asked for.
    const rejected: string[] = [];
    for (const ref of parsed.data.refs) {
      const { roots, warnings } = resolveCodexPluginSkillRefs(resourceHome(), [ref]);
      if (roots.length === 0) {
        rejected.push(warnings[0] ?? `${ref.plugin}@${ref.marketplace}/${ref.relPath}`);
      }
    }
    if (rejected.length > 0) return reply.status(400).send({ error: rejected.join(" ") });
    settings.addCodexPluginSkillRefs(parsed.data.refs);
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  fastify.delete("/resources/skills/codex-plugin-refs", async (request, reply) => {
    const parsed = pluginRefShape.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    settings.removeCodexPluginSkillRef(parsed.data);
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  // Preview a LOCAL folder of skills (SKL-05): engine discovery, materializes nothing. Shares
  // the git preview's payload shape so the renderer reuses one dialog.
  fastify.post("/resources/skills/inspect-local", async (request, reply) => {
    const parsed = z.object({ path: z.string().trim().min(1).max(2000) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    try {
      const skills = skillStore.inspectLocalFolder(nodePath.resolve(parsed.data.path));
      return { skills: toSkillPreviews(skills) };
    } catch (error) {
      return sendLocalPathFailure(reply, error, "Couldn't read that folder.");
    }
  });

  // Import selected skills from a LOCAL folder (SKL-05/06): one-shot full-fileset copy.
  fastify.post("/resources/skills/import-local-folder", async (request, reply) => {
    const parsed = z
      .object({
        path: z.string().trim().min(1).max(2000),
        selected: z.array(z.string().trim().min(1).max(200)).min(1).max(500).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    try {
      const imported = skillStore.importLocalFolder(
        nodePath.resolve(parsed.data.path),
        parsed.data.selected,
      );
      broadcast({ type: "resources_changed" });
      return { imported };
    } catch (error) {
      return sendLocalPathFailure(reply, error, "Couldn't import from that folder.");
    }
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
        // SKL-04: import only these skills (names from the preview). Omitted = full import.
        selected: z.array(z.string().trim().min(1).max(200)).min(1).max(500).optional(),
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
      const result = skillStore.importGitRepo(
        source.cloneUrl,
        source.ref,
        source.subdir,
        parsed.data.selected,
      );
      broadcast({ type: "resources_changed" });
      return { imported: result.skills, skipped: [] as string[], repoId: result.collectionId };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Preview a repository BEFORE importing (SKL-03): the engine clones + discovers without
  // materializing anything, and the cached clone makes the following import show-what-you-saw.
  // No broadcast: nothing changed.
  fastify.post("/resources/skills/inspect-git", async (request, reply) => {
    const parsed = z.object({ url: z.string().trim().min(1).max(2000) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const source = resolveSkillSource(parsed.data.url);
    if (!source) {
      return reply.status(400).send({ error: "Couldn't understand that repository reference." });
    }
    try {
      const result = skillStore.inspectGitRepo(source.cloneUrl, source.ref, source.subdir);
      return { repoId: result.collectionId, skills: toSkillPreviews(result.skills) };
    } catch (error) {
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Cancel a preview: idempotent; refuses a genuinely imported collection (that is the
  // forget/delete flow's job). No broadcast: a preview was never visible resource state.
  fastify.post("/resources/skills/discard-git-preview", async (request, reply) => {
    const parsed = z.object({ repoId: z.string().trim().min(1).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    try {
      skillStore.discardGitPreview(parsed.data.repoId);
      return { ok: true };
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

  const commandFailure = (reply: FastifyReply, error: unknown) => {
    if (!(error instanceof InjectedCommandError))
      return reply.status(500).send({ error: "The command library operation failed." });
    const status = error.code === "not_found" ? 404 : error.code === "collision" ? 409 : 400;
    return reply.status(status).send({ error: error.message });
  };

  // App-owned injected slash commands. Imported source bytes arrive through a
  // browser/Electron-compatible file input and are copied into app data; no
  // client source path is accepted, retained, or returned as provenance.
  fastify.get("/resources/commands", async () => ({ commands: injectedCommands.list() }));

  fastify.post("/resources/commands/import", async (request, reply) => {
    const parsed = z
      .object({ fileName: z.string().min(1).max(128), content: z.string().max(256_000) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({ error: "Choose a .ts or .js command file up to 256 KB." });
    try {
      const command = injectedCommands.import(parsed.data.fileName, parsed.data.content);
      broadcast({ type: "resources_changed" });
      return reply.status(201).send({ command });
    } catch (error) {
      return commandFailure(reply, error);
    }
  });

  fastify.post("/resources/commands/toggle", async (request, reply) => {
    const parsed = z
      .object({ id: z.string().min(1).max(96), enabled: z.boolean() })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid command toggle." });
    try {
      injectedCommands.setEnabled(parsed.data.id, parsed.data.enabled);
      broadcast({ type: "resources_changed" });
      return { ok: true };
    } catch (error) {
      return commandFailure(reply, error);
    }
  });

  fastify.delete("/resources/commands", async (request, reply) => {
    const parsed = z
      .object({ id: z.string().min(1).max(96) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid command deletion." });
    try {
      injectedCommands.delete(parsed.data.id);
      broadcast({ type: "resources_changed" });
      return { ok: true };
    } catch (error) {
      return commandFailure(reply, error);
    }
  });

  // Extensions: user-added pi extension files (.ts/.js) merged into every
  // session's --extension list. Enable/disable without removing the entry.
  fastify.get("/resources/extensions", async (request) => {
    const projectId = (request.query as { projectId?: string }).projectId;
    // Match launch normalization so a legacy relative setting cannot appear
    // enabled in the catalog while its resolved launch path is disabled.
    const disabled = new Set(
      settings.get().disabledExtensions.map((filePath) => nodePath.resolve(filePath)),
    );
    // Merge the manually-added registry with the ones DISCOVERED in the standard
    // pi dirs (global + this project's), so a user sees their existing extensions
    // without adding each by hand. Deduped by absolute path; a discovered file
    // that was also added manually is shown once, marked as added.
    const registry = new Set(
      settings.get().extensions.map((filePath) => nodePath.resolve(filePath)),
    );
    const discovered = scanExtensions(rootsFor(projectId));
    const scopeByPath = new Map(
      discovered.map((entry) => [nodePath.resolve(entry.path), entry.scope]),
    );
    const paths = [
      ...new Set([...registry, ...discovered.map((entry) => nodePath.resolve(entry.path))]),
    ];
    return {
      loadingMode: settings.get().extensionLoadingMode,
      extensions: paths.map((filePath) => ({
        path: filePath,
        name: nodePath.basename(filePath),
        exists: (() => {
          try {
            return statSync(filePath).isFile();
          } catch {
            return false;
          }
        })(),
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
        "Lets the agent delegate to your named agents (subagents), run them in parallel, review and answer pending supervisor requests, and maintain a session plan; a subagent reports back over a supervisor channel.",
      condition: "Always on for parent sessions",
      match: (name: string): boolean =>
        [
          "managed_subagent",
          "managed_parallel",
          "list_supervisor_requests",
          "answer_supervisor_request",
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
    if (!parsed.success) {
      const extensionIssue = parsed.error.issues.find(
        (issue) => issue.path[0] === "edit" && issue.path[1] === "extensions",
      );
      if (extensionIssue) {
        return reply.status(400).send({
          error:
            extensionIssue.code === "invalid_type"
              ? "Extensions must be a list of file paths or null."
              : extensionIssue.path.length > 2
                ? `Each extension entry cannot exceed ${AGENT_EXTENSION_MAX_LENGTH} characters.`
                : `Extensions cannot exceed ${AGENT_EXTENSION_MAX_ITEMS} entries.`,
        });
      }
      return reply.status(400).send({ error: parsed.error.message });
    }
    const { projectId, scope, name, edit, createFromBuiltin } = parsed.data;
    if (scope === "builtin" && edit.extensions !== undefined) {
      return reply.status(400).send({ error: "Builtin extension overrides are not supported." });
    }
    let validatedEdit = edit;
    try {
      if (edit.extensions !== undefined && edit.extensions !== null) {
        validatedEdit = {
          ...validatedEdit,
          extensions: validateAgentExtensionsForAuthoring(edit.extensions),
        };
      }
      if (edit.defaultReads !== undefined) {
        validatedEdit = {
          ...validatedEdit,
          defaultReads: validateAgentDefaultReadsForAuthoring(edit.defaultReads) ?? [],
        };
      }
    } catch (error) {
      return reply.status(400).send({
        error:
          error instanceof Error
            ? error.message
            : "Agent extension or default-read metadata exceeds the authoring budget.",
      });
    }
    const roots = rootsFor(projectId);
    try {
      if (createFromBuiltin && scope !== "global") {
        return reply.status(400).send({ error: "Builtin replacements must be global agents." });
      }
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
          computeBuiltinOverride(base, validatedEdit),
        );
        writeBuiltinAgentOverride(roots, name, merged);
      } else {
        if (scope === "project" && !roots.projectPath) {
          return reply.status(400).send({ error: "projectId required for project scope" });
        }
        let baseContent: string | undefined;
        if (createFromBuiltin) {
          const builtinFile = nodePath.join(BUILTIN_AGENTS_DIR, `${createFromBuiltin}.md`);
          if (!existsSync(builtinFile)) {
            return reply.status(404).send({ error: `unknown builtin agent: ${createFromBuiltin}` });
          }
          baseContent = materializeBuiltinAgentOverrideContent(
            readFileSync(builtinFile, "utf8"),
            readAgentOverrides(roots)[createFromBuiltin],
          );
        }
        writeAgentFile(roots, scope, name, validatedEdit, {
          createOnly: createFromBuiltin !== undefined,
          baseContent,
        });
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
    if (disabled) {
      for (const project of projects.list()) {
        if (project.defaultAgentName !== name) continue;
        const stillEffective = scanAgents(rootsFor(project.id)).some(
          (agent) => agent.name === name && !agent.shadowed && !agent.disabled,
        );
        if (!stillEffective) projects.upsert({ ...project, defaultAgentName: undefined });
      }
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
      agentAvatars.validateForMutation();
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
        // Re-evaluate each project's effective bare-name source after deletion.
        // Defaults may remain when another source (including a builtin) takes
        // over; custom assignment entries remain only while a custom source does.
        for (const project of projects.list()) {
          if (project.defaultAgentName !== name && !project.assignedAgentNames?.includes(name)) {
            continue;
          }
          const effective = scanAgents(rootsFor(project.id)).find(
            (agent) => agent.name === name && !agent.shadowed && !agent.disabled,
          );
          const next = { ...project };
          if (project.defaultAgentName === name && !effective) next.defaultAgentName = undefined;
          if (
            project.assignedAgentNames?.includes(name) &&
            (!effective || effective.scope === "builtin")
          ) {
            next.assignedAgentNames = project.assignedAgentNames.filter((item) => item !== name);
          }
          projects.upsert(next);
        }
      }
      // Avatar ownership follows the exact managed agent. Removing/resetting one
      // same-named source never touches another scope's assignment.
      agentAvatars.remove(avatarIdentity(scope, name, projectId));
    } catch (error) {
      if (error instanceof Error && error.message === "agent_ambiguous") {
        return reply.status(409).send({ error: `Agent "${name}" has ambiguous global sources.` });
      }
      if (error instanceof AgentAvatarStoreError)
        return reply.status(409).send({ error: error.message });
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
      agentAvatars.validateForMutation();
      // Refuse an avatar identity collision before moving the resource file, so
      // the cross-store rename cannot report failure after the catalog changed.
      const oldAvatarIdentity = avatarIdentity(scope, name, projectId);
      const newAvatarIdentity = avatarIdentity(scope, newName, projectId);
      const avatarMoves = agentAvatars.assignment(oldAvatarIdentity) !== undefined;
      if (avatarMoves && agentAvatars.assignment(newAvatarIdentity)) {
        return reply.status(409).send({ error: `An avatar is already assigned to "${newName}".` });
      }
      // Move the independently atomic avatar assignment first. A catalog rename
      // failure then rolls it back, while an avatar write failure never changes
      // the resource file.
      if (avatarMoves) agentAvatars.rename(oldAvatarIdentity, newAvatarIdentity);
      try {
        renameAgentFile(roots, scope, name, newName);
      } catch (error) {
        if (avatarMoves) {
          try {
            agentAvatars.rename(newAvatarIdentity, oldAvatarIdentity);
          } catch (rollbackError) {
            throw new AggregateError(
              [error, rollbackError],
              "Agent rename failed and avatar ownership could not be restored.",
            );
          }
        }
        throw error;
      }
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
      if (message === "agent_avatar_exists") {
        return reply.status(409).send({ error: `An avatar is already assigned to "${newName}".` });
      }
      if (error instanceof AgentAvatarStoreError)
        return reply.status(409).send({ error: error.message });
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
      if (libraryWasShadowed) continue;
      const applies =
        scope === "project" ? project.path === roots.projectPath : !hasProjectAgent(project.path);
      if (!applies) continue;
      const next = { ...project };
      let changed = false;
      if (project.defaultAgentName === name) {
        next.defaultAgentName = newName;
        changed = true;
      }
      if (project.assignedAgentNames?.includes(name)) {
        next.assignedAgentNames = [
          ...new Set(project.assignedAgentNames.map((item) => (item === name ? newName : item))),
        ];
        changed = true;
      }
      if (changed) projects.upsert(next);
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
