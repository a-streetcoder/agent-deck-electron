import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync, renameSync } from "node:fs";
import nodePath from "node:path";
import {
  canRetryLoopRun,
  isLoopAvailableInProject,
  isLoopRunTerminal,
  isRunnableLoopStructure,
  loopAgentRoleLabel,
  loopRequiredAgentRoles,
  normalizeLoopLaunchContext,
  loopDefinitionValidationError,
  LOOP_AGENT_PREFLIGHT_CODE,
  LOOP_CURRENT_CHECKOUT_CONFIRMATION_CODE,
  LOOP_EVALUATOR_THINKING_LEVELS,
  LOOP_PARALLEL_WRITE_TARGET_CODE,
  LOOP_STRUCTURE_LABEL,
  LOOP_STRUCTURE_UNSUPPORTED_CODE,
  type LoopDefinition,
  type LoopStructure,
} from "@agent-deck/domain";
import {
  deleteLoopFile,
  duplicateLoop,
  LoopCatalogCapabilityError,
  LoopDefinitionInvalidError,
  LoopStructureNotRunnableError,
  scanLoops,
  writeLoopFile,
} from "@agent-deck/resources";
import type { ThinkingLevel } from "@agent-deck/pi-host";
import type { FastifyReply } from "fastify";
import { z } from "zod";
import {
  createLoopWorktree,
  gitApplyPatch,
  gitApplyPatchCheck,
  gitCommitOid,
  gitCurrentBranch,
  gitLoopWorktreePatch,
  gitOperationInProgress,
  gitRepositoryIdentity,
  gitWorkingTreeClean,
  gitWorktreePrune,
  gitWorktreeRegistrations,
  type GitWorktree,
  type OwnedLoopWorktreeProof,
} from "../git.ts";
import { SessionCreationError } from "../SessionManager.ts";
import { envDefaults, type ServerContext } from "../context.ts";
import { finalizeExtensions } from "./shared.ts";

export function canonicalCheckoutLockKey(
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): string {
  // realpath.native collapses symlink/junction aliases. Destructive execution
  // fails closed when the native canonical identity cannot be established.
  const canonical = realpathSync.native(candidate);
  if (platform === "win32") {
    return nodePath.win32.normalize(canonical.replaceAll("/", "\\")).toLocaleLowerCase("en-US");
  }
  return nodePath.normalize(canonical);
}

