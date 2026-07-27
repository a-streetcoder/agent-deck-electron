import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import nodePath from "node:path";
import type { ProjectMeta } from "@agent-deck/contracts";
import type { SkillInfo } from "@agent-deck/domain";
import {
  BUILTIN_AGENTS_DIR,
  catalogSkillTreeFingerprint,
  computeBuiltinOverride,
  discoverImportSkillRoots,
  discoverSkillRoots,
  deleteAgentFile,
  deletePromptFile,
  isSkillTreeFingerprint,
  durableMaterializeSkillTreeEntries,
  mergeWithUnmanagedOverrideFields,
  MISSING_SKILL_TREE_FINGERPRINT,
  parseAgentFile,
  readAgentOverrides,
  renameAgentFile,
  ResourceCatalogCapabilityError,
  renamePromptFile,
  replaceSkillTreeFromEntries,
  resourceRecoveryPath,
  rollbackResourceRecovery,
  resolveSkillSource,
  scanAgents,
  scanExtensions,
  scanPrompts,
  setAgentDisabledFile,
  skillTreeFingerprint,
  skillTreeSnapshot,
  SkillTreeFingerprintError,
  writeAgentFile,
  writeBuiltinAgentOverride,
  writePromptFile,
  type ResourceRecovery,
  type ResourceRoots,
  type SkillTreeEntry,
  type SkillTreeSnapshot,
} from "@agent-deck/resources";
import { z } from "zod";
import {
  gitBlobAtCommit,
  gitHead,
  gitLsRemote,
  gitPullFfInto,
  gitRepoRelativePosixPath,
  gitResetHardTo,
  gitStatus,
} from "../git.ts";
import type { ImportedSkillRepository } from "../persistence.ts";
import {
  isPathInside,
  ManagedSkillRepositoryUnavailableError,
  normalizeGitRemote,
  sanitizedRepositoryFolder,
} from "../skillRepositories.ts";
import type { ServerContext } from "../context.ts";
// Legacy copied-skill-repo migration (removable — ADR-0002 P1a).
import {
  durableSyncDirectory,
  durableWriteJson,
  legacyTransactionJournalPath,
  legacyTransactionRoot,
  readLegacyTransaction,
  type LegacyTransactionJournal,
  type LegacyTransactionStep,
} from "../skills/legacySkillRepo.ts";
import { RESOURCE_NAME } from "./shared.ts";

const mergeIdFor = (merge: {
  name: string;
  localFingerprint: string;
  sourceFingerprint: string;
  mergeId?: string;
}): string =>
  merge.mergeId ??
  createHash("sha256")
    .update(`${merge.name}\0${merge.localFingerprint}\0${merge.sourceFingerprint}`)
    .digest("hex");

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

const writableCatalogScope = z
  .enum(["global", "project"])
  .refine((scope): boolean => scope === "global", "project resource catalogs are not supported");
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
 * A fallback catalog skill name for a repo's root SKILL.md that lacks a
 * frontmatter name: the last URL/path segment, sanitized to the name charset and
 * guaranteed to start alnum so a valid root skill is never silently skipped.
 */
function skillRepoName(cloneUrl: string): string {
  return (
    (
      cloneUrl
        .replace(/\.git$/, "")
        .replace(/[/\\]+$/, "")
        .split(/[/\\]/)
        .pop() || "repository"
    )
      .replace(/[^A-Za-z0-9._-]/g, "-")
      .replace(/^[^A-Za-z0-9]+/, "") || "repository"
  );
}

/** The dir to scan for skills — the clone, or a subdir GUARANTEED to stay inside
 *  it (a crafted/legacy `../…` subdir falls back to the clone root). */
function subdirScanPath(clonePath: string, subdir?: string): string {
  if (!subdir) return clonePath;
  const base = nodePath.resolve(clonePath);
  const resolved = nodePath.resolve(clonePath, subdir);
  return resolved === base || resolved.startsWith(base + nodePath.sep) ? resolved : clonePath;
}

function legacySourceRoots(clonePath: string, subdir: string | undefined, remoteUrl: string) {
  const scanDir = subdirScanPath(clonePath, subdir);
  const byName = new Map<string, string[]>();
  for (const skill of discoverImportSkillRoots(scanDir, skillRepoName(remoteUrl))) {
    const matches = byName.get(skill.name) ?? [];
    matches.push(skill.rootPath);
    byName.set(skill.name, matches);
  }
  return { scanDir, byName };
}

type MergeEntryState = "file" | "directory" | "missing";
type PreparedPathConflict = {
  path: string;
  local: MergeEntryState;
  remote: MergeEntryState;
};

function snapshotMap(snapshot: SkillTreeSnapshot): Map<string, SkillTreeEntry> {
  return new Map(snapshot.entries.map((entry) => [entry.relativePath, entry]));
}

function entryState(entry: SkillTreeEntry | undefined): MergeEntryState {
  return entry?.type ?? "missing";
}

function sameSnapshotEntry(
  left: SkillTreeEntry | undefined,
  right: SkillTreeEntry | undefined,
): boolean {
  if (!left || !right) return left === right;
  if (left.type !== right.type) return false;
  return (
    left.type === "directory" || left.content?.equals(right.content ?? Buffer.alloc(0)) === true
  );
}

/** Three-way payload merge. Conflicts keep local bytes as the safe default. */
function prepareThreeWayMerge(
  base: SkillTreeSnapshot,
  local: SkillTreeSnapshot,
  remote: SkillTreeSnapshot,
): { entries: SkillTreeEntry[]; conflicts: PreparedPathConflict[] } {
  const baseEntries = snapshotMap(base);
  const localEntries = snapshotMap(local);
  const remoteEntries = snapshotMap(remote);
  const paths = [
    ...new Set([...baseEntries.keys(), ...localEntries.keys(), ...remoteEntries.keys()]),
  ].sort();
  const conflictPaths = new Set<string>();
  const subtreeChanged = (entries: ReadonlyMap<string, SkillTreeEntry>, path: string): boolean => {
    const prefix = `${path}/`;
    return paths.some(
      (candidate) =>
        (candidate === path || candidate.startsWith(prefix)) &&
        !sameSnapshotEntry(entries.get(candidate), baseEntries.get(candidate)),
    );
  };
  for (const path of paths) {
    const before = baseEntries.get(path);
    const mine = localEntries.get(path);
    const theirs = remoteEntries.get(path);
    if (
      !sameSnapshotEntry(mine, before) &&
      !sameSnapshotEntry(theirs, before) &&
      !sameSnapshotEntry(mine, theirs)
    ) {
      conflictPaths.add(path);
    }
  }
  // Topology is an ancestor-level decision. If one side turns a directory
  // into a file/deletion while the other changes anything in that subtree,
  // choosing only a child could materialize a child beneath a file or retain
  // descendants beneath a deleted parent. Promote the conflict to the parent.
  for (const path of paths) {
    const mine = localEntries.get(path);
    const theirs = remoteEntries.get(path);
    if (
      entryState(mine) !== entryState(theirs) &&
      (mine?.type === "directory" || theirs?.type === "directory") &&
      subtreeChanged(localEntries, path) &&
      subtreeChanged(remoteEntries, path)
    ) {
      conflictPaths.add(path);
    }
  }
  // A type conflict owns its descendants. Keeping a remote child beneath a
  // local file (or vice versa) would otherwise create an incoherent tree.
  for (const parent of [...conflictPaths]) {
    const prefix = `${parent}/`;
    for (const path of paths) if (path.startsWith(prefix)) conflictPaths.add(path);
  }
  const merged: SkillTreeEntry[] = [];
  for (const path of paths) {
    const before = baseEntries.get(path);
    const mine = localEntries.get(path);
    const theirs = remoteEntries.get(path);
    const chosen = conflictPaths.has(path) ? mine : sameSnapshotEntry(mine, before) ? theirs : mine;
    if (chosen) merged.push(chosen);
  }
  const visibleConflicts = [...conflictPaths].filter((candidate) => {
    const parts = candidate.split("/");
    return !parts
      .slice(1)
      .some((_, index) => conflictPaths.has(parts.slice(0, index + 1).join("/")));
  });
  return {
    entries: merged,
    conflicts: visibleConflicts.sort().map((path) => ({
      path,
      local: entryState(localEntries.get(path)),
      remote: entryState(remoteEntries.get(path)),
    })),
  };
}

