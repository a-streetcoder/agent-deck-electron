import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import nodePath from "node:path";
import {
  isRunnableLoopStructure,
  loopDefinitionValidationError,
  LOOP_STRUCTURE_LABEL,
  LOOP_STRUCTURE_UNSUPPORTED_CODE,
  type LoopStructure,
} from "@agent-deck/domain";
import {
  deleteLoopFile,
  duplicateLoop,
  LoopDefinitionInvalidError,
  LoopStructureNotRunnableError,
  scanLoops,
  writeLoopFile,
} from "@agent-deck/resources";
import { z } from "zod";
import {
  createLoopWorktree,
  gitDeleteOwnedWorktreeBranch,
  strictRemoveOwnedLoopWorktree,
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
export function registerLoopRoutes(ctx: ServerContext): void {
  const {
    fastify,
    sessions,
    index,
    projects,
    loopEngine,
    bridgeTokens,
    broadcast,
    rootsFor,
    enabledExtensionPaths,
    worktreesRoot,
  } = ctx;
  const loopWorktreesRoot = ensurePrivateLoopWorktreesRoot(worktreesRoot);
  // Trust-boundary lock: at most one destructive Loop may own a canonical
  // checkout. Interrupted runs seed durable recovery locks before onReady.
  const checkoutLocks = new Map<string, { owner: string; kind: "active" | "recovery" }>();
  for (const [key, runId] of loopEngine.recoveryCheckoutLocks()) {
    checkoutLocks.set(key, { owner: runId, kind: "recovery" });
  }

  // Reconcile only resources whose exact Loop ownership was durably recorded.
  // A live resumable parent is destroyed/settled before its index/token record
  // is removed; owned worktree branches are deliberately retained.
  fastify.addHook("onReady", async () => {
    for (const run of loopEngine.pendingResourceReconciliations()) {
      const launch = run.launch;
      if (!launch) continue;
      if (!launch.sessionReconciledAt) {
        try {
          await sessions.destroy(launch.sessionId);
          index.remove(launch.sessionId);
          bridgeTokens.delete(launch.sessionId);
          loopEngine.markSessionReconciled(run.id);
        } catch (error) {
          fastify.log.warn(
            { err: error, runId: run.id },
            "failed to reconcile Loop parent session",
          );
        }
      }
      if (
        launch.sessionReconciledAt &&
        launch.worktree?.branchOwned === true &&
        !launch.worktreeReconciledAt
      ) {
        try {
          const project = run.projectId
            ? projects.find((item) => item.id === run.projectId)
            : undefined;
          if (!project) throw new Error("Loop worktree project is no longer registered");
          await strictRemoveOwnedLoopWorktree({
            managedRoot: loopWorktreesRoot,
            registeredProjectRoot: project.path,
            worktree: launch.worktree,
          });
          loopEngine.markWorktreeReconciled(run.id);
        } catch (error) {
          fastify.log.warn(
            { err: error, runId: run.id },
            "failed to reconcile owned Loop worktree",
          );
        }
      }
    }
  });

  // Loop definitions (native LoopDefinitionStore, Bank CRUD half — no run engine
  // yet). Global: loops live under ~/.pi/agent/loops.
  const loopEditBody = z.object({
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
    maxIterations: z.number().int().optional(),
    validationCommand: z.string().max(10_000).optional(),
    writeTarget: z.enum(["artifactMarkdown", "newWorktree", "currentCheckout"]).optional(),
  });

  fastify.get("/loops", async () => ({ loops: scanLoops(rootsFor()) }));

  fastify.put("/loops", async (request, reply) => {
    const parsed = loopEditBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const roots = rootsFor();
    const existing = scanLoops(roots).find((loop) => loop.name === parsed.data.name);
    const resultingStructure = parsed.data.structure ?? existing?.structure ?? "singleAgent";
    if (!isRunnableLoopStructure(resultingStructure)) {
      return reply.status(422).send(unsupportedStructureError(resultingStructure));
    }
    try {
      writeLoopFile(roots, parsed.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
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
    const parsed = z.object({ name: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    deleteLoopFile(rootsFor(), parsed.data.name);
    broadcast({ type: "resources_changed" });
    return { ok: true };
  });

  fastify.post("/loops/:name/duplicate", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const roots = rootsFor();
    const source = scanLoops(roots).find((loop) => loop.name === name);
    if (!source) return reply.status(404).send({ error: `unknown loop: ${name}` });
    if (!isRunnableLoopStructure(source.structure)) {
      return reply.status(422).send(unsupportedStructureError(source.structure));
    }
    try {
      const copyName = duplicateLoop(roots, name);
      broadcast({ type: "resources_changed" });
      return { name: copyName };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "loop_not_found") {
        return reply.status(404).send({ error: `unknown loop: ${name}` });
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
  fastify.post("/loops/:name/run", async (request, reply) => {
    const name = (request.params as { name: string }).name;
    const loop = scanLoops(rootsFor()).find((l) => l.name === name);
    if (!loop) return reply.status(404).send({ error: `unknown loop: ${name}` });
    // This must precede request parsing, project lookup, worktree creation,
    // session/Pi allocation, and LoopEngine.start: unsupported persisted/native
    // definitions are readable but never silently run as single-agent loops.
    if (!isRunnableLoopStructure(loop.structure)) {
      return reply.status(422).send(unsupportedStructureError(loop.structure));
    }
    const parsed = z
      .object({
        projectId: z.string().optional(),
        retryOf: z.string().uuid().optional(),
        provider: z.string().optional(),
        model: z.string().optional(),
        extensions: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const body = parsed.data;
    const definitionError = loopDefinitionValidationError(loop);
    if (definitionError) {
      return reply.status(422).send({ code: "loop_definition_invalid", error: definitionError });
    }
    const defaults = envDefaults();
    // A loop runs its agent + shell validation command in a project's working
    // tree — require an explicit project so it never executes in the server's cwd.
    if (!body.projectId) {
      return reply.status(400).send({ error: "projectId is required to run a loop" });
    }
    const project = projects.find((p) => p.id === body.projectId);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    let checkoutLockKey: string | undefined;
    if (loop.writeTarget === "currentCheckout") {
      try {
        checkoutLockKey = canonicalCheckoutLockKey(project.path);
      } catch {
        return reply.status(409).send({
          code: "loop_checkout_canonicalization_failed",
          error: "The project checkout could not be identified safely. No Loop was started.",
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
    // the agent's work never touches the main checkout. The branch is kept after
    // the run; only the worktree directory is removed.
    let cwd = project.path;
    let worktree: GitWorktree | null = null;
    let worktreeOwnership: OwnedLoopWorktreeProof | null = null;
    if (loop.writeTarget === "newWorktree") {
      const ownershipId = randomUUID();
      const target = nodePath.join(loopWorktreesRoot, `loop-${ownershipId}`);
      const branch = `agent-deck/loop-${loop.name.replace(/[^A-Za-z0-9]+/g, "-")}-${ownershipId.slice(0, 8)}`;
      try {
        worktree = await createLoopWorktree(project.path, target, branch);
        worktreeOwnership = {
          ownershipVersion: 1,
          ownershipId,
          projectRoot: canonicalCheckoutLockKey(project.path),
          path: worktree.path,
          branch: worktree.branch,
          sourceBranch: worktree.sourceBranch,
          branchOwned: true,
        };
        cwd = target;
      } catch (error) {
        releaseCheckoutLock();
        return reply.status(400).send({
          error: `Couldn't create a worktree for this loop: ${error instanceof Error ? error.message : String(error)}`,
        });
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
    let parent: ReturnType<typeof sessions.create> | undefined;
    let run: ReturnType<typeof loopEngine.start> | undefined;
    let announcementAttempted = false;
    try {
      parent = sessions.create({
        cwd,
        projectId: body.projectId,
        ...(worktree ? { worktree } : {}),
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
      run = loopEngine.start(loop, cwd, {
        projectId: body.projectId,
        retryOf: body.retryOf,
        launch: {
          sessionId: parent.meta.id,
          writeTarget: loop.writeTarget,
          checkoutLockKey,
          ...(worktreeOwnership ? { worktree: worktreeOwnership } : {}),
        },
        executeRole: ({ prompt, agentName, phase }) => {
          const toolPolicy =
            phase === "evaluator"
              ? "none"
              : phase === "checker" || loop.writeTarget === "artifactMarkdown"
                ? "readOnly"
                : "configured";
          return sessions.runSubagent(parent!.meta.id, prompt, agentName || undefined, toolPolicy);
        },
        cancel: () => sessions.destroy(parent!.meta.id),
      });
      announcementAttempted = true;
      sessions.announceCreated(parent);
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
      if (partialId) bridgeTokens.delete(partialId);
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
      if (worktree && worktreeOwnership) {
        let removed = false;
        try {
          await strictRemoveOwnedLoopWorktree({
            managedRoot: loopWorktreesRoot,
            registeredProjectRoot: project.path,
            worktree: worktreeOwnership,
          });
          removed = true;
        } catch (cleanupError) {
          fastify.log.warn(
            { err: cleanupError },
            "refused or failed strict Loop worktree cleanup after startup",
          );
        }
        if (removed) {
          await gitDeleteOwnedWorktreeBranch(project.path, worktree).catch((cleanupError) => {
            fastify.log.warn(
              { err: cleanupError, branch: worktree?.branch },
              "failed to remove generated Loop branch after startup",
            );
          });
        }
      }
      releaseCheckoutLock();
      return reply.status(500).send({
        code: "loop_start_failed",
        error: `The Loop couldn't be started safely. Transient cleanup was attempted; fix the launch error and try again: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    // The durable run timeline is authoritative. The parent Pi/session and
    // temporary worktree are implementation resources and are removed after all
    // children settle; only the generated branch is retained.
    void loopEngine.settled(run.id).finally(async () => {
      try {
        try {
          await sessions.destroy(parent.meta.id);
          const removed = index.remove(parent.meta.id);
          if (removed) broadcast({ type: "session_removed", sessionId: parent.meta.id });
          bridgeTokens.delete(parent.meta.id);
          loopEngine.markSessionReconciled(run.id);
        } catch (cleanupError) {
          fastify.log.warn({ err: cleanupError }, "failed to reconcile settled Loop parent");
        }
        if (worktreeOwnership && run.launch?.sessionReconciledAt) {
          try {
            await strictRemoveOwnedLoopWorktree({
              managedRoot: loopWorktreesRoot,
              registeredProjectRoot: project.path,
              worktree: worktreeOwnership,
            });
            loopEngine.markWorktreeReconciled(run.id);
          } catch (cleanupError) {
            fastify.log.warn({ err: cleanupError }, "failed to remove settled Loop worktree");
          }
        }
      } finally {
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
    const previous = loopEngine.get((request.params as { id: string }).id);
    if (!previous) return reply.status(404).send({ error: "unknown loop run" });
    if (!previous.projectId) {
      return reply.status(409).send({ error: "The original project is unavailable." });
    }
    const response = await fastify.inject({
      method: "POST",
      url: `/loops/${encodeURIComponent(previous.loopName)}/run`,
      payload: {
        projectId: previous.projectId,
        retryOf: previous.id,
      },
    });
    return reply.status(response.statusCode).send(response.json());
  });
}
