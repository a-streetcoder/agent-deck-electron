import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import {
  isRunnableLoopStructure,
  LOOP_STRUCTURE_LABEL,
  LOOP_STRUCTURE_UNSUPPORTED_CODE,
  type LoopStructure,
} from "@agent-deck/domain";
import {
  deleteLoopFile,
  duplicateLoop,
  LoopStructureNotRunnableError,
  scanLoops,
  writeLoopFile,
} from "@agent-deck/resources";
import { z } from "zod";
import {
  createSessionWorktree,
  gitDeleteOwnedWorktreeBranch,
  gitWorktreeRemove,
  type GitWorktree,
} from "../git.ts";
import { SessionCreationError } from "../SessionManager.ts";
import { envDefaults, type ServerContext } from "../context.ts";
import { finalizeExtensions } from "./shared.ts";

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
  } = ctx;

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
      return reply.status(500).send({ error: message });
    }
  });

  // Run a loop (native single-agent loop engine). Each iteration drives the
  // loop's agent to completion via a per-run parent session in the project cwd,
  // then runs the validation command; exit 0 stops the run successfully.
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
        provider: z.string().optional(),
        model: z.string().optional(),
        extensions: z.array(z.string()).optional(),
        env: z.record(z.string()).optional(),
      })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const body = parsed.data;
    const defaults = envDefaults();
    // A loop runs its agent + shell validation command in a project's working
    // tree — require an explicit project so it never executes in the server's cwd.
    if (!body.projectId) {
      return reply.status(400).send({ error: "projectId is required to run a loop" });
    }
    const project = projects.find((p) => p.id === body.projectId);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    // writeTarget "newWorktree": run the loop in an isolated git worktree on a
    // fresh branch off the current one (native PiAgentSessionWorktreeService), so
    // the agent's work never touches the main checkout. The branch is kept after
    // the run; only the worktree directory is removed.
    let cwd = project.path;
    let worktree: GitWorktree | null = null;
    if (loop.writeTarget === "newWorktree") {
      const suffix = randomUUID().slice(0, 8);
      const target = nodePath.join(tmpdir(), `agent-deck-worktree-${suffix}`);
      const branch = `agent-deck/loop-${loop.name.replace(/[^A-Za-z0-9]+/g, "-")}-${suffix}`;
      try {
        worktree = await createSessionWorktree(project.path, target, branch);
        cwd = target;
      } catch (error) {
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
        executeAgent: (definition) =>
          sessions.runSubagent(parent!.meta.id, definition.goal, definition.agentName || undefined),
      });
      announcementAttempted = true;
      sessions.announceCreated(parent);
    } catch (error) {
      if (run) {
        loopEngine.stop(run.id);
        // start() may already have dispatched executeAgent. Wait for that run to
        // reach its terminal state before closing the parent/worktree it owns.
        // The normal settled-finally path is installed only after announcement
        // succeeds below, so rollback remains exactly once.
        await loopEngine.settled(run.id).catch((cleanupError) => {
          fastify.log.warn({ err: cleanupError }, "failed waiting for Loop startup rollback");
        });
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
      if (worktree) {
        await gitWorktreeRemove(project.path, worktree.path).catch((cleanupError) => {
          fastify.log.warn({ err: cleanupError }, "failed to remove Loop worktree after startup");
        });
        await gitDeleteOwnedWorktreeBranch(project.path, worktree).catch((cleanupError) => {
          fastify.log.warn(
            { err: cleanupError, branch: worktree?.branch },
            "failed to remove generated Loop branch after startup",
          );
        });
      }
      return reply.status(500).send({
        code: "loop_start_failed",
        error: `The Loop couldn't be started safely. Transient cleanup was attempted; fix the launch error and try again: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    // Tear down the transient parent session once the run reaches a terminal
    // state (whatever the outcome): stop the pi process AND drop it from the
    // session index/list so this internal helper never surfaces in the UI.
    void loopEngine.settled(run.id).finally(async () => {
      // Await destroy so the pi process has released the worktree dir before we
      // remove it (a live process would block the removal, esp. on Windows). A
      // destroy failure must not skip the rest of the cleanup.
      try {
        await sessions.destroy(parent.meta.id);
      } catch {
        // Best-effort — proceed with index/worktree cleanup regardless.
      }
      index.remove(parent.meta.id);
      bridgeTokens.delete(parent.meta.id);
      broadcast({ type: "session_removed", sessionId: parent.meta.id });
      // Remove the isolated worktree dir; its branch is kept so committed work
      // survives.
      if (worktree) await gitWorktreeRemove(project.path, worktree.path);
    });
    return reply.status(201).send({ run, worktree });
  });

  fastify.get("/loops/runs/:id", async (request, reply) => {
    const run = loopEngine.get((request.params as { id: string }).id);
    if (!run) return reply.status(404).send({ error: "unknown loop run" });
    return { run };
  });

  fastify.post("/loops/runs/:id/stop", async (request, reply) => {
    const run = loopEngine.get((request.params as { id: string }).id);
    if (!run) return reply.status(404).send({ error: "unknown loop run" });
    loopEngine.stop(run.id);
    return { ok: true };
  });
}