function chooseConflictEntries(
  local: SkillTreeSnapshot,
  remote: SkillTreeSnapshot,
  conflicts: readonly PreparedPathConflict[],
  choices: ReadonlyMap<string, "mine" | "remote">,
): SkillTreeEntry[] {
  const result = snapshotMap(local);
  const remoteEntries = snapshotMap(remote);
  for (const conflict of conflicts) {
    if ((choices.get(conflict.path) ?? "mine") === "mine") continue;
    const prefix = `${conflict.path}/`;
    for (const path of [...result.keys()]) {
      if (path === conflict.path || path.startsWith(prefix)) result.delete(path);
    }
    for (const [path, remoteEntry] of remoteEntries) {
      if (path === conflict.path || path.startsWith(prefix)) result.set(path, remoteEntry);
    }
  }
  return [...result.values()].sort((left, right) =>
    left.relativePath.localeCompare(right.relativePath),
  );
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
    skillReposRoot,
    managedSkillRepositories,
    managedSkillRepositoryStore,
    broadcast,
    resourceHome,
    rootsFor,
    skillStore,
    collectionSnapshotRoots,
    rebuildCollectionSnapshot,
    removeCollectionSnapshot,
    withRepositoryLock,
    watchSkillRoots,
    unwatchSkillRoots,
    extensionBridgeConflictAt,
  } = ctx;

  const transactionFile = (repositoryId: string): string =>
    legacyTransactionJournalPath(skillReposRoot, repositoryId);
  const transactionFingerprint = (name: string): string =>
    skillTreeSnapshot(nodePath.join(resourceHome(), ".pi", "agent", "skills", name), {
      reservedGit: "presence",
    }).fingerprint;
  const persistTransaction = (journal: LegacyTransactionJournal): void =>
    durableWriteJson(transactionFile(journal.repositoryId), journal);
  const finishTransaction = (journal: LegacyTransactionJournal): void => {
    rmSync(transactionFile(journal.repositoryId), { force: true });
    rmSync(journal.workspace, { recursive: true, force: true });
  };
  const rollbackTransaction = async (journal: LegacyTransactionJournal): Promise<void> => {
    journal.phase = "rolling-back";
    persistTransaction(journal);
    for (let index = journal.steps.length - 1; index >= 0; index -= 1) {
      const step = journal.steps[index]!;
      if (step.state === "rolled-back") continue;
      const current = transactionFingerprint(step.name);
      if (current === step.originalFingerprint) {
        step.state = "rolled-back";
        persistTransaction(journal);
        continue;
      }
      if (current !== step.installedFingerprint) {
        throw new ResourceCatalogCapabilityError(
          "RESOURCE_RECONCILE_INCOMPLETE",
          `Rollback refused because ${step.name} drifted; all trees and the journal were retained.`,
        );
      }
      rollbackResourceRecovery(
        resourceHome(),
        "global-skills",
        step.recoveryToken,
        step.installedPath,
        step.installedMissing,
        step.originalMissing,
      );
      if (transactionFingerprint(step.name) !== step.originalFingerprint) {
        throw new ResourceCatalogCapabilityError(
          "RESOURCE_RECONCILE_INCOMPLETE",
          `Rollback could not verify ${step.name}; all trees and the journal were retained.`,
        );
      }
      step.state = "rolled-back";
      persistTransaction(journal);
    }
    try {
      await gitResetHardTo(journal.clonePath, journal.baseCommit);
    } catch (cause) {
      const error = new ResourceCatalogCapabilityError(
        "RESOURCE_RECONCILE_INCOMPLETE",
        "Catalog rollback completed but the repository clone could not be restored.",
      );
      error.cause = cause;
      throw error;
    }
    finishTransaction(journal);
  };
  const reconcileTransaction = async (repositoryId: string): Promise<void> => {
    const file = transactionFile(repositoryId);
    if (!existsSync(file)) return;
    const journal = readLegacyTransaction(file);
    const root = nodePath.resolve(legacyTransactionRoot(skillReposRoot));
    const workspace = nodePath.resolve(journal.workspace);
    if (!workspace.startsWith(`${root}${nodePath.sep}`)) {
      throw new ResourceCatalogCapabilityError(
        "RESOURCE_RECONCILE_INCOMPLETE",
        "Transaction workspace escaped app data; retained evidence was not changed.",
      );
    }
    const persisted = settings
      .get()
      .importedSkillRepositories.find((item) => item.id === repositoryId);
    const settingsApplied =
      persisted?.lastSyncedCommit === journal.targetCommit &&
      (!journal.settingsSkillName ||
        (persisted.skillHashes?.[journal.settingsSkillName] === journal.settingsFingerprint &&
          !(persisted.pendingMerges ?? []).some(
            (merge) => merge.mergeId === journal.settingsPendingMergeId,
          )));
    if (journal.phase === "settings" && settingsApplied) {
      finishTransaction(journal);
      return;
    }
    await rollbackTransaction(journal);
  };

  fastify.addHook("onReady", async () => {
    const root = legacyTransactionRoot(skillReposRoot);
    if (!existsSync(root)) return;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/.test(entry.name)) continue;
      try {
        const journal = readLegacyTransaction(nodePath.join(root, entry.name));
        await reconcileTransaction(journal.repositoryId);
      } catch (error) {
        fastify.log.error(
          { err: error },
          "legacy skill transaction requires manual reconciliation",
        );
      }
    }
  });

  const resourceMutationFailure = (error: unknown): { status: number; error: string } => {
    if (error instanceof ManagedSkillRepositoryUnavailableError) return unavailableFailure;
    if (error instanceof SkillTreeFingerprintError) {
      return {
        status: 409,
        error: "The skill payload is unsafe, linked, special, or changed while it was being read.",
      };
    }
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
    return { status: 500, error: "The resource catalog operation failed." };
  };
  const sendResourceMutationFailure = (
    reply: { status(code: number): { send(body: { error: string }): unknown } },
    error: unknown,
  ): unknown => {
    const failure = resourceMutationFailure(error);
    return reply.status(failure.status).send({ error: failure.error });
  };

  const managedRepositoryPath = (candidate: string): string | undefined => {
    try {
      return managedSkillRepositories.validateRepository(candidate);
    } catch {
      return undefined;
    }
  };
  const managedCloneSkillRoot = (clonePath: string, candidate: string): string | undefined => {
    try {
      const safe =
        nodePath.resolve(candidate) === nodePath.resolve(clonePath)
          ? managedSkillRepositories.validateRepository(clonePath)
          : managedSkillRepositories.validatePath(candidate, { kind: "directory" });
      managedSkillRepositories.validatePath(nodePath.join(safe, "SKILL.md"), { kind: "file" });
      return isPathInside(clonePath, safe) ? safe : undefined;
    } catch {
      return undefined;
    }
  };
  const unavailableFailure = {
    status: 409,
    error:
      "This managed skill repository is unavailable because its stored path is outside the trusted SkillRepositories directory, linked, or changed. Restore the original directory and restart Agent Deck; the record was left unchanged.",
  };

  /**
   * Catalog roots for a repo record's scope. Null when the project it was
   * imported into is no longer registered (routes reply 400).
   */
  const rootsForRepoRecord = (record: ImportedSkillRepository): ResourceRoots | null => {
    if (record.scope !== "project") return rootsFor(undefined);
    const project = record.projectPath
      ? projects.find((p) => p.path === record.projectPath)
      : undefined;
    return project ? rootsFor(project.id) : null;
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

  // Import skills from a git repository (native SkillRepositorySync, import half):
  // shallow-clone to a temp dir, copy each SKILL.md-bearing directory into the
  // scope's catalog, then discard the clone. Push/update-sync is a follow-up.
  fastify.post("/resources/skills/import-git", async (request, reply) => {
    const parsed = z
      .object({
        projectId: z.string().optional(),
        scope: writableCatalogScope,
        url: z.string().trim().min(1).max(2000),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { projectId, scope, url } = parsed.data;
    const roots = rootsFor(projectId);
    if (scope === "project" && !roots.projectPath) {
      return reply.status(400).send({ error: "projectId required for project scope" });
    }
    // Accept the ways a user names a repo (native resolveSource): owner/repo, a
    // skills.sh link, an SSH remote, or a web tree URL (whose branch + path pin
    // the ref + subdir). A plain https URL still resolves to itself.
    const source = resolveSkillSource(url);
    if (!source) {
      return reply.status(400).send({ error: "Couldn't understand that repository reference." });
    }
    const repoName = skillRepoName(source.cloneUrl);
    const repoId = randomUUID();
    const collectionId = randomUUID();
    const cloneLeaf = sanitizedRepositoryFolder(source.cloneUrl);
    const clonePath = nodePath.join(skillReposRoot, cloneLeaf);
    let ownedLeaf: string | undefined;
    const cleanupOwned = (): void => {
      if (!ownedLeaf) return;
      try {
        managedSkillRepositoryStore.deleteRepository(ownedLeaf);
      } catch {
        // Fail closed: never substitute ambient recursive removal. A refused
        // cleanup remains quarantined/visible for manual recovery.
      }
      ownedLeaf = undefined;
    };
    try {
      const result = await withRepositoryLock(clonePath, async () => {
        managedSkillRepositories.validateRoot();
        let safeClonePath: string;
        let inspectedHead: string;
        if (existsSync(clonePath)) {
          const existing = managedRepositoryPath(clonePath);
          if (!existing) throw new Error("existing_repository_invalid");
          const alreadyRegistered = settings.get().importedSkillRepositories.some((record) => {
            if (record.storageMode !== "collection-v1") return false;
            try {
              return managedSkillRepositories.validateRepository(record.clonePath) === existing;
            } catch {
              return false;
            }
          });
          if (alreadyRegistered) throw new Error("repository_exists");
          let inspected: Awaited<ReturnType<typeof managedSkillRepositoryStore.inspectRepository>>;
          try {
            inspected = await managedSkillRepositoryStore.inspectRepository(cloneLeaf, source.ref);
          } catch {
            throw new Error("existing_repository_invalid");
          }
          const requestedRemote = normalizeGitRemote(source.cloneUrl);
          const existingRemote = normalizeGitRemote(inspected.origin, existing);
          if (!requestedRemote || !existingRemote || requestedRemote !== existingRemote) {
            throw new Error("existing_repository_origin_mismatch");
          }
          if (!inspected.refMatches) throw new Error("existing_repository_ref_mismatch");
          inspectedHead = inspected.head;
          safeClonePath = existing;
        } else {
          const cloned = await managedSkillRepositoryStore.cloneRepository(
            source.cloneUrl,
            source.ref,
            cloneLeaf,
          );
          ownedLeaf = cloneLeaf;
          inspectedHead = cloned.head;
          safeClonePath = managedSkillRepositories.validateRepository(clonePath);
        }
        const lexicalScanDir = subdirScanPath(safeClonePath, source.subdir);
        const scanDir =
          nodePath.resolve(lexicalScanDir) === nodePath.resolve(safeClonePath)
            ? managedSkillRepositories.validateRepository(safeClonePath)
            : managedSkillRepositories.validatePath(lexicalScanDir, { kind: "directory" });
        if (!isPathInside(safeClonePath, scanDir)) throw new Error("unsafe_collection_path");
        const selected = discoverSkillRoots(scanDir, (root) =>
          Boolean(managedCloneSkillRoot(safeClonePath, root)),
        ).map((skill) => ({
          ...skill,
          relativePath: nodePath.relative(safeClonePath, skill.rootPath),
        }));
        if (selected.length === 0) throw new Error("no_skills");
        const safeSelected = selected.flatMap((skill) => {
          const safeRoot = managedCloneSkillRoot(safeClonePath, skill.rootPath);
          return safeRoot ? [{ ...skill, rootPath: safeRoot }] : [];
        });
        if (safeSelected.length !== selected.length) throw new Error("unsafe_collection_path");
        managedSkillRepositories.validateRepository(safeClonePath);
        const displaySkillRoots = safeSelected.map((skill) => skill.rootPath);
        const imported = safeSelected.map((skill) => skill.name);
        const repoRecord: ImportedSkillRepository = {
          id: repoId,
          storageMode: "collection-v1",
          remoteUrl: source.cloneUrl,
          ref: source.ref,
          subdir: source.subdir,
          scope,
          clonePath: safeClonePath,
          skillNames: imported,
          selectedSkillRelativePaths: safeSelected.map((skill) => skill.relativePath),
          syncedSkillRelativePaths: safeSelected.map((skill) => skill.relativePath),
          skillRootPaths: [],
          collectionId,
          lastSyncedCommit: inspectedHead,
          importedAt: new Date().toISOString(),
        };
        managedSkillRepositories.deriveSkillRoots(repoRecord);
        const skillRootPaths = await rebuildCollectionSnapshot(repoRecord);
        repoRecord.skillRootPaths = skillRootPaths;
        settings.upsertSkillRepositoryCollection(repoRecord, {
          id: collectionId,
          name: repoName,
          repositoryId: repoId,
          skillRootPaths,
        });
        ownedLeaf = undefined;
        watchSkillRoots(displaySkillRoots);
        return { imported, skipped: [] as string[], repoId };
      });
      broadcast({ type: "resources_changed" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      cleanupOwned();
      if (message === "repository_exists" || message === "repository_busy") {
        return reply.status(409).send({ error: "That skill repository is already being managed." });
      }
      if (message === "existing_repository_invalid") {
        return reply.status(409).send({
          error: "The existing managed directory is not a valid Git clone with an origin remote.",
        });
      }
      if (message === "existing_repository_origin_mismatch") {
        return reply.status(409).send({
          error: "The existing managed clone belongs to a different origin remote.",
        });
      }
      if (message === "existing_repository_ref_mismatch") {
        return reply.status(409).send({
          error: "The requested ref does not resolve to the existing managed clone's HEAD.",
        });
      }
      if (message === "no_skills") {
        return reply.status(400).send({ error: "No SKILL.md found in that repository." });
      }
      if (
        message === "clone_failed" ||
        (error instanceof ResourceCatalogCapabilityError &&
          error.code === "RESOURCE_IO" &&
          !existsSync(clonePath))
      ) {
        return reply.status(400).send({
          error:
            "Couldn't clone that repository — check the URL (private repos aren't supported yet).",
        });
      }
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Imported skill repositories (native importedSkillRepositories) — the git repos
  // a user synced skills from, so the UI can offer re-sync + forget.
  fastify.get("/resources/skill-repos", async () => {
    return {
      repos: settings.get().importedSkillRepositories.map((r) => {
        let unavailable: { code: string; message: string } | undefined;
        if (r.storageMode === "collection-v1" && !collectionSnapshotRoots(r)) {
          unavailable = {
            code: "MANAGED_SKILL_REPOSITORY_UNAVAILABLE",
            message: unavailableFailure.error,
          };
        }
        return {
          id: r.id,
          remoteUrl: r.remoteUrl,
          ref: r.ref,
          scope: r.scope,
          storageMode: r.storageMode,
          skillNames: r.skillNames,
          skillRootPaths: r.skillRootPaths,
          selectedSkillRelativePaths: r.selectedSkillRelativePaths,
          syncedSkillRelativePaths: r.syncedSkillRelativePaths,
          lastSyncedCommit: r.lastSyncedCommit,
          importedAt: r.importedAt,
          pendingMerges:
            r.storageMode === "collection-v1"
              ? undefined
              : (r.pendingMerges ?? []).map((merge) => ({
                  ...merge,
                  mergeId: mergeIdFor(merge),
                })),
          available: unavailable === undefined,
          unavailable,
        };
      }),
    };
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
      return {
        path: resourceRecoveryPath(resourceHome(), "global-skills", parsed.data.token),
      };
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

  // Check a repo for updates (native checkForUpdate) — a network-only ls-remote,
  // compared against the last synced commit.
  fastify.post("/resources/skill-repos/:id/check", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = settings.get().importedSkillRepositories.find((r) => r.id === id);
    if (!record) return reply.status(404).send({ error: "unknown skill repository" });
    if (record.storageMode === "collection-v1" && !collectionSnapshotRoots(record)) {
      return reply.status(unavailableFailure.status).send({
        error: unavailableFailure.error,
        code: "MANAGED_SKILL_REPOSITORY_UNAVAILABLE",
      });
    }
    try {
      return await withRepositoryLock(record.id, async () => {
        if (record.storageMode === "collection-v1") {
          managedSkillRepositories.validateRepository(record.clonePath);
          await managedSkillRepositoryStore.inspectRepository(
            nodePath.basename(record.clonePath),
            record.ref,
          );
        }
        const remoteCommit = await gitLsRemote(record.remoteUrl, record.ref);
        if (record.storageMode === "collection-v1") {
          managedSkillRepositories.validateRepository(record.clonePath);
          await managedSkillRepositoryStore.inspectRepository(
            nodePath.basename(record.clonePath),
            record.ref,
          );
        }
        return {
          updateAvailable: remoteCommit !== null && remoteCommit !== record.lastSyncedCommit,
          // Distinguish "checked, up to date" from "couldn't reach the remote" so the
          // UI doesn't present a transient network failure as "all good".
          checkFailed: remoteCommit === null,
          remoteCommit,
          syncedCommit: record.lastSyncedCommit,
        };
      });
    } catch (error) {
      if (error instanceof ManagedSkillRepositoryUnavailableError) {
        return reply.status(unavailableFailure.status).send({
          error: unavailableFailure.error,
          code: "MANAGED_SKILL_REPOSITORY_UNAVAILABLE",
        });
      }
      if (error instanceof Error && error.message === "repository_busy") {
        return reply.status(409).send({ error: "That repository operation is already running." });
      }
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Update a repo (native update): fetch + ff the persistent clone, re-copy its
  // skills into the catalog (overwriting), and advance the synced commit.
  fastify.post("/resources/skill-repos/:id/update", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = settings.get().importedSkillRepositories.find((r) => r.id === id);
    if (!record) return reply.status(404).send({ error: "unknown skill repository" });
    if (record.scope === "project") {
      return reply
        .status(400)
        .send({ error: "Project-scoped skill repository catalogs are no longer writable." });
    }
    if (record.storageMode === "collection-v1") {
      if (!collectionSnapshotRoots(record)) {
        return reply.status(unavailableFailure.status).send({
          error: unavailableFailure.error,
          code: "MANAGED_SKILL_REPOSITORY_UNAVAILABLE",
        });
      }
      try {
        const result = await withRepositoryLock(record.id, async () => {
          const current = settings.get().importedSkillRepositories.find((item) => item.id === id);
          if (!current || current.storageMode !== "collection-v1") {
            throw new Error("repository_mode_changed");
          }
          const safeClonePath = managedSkillRepositories.validateRepository(current.clonePath);
          const cloneLeaf = nodePath.basename(safeClonePath);
          const previousRoots = managedSkillRepositories.deriveSkillRoots(current);
          const status = await managedSkillRepositoryStore.inspectRepository(
            cloneLeaf,
            current.ref,
          );
          if (!status.clean) throw new Error("repository_dirty");
          const updated = await managedSkillRepositoryStore.updateRepository(
            cloneLeaf,
            current.ref,
          );
          const newCommit = updated.head;
          managedSkillRepositories.validateRepository(safeClonePath);
          if (newCommit === current.lastSyncedCommit) {
            managedSkillRepositories.deriveSkillRoots(current);
            return {
              updated: false,
              commit: newCommit,
              imported: current.skillNames,
              conflicts: [],
            };
          }
          const selectedIntent = new Set(
            current.selectedSkillRelativePaths ?? current.syncedSkillRelativePaths ?? [],
          );
          const discovered = discoverSkillRoots(safeClonePath, (root) =>
            Boolean(managedCloneSkillRoot(safeClonePath, root)),
          ).flatMap((skill) => {
            const safeRoot = managedCloneSkillRoot(safeClonePath, skill.rootPath);
            return safeRoot
              ? [
                  {
                    ...skill,
                    rootPath: safeRoot,
                    relativePath: nodePath.relative(safeClonePath, safeRoot),
                  },
                ]
              : [];
          });
          const selected = discovered.filter((skill) => selectedIntent.has(skill.relativePath));
          const syncedSkillRelativePaths = selected.map((skill) => skill.relativePath);
          const next: ImportedSkillRepository = {
            ...current,
            skillRootPaths: [],
            selectedSkillRelativePaths: [...selectedIntent],
            syncedSkillRelativePaths,
            skillNames: selected.map((skill) => skill.name),
            lastSyncedCommit: newCommit,
          };
          const skillRootPaths = await rebuildCollectionSnapshot(next);
          next.skillRootPaths = skillRootPaths;
          const collectionId = current.collectionId;
          if (!collectionId) throw new Error("collection_missing");
          settings.upsertSkillRepositoryCollection(next, {
            id: collectionId,
            name: skillRepoName(current.remoteUrl),
            repositoryId: current.id,
            skillRootPaths,
          });
          const nextDisplayRoots = selected.map((skill) => skill.rootPath);
          const stillWatched = new Set(
            settings.get().importedSkillRepositories.flatMap((candidate) => {
              if (
                candidate.storageMode !== "collection-v1" ||
                !collectionSnapshotRoots(candidate)
              ) {
                return [];
              }
              try {
                return managedSkillRepositories.deriveSkillRoots(candidate);
              } catch {
                return [];
              }
            }),
          );
          await unwatchSkillRoots(previousRoots.filter((root) => !stillWatched.has(root)));
          watchSkillRoots(nextDisplayRoots);
          return {
            updated: true,
            commit: newCommit,
            imported: next.skillNames,
            conflicts: [] as string[],
          };
        });
        broadcast({ type: "resources_changed" });
        return result;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "repository_busy") {
          return reply.status(409).send({ error: "That repository operation is already running." });
        }
        if (
          message === "repository_dirty" ||
          (error instanceof ResourceCatalogCapabilityError && error.code === "RESOURCE_BUSY")
        ) {
          return reply.status(409).send({
            error:
              "The managed skill collection has local changes. Commit or discard them before updating.",
          });
        }
        return sendResourceMutationFailure(reply, error);
      }
    }
    try {
      const result = await withRepositoryLock(record.id, async () => {
        // Re-read under the lock: a preceding resolve may have changed the
        // fingerprints while this request was waiting to run. Recover an
        // interrupted legacy transaction before deriving any new snapshots.
        let currentRecord = settings
          .get()
          .importedSkillRepositories.find((candidate) => candidate.id === id);
        if (!currentRecord) throw new Error("unknown_repository");
        if (currentRecord.storageMode !== "collection-v1") {
          await reconcileTransaction(currentRecord.id);
          currentRecord = settings
            .get()
            .importedSkillRepositories.find((candidate) => candidate.id === id);
          if (!currentRecord) throw new Error("unknown_repository");
        }
        if (currentRecord.storageMode === "collection-v1") {
          throw new Error("repository_mode_changed");
        }
        if (!existsSync(currentRecord.clonePath)) {
          throw new Error("repository_clone_missing");
        }
        const roots = rootsForRepoRecord(currentRecord);
        if (!roots) throw new Error("repository_project_missing");

        // A process may have died after fetch/reset advanced the checkout but
        // before catalog metadata was persisted. The persisted commit remains
        // authoritative: restore it under the repository lock before deriving
        // any base snapshots, then retry the update normally.
        if ((await gitHead(currentRecord.clonePath)) !== currentRecord.lastSyncedCommit) {
          await gitResetHardTo(currentRecord.clonePath, currentRecord.lastSyncedCommit);
        }

        // Migrate old SKILL.md-only (or absent) baselines only from the persistent
        // clone while it is demonstrably the clean checkout of lastSyncedCommit.
        // The current catalog is never adopted as historical truth.
        const stored = { ...(currentRecord.skillHashes ?? {}) };
        const forcedConflicts = new Set<string>();
        const canonicalBaseSkill = new Map<string, Buffer>();
        const needsMigration = currentRecord.skillNames.some(
          (name) => !isSkillTreeFingerprint(stored[name]),
        );
        if (needsMigration) {
          const [head, status] = await Promise.all([
            gitHead(currentRecord.clonePath),
            gitStatus(currentRecord.clonePath),
          ]);
          let sourceRoots: ReturnType<typeof legacySourceRoots> | undefined;
          if (head === currentRecord.lastSyncedCommit && status.repo && status.clean) {
            try {
              sourceRoots = legacySourceRoots(
                currentRecord.clonePath,
                currentRecord.subdir,
                currentRecord.remoteUrl,
              );
            } catch {
              sourceRoots = undefined;
            }
          }
          for (const name of currentRecord.skillNames) {
            const old = stored[name];
            if (isSkillTreeFingerprint(old)) continue;
            const matches = sourceRoots?.byName.get(name);
            const sourceRoot = matches?.length === 1 ? matches[0] : undefined;
            if (sourceRoot) {
              try {
                const skillPath = gitRepoRelativePosixPath(
                  currentRecord.clonePath,
                  nodePath.join(sourceRoot, "SKILL.md"),
                );
                const canonicalSkill = await gitBlobAtCommit(
                  currentRecord.clonePath,
                  currentRecord.lastSyncedCommit,
                  skillPath,
                );
                const oldHashVerified =
                  old === undefined ||
                  createHash("sha256").update(canonicalSkill).digest("hex") === old;
                if (oldHashVerified) {
                  const checkoutFingerprint = skillTreeFingerprint(sourceRoot);
                  const canonicalFingerprint = skillTreeFingerprint(sourceRoot, {
                    canonicalFileContent: new Map([["SKILL.md", canonicalSkill]]),
                  });
                  let catalogFingerprint: string | undefined;
                  try {
                    catalogFingerprint = catalogSkillTreeFingerprint(
                      roots,
                      currentRecord.scope,
                      name,
                    );
                  } catch {
                    // The later conflict scan handles an unsafe or unreadable catalog tree.
                  }
                  stored[name] =
                    catalogFingerprint === checkoutFingerprint
                      ? checkoutFingerprint
                      : canonicalFingerprint;
                  if (stored[name] === canonicalFingerprint)
                    canonicalBaseSkill.set(name, canonicalSkill);
                  continue;
                }
              } catch {
                // An invalid path/blob or unreadable, linked, special, or raced source
                // cannot prove a baseline.
              }
            }
            forcedConflicts.add(name);
          }
        }

        if (forcedConflicts.size > 0) throw new Error("legacy_baseline_unavailable");
        const existingMerges = currentRecord.pendingMerges ?? [];
        if (existingMerges.length > 0) {
          return {
            updated: false,
            commit: currentRecord.lastSyncedCommit,
            conflicts: existingMerges.map((item) => item.name),
            mergeConflicts: existingMerges.map((merge) => ({
              ...merge,
              mergeId: mergeIdFor(merge),
            })),
          };
        }

        const remoteTip = await gitLsRemote(currentRecord.remoteUrl, currentRecord.ref);
        if (remoteTip === currentRecord.lastSyncedCommit) {
          return { updated: false, commit: currentRecord.lastSyncedCommit, conflicts: [] };
        }
        const catalogRoot = (name: string): string =>
          nodePath.join(resourceHome(), ".pi", "agent", "skills", name);
        const oldSources = legacySourceRoots(
          currentRecord.clonePath,
          currentRecord.subdir,
          currentRecord.remoteUrl,
        ).byName;
        const baseSnapshots = new Map<string, SkillTreeSnapshot>();
        const localSnapshots = new Map<string, SkillTreeSnapshot>();
        for (const name of currentRecord.skillNames) {
          const sourceMatches = oldSources.get(name) ?? [];
          const base =
            sourceMatches.length === 1
              ? skillTreeSnapshot(
                  sourceMatches[0]!,
                  canonicalBaseSkill.has(name)
                    ? {
                        canonicalFileContent: new Map([
                          ["SKILL.md", canonicalBaseSkill.get(name)!],
                        ]),
                      }
                    : undefined,
                )
              : { fingerprint: MISSING_SKILL_TREE_FINGERPRINT, entries: [] };
          if (base.fingerprint !== stored[name]) throw new Error("legacy_source_stale");
          baseSnapshots.set(name, base);
          const local = skillTreeSnapshot(catalogRoot(name), { reservedGit: "presence" });
          if (local.unsafeReservedGit) throw new Error("legacy_catalog_unsafe");
          localSnapshots.set(name, local);
        }

        const newCommit = await gitPullFfInto(currentRecord.clonePath, currentRecord.ref);
        if (newCommit === currentRecord.lastSyncedCommit) {
          return { updated: false, commit: newCommit, conflicts: [] };
        }
        let transaction: LegacyTransactionJournal | undefined;
        try {
          const sourceStatus = await gitStatus(currentRecord.clonePath);
          if (
            (await gitHead(currentRecord.clonePath)) !== newCommit ||
            !sourceStatus.repo ||
            !sourceStatus.clean
          ) {
            throw new Error("legacy_source_stale");
          }
          const newSources = legacySourceRoots(
            currentRecord.clonePath,
            currentRecord.subdir,
            currentRecord.remoteUrl,
          ).byName;
          const names = [...new Set([...currentRecord.skillNames, ...newSources.keys()])].sort();
          const skillHashes = { ...stored };
          const pendingMerges: NonNullable<ImportedSkillRepository["pendingMerges"]> = [];
          const recoveries: ResourceRecovery[] = [];
          const nextSkillNames = new Set(currentRecord.skillNames);
          const plans: Array<{
            name: string;
            local: SkillTreeSnapshot;
            remote: SkillTreeSnapshot;
            sourcePath?: string;
            prepared: ReturnType<typeof prepareThreeWayMerge>;
          }> = [];

          // Prepare every skill before touching the catalog. An unsafe link,
          // special entry, ambiguous source, or read race in any skill therefore
          // fails the repository update without a partial catalog mutation.
          for (const name of names) {
            const base =
              baseSnapshots.get(name) ??
              ({
                fingerprint: MISSING_SKILL_TREE_FINGERPRINT,
                entries: [],
              } satisfies SkillTreeSnapshot);
            const local =
              localSnapshots.get(name) ??
              skillTreeSnapshot(catalogRoot(name), { reservedGit: "presence" });
            if (local.unsafeReservedGit) throw new Error("legacy_catalog_unsafe");
            const sourceMatches = newSources.get(name) ?? [];
            if (sourceMatches.length > 1) throw new Error("legacy_source_ambiguous");
            const remote = sourceMatches[0]
              ? skillTreeSnapshot(sourceMatches[0])
              : ({
                  fingerprint: MISSING_SKILL_TREE_FINGERPRINT,
                  entries: [],
                } satisfies SkillTreeSnapshot);
            plans.push({
              name,
              local,
              remote,
              sourcePath: sourceMatches[0],
              prepared: prepareThreeWayMerge(base, local, remote),
            });
          }
          for (const plan of plans) {
            const { name, local, remote, sourcePath } = plan;
            // Reject local or source drift at the last practical boundary before
            // the first native atomic catalog replacement.
            if (
              skillTreeSnapshot(catalogRoot(name), { reservedGit: "presence" }).fingerprint !==
                local.fingerprint ||
              (sourcePath
                ? skillTreeSnapshot(sourcePath).fingerprint
                : MISSING_SKILL_TREE_FINGERPRINT) !== remote.fingerprint
            ) {
              throw new Error("legacy_merge_stale");
            }
          }
          const transactionId = randomUUID().replaceAll("-", "");
          const workspace = nodePath.join(
            legacyTransactionRoot(skillReposRoot),
            `${createHash("sha256").update(currentRecord.id).digest("hex")}-${transactionId}`,
          );
          mkdirSync(workspace, { recursive: true, mode: 0o700 });
          const transactionSteps: LegacyTransactionStep[] = plans.map((plan, index) => {
            const stepRoot = nodePath.join(workspace, String(index));
            const installedPath =
              plan.prepared.entries.length > 0 ? nodePath.join(stepRoot, "installed") : undefined;
            if (installedPath) {
              mkdirSync(installedPath, { recursive: true });
              durableMaterializeSkillTreeEntries(installedPath, plan.prepared.entries);
              durableSyncDirectory(nodePath.dirname(installedPath));
            }
            const nonce = createHash("sha256")
              .update(`${transactionId}:${index}`)
              .digest("hex")
              .slice(0, 32);
            return {
              name: plan.name,
              recoveryToken: `.agent-deck-resource-recovery-v1-${plan.name.length}-${plan.name}-${nonce}`,
              originalMissing: plan.local.entries.length === 0,
              originalFingerprint: plan.local.fingerprint,
              installedMissing: plan.prepared.entries.length === 0,
              installedFingerprint: plan.prepared.entries.length
                ? skillTreeFingerprint(installedPath!)
                : MISSING_SKILL_TREE_FINGERPRINT,
              installedPath,
              state: "pending",
            };
          });
          durableSyncDirectory(workspace);
          durableSyncDirectory(legacyTransactionRoot(skillReposRoot));
          durableSyncDirectory(skillReposRoot);
          if (
            process.env.AGENT_DECK_TEST === "1" &&
            process.env.AGENT_DECK_TEST_LEGACY_FAIL_AFTER_DURABLE_WORKSPACE === "1"
          ) {
            delete process.env.AGENT_DECK_TEST_LEGACY_FAIL_AFTER_DURABLE_WORKSPACE;
            throw new Error("injected_legacy_workspace_failure");
          }
          transaction = {
            version: 1,
            id: transactionId,
            repositoryId: currentRecord.id,
            clonePath: currentRecord.clonePath,
            baseCommit: currentRecord.lastSyncedCommit,
            targetCommit: newCommit,
            phase: "prepared",
            workspace,
            steps: transactionSteps,
          };
          persistTransaction(transaction);
          transaction.phase = "applying";
          persistTransaction(transaction);

          for (const [planIndex, { name, local, remote, prepared }] of plans.entries()) {
            const step = transaction.steps[planIndex]!;
            const recovery = replaceSkillTreeFromEntries(
              roots,
              currentRecord.scope,
              name,
              prepared.entries,
              local.entries,
              step.recoveryToken,
            );
            if (recovery) recoveries.push(recovery);
            if (
              process.env.AGENT_DECK_TEST === "1" &&
              process.env.AGENT_DECK_TEST_LEGACY_CRASH_AFTER_FIRST_APPLY === "1" &&
              planIndex === 0
            ) {
              delete process.env.AGENT_DECK_TEST_LEGACY_CRASH_AFTER_FIRST_APPLY;
              throw new Error("injected_legacy_crash");
            }
            step.state = "applied";
            persistTransaction(transaction);
            const mergedFingerprint = catalogSkillTreeFingerprint(roots, currentRecord.scope, name);
            skillHashes[name] = mergedFingerprint;
            if (prepared.entries.length === 0) nextSkillNames.delete(name);
            else nextSkillNames.add(name);
            if (
              process.env.AGENT_DECK_TEST === "1" &&
              process.env.AGENT_DECK_TEST_LEGACY_FAIL_AFTER_FIRST_APPLY === "1" &&
              planIndex === 0
            ) {
              delete process.env.AGENT_DECK_TEST_LEGACY_FAIL_AFTER_FIRST_APPLY;
              throw new Error("injected_legacy_apply_failure");
            }
            if (prepared.conflicts.length > 0) {
              pendingMerges.push({
                name,
                mergeId: randomUUID(),
                localFingerprint: mergedFingerprint,
                sourceFingerprint: remote.fingerprint,
                paths: prepared.conflicts,
              });
            }
          }
          const next: ImportedSkillRepository = {
            ...currentRecord,
            skillNames: [...nextSkillNames],
            skillHashes,
            pendingMerges,
            lastSyncedCommit: newCommit,
          };
          transaction.phase = "settings";
          persistTransaction(transaction);
          if (
            process.env.AGENT_DECK_TEST === "1" &&
            process.env.AGENT_DECK_TEST_LEGACY_FAIL_SETTINGS_WRITE === "1"
          ) {
            delete process.env.AGENT_DECK_TEST_LEGACY_FAIL_SETTINGS_WRITE;
            throw new Error("injected_legacy_settings_failure");
          }
          settings.upsertImportedSkillRepository(next);
          const committedTransaction = transaction;
          transaction = undefined;
          finishTransaction(committedTransaction);
          return {
            updated: true,
            commit: newCommit,
            imported: next.skillNames,
            conflicts: pendingMerges.map((item) => item.name),
            mergeConflicts: pendingMerges,
            recoveries,
          };
        } catch (error) {
          if (error instanceof Error && error.message === "injected_legacy_crash") throw error;
          if (transaction) {
            await rollbackTransaction(transaction);
          } else {
            try {
              await gitResetHardTo(currentRecord.clonePath, currentRecord.lastSyncedCommit);
            } catch (resetError) {
              const incomplete = new ResourceCatalogCapabilityError(
                "RESOURCE_RECONCILE_INCOMPLETE",
                "The repository update failed and its clone could not be restored for retry.",
              );
              incomplete.cause = resetError;
              throw incomplete;
            }
          }
          throw error;
        }
      });
      broadcast({ type: "resources_changed" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "repository_busy") {
        return reply.status(409).send({ error: "That repository operation is already running." });
      }
      if (message === "unknown_repository") {
        return reply.status(404).send({ error: "unknown skill repository" });
      }
      if (message === "repository_clone_missing") {
        return reply
          .status(400)
          .send({ error: "The clone is missing — re-import the repository." });
      }
      if (message === "repository_project_missing") {
        return reply.status(400).send({ error: "That project is no longer registered." });
      }
      if (message === "repository_mode_changed") {
        return reply.status(409).send({ error: "That repository changed while the update began." });
      }
      if (
        message === "legacy_baseline_unavailable" ||
        message === "legacy_source_stale" ||
        message === "legacy_source_ambiguous" ||
        message === "legacy_merge_stale" ||
        message === "legacy_catalog_unsafe"
      ) {
        return reply.status(409).send({
          error:
            "The local skill or repository source changed while preparing the merge. Nothing was applied; retry the update.",
        });
      }
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Resolve only the paths prepared by the three-way update. Omitted choices
  // default to Keep Mine; the former coarse whole-folder body is rejected.
  fastify.post("/resources/skill-repos/:id/refresh-merge", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z.object({ name: RESOURCE_NAME }).strict().safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid merge refresh" });
    try {
      const refreshed = await withRepositoryLock(id, async () => {
        await reconcileTransaction(id);
        const current = settings
          .get()
          .importedSkillRepositories.find((candidate) => candidate.id === id);
        if (!current || current.storageMode === "collection-v1")
          throw new Error("unknown_repository");
        const pending = current.pendingMerges?.find((item) => item.name === parsed.data.name);
        if (!pending) throw new Error("unknown_merge_conflict");
        if (
          (await gitHead(current.clonePath)) !== current.lastSyncedCommit ||
          !(await gitStatus(current.clonePath)).clean
        ) {
          throw new Error("legacy_source_stale");
        }
        const root = rootsForRepoRecord(current)!;
        const local = skillTreeSnapshot(
          nodePath.join(root.home, ".pi", "agent", "skills", parsed.data.name),
          { reservedGit: "presence" },
        );
        const sources =
          legacySourceRoots(current.clonePath, current.subdir, current.remoteUrl).byName.get(
            parsed.data.name,
          ) ?? [];
        if (sources.length > 1) throw new Error("legacy_source_ambiguous");
        const remote = sources[0]
          ? skillTreeSnapshot(sources[0])
          : ({
              fingerprint: MISSING_SKILL_TREE_FINGERPRINT,
              entries: [],
            } satisfies SkillTreeSnapshot);
        const localByPath = new Map(local.entries.map((entry) => [entry.relativePath, entry]));
        const remoteByPath = new Map(remote.entries.map((entry) => [entry.relativePath, entry]));
        const next = {
          ...pending,
          mergeId: randomUUID(),
          localFingerprint: local.fingerprint,
          sourceFingerprint: remote.fingerprint,
          paths: pending.paths.map((item) => ({
            path: item.path,
            local: entryState(localByPath.get(item.path)),
            remote: entryState(remoteByPath.get(item.path)),
          })),
        };
        settings.upsertImportedSkillRepository({
          ...current,
          pendingMerges: (current.pendingMerges ?? []).map((item) =>
            item.name === next.name ? next : item,
          ),
        });
        return next;
      });
      return { mergeConflict: refreshed };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "repository_busy" || message === "legacy_source_stale") {
        return reply.status(409).send({
          code: "LEGACY_MERGE_REFRESH_BLOCKED",
          error: "The repository source is not clean at its last synced commit.",
        });
      }
      if (message === "unknown_repository" || message === "unknown_merge_conflict") {
        return reply.status(404).send({ error: "merge conflict is no longer available" });
      }
      return sendResourceMutationFailure(reply, error);
    }
  });

  fastify.post("/resources/skill-repos/:id/resolve", async (request, reply) => {
    const { id } = request.params as { id: string };
    const parsed = z
      .object({
        name: RESOURCE_NAME,
        mergeId: z.string().min(1).max(128),
        choices: z.array(
          z.object({ path: z.string().min(1).max(4096), resolution: z.enum(["mine", "remote"]) }),
        ),
      })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const record = settings.get().importedSkillRepositories.find((r) => r.id === id);
    if (!record) return reply.status(404).send({ error: "unknown skill repository" });
    if (record.storageMode === "collection-v1") {
      return reply.status(400).send({ error: "In-place collections must be clean before update." });
    }
    if (record.scope === "project") {
      return reply
        .status(400)
        .send({ error: "Project-scoped skill repository catalogs are no longer writable." });
    }
    try {
      const result = await withRepositoryLock(record.id, async () => {
        await reconcileTransaction(record.id);
        const current = settings
          .get()
          .importedSkillRepositories.find((candidate) => candidate.id === id);
        if (!current) throw new Error("unknown_repository");
        if (current.storageMode === "collection-v1") throw new Error("repository_mode_changed");
        if (!existsSync(current.clonePath)) throw new Error("repository_clone_missing");
        const pending = current.pendingMerges?.find((item) => item.name === parsed.data.name);
        if (!pending) throw new Error("unknown_merge_conflict");
        if (parsed.data.mergeId !== mergeIdFor(pending)) throw new Error("legacy_merge_stale");
        const allowed = new Set(pending.paths.map((item) => item.path));
        const choices = new Map<string, "mine" | "remote">();
        for (const choice of parsed.data.choices) {
          if (!allowed.has(choice.path) || choices.has(choice.path))
            throw new Error("invalid_merge_choice");
          choices.set(choice.path, choice.resolution);
        }
        const catalogRoot = nodePath.join(
          resourceHome(),
          ".pi",
          "agent",
          "skills",
          parsed.data.name,
        );
        const local = skillTreeSnapshot(catalogRoot, { reservedGit: "presence" });
        if (local.unsafeReservedGit) throw new Error("legacy_catalog_unsafe");
        const sources =
          legacySourceRoots(current.clonePath, current.subdir, current.remoteUrl).byName.get(
            parsed.data.name,
          ) ?? [];
        if (sources.length > 1) throw new Error("legacy_source_ambiguous");
        const remote = sources[0]
          ? skillTreeSnapshot(sources[0])
          : ({
              fingerprint: MISSING_SKILL_TREE_FINGERPRINT,
              entries: [],
            } satisfies SkillTreeSnapshot);
        if (
          local.fingerprint !== pending.localFingerprint ||
          remote.fingerprint !== pending.sourceFingerprint ||
          (await gitHead(current.clonePath)) !== current.lastSyncedCommit ||
          !(await gitStatus(current.clonePath)).clean
        ) {
          throw new Error("legacy_merge_stale");
        }
        const entries = chooseConflictEntries(local, remote, pending.paths, choices);
        const transactionId = randomUUID().replaceAll("-", "");
        const workspace = nodePath.join(
          legacyTransactionRoot(skillReposRoot),
          `${createHash("sha256").update(current.id).digest("hex")}-${transactionId}`,
        );
        const installedPath =
          entries.length > 0 ? nodePath.join(workspace, "0", "installed") : undefined;
        if (installedPath) {
          mkdirSync(installedPath, { recursive: true });
          durableMaterializeSkillTreeEntries(installedPath, entries);
          durableSyncDirectory(nodePath.dirname(installedPath));
        } else {
          mkdirSync(workspace, { recursive: true, mode: 0o700 });
        }
        durableSyncDirectory(workspace);
        durableSyncDirectory(legacyTransactionRoot(skillReposRoot));
        durableSyncDirectory(skillReposRoot);
        const nonce = createHash("sha256").update(`${transactionId}:0`).digest("hex").slice(0, 32);
        let transaction: LegacyTransactionJournal | undefined = {
          version: 1,
          id: transactionId,
          repositoryId: current.id,
          clonePath: current.clonePath,
          baseCommit: current.lastSyncedCommit,
          targetCommit: current.lastSyncedCommit,
          settingsSkillName: parsed.data.name,
          settingsFingerprint: entries.length
            ? skillTreeFingerprint(installedPath!)
            : MISSING_SKILL_TREE_FINGERPRINT,
          settingsPendingMergeId: pending.mergeId,
          phase: "prepared",
          workspace,
          steps: [
            {
              name: parsed.data.name,
              recoveryToken: `.agent-deck-resource-recovery-v1-${parsed.data.name.length}-${parsed.data.name}-${nonce}`,
              originalMissing: local.entries.length === 0,
              originalFingerprint: local.fingerprint,
              installedMissing: entries.length === 0,
              installedFingerprint: entries.length
                ? skillTreeFingerprint(installedPath!)
                : MISSING_SKILL_TREE_FINGERPRINT,
              installedPath,
              state: "pending",
            },
          ],
        };
        persistTransaction(transaction);
        try {
          transaction.phase = "applying";
          persistTransaction(transaction);
          const recovery = replaceSkillTreeFromEntries(
            rootsForRepoRecord(current)!,
            current.scope,
            parsed.data.name,
            entries,
            local.entries,
            transaction.steps[0]!.recoveryToken,
          );
          transaction.steps[0]!.state = "applied";
          persistTransaction(transaction);
          const fingerprint = catalogSkillTreeFingerprint(
            rootsForRepoRecord(current)!,
            current.scope,
            parsed.data.name,
          );
          const remaining = (current.pendingMerges ?? []).filter(
            (item) => item.name !== parsed.data.name,
          );
          const skillNames =
            entries.length === 0
              ? current.skillNames.filter((name) => name !== parsed.data.name)
              : [...new Set([...current.skillNames, parsed.data.name])];
          transaction.phase = "settings";
          persistTransaction(transaction);
          if (
            process.env.AGENT_DECK_TEST === "1" &&
            process.env.AGENT_DECK_TEST_LEGACY_FAIL_RESOLVE_SETTINGS_WRITE === "1"
          ) {
            delete process.env.AGENT_DECK_TEST_LEGACY_FAIL_RESOLVE_SETTINGS_WRITE;
            throw new Error("injected_legacy_resolve_settings_failure");
          }
          settings.upsertImportedSkillRepository({
            ...current,
            skillNames,
            skillHashes: { ...(current.skillHashes ?? {}), [parsed.data.name]: fingerprint },
            pendingMerges: remaining,
          });
          const committed = transaction;
          transaction = undefined;
          finishTransaction(committed);
          return { ok: true, conflicts: remaining, recoveries: recovery ? [recovery] : [] };
        } catch (error) {
          if (transaction) await rollbackTransaction(transaction);
          throw error;
        }
      });
      broadcast({ type: "resources_changed" });
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message === "repository_busy" ||
        message === "legacy_merge_stale" ||
        message === "legacy_catalog_unsafe"
      ) {
        return reply.status(409).send({
          code: message === "legacy_merge_stale" ? "LEGACY_MERGE_STALE" : undefined,
          error:
            "The local skill or repository source changed. No conflict choices were applied; refresh the review and apply again.",
        });
      }
      if (message === "unknown_repository")
        return reply.status(404).send({ error: "unknown skill repository" });
      if (message === "unknown_merge_conflict" || message === "invalid_merge_choice") {
        return reply.status(400).send({ error: "Unknown or duplicate merge conflict path." });
      }
      if (message === "repository_clone_missing")
        return reply
          .status(400)
          .send({ error: "The clone is missing — re-import the repository." });
      if (message === "repository_mode_changed")
        return reply.status(409).send({ error: "That repository changed while resolve began." });
      return sendResourceMutationFailure(reply, error);
    }
  });

  // Explicit quarantine escape hatch: remove only unavailable collection-v1
  // metadata. This never validates, opens, renames, or deletes the clone path.
  fastify.delete("/resources/skill-repos/:id/record", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = settings
      .get()
      .importedSkillRepositories.find((candidate) => candidate.id === id);
    if (!record) return reply.status(404).send({ error: "unknown skill repository" });
    if (record.storageMode !== "collection-v1") {
      return reply
        .status(400)
        .send({ error: "Record-only removal is only available for managed collections." });
    }
    try {
      await withRepositoryLock(record.id, async () => {
        const current = settings
          .get()
          .importedSkillRepositories.find((candidate) => candidate.id === id);
        if (!current || current.storageMode !== "collection-v1") {
          throw new Error("repository_mode_changed");
        }
        if (collectionSnapshotRoots(current)) throw new Error("repository_available");
        if (!current.collectionId) throw new Error("collection_missing");
        // This touches only app-private snapshot storage. It never validates,
        // opens, renames, or removes the unavailable clone path.
        managedSkillRepositoryStore.deleteSnapshot(current.id);
        settings.removeSkillRepositoryCollection(current.id, current.collectionId);
        removeCollectionSnapshot(current.id);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "repository_busy") {
        return reply.status(409).send({ error: "That repository operation is already running." });
      }
      if (message === "repository_available") {
        return reply
          .status(409)
          .send({ error: "This repository is available; use Forget to remove its clone safely." });
      }
      return sendResourceMutationFailure(reply, error);
    }
    broadcast({ type: "resources_changed" });
    return { ok: true, removedRecordOnly: true };
  });

  // Forget a repo: drop the provenance record + the persistent clone. The skills
  // already copied into the catalog stay (they're independent copies).
  fastify.delete("/resources/skill-repos/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const record = settings.get().importedSkillRepositories.find((r) => r.id === id);
    if (!record) return reply.status(404).send({ error: "unknown skill repository" });
    if (record.storageMode === "collection-v1") {
      if (!collectionSnapshotRoots(record)) {
        return reply.status(unavailableFailure.status).send({
          error: unavailableFailure.error,
          code: "MANAGED_SKILL_REPOSITORY_UNAVAILABLE",
        });
      }
      try {
        await withRepositoryLock(record.id, async () => {
          const current = settings.get().importedSkillRepositories.find((item) => item.id === id);
          if (!current || current.storageMode !== "collection-v1") {
            throw new Error("repository_mode_changed");
          }
          const safeClonePath = managedSkillRepositories.validateRepository(current.clonePath);
          const skillRoots = managedSkillRepositories.deriveSkillRoots(current);
          if (!current.collectionId) throw new Error("collection_missing");
          managedSkillRepositories.validateRepository(safeClonePath);
          managedSkillRepositoryStore.deleteRepository(nodePath.basename(safeClonePath));
          managedSkillRepositoryStore.deleteSnapshot(current.id);
          settings.removeSkillRepositoryCollection(current.id, current.collectionId);
          removeCollectionSnapshot(current.id);
          const stillWatched = new Set(
            settings.get().importedSkillRepositories.flatMap((candidate) => {
              if (
                candidate.storageMode !== "collection-v1" ||
                !collectionSnapshotRoots(candidate)
              ) {
                return [];
              }
              try {
                return managedSkillRepositories.deriveSkillRoots(candidate);
              } catch {
                return [];
              }
            }),
          );
          await unwatchSkillRoots(skillRoots.filter((root) => !stillWatched.has(root)));
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === "repository_busy") {
          return reply.status(409).send({ error: "That repository operation is already running." });
        }
        return sendResourceMutationFailure(reply, error);
      }
      broadcast({ type: "resources_changed" });
      return { ok: true };
    }
    try {
      await withRepositoryLock(record.id, async () => {
        const currentRecord = settings
          .get()
          .importedSkillRepositories.find((candidate) => candidate.id === id);
        if (!currentRecord) throw new Error("unknown_repository");
        if (currentRecord.storageMode === "collection-v1") {
          throw new Error("repository_mode_changed");
        }
        try {
          rmSync(currentRecord.clonePath, { recursive: true, force: true, maxRetries: 5 });
        } catch {
          // Legacy semantics: clone removal is best-effort and copied skills stay.
        }
        settings.removeImportedSkillRepository(currentRecord.id);
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "repository_busy") {
        return reply.status(409).send({ error: "That repository operation is already running." });
      }
      if (message === "unknown_repository") {
        return reply.status(404).send({ error: "unknown skill repository" });
      }
      if (message === "repository_mode_changed") {
        return reply.status(409).send({ error: "That repository changed while forget began." });
      }
      return sendResourceMutationFailure(reply, error);
    }
    return { ok: true };
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