export function ensurePrivateLoopWorktreesRoot(worktreesRoot: string): string {
  const candidate = nodePath.join(worktreesRoot, "loop");
  mkdirSync(candidate, { recursive: true, mode: 0o700 });
  const before = lstatSync(candidate);
  if (!before.isDirectory() || before.isSymbolicLink()) {
    throw new Error("Loop worktree root must be an app-owned directory");
  }
  try {
    chmodSync(candidate, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
  const after = lstatSync(candidate);
  if (process.platform !== "win32" && (after.mode & 0o077) !== 0) {
    throw new Error("Loop worktree root permissions are not private");
  }
  const canonical = realpathSync.native(candidate);
  if (canonicalCheckoutLockKey(candidate) !== canonicalCheckoutLockKey(canonical)) {
    throw new Error("Loop worktree root could not be canonicalized safely");
  }
  return canonical;
}

function catalogCapabilityRefusal(error: unknown, reply: FastifyReply): FastifyReply | undefined {
  if (!(error instanceof LoopCatalogCapabilityError)) return undefined;
  return reply.status(409).send({
    code: "loop_catalog_capability_error",
    error: "The native Loop catalog safety boundary refused this filesystem operation.",
  });
}

function loopWorktreeBranch(loopName: string, ownershipId: string): string {
  return `agent-deck/loop-${loopName.replace(/[^A-Za-z0-9]+/g, "-")}-${ownershipId.slice(0, 8)}`;
}

function unsupportedStructureError(structure: LoopStructure): {
  code: typeof LOOP_STRUCTURE_UNSUPPORTED_CODE;
  error: string;
} {
  return {
    code: LOOP_STRUCTURE_UNSUPPORTED_CODE,
    error: `${LOOP_STRUCTURE_LABEL[structure]} loops are not available to run. Convert this loop to Single agent first.`,
  };
}

/**
 * Loop definitions (Bank CRUD) + the loop run engine routes. Moved verbatim
 * from server.ts.
 */
export interface LoopRouteTestDependencies {
  canonicalCheckoutLockKey: typeof canonicalCheckoutLockKey;
  createLoopWorktree: typeof createLoopWorktree;
  gitWorktreeRegistrations: typeof gitWorktreeRegistrations;
  gitCommitOid?: typeof gitCommitOid;
  gitCurrentBranch?: typeof gitCurrentBranch;
  gitRepositoryIdentity?: typeof gitRepositoryIdentity;
  gitLoopWorktreePatch?: typeof gitLoopWorktreePatch;
  gitWorkingTreeClean?: typeof gitWorkingTreeClean;
  gitOperationInProgress?: typeof gitOperationInProgress;
  gitApplyPatchCheck?: typeof gitApplyPatchCheck;
  gitApplyPatch?: typeof gitApplyPatch;
  gitWorktreePrune?: typeof gitWorktreePrune;
  /** Test seam around the single exact-entry atomic rename; production uses renameSync. */
  renameWorktree?: (source: string, destination: string) => void;
}

export function registerLoopRoutes(
  ctx: ServerContext,
  routeDependencies: LoopRouteTestDependencies = {
    canonicalCheckoutLockKey,
    createLoopWorktree,
    gitWorktreeRegistrations,
  },
): void {
  const {
    fastify,
    sessions,
    index,
    projects,
    loopEngine,
    bridgeTokens,
    broadcast,
    rootsFor,
    resolveNamedAgent,
    enabledExtensionPaths,
    worktreesRoot,
  } = ctx;
  const loopWorktreesRoot = ensurePrivateLoopWorktreesRoot(worktreesRoot);
  // Trust-boundary lock: at most one destructive Loop may own a canonical
  // checkout. Interrupted runs seed durable recovery locks before onReady.
  const checkoutLocks = new Map<
    string,
    { owner: string; kind: "active" | "recovery" | "review" }
  >();
  const worktreeOperationLocks = new Set<string>();
  for (const [key, runId] of loopEngine.recoveryCheckoutLocks()) {
    checkoutLocks.set(key, { owner: runId, kind: "recovery" });
  }

  const gitOps = {
    commitOid: routeDependencies.gitCommitOid ?? gitCommitOid,
    currentBranch: routeDependencies.gitCurrentBranch ?? gitCurrentBranch,
    repositoryIdentity: routeDependencies.gitRepositoryIdentity ?? gitRepositoryIdentity,
    patch: routeDependencies.gitLoopWorktreePatch ?? gitLoopWorktreePatch,
    clean: routeDependencies.gitWorkingTreeClean ?? gitWorkingTreeClean,
    operationInProgress: routeDependencies.gitOperationInProgress ?? gitOperationInProgress,
    applyCheck: routeDependencies.gitApplyPatchCheck ?? gitApplyPatchCheck,
    apply: routeDependencies.gitApplyPatch ?? gitApplyPatch,
    prune: routeDependencies.gitWorktreePrune ?? gitWorktreePrune,
    renameWorktree: routeDependencies.renameWorktree ?? renameSync,
  };

  type ValidatedLoopWorktree = {
    run: NonNullable<ReturnType<typeof loopEngine.get>>;
    ownership: OwnedLoopWorktreeProof & { baseCommit: string };
    projectRoot: string;
    worktreePath: string;
  };
  const validateOwnedWorktree = async (id: string): Promise<ValidatedLoopWorktree> => {
    const run = loopEngine.get(id);
    const ownership = run?.launch?.worktree as Partial<OwnedLoopWorktreeProof> | undefined;
    if (
      !run ||
      !isLoopRunTerminal(run.status) ||
      run.launch?.writeTarget !== "newWorktree" ||
      !ownership ||
      ownership.ownershipVersion !== 1 ||
      typeof ownership.ownershipId !== "string" ||
      !z.string().uuid().safeParse(ownership.ownershipId).success ||
      typeof ownership.projectRoot !== "string" ||
      typeof ownership.path !== "string" ||
      typeof ownership.branch !== "string" ||
      typeof ownership.sourceBranch !== "string" ||
      typeof ownership.baseCommit !== "string" ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(ownership.baseCommit) ||
      ownership.branchOwned !== true ||
      !run.projectId
    ) {
      throw new Error("loop_worktree_unavailable");
    }
    const project = projects.find((candidate) => candidate.id === run.projectId);
    if (!project) throw new Error("loop_worktree_unavailable");
    const rootStat = lstatSync(loopWorktreesRoot);
    if (
      !rootStat.isDirectory() ||
      rootStat.isSymbolicLink() ||
      (process.platform !== "win32" && (rootStat.mode & 0o077) !== 0)
    ) {
      throw new Error("loop_worktree_unavailable");
    }
    const projectRoot = routeDependencies.canonicalCheckoutLockKey(project.path);
    if (ownership.projectRoot !== projectRoot) throw new Error("loop_worktree_unavailable");
    const expectedBasename = `loop-${ownership.ownershipId}`;
    const expectedPath = nodePath.join(loopWorktreesRoot, expectedBasename);
    if (
      nodePath.basename(ownership.path) !== expectedBasename ||
      ownership.branch !== loopWorktreeBranch(run.loopName, ownership.ownershipId) ||
      routeDependencies.canonicalCheckoutLockKey(ownership.path) !==
        routeDependencies.canonicalCheckoutLockKey(expectedPath)
    ) {
      throw new Error("loop_worktree_unavailable");
    }
    const candidateStat = lstatSync(expectedPath);
    if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) {
      throw new Error("loop_worktree_unavailable");
    }
    const worktreePath = realpathSync.native(expectedPath);
    if (
      routeDependencies.canonicalCheckoutLockKey(ownership.path) !==
        routeDependencies.canonicalCheckoutLockKey(worktreePath) ||
      routeDependencies.canonicalCheckoutLockKey(nodePath.dirname(worktreePath)) !==
        routeDependencies.canonicalCheckoutLockKey(loopWorktreesRoot)
    ) {
      throw new Error("loop_worktree_unavailable");
    }
    const registrations = await routeDependencies.gitWorktreeRegistrations(projectRoot);
    if (
      !registrations.some(
        (entry) =>
          entry.branch === ownership.branch &&
          routeDependencies.canonicalCheckoutLockKey(entry.path) ===
            routeDependencies.canonicalCheckoutLockKey(worktreePath),
      )
    ) {
      throw new Error("loop_worktree_unavailable");
    }
    if (
      (await gitOps.repositoryIdentity(projectRoot)) !==
        (await gitOps.repositoryIdentity(worktreePath)) ||
      (await gitOps.currentBranch(worktreePath)) !== ownership.branch ||
      (await gitOps.commitOid(worktreePath, ownership.baseCommit)) !== ownership.baseCommit
    ) {
      throw new Error("loop_worktree_unavailable");
    }
    await gitOps.commitOid(worktreePath, `refs/heads/${ownership.branch}`);
    return {
      run,
      ownership: ownership as OwnedLoopWorktreeProof & { baseCommit: string },
      projectRoot,
      worktreePath,
    };
  };

  const validateArchivedWorktree = async (
    archivedPath: string,
    validated: ValidatedLoopWorktree,
  ): Promise<void> => {
    const archivedStat = lstatSync(archivedPath);
    // rename(2) moves a symlink directory entry, never its target. We still
    // refuse to prune after any same-user swap by validating the moved entry.
    if (!archivedStat.isDirectory() || archivedStat.isSymbolicLink()) {
      throw new Error("archived entry is not a real directory");
    }
    const canonicalArchive = realpathSync.native(archivedPath);
    if (
      routeDependencies.canonicalCheckoutLockKey(canonicalArchive) !==
        routeDependencies.canonicalCheckoutLockKey(archivedPath) ||
      routeDependencies.canonicalCheckoutLockKey(nodePath.dirname(canonicalArchive)) !==
        routeDependencies.canonicalCheckoutLockKey(loopWorktreesRoot)
    ) {
      throw new Error("archived entry is outside the private worktree root");
    }
    if (
      (await gitOps.repositoryIdentity(canonicalArchive)) !==
        (await gitOps.repositoryIdentity(validated.projectRoot)) ||
      (await gitOps.currentBranch(canonicalArchive)) !== validated.ownership.branch ||
      (await gitOps.commitOid(canonicalArchive, validated.ownership.baseCommit)) !==
        validated.ownership.baseCommit
    ) {
      throw new Error("archived entry does not match Loop ownership");
    }
    await gitOps.commitOid(canonicalArchive, `refs/heads/${validated.ownership.branch}`);
  };

  // Reconcile only transient parent sessions whose exact ownership was durably
  // recorded. Registered Loop worktrees and branches are review evidence and
  // are never removed automatically, including during startup recovery.
  fastify.addHook("onReady", async () => {
    for (const run of loopEngine.pendingResourceReconciliations()) {
      const launch = run.launch;
      if (!launch || launch.sessionReconciledAt) continue;
      try {
        await sessions.destroy(launch.sessionId);
        bridgeTokens.delete(launch.sessionId);
        loopEngine.markSessionReconciled(run.id);
      } catch (error) {
        fastify.log.warn({ err: error, runId: run.id }, "failed to reconcile Loop parent session");
      }
    }
  });

  // Loop definitions (native LoopDefinitionStore, Bank CRUD half — no run engine
  // yet). Global: loops live under ~/.pi/agent/loops.
  const loopEditBody = z.object({
    id: z.string().min(1).max(500).optional(),
    name: z.string().trim().min(1).max(200),
    description: z.string().max(2000).optional(),
    goal: z.string().max(50_000).optional(),
    structure: z
      .enum([
        "singleAgent",
        "makerChecker",
        "agentPipeline",
        "parallelAgents",
        "discoveryTriage",
        "humanApproval",
      ])
      .optional(),
    agentName: z.string().max(200).optional(),
    makerName: z.string().max(200).optional(),
    checkerName: z.string().max(200).optional(),
    checkerRubric: z.string().max(20_000).optional(),
    pipelineStages: z.array(z.string().max(200)).max(100).optional(),
    parallelBranches: z.array(z.string().max(200)).max(100).optional(),
    triageAgent: z.string().max(200).optional(),
    classificationPrompt: z.string().max(20_000).optional(),
    checkpointPrompt: z.string().max(20_000).optional(),
    launchContext: z.string().max(50_000).optional(),
    launchContextScope: z.enum(["firstIterationOnly", "everyIteration"]).optional(),
    maxIterations: z.number().int().optional(),
    validationCommand: z.string().max(10_000).optional(),
    successCondition: z.string().max(50_000).optional(),
    successConditionSource: z.enum(["goal", "custom"]).optional(),
    evaluatorProvider: z.string().max(500).optional(),
    evaluatorModel: z.string().max(500).optional(),
    evaluatorThinkingLevel: z
      .union([z.literal(""), z.enum(LOOP_EVALUATOR_THINKING_LEVELS)])
      .optional(),
    writeTarget: z.enum(["artifactMarkdown", "newWorktree", "currentCheckout"]).optional(),
    availability: z.enum(["allProjects", "projectPaths"]).optional(),
    projectPaths: z.array(z.string().max(10_000)).max(1_000).optional(),
  });

  fastify.get("/loops", async (_request, reply) => {
    try {
      return { loops: scanLoops(rootsFor()) };
    } catch (error) {
      return (
        catalogCapabilityRefusal(error, reply) ??
        reply.status(500).send({ error: "Loop catalog scan failed." })
      );
    }
  });

  fastify.put("/loops", async (request, reply) => {
    const parsed = loopEditBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const roots = rootsFor();
    let existing;
    try {
      existing = parsed.data.id
        ? scanLoops(roots).find((loop) => loop.id === parsed.data.id)
        : undefined;
    } catch (error) {
      return (
        catalogCapabilityRefusal(error, reply) ??
        reply.status(500).send({ error: "Loop catalog scan failed." })
      );
    }
    if (parsed.data.id && !existing) return reply.status(404).send({ error: "unknown loop" });
    if (parsed.data.availability === "projectPaths" && !parsed.data.projectPaths?.length) {
      return reply.status(422).send({
        code: "loop_definition_invalid",
        error: "Select at least one project for project-specific availability.",
      });
    }
    const resultingStructure = parsed.data.structure ?? existing?.structure ?? "singleAgent";
    if (!isRunnableLoopStructure(resultingStructure)) {
      return reply.status(422).send(unsupportedStructureError(resultingStructure));
    }
    try {
      writeLoopFile(roots, parsed.data);
    } catch (error) {
      const refused = catalogCapabilityRefusal(error, reply);
      if (refused) return refused;
      const message = error instanceof Error ? error.message : String(error);
      if (message === "loop_not_found") {
        return reply.status(404).send({ error: "unknown loop" });
      }
      if (message === "loop_slug_conflict") {
        return reply
          .status(409)
          .send({ error: "Another loop already uses a name that resolves to the same file." });
      }
      // Repeat the route contract if the persisted structure changed between
      // the optimistic scan above and the authoritative resource write.
      if (error instanceof LoopStructureNotRunnableError) {
        return reply.status(422).send(unsupportedStructureError(error.structure));
      }
      if (error instanceof LoopDefinitionInvalidError) {
        return reply.status(422).send({ code: error.code, error: error.message });
      }
      return reply.status(500).send({ error: message });
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  fastify.delete("/loops", async (request, reply) => {
    const parsed = z.object({ id: z.string().min(1).max(500) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    try {
      deleteLoopFile(rootsFor(), parsed.data.id);
    } catch (error) {
      return (
        catalogCapabilityRefusal(error, reply) ??
        reply.status(500).send({ error: "Loop catalog delete failed." })
      );
    }
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  fastify.post("/loops/:id/duplicate", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const roots = rootsFor();
    let source;
    try {
      source = scanLoops(roots).find((loop) => loop.id === id);
    } catch (error) {
      return (
        catalogCapabilityRefusal(error, reply) ??
        reply.status(500).send({ error: "Loop catalog scan failed." })
      );
    }
    if (!source) return reply.status(404).send({ error: "unknown loop" });
    if (!isRunnableLoopStructure(source.structure)) {
      return reply.status(422).send(unsupportedStructureError(source.structure));
    }
    try {
      const copyName = duplicateLoop(roots, id);
      broadcast({ type: "resources_changed" });
      return { name: copyName };
    } catch (error) {
      const refused = catalogCapabilityRefusal(error, reply);
      if (refused) return refused;
      const message = error instanceof Error ? error.message : String(error);
      if (message === "loop_not_found") {
        return reply.status(404).send({ error: "unknown loop" });
      }
      // The resource layer repeats the invariant to close direct-call and
      // check/use races. Preserve the same user-facing typed 422 contract if
      // the source changed after the route's initial scan.
      if (error instanceof LoopStructureNotRunnableError) {
        return reply.status(422).send(unsupportedStructureError(error.structure));
      }
      if (error instanceof LoopDefinitionInvalidError) {
        return reply.status(422).send({ code: error.code, error: error.message });
      }
      return reply.status(500).send({ error: message });
    }
  });

  // Run a supported Loop through a transient parent session. Maker+Checker
  // roles receive phase-specific capabilities; durable truth lives in run state.
  fastify.post("/loops/:id/run", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = z
      .object({
        projectId: z.string().optional(),
        retryOf: z.string().uuid().optional(),
        goal: z.string().max(50_000).optional(),
        launchContext: z.string().max(50_000).optional(),
        launchContextScope: z.enum(["firstIterationOnly", "everyIteration"]).optional(),
        successCondition: z.string().max(50_000).optional(),
        successConditionSource: z.enum(["goal", "custom"]).optional(),
        evaluatorProvider: z.string().max(500).optional(),
        evaluatorModel: z.string().max(500).optional(),
        evaluatorThinkingLevel: z
          .union([z.literal(""), z.enum(LOOP_EVALUATOR_THINKING_LEVELS)])
          .optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        extensions: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
        currentCheckoutConfirmed: z.boolean().optional(),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const body = parsed.data;
    if (!body.projectId) {
      return reply.status(400).send({ error: "projectId is required to run a loop" });
    }
    const project = projects.find((candidate) => candidate.id === body.projectId);
    if (!project) return reply.status(404).send({ error: "unknown project" });

    let loop: LoopDefinition;
    if (body.retryOf) {
      const previous = loopEngine.get(body.retryOf);
      if (
        !previous ||
        !canRetryLoopRun(previous) ||
        previous.projectId !== body.projectId ||
        previous.catalogId !== id ||
        !previous.definitionSnapshot
      ) {
        return reply.status(409).send({
          code: "loop_retry_unavailable",
          error: "The original effective Loop definition is unavailable for retry.",
        });
      }
      loop = {
        id,
        source: "user",
        availability: "allProjects",
        projectPaths: [],
        filePath: "",
        ...structuredClone(previous.definitionSnapshot),
      };
    } else {
      try {
        const found = scanLoops(rootsFor()).find((candidate) => candidate.id === id);
        if (!found) return reply.status(404).send({ error: "unknown loop" });
        loop = found;
      } catch (error) {
        return (
          catalogCapabilityRefusal(error, reply) ??
          reply.status(500).send({ error: "Loop catalog scan failed." })
        );
      }
      // Availability is exact registered-project metadata only. It is checked
      // before lock, worktree, session, child, or Pi allocation.
      if (!isLoopAvailableInProject(loop, project.path)) {
        return reply.status(403).send({
          code: "loop_unavailable_for_project",
          error: "This Loop is not assigned to the selected project.",
        });
      }
    }

    if (!body.retryOf) {
      loop = {
        ...loop,
        goal: body.goal ?? loop.goal,
        launchContext:
          body.launchContext === undefined
            ? loop.launchContext
            : normalizeLoopLaunchContext(body.launchContext),
        launchContextScope: body.launchContextScope ?? loop.launchContextScope,
        successConditionSource:
          body.successConditionSource ??
          (body.successCondition !== undefined
            ? "custom"
            : (loop.successConditionSource ?? "goal")),
        successCondition:
          body.successConditionSource === "goal" ||
          (body.successCondition === undefined &&
            (loop.successConditionSource ?? "goal") === "goal")
            ? (body.goal ?? loop.goal)
            : body.successCondition === undefined
              ? loop.successCondition
              : body.successCondition.trim() || (body.goal ?? loop.goal),
        evaluatorProvider:
          body.evaluatorModel === undefined
            ? loop.evaluatorProvider
            : body.evaluatorModel.trim()
              ? body.evaluatorProvider?.trim() || undefined
              : undefined,
        evaluatorModel:
          body.evaluatorModel === undefined
            ? loop.evaluatorModel
            : body.evaluatorModel.trim() || undefined,
        evaluatorThinkingLevel:
          body.evaluatorThinkingLevel === undefined
            ? loop.evaluatorThinkingLevel
            : body.evaluatorThinkingLevel.trim() || undefined,
      };
    }
    if (!isRunnableLoopStructure(loop.structure)) {
      return reply.status(422).send(unsupportedStructureError(loop.structure));
    }
    if (loop.structure === "parallelAgents" && loop.writeTarget !== "artifactMarkdown") {
      return reply.status(422).send({
        code: LOOP_PARALLEL_WRITE_TARGET_CODE,
        error: "Parallel agents are report-only and require the Artifact (markdown) write target.",
      });
    }
    if (
      loop.evaluatorThinkingLevel &&
      !LOOP_EVALUATOR_THINKING_LEVELS.includes(
        loop.evaluatorThinkingLevel as (typeof LOOP_EVALUATOR_THINKING_LEVELS)[number],
      )
    ) {
      return reply.status(422).send({
        code: "loop_definition_invalid",
        error: `Evaluator thinking level "${loop.evaluatorThinkingLevel}" is unavailable.`,
      });
    }
    const requiredRoles = loopRequiredAgentRoles(loop);
    const agentIssues = requiredRoles.flatMap((role) => {
      if (!role.agentName) return [{ ...role, reason: "missing" as const }];
      const resolved = resolveNamedAgent(role.agentName, body.projectId);
      return resolved.status === "ok"
        ? []
        : [
            {
              ...role,
              reason: resolved.status === "disabled" ? ("disabled" as const) : ("missing" as const),
            },
          ];
    });
    if (agentIssues.length) {
      const summary = agentIssues
        .map(
          (issue) =>
            `${loopAgentRoleLabel(issue)}: ${issue.agentName ? `"${issue.agentName}"` : "no agent selected"} (${issue.reason})`,
        )
        .join("; ");
      return reply.status(422).send({
        code: LOOP_AGENT_PREFLIGHT_CODE,
        error: `Required Loop agents are unavailable. ${summary}`,
        issues: agentIssues,
      });
    }
    const definitionError = loopDefinitionValidationError(loop);
    if (definitionError) {
      return reply.status(422).send({ code: "loop_definition_invalid", error: definitionError });
    }
    if (loop.writeTarget === "currentCheckout" && body.currentCheckoutConfirmed !== true) {
      return reply.status(422).send({
        code: LOOP_CURRENT_CHECKOUT_CONFIRMATION_CODE,
        error: "Confirm that this Loop may run in the current project checkout.",
      });
    }
    const defaults = envDefaults();
    // A native Human Approval run is a durable app-data checkpoint only. It
    // never allocates a Pi session, child, validation process, checkout lock,
    // or worktree, regardless of the saved write target.
    if (loop.structure === "humanApproval") {
      let run: ReturnType<typeof loopEngine.start> | undefined;
      try {
        run = loopEngine.start(loop, project.path, {
          projectId: body.projectId,
          retryOf: body.retryOf,
        });
        return reply.status(201).send({ run, worktree: null });
      } catch (error) {
        if (run) loopEngine.rollbackStart(run.id);
        return reply.status(500).send({
          code: "loop_start_failed",
          error: `The approval checkpoint couldn't be recorded safely: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    let checkoutLockKey: string | undefined;
    if (loop.writeTarget === "currentCheckout") {
      try {
        checkoutLockKey = routeDependencies.canonicalCheckoutLockKey(project.path);
      } catch {
        const error =
          "The project checkout could not be identified safely. No agent resources were allocated.";
        const run = loopEngine.recordFailedStart(
          loop,
          project.path,
          "unsafeWriteTarget",
          error,
          body.projectId,
        );
        return reply.status(409).send({
          code: "loop_checkout_canonicalization_failed",
          error,
          run,
        });
      }
    }
    const existingLock = checkoutLockKey ? checkoutLocks.get(checkoutLockKey) : undefined;
    if (existingLock) {
      return reply.status(409).send(
        existingLock.kind === "recovery"
          ? {
              code: "loop_checkout_recovery_required",
              runId: existingLock.owner,
              error:
                "An interrupted Loop still protects this checkout. Ensure no old agent remains, then acknowledge the interrupted run to unlock it.",
            }
          : {
              code: "loop_checkout_busy",
              error: "Another Loop is already running in this project checkout.",
            },
      );
    }
    const lockOwner = randomUUID();
    if (checkoutLockKey) checkoutLocks.set(checkoutLockKey, { owner: lockOwner, kind: "active" });
    let lockReleased = false;
    const releaseCheckoutLock = (): void => {
      if (lockReleased || !checkoutLockKey) return;
      lockReleased = true;
      if (checkoutLocks.get(checkoutLockKey)?.owner === lockOwner)
        checkoutLocks.delete(checkoutLockKey);
    };
    // writeTarget "newWorktree": run the loop in an isolated git worktree on a
    // fresh branch off the current one (native PiAgentSessionWorktreeService), so
    // the agent's work never touches the main checkout. Once registered, both the
    // worktree and branch are retained as durable review evidence.
    let cwd = project.path;
    let worktree: GitWorktree | null = null;
    let worktreeOwnership: OwnedLoopWorktreeProof | null = null;
    if (loop.writeTarget === "newWorktree") {
      const ownershipId = randomUUID();
      const target = nodePath.join(loopWorktreesRoot, `loop-${ownershipId}`);
      const branch = loopWorktreeBranch(loop.name, ownershipId);
      try {
        worktree = await routeDependencies.createLoopWorktree(project.path, target, branch);
        worktreeOwnership = {
          ownershipVersion: 1,
          ownershipId,
          projectRoot: routeDependencies.canonicalCheckoutLockKey(project.path),
          path: worktree.path,
          branch: worktree.branch,
          sourceBranch: worktree.sourceBranch,
          baseCommit: worktree.baseCommit,
          branchOwned: true,
        };
        cwd = target;
      } catch (error) {
        releaseCheckoutLock();
        const summary = `Couldn't establish a safe worktree for this Loop: ${error instanceof Error ? error.message : String(error)}`;
        const run = loopEngine.recordFailedStart(
          loop,
          project.path,
          "unsafeWriteTarget",
          summary,
          body.projectId,
        );
        return reply.status(400).send({ code: "loop_unsafe_write_target", error: summary, run });
      }
    }
    // Default to the configured default + provider-registration extensions so a
    // plain run (just a projectId) still has its model provider registered.
    const baseExtensions = body.extensions ?? [
      ...(defaults.extensions ?? []),
      ...(defaults.providerExtensions ?? []),
    ];
    const finalizedBase = finalizeExtensions([
      ...baseExtensions,
      ...enabledExtensionPaths(body.projectId),
    ]);
    // Allocate the durable run identity before the parent session so retained
    // worktree sessions carry an explicit, server-owned review marker from their
    // first persisted metadata snapshot.
    const loopReviewRunId = worktree ? randomUUID() : undefined;
    let parent: ReturnType<typeof sessions.create> | undefined;
    let run: ReturnType<typeof loopEngine.start> | undefined;
    let announcementAttempted = false;
    let stopSnapshotTracking: (() => void) | undefined;
    try {
      parent = sessions.create({
        cwd,
        projectId: body.projectId,
        ...(worktree ? { worktree, loopReviewRunId } : {}),
        env: { ...defaults.env, ...body.env },
        plan: {
          kind: "parent",
          provider: body.provider ?? defaults.provider,
          model: body.model ?? defaults.model,
          extensions: finalizedBase.length > 0 ? finalizedBase : undefined,
        },
        // The transient parent becomes externally visible only after the engine
        // has accepted the run, giving startup a rollback-safe commit point.
        deferAnnouncement: true,
      });
      // A Loop has no independent pre-allocation model catalog. Validate against
      // the exact transient parent Pi session after allocation, but before the
      // engine can dispatch maker/stage/branch work.
      if (loop.evaluatorModel) {
        const availableModels = await parent.getAvailableModels();
        const evaluatorProvider = loop.evaluatorProvider ?? body.provider ?? defaults.provider;
        if (
          !availableModels.some(
            (model) => model.provider === evaluatorProvider && model.id === loop.evaluatorModel,
          )
        ) {
          throw new Error(
            `Evaluator model "${evaluatorProvider}/${loop.evaluatorModel}" is unavailable.`,
          );
        }
      }
      run = loopEngine.start(loop, cwd, {
        ...(loopReviewRunId ? { runId: loopReviewRunId } : {}),
        projectId: body.projectId,
        retryOf: body.retryOf,
        launch: {
          sessionId: parent.meta.id,
          writeTarget: loop.writeTarget,
          checkoutLockKey,
          ...(worktreeOwnership ? { worktree: worktreeOwnership } : {}),
        },
        executeRole: ({ prompt, agentName, phase, provider, model, thinking }) => {
          const toolPolicy =
            phase === "evaluator"
              ? "none"
              : phase === "checker" || loop.writeTarget === "artifactMarkdown"
                ? "readOnly"
                : "configured";
          const overrides =
            provider || model || thinking
              ? { provider, model, thinking: thinking as ThinkingLevel | undefined }
              : undefined;
          return overrides
            ? sessions.runSubagent(
                parent!.meta.id,
                prompt,
                agentName || undefined,
                toolPolicy,
                overrides,
              )
            : sessions.runSubagent(parent!.meta.id, prompt, agentName || undefined, toolPolicy);
        },
        cancel: () => sessions.destroy(parent!.meta.id),
      });
      parent.meta.title = `Loop: ${loop.name} · ${run.id.slice(0, 8)}`;
      parent.meta.agentName = `Loop · ${loop.name}`;
      announcementAttempted = true;
      sessions.announceCreated(parent);
      stopSnapshotTracking = sessions.trackLoopSession?.(parent.meta.id);
    } catch (error) {
      if (run) {
        void loopEngine.stop(run.id);
        // start() may already have dispatched executeAgent. Wait for that run to
        // reach its terminal state before closing the parent/worktree it owns.
        // The normal settled-finally path is installed only after announcement
        // succeeds below, so rollback remains exactly once.
        await loopEngine.settled(run.id).catch((cleanupError) => {
          fastify.log.warn({ err: cleanupError }, "failed waiting for Loop startup rollback");
        });
        loopEngine.rollbackStart(run.id);
      }
      if (parent) await sessions.destroy(parent.meta.id).catch(() => {});
      else if (error instanceof SessionCreationError) await error.cleanup;
      const partialId =
        parent?.meta.id ?? (error instanceof SessionCreationError ? error.sessionId : undefined);
      if (partialId) {
        bridgeTokens.delete(partialId);
        sessions.removeLoopSessionSnapshot?.(partialId);
      }
      if (announcementAttempted && parent) {
        const owned = parent.meta;
        const indexed = index.find((meta) => meta.id === owned.id);
        if (
          indexed &&
          indexed.createdAt === owned.createdAt &&
          indexed.cwd === owned.cwd &&
          indexed.projectId === owned.projectId
        ) {
          index.remove(owned.id);
          broadcast({ type: "session_removed", sessionId: owned.id });
        }
      }
      // Once Git has registered a Loop worktree, retain both it and its branch
      // even if later startup fails. They may contain review evidence, and no
      // recursive/path-based cleanup is safe against same-user rename races.
      releaseCheckoutLock();
      const retainedReview = worktreeOwnership
        ? ` Registered review worktree retained at ${worktreeOwnership.path} on branch ${worktreeOwnership.branch}.`
        : "";
      const detail = error instanceof Error ? error.message : String(error);
      let failedRun: ReturnType<typeof loopEngine.recordFailedStart> | undefined;
      try {
        failedRun = loopEngine.recordFailedStart(
          loop,
          cwd,
          "toolFailed",
          `The Loop couldn't be started safely: ${detail}`,
          body.projectId,
          worktreeOwnership && partialId
            ? {
                sessionId: partialId,
                writeTarget: loop.writeTarget,
                worktree: worktreeOwnership,
                sessionReconciledAt: new Date().toISOString(),
              }
            : undefined,
        );
      } catch (auditError) {
        fastify.log.error({ err: auditError }, "failed to persist Loop startup failure audit");
      }
      return reply.status(500).send({
        code: "loop_start_failed",
        error: `The Loop couldn't be started safely.${retainedReview} Fix the launch error and try again: ${detail}`,
        ...(failedRun ? { run: failedRun } : {}),
      });
    }
    // Reconcile only the transient parent after settlement. A registered Loop
    // worktree and branch remain durable review evidence at launch.worktree.
    void loopEngine.settled(run.id).finally(async () => {
      try {
        await sessions.destroy(parent.meta.id);
        bridgeTokens.delete(parent.meta.id);
        loopEngine.markSessionReconciled(run.id);
      } catch (cleanupError) {
        fastify.log.warn({ err: cleanupError }, "failed to reconcile settled Loop parent");
      } finally {
        stopSnapshotTracking?.();
        releaseCheckoutLock();
      }
    });
    return reply.status(201).send({ run, worktree });
  });

  fastify.get("/loops/runs", async () => ({ runs: loopEngine.list() }));

  fastify.get("/loops/runs/:id", async (request, reply) => {
    const run = loopEngine.get((request.params as { id: string }).id);
    if (!run) return reply.status(404).send({ error: "unknown loop run" });
    return { run };
  });

  const worktreeUnavailable = (reply: FastifyReply): FastifyReply =>
    reply.status(409).send({
      code: "loop_worktree_unavailable",
      error: "The retained Loop worktree is unavailable for review.",
    });

  // Electron main receives only an opaque run id. The backend is the sole path authority.
  fastify.get("/loops/runs/:id/worktree-directory", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!loopEngine.get(id)) return reply.status(404).send({ error: "unknown loop run" });
    try {
      const validated = await validateOwnedWorktree(id);
      return { directory: validated.worktreePath };
    } catch {
      return worktreeUnavailable(reply);
    }
  });

  fastify.get("/loops/runs/:id/review", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!loopEngine.get(id)) return reply.status(404).send({ error: "unknown loop run" });
    if (worktreeOperationLocks.has(id)) {
      return reply
        .status(409)
        .send({ code: "loop_review_busy", error: "A worktree decision is already in progress." });
    }
    worktreeOperationLocks.add(id);
    try {
      const validated = await validateOwnedWorktree(id);
      const review = loopEngine.ensureWorktreeReviewAvailable(id);
      if (review.status !== "available") {
        return reply.status(409).send({
          code: "loop_review_unavailable",
          error: "This worktree is no longer available for review.",
        });
      }
      const generated = await gitOps.patch(validated.worktreePath, validated.ownership.baseCommit);
      const hash = createHash("sha256").update(generated.bytes).digest("hex");
      const saved = loopEngine.saveWorktreePatch(id, generated.bytes, hash, generated.changedFiles);
      const previewLimit = 240_000;
      const patch = generated.bytes.subarray(0, previewLimit).toString("utf8");
      return {
        run: loopEngine.get(id),
        review: saved,
        patch,
        patchTruncated: generated.bytes.length > previewLimit,
        changedFiles: generated.changedFiles,
      };
    } catch (error) {
      if (error instanceof Error && error.message === "loop_patch_too_large") {
        return reply.status(413).send({
          code: "loop_patch_too_large",
          error: "The worktree patch exceeds the safe review limit.",
        });
      }
      return worktreeUnavailable(reply);
    } finally {
      worktreeOperationLocks.delete(id);
    }
  });

  const decisionBody = z.object({
    confirmed: z.literal(true),
    expectedUpdatedAt: z.string().min(1),
  });

  fastify.post("/loops/runs/:id/apply", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = decisionBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    if (!loopEngine.get(id)) return reply.status(404).send({ error: "unknown loop run" });
    if (worktreeOperationLocks.has(id)) {
      return reply
        .status(409)
        .send({ code: "loop_review_busy", error: "A worktree decision is already in progress." });
    }
    worktreeOperationLocks.add(id);
    let projectLockKey: string | undefined;
    let applyingUpdatedAt: string | undefined;
    try {
      const validated = await validateOwnedWorktree(id);
      projectLockKey = routeDependencies.canonicalCheckoutLockKey(validated.projectRoot);
      if (checkoutLocks.has(projectLockKey)) {
        return reply
          .status(409)
          .send({ code: "loop_checkout_busy", error: "The project checkout is busy." });
      }
      checkoutLocks.set(projectLockKey, { owner: id, kind: "review" });
      const current = loopEngine.ensureWorktreeReviewAvailable(id);
      if (current.status !== "available") {
        return reply.status(409).send({
          code: "loop_review_unavailable",
          error: "This worktree is no longer available to apply.",
        });
      }
      if (
        !(await gitOps.clean(validated.projectRoot)) ||
        (await gitOps.operationInProgress(validated.projectRoot)) ||
        (await gitOps.currentBranch(validated.projectRoot)) !== validated.ownership.sourceBranch
      ) {
        return reply.status(409).send({
          code: "loop_apply_preflight_failed",
          error: "The project checkout must be clean, idle, and on the recorded source branch.",
        });
      }
      // Applying is a decision on bytes the user actually reviewed. Generate a
      // fixed in-memory candidate while holding the operation lock, but never
      // replace the persisted reviewed hash on a stale or direct apply request.
      const generated = await gitOps.patch(validated.worktreePath, validated.ownership.baseCommit);
      const hash = createHash("sha256").update(generated.bytes).digest("hex");
      if (!current.patchHash || hash !== current.patchHash) {
        return reply.status(409).send({
          code: "loop_worktree_changed",
          error:
            "The Loop worktree changed after review. Review the latest changes before applying.",
          run: loopEngine.get(id),
        });
      }
      let run;
      try {
        run = loopEngine.transitionWorktreeReview(id, parsed.data.expectedUpdatedAt, "applying");
      } catch {
        return reply.status(409).send({
          code: "loop_review_conflict",
          error: "The run changed; reload before applying.",
        });
      }
      applyingUpdatedAt = run.review!.updatedAt;
      // The durable artifact is evidence only. Both check and apply consume the
      // exact reviewed bytes through stdin, never a mutable artifact pathname.
      await gitOps.applyCheck(validated.projectRoot, generated.bytes);
      try {
        await gitOps.apply(validated.projectRoot, generated.bytes);
      } catch (error) {
        const uncertain = loopEngine.transitionWorktreeReview(
          id,
          applyingUpdatedAt,
          "applyUncertain",
          {
            error: `Apply outcome is uncertain: ${error instanceof Error ? error.message : String(error)}`,
          },
        );
        return reply
          .status(500)
          .send({ code: "loop_apply_uncertain", error: uncertain.review!.error, run: uncertain });
      }
      const applied = loopEngine.transitionWorktreeReview(id, applyingUpdatedAt, "applied", {
        error: undefined,
      });
      return { run: applied };
    } catch (error) {
      if (applyingUpdatedAt) {
        try {
          const available = loopEngine.transitionWorktreeReview(
            id,
            applyingUpdatedAt,
            "available",
            {
              error: error instanceof Error ? error.message : String(error),
            },
          );
          return reply
            .status(409)
            .send({ code: "loop_apply_failed", error: available.review!.error, run: available });
        } catch {
          // A mismatch after applying was persisted is itself uncertain.
          const run = loopEngine.get(id);
          return reply.status(500).send({
            code: "loop_apply_uncertain",
            error: "Apply outcome is uncertain; inspect the checkout before continuing.",
            run,
          });
        }
      }
      return worktreeUnavailable(reply);
    } finally {
      if (projectLockKey && checkoutLocks.get(projectLockKey)?.owner === id)
        checkoutLocks.delete(projectLockKey);
      worktreeOperationLocks.delete(id);
    }
  });

  fastify.post("/loops/runs/:id/discard", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const parsed = decisionBody
      .extend({ loopName: z.string().min(1).max(200) })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const existing = loopEngine.get(id);
    if (!existing) return reply.status(404).send({ error: "unknown loop run" });
    if (parsed.data.loopName !== existing.loopName) {
      return reply.status(422).send({
        code: "loop_discard_confirmation_failed",
        error: "Type the exact Loop name to confirm safe archival.",
      });
    }
    if (worktreeOperationLocks.has(id)) {
      return reply
        .status(409)
        .send({ code: "loop_review_busy", error: "A worktree decision is already in progress." });
    }
    worktreeOperationLocks.add(id);
    let discardingUpdatedAt: string | undefined;
    let archivedPath: string | undefined;
    try {
      const validated = await validateOwnedWorktree(id);
      const current = loopEngine.ensureWorktreeReviewAvailable(id);
      if (current.status !== "available") {
        return reply.status(409).send({
          code: "loop_review_unavailable",
          error: "This worktree is no longer available to archive.",
        });
      }
      archivedPath = nodePath.join(
        loopWorktreesRoot,
        `${nodePath.basename(validated.worktreePath)}.archived-${Date.now()}-${randomUUID()}`,
      );
      let run;
      try {
        run = loopEngine.transitionWorktreeReview(id, parsed.data.expectedUpdatedAt, "discarding", {
          archivedPath,
        });
      } catch {
        return reply.status(409).send({
          code: "loop_review_conflict",
          error: "The run changed; reload before archiving.",
        });
      }
      discardingUpdatedAt = run.review!.updatedAt;
      try {
        // Revalidate immediately before the synchronous exact-entry rename.
        // The injected seam may deterministically model a same-user swap.
        await validateOwnedWorktree(id);
        gitOps.renameWorktree(validated.worktreePath, archivedPath);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        try {
          // A failed atomic rename is a normal retryable failure only when the
          // original exact entry still proves ownership and no archive appeared.
          try {
            lstatSync(archivedPath);
            throw new Error("archive entry exists");
          } catch (archiveError) {
            if (
              archiveError instanceof Error &&
              "code" in archiveError &&
              archiveError.code === "ENOENT"
            ) {
              await validateOwnedWorktree(id);
              const available = loopEngine.transitionWorktreeReview(
                id,
                discardingUpdatedAt,
                "available",
                {
                  archivedPath: undefined,
                  error: `The worktree was not archived: ${detail}`,
                },
              );
              return reply.status(409).send({
                code: "loop_discard_failed",
                error: available.review!.error,
                run: available,
              });
            }
            throw archiveError;
          }
        } catch {
          const uncertain = loopEngine.transitionWorktreeReview(
            id,
            discardingUpdatedAt,
            "discardUncertain",
            {
              archivedPath,
              error: `The archive outcome is uncertain; the recorded entry was not modified further: ${detail}`,
            },
          );
          return reply.status(500).send({
            code: "loop_discard_uncertain",
            error: uncertain.review!.error,
            run: uncertain,
          });
        }
      }
      try {
        await validateArchivedWorktree(archivedPath, validated);
      } catch (error) {
        const uncertain = loopEngine.transitionWorktreeReview(
          id,
          discardingUpdatedAt,
          "discardUncertain",
          {
            archivedPath,
            error: `The archived entry failed ownership validation and was left untouched: ${error instanceof Error ? error.message : String(error)}`,
          },
        );
        return reply
          .status(500)
          .send({ code: "loop_discard_uncertain", error: uncertain.review!.error, run: uncertain });
      }
      try {
        await gitOps.prune(validated.projectRoot);
      } catch (error) {
        const uncertain = loopEngine.transitionWorktreeReview(
          id,
          discardingUpdatedAt,
          "discardUncertain",
          {
            archivedPath,
            error: `The worktree was archived at the recorded path, but Git registration pruning is uncertain: ${error instanceof Error ? error.message : String(error)}`,
          },
        );
        return reply
          .status(500)
          .send({ code: "loop_discard_uncertain", error: uncertain.review!.error, run: uncertain });
      }
      const discarded = loopEngine.transitionWorktreeReview(id, discardingUpdatedAt, "discarded", {
        archivedPath,
        error: undefined,
      });
      return { run: discarded };
    } catch {
      return worktreeUnavailable(reply);
    } finally {
      worktreeOperationLocks.delete(id);
    }
  });

  // Electron main calls this with an opaque run id; the renderer never supplies a filesystem path.
  fastify.get("/loops/runs/:id/artifact-directory", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!loopEngine.get(id)) return reply.status(404).send({ error: "unknown loop run" });
    try {
      const directory = loopEngine.artifactDirectoryForReveal(id);
      if (!directory) return reply.status(409).send({ error: "run has no artifact directory" });
      return { directory };
    } catch (error) {
      return reply.status(409).send({
        error: error instanceof Error ? error.message : "artifact directory is unavailable",
      });
    }
  });

  fastify.post("/loops/runs/:id/resolve", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    if (!loopEngine.get(id)) return reply.status(404).send({ error: "unknown loop run" });
    const parsed = z
      .object({
        decision: z.enum(["approve", "reject"]),
        expectedUpdatedAt: z.string().min(1),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    try {
      return {
        run: loopEngine.resolveHumanApproval(
          id,
          parsed.data.decision,
          parsed.data.expectedUpdatedAt,
        ),
      };
    } catch (error) {
      const typed = error as { code?: string; message?: string };
      if (typed.code === "loop_human_approval_conflict") {
        return reply.status(409).send({ code: typed.code, error: typed.message });
      }
      throw error;
    }
  });

  fastify.post("/loops/runs/:id/stop", async (request, reply) => {
    const run = loopEngine.get((request.params as { id: string }).id);
    if (!run) return reply.status(404).send({ error: "unknown loop run" });
    await loopEngine.stop(run.id);
    return { ok: true };
  });

  fastify.post("/loops/runs/:id/acknowledge", async (request, reply) => {
    const id = (request.params as { id: string }).id;
    const run = loopEngine.acknowledgeCheckoutRecovery(id);
    if (!run?.launch?.checkoutLockKey) {
      return reply.status(409).send({
        code: "loop_checkout_acknowledgement_unavailable",
        error: "This run does not have an interrupted checkout lock to acknowledge.",
      });
    }
    const lock = checkoutLocks.get(run.launch.checkoutLockKey);
    if (lock?.kind === "recovery" && lock.owner === run.id) {
      checkoutLocks.delete(run.launch.checkoutLockKey);
    }
    return { run };
  });

  fastify.post("/loops/runs/:id/retry", async (request, reply) => {
    const parsed = z
      .object({ currentCheckoutConfirmed: z.boolean().optional() })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const previous = loopEngine.get((request.params as { id: string }).id);
    if (!previous) return reply.status(404).send({ error: "unknown loop run" });
    if (!canRetryLoopRun(previous)) {
      return reply.status(409).send({
        code: "loop_retry_unavailable",
        error:
          previous.stopReason === "humanRejected"
            ? "A rejected approval checkpoint is terminal and cannot be retried."
            : "This Loop outcome is not eligible for retry.",
      });
    }
    if (!previous.projectId || !previous.catalogId) {
      return reply.status(409).send({ error: "The original project is unavailable." });
    }
    const response = await fastify.inject({
      method: "POST",
      url: `/loops/${encodeURIComponent(previous.catalogId)}/run`,
      payload: {
        projectId: previous.projectId,
        retryOf: previous.id,
        currentCheckoutConfirmed: parsed.data.currentCheckoutConfirmed,
      },
    });
    return reply.status(response.statusCode).send(response.json());
  });
}
