import { randomUUID } from "node:crypto";
import { copyFileSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import type { SessionMeta, UserIdentity } from "@agent-deck/contracts";
import { redactSecrets } from "@agent-deck/domain";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { userActor } from "../eventProducers.ts";
import {
  gitCarriesLfs,
  gitDeleteTransferRef,
  gitErrorText,
  gitRestoreSnapshotInPlace,
  gitSharePlan,
  gitTopLevel,
  SnapshotResetError,
  type GitWorktree,
} from "../git.ts";
import { githubEnv } from "../githubConnections.ts";
import {
  checkPiTranscript,
  createHandoffs,
  createTransferWorktree,
  fetchTransferSnapshot,
  HANDOFF_TTL_MS,
  LFS_DETECTION_REFUSAL,
  LFS_MOVE_REFUSAL,
  MAX_TRANSFER_BYTES,
  prepareSessionExport,
  resolveTransferLaunch,
  rewriteTranscriptCwd,
  TransferFetchError,
  TransferModelError,
  transcriptParentSession,
  transferEnvelopeSchema,
  type PushedTransfer,
} from "../sessionTransfer.ts";
import { requestUser } from "../trustedProxy.ts";
import { deviceName, liveState } from "./sessionShare.ts";

type Reply = { status(code: number): { send(body: unknown): unknown } };

const returnBody = z
  .object({
    /** The untracked files the owner saw and agreed to bring back; absent: preflight. */
    confirmedUntracked: z.array(z.string().max(4096)).max(100_000).optional(),
  })
  .strict();
const abortBody = z.object({ handoff: z.string().uuid().optional() }).strict();
const returnedBody = z
  .object({ deviceSessionId: z.string().uuid(), handoff: z.string().uuid() })
  .strict();
/** The device's import: the server's envelope and the hand-off that finishes it. */
const importReturnBody = z.object({ envelope: z.unknown(), handoff: z.string().uuid() }).strict();

/**
 * SRV-12c3, the return trip: a session moved to the shared server comes back to
 * the device it came from. The renderer on the device drives it through
 * Electron main: `POST /sessions/:id/return` on the server (preflight, then the
 * snapshot pushed with the session OWNER's GitHub connection and the envelope),
 * `POST /sessions/:id/import-return` on the local backend (the same fetch and
 * checks as a server import, with the device's own git login), then
 * `PATCH /sessions/:id/returned` on the server, which turns the server copy
 * into a pointer to the device. The export and import steps are the ones a
 * share uses (sessionTransfer.ts).
 */
export function registerSessionReturnRoutes(ctx: ServerContext): void {
  const { fastify, sessions, index, projects, broadcast } = ctx;
  const handoffs = createHandoffs(fastify, sessions.mutationClaims);
  const metaOf = (id: string) => sessions.get(id)?.meta ?? index.find((s) => s.id === id);
  const decorate = (meta: SessionMeta) => ctx.withActivity?.([meta])[0] ?? meta;
  const refuse = (reply: Reply, error: string) =>
    reply.status(409).send({ code: "return_refused", error });
  const stale = (reply: Reply) =>
    reply.status(409).send({
      code: "return_stale",
      error: "This return is no longer prepared on the server. Bring the session back again.",
    });
  const inProgress = (reply: Reply, error = "This session is being returned right now.") =>
    reply.status(409).send({ code: "return_in_progress", error });

  // --------------------------------------------------------------- server side

  /**
   * The server session and its requester, or the answer that refuses them. Only
   * the owner takes a session back (the envelope and its completion are theirs);
   * the operator may only cancel a return (`operator`).
   */
  const serverSession = (
    request: { params: unknown; raw: Parameters<typeof requestUser>[0] },
    reply: Reply,
    operator = false,
  ): { meta: SessionMeta; user: UserIdentity } | undefined => {
    if (!ctx.sharedServer) {
      reply.status(409).send({ error: "A session goes back to a device from a shared server." });
      return undefined;
    }
    const { id } = request.params as { id: string };
    const meta = metaOf(id);
    if (!meta) {
      reply.status(404).send({ code: "unknown_session", error: "unknown session" });
      return undefined;
    }
    const user = requestUser(request.raw);
    const owner = !!user && meta.createdBy !== undefined && user.id === meta.createdBy.id;
    if (!owner && !(operator && !!user && ctx.userAgentDirs?.isOperator(user) === true)) {
      reply.status(403).send({
        code: "return_forbidden",
        error: operator
          ? "Only the person who owns this session, or the operator, can cancel its return."
          : "Only the person who owns this session can bring it back.",
      });
      return undefined;
    }
    return { meta, user: user! };
  };

  const returnRefusal = async (meta: SessionMeta): Promise<string | undefined> => {
    if (meta.sharedTo)
      return `This session already continues on ${meta.sharedTo.device ?? "a device"}.`;
    if (!meta.sharedFrom)
      return "This session did not come from a device: there is nothing to bring back.";
    if (meta.lifecycle === "draft" || !meta.piSessionFile)
      return "This session has nothing to bring back yet.";
    if (meta.loopReviewRunId || meta.agentName?.startsWith("Loop ·"))
      return "A Loop session cannot move to a device.";
    const live = await liveState(sessions, meta.id);
    if (live.streaming) return "Wait until the session has finished responding.";
    if (live.liveSubagents) return "Wait until this session's subagents have finished.";
    // ade-q0pz: the hook-free transfer push would leave LFS objects behind (the
    // export checks the snapshot itself again); a failed detection refuses.
    return gitCarriesLfs(meta.cwd).then(
      (found) => (found ? LFS_MOVE_REFUSAL : undefined),
      () => LFS_DETECTION_REFUSAL,
    );
  };

  fastify.post("/sessions/:id/return", async (request, reply) => {
    const parsed = returnBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const found = serverSession(request, reply);
    if (!found) return reply;
    const { meta } = found;
    const id = meta.id;
    // One return at a time: a pending one is finished or cancelled first, so a
    // second device or tab can never take over the hand-off of the first.
    if (handoffs.get(id))
      return inProgress(
        reply,
        "A return of this session is already prepared. Finish it, or cancel it first.",
      );
    await handoffs.retryLeftover(id);
    const before = await returnRefusal(meta);
    if (before) return refuse(reply, before);
    // The OWNER's connection pushes; without one there is no push at all, never
    // the server's own credentials.
    const ownerEnv = githubEnv(meta.createdBy, ctx.githubConnections);
    const token = ownerEnv.GH_TOKEN;
    if (!token)
      return reply.status(409).send({
        code: "github_not_connected",
        error:
          "Connect GitHub first: the session's work goes back through the owner's GitHub connection.",
      });
    const redact = (text: string) => redactSecrets(text.split(token).join("<secret>"));

    if (parsed.data.confirmedUntracked === undefined) {
      try {
        const plan = await gitSharePlan(meta.cwd);
        return {
          plan: {
            branch: plan.branch,
            head: plan.head,
            files: { tracked: plan.tracked, untracked: plan.untracked },
            dirtySubmodules: plan.dirtySubmodules,
            localCommits: plan.localCommits,
            sizeBytes: statSync(meta.piSessionFile!).size,
            device: meta.sharedFrom!.device,
          },
        };
      } catch (error) {
        return refuse(reply, `The session's repository could not be read: ${gitErrorText(error)}`);
      }
    }

    const release = handoffs.claim(id);
    if (!release)
      return reply.status(409).send({
        code: "session_mutation_busy",
        error: "Another session mutation is already in progress. Try again when it finishes.",
      });
    let kept = false;
    let pushed: PushedTransfer | undefined;
    try {
      const current = metaOf(id);
      if (!current)
        return reply.status(404).send({ code: "unknown_session", error: "unknown session" });
      const refusal = await returnRefusal(current);
      if (refusal) return refuse(reply, refusal);
      const prepared = await prepareSessionExport(ctx, current, {
        mode: "snapshot",
        untracked: parsed.data.confirmedUntracked,
        device: deviceName(),
        pushEnv: ownerEnv,
        returnTo: {
          device: current.sharedFrom!.device,
          localSessionId: current.sharedFrom!.localSessionId,
        },
        redact,
      });
      if ("status" in prepared) return reply.status(prepared.status).send(prepared.body);
      pushed = prepared.pushed;
      // Frozen (prompts, the live mirror's forwarded ones too, answer
      // session_moving) until the device confirms, the return is aborted, or 15 minutes.
      const handoff = handoffs.start(id, release, pushed);
      kept = true;
      return { envelope: prepared.envelope, handoff };
    } finally {
      if (!kept) {
        release();
        // A pushed ref never outlives a failed answer.
        if (pushed) await handoffs.dropRef(id, pushed);
      }
    }
  });

  // Cancel a prepared return: unfreeze the server copy and delete the pushed ref
  // (kept for a retry when that fails). Without a token it cancels whatever
  // return is pending (a dialog that lost it). The operator may cancel too.
  fastify.post("/sessions/:id/return/abort", async (request, reply) => {
    const parsed = abortBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const found = serverSession(request, reply, true);
    if (!found) return reply;
    const id = found.meta.id;
    const handoff = handoffs.get(id);
    if (!handoff || (parsed.data.handoff && handoff.token !== parsed.data.handoff))
      return { ok: true, transferRefDeleted: await handoffs.retryLeftover(id) };
    // A finalizing return is never cancelled underneath it.
    if (handoff.finalizing) return inProgress(reply);
    handoffs.end(id, handoff.token);
    const transferRefDeleted = handoff.pushed ? await handoffs.dropRef(id, handoff.pushed) : true;
    return { ok: true, transferRefDeleted };
  });

  // The device has the session again: end the server Pi and turn this copy into
  // a read-only pointer to the device. Repeating it for the same device session
  // answers the pointer again (the device retries after a lost answer).
  fastify.patch("/sessions/:id/returned", async (request, reply) => {
    const parsed = returnedBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const found = serverSession(request, reply);
    if (!found) return reply;
    const { meta, user } = found;
    const id = meta.id;
    if (meta.sharedTo && meta.sharedTo.serverOrigin === null) {
      if (meta.sharedTo.deviceSessionId !== parsed.data.deviceSessionId)
        return refuse(reply, "This session already went back to another device session.");
      return {
        session: decorate(meta),
        transferRefDeleted: await handoffs.retryLeftover(id),
      };
    }
    const current = handoffs.get(id);
    if (current?.token !== parsed.data.handoff) return stale(reply);
    if (current.finalizing) return inProgress(reply);
    if (meta.sharedFrom?.localSessionId !== parsed.data.deviceSessionId)
      return refuse(reply, "That is not the device session this copy came from.");
    current.finalizing = true;
    const ours = () => handoffs.get(id) === current;
    try {
      const live = await liveState(sessions, id);
      if (!ours()) return stale(reply);
      if (live.streaming)
        return refuse(reply, "A turn is running in this session; stop it, then finish the return.");
      ctx.askUser.cancelSession(id);
      await sessions.destroy(id);
      if (!ours()) return stale(reply);
      const latest = index.find((s) => s.id === id) ?? meta;
      const next: SessionMeta = {
        ...latest,
        sharedTo: {
          serverOrigin: null,
          device: meta.sharedFrom.device,
          deviceSessionId: parsed.data.deviceSessionId,
          sharedAt: new Date().toISOString(),
          mode: "snapshot",
        },
      };
      // A pointer is idle: not ended, parked, failed or waiting for review.
      delete next.endedAt;
      delete next.parkedAt;
      delete next.status;
      delete next.lastError;
      delete next.needsAttention;
      delete next.needsAttentionAt;
      index.upsert(next);
      handoffs.end(id, current.token);
      // The device deleted the ref too; a failure here is kept and retried.
      const transferRefDeleted = current.pushed ? await handoffs.dropRef(id, current.pushed) : true;
      ctx.events.sessionShared(next, userActor(user), {
        direction: "return",
        mode: "snapshot",
        localSessionId: parsed.data.deviceSessionId,
        device: meta.sharedFrom.device,
      });
      const decorated = decorate(next);
      broadcast({ type: "session_meta", session: decorated });
      return { session: decorated, transferRefDeleted };
    } finally {
      if (ours()) current.finalizing = false;
    }
  });

  // --------------------------------------------------------------- device side

  fastify.post(
    "/sessions/:id/import-return",
    { bodyLimit: MAX_TRANSFER_BYTES + 1024 * 1024 },
    async (request, reply) => {
      if (ctx.sharedServer)
        return reply.status(409).send({ error: "A session comes back on the device it left." });
      const { id } = request.params as { id: string };
      const meta = metaOf(id);
      if (!meta) return reply.status(404).send({ error: "unknown session" });
      const link = meta.sharedTo;
      if (!link?.serverOrigin || !link.serverSessionId || !meta.piSessionFile)
        return refuse(reply, "This session is not a link to a session on the shared server.");
      const invalid = (error: string) =>
        reply.status(400).send({ code: "invalid_envelope", error });
      const body = importReturnBody.safeParse(request.body);
      if (!body.success) return invalid("The returned session is not valid: body.");
      // The envelope comes from the server: checked as strictly as the server checks a share.
      const parsed = transferEnvelopeSchema.safeParse(body.data.envelope);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return invalid(
          `The returned session is not valid: ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
        );
      }
      const envelope = parsed.data;
      const transfer = envelope.transfer;
      if (
        envelope.direction !== "return" ||
        transfer.mode !== "snapshot" ||
        envelope.localSessionId !== link.serverSessionId ||
        envelope.sharedFrom?.localSessionId !== id
      )
        return invalid("The returned session is not the server copy of this session.");
      try {
        checkPiTranscript(envelope.transcript);
      } catch (error) {
        return invalid(`The returned session is not valid: ${(error as Error).message}`);
      }
      // Every check that can refuse runs before git touches anything.
      try {
        ctx.sessionPastes.checkTurns(envelope.pastes);
      } catch {
        return invalid("The returned session has an invalid paste.");
      }
      const release = handoffs.claim(id);
      if (!release)
        return reply.status(409).send({
          code: "session_mutation_busy",
          error: "Another session mutation is already in progress. Try again when it finishes.",
        });
      try {
        const actor = userActor(requestUser(request.raw));
        const server = { serverOrigin: link.serverOrigin, serverSessionId: link.serverSessionId };
        return await bringBack(meta, server, envelope, transfer, body.data.handoff, actor, reply);
      } finally {
        release();
      }
    },
  );

  async function bringBack(
    meta: SessionMeta,
    link: { serverOrigin: string; serverSessionId: string },
    envelope: z.infer<typeof transferEnvelopeSchema>,
    transfer: { mode: "snapshot"; ref: string; commit: string; baseHead: string },
    handoff: string,
    actor: ReturnType<typeof userActor>,
    reply: Reply,
  ) {
    const id = meta.id;
    const project = meta.projectId ? projects.find((p) => p.id === meta.projectId) : undefined;
    const where = { id, cwd: meta.cwd, ...(meta.projectId ? { projectId: meta.projectId } : {}) };
    // The agent, model and thinking level the server copy ran with, on this
    // device's own providers (a model it does not offer refuses here, untouched).
    let launch: Awaited<ReturnType<typeof resolveTransferLaunch>>;
    try {
      launch = await resolveTransferLaunch(ctx, envelope, where, undefined, {
        localCatalog: true,
      });
    } catch (error) {
      return reply.status(409).send({
        code: error instanceof TransferModelError ? "model_unavailable" : "return_refused",
        error: (error as Error).message,
      });
    }
    const root = await gitTopLevel(meta.cwd).catch(() => undefined);
    const repo = root ?? project?.path;
    if (!repo) return refuse(reply, "This session's repository is no longer on this device.");
    // Fetch first, with this device's own git login; nothing changes before it.
    try {
      await fetchTransferSnapshot(repo, transfer, {});
    } catch (error) {
      const text =
        error instanceof TransferFetchError && error.code === "transfer_fetch_failed"
          ? `The server's snapshot could not be fetched: ${redactSecrets(error.message).slice(-1_000)}`
          : "The fetched snapshot is not the one the server sent.";
      return reply.status(409).send({
        code: error instanceof TransferFetchError ? error.code : "transfer_mismatch",
        error: text,
      });
    }

    // The original checkout only when that loses nothing (gitRestoreSnapshotInPlace:
    // clean, HEAD at the base, nothing ignored in the way); otherwise, and when
    // it refuses for any reason, a fresh worktree; the checkout is left alone.
    let cwd = meta.cwd;
    let fresh: { worktree: GitWorktree; discard: () => Promise<void> } | undefined;
    let restoredInPlace = false;
    try {
      restoredInPlace = root
        ? await gitRestoreSnapshotInPlace(root, transfer.commit, transfer.baseHead)
        : false;
    } catch (error) {
      // Merged, but HEAD is still on the transfer commit: say so, never silently.
      const text = error instanceof SnapshotResetError ? error.message : gitErrorText(error);
      return reply.status(500).send({
        code: "session_return_failed",
        error: `The session could not be brought back. ${redactSecrets(text).slice(-500)} This session still links to the server copy.`,
      });
    }
    try {
      if (!restoredInPlace) {
        fresh = await createTransferWorktree(ctx, project?.path ?? repo, transfer);
        cwd = fresh.worktree.path;
        launch = await resolveTransferLaunch(ctx, envelope, { ...where, cwd }, undefined, {
          localCatalog: true,
        }).catch(() => launch);
      }
      ctx.sessionPastes.importTurns(id, envelope.pastes);
      // The same local session id: the server transcript replaces the pointer's
      // (it begins with the turns this device sent), written whole or not at
      // all; the pointer's own file stays as <file>.pre-return (one generation),
      // and its parentSession (a path on this device) is kept.
      const file = meta.piSessionFile!;
      const parentSession = transcriptParentSession(readFileSync(file, "utf8"));
      const temp = `${file}.return-${randomUUID()}`;
      try {
        writeFileSync(temp, rewriteTranscriptCwd(envelope.transcript, cwd, parentSession), {
          flag: "wx",
          mode: 0o600,
        });
        copyFileSync(file, `${file}.pre-return`);
        renameSync(temp, file);
      } catch (error) {
        rmSync(temp, { force: true });
        throw error;
      }
    } catch (error) {
      await fresh?.discard();
      const where = restoredInPlace
        ? ` The server's work is now uncommitted in ${cwd}; this session still links to the server copy.`
        : "";
      return reply.status(500).send({
        code: "session_return_failed",
        error: `The session could not be brought back: ${redactSecrets(gitErrorText(error)).slice(-500)}${where}`,
      });
    }

    // The server's authors stay as attribution labels: this is the owner's own device.
    ctx.sessionAuthors?.importTurns(id, envelope.authors);
    const latest = index.find((s) => s.id === id) ?? meta;
    const now = new Date();
    const next: SessionMeta = {
      ...latest,
      cwd,
      updatedAt: now.toISOString(),
      ...(envelope.meta.title ? { title: envelope.meta.title } : {}),
      ...(envelope.meta.titleUserEdited ? { titleUserEdited: true } : {}),
      ...(envelope.meta.plan?.length ? { plan: envelope.meta.plan } : {}),
      ...(envelope.meta.subagentsEnabled !== undefined
        ? { subagentsEnabled: envelope.meta.subagentsEnabled }
        : {}),
      launchPlan: launch.launchPlan,
      launchResourceConfig: launch.launchResourceConfig,
      launchResourceFingerprint: launch.launchResourceFingerprint,
      returnedFrom: {
        serverOrigin: link.serverOrigin,
        serverSessionId: link.serverSessionId,
        returnedAt: now.toISOString(),
        ...(envelope.meta.mergePr ? { mergePr: envelope.meta.mergePr } : {}),
      },
      // Until the server copy is closed (PATCH returned), and while it can be.
      returnPending: {
        token: handoff,
        serverOrigin: link.serverOrigin,
        serverSessionId: link.serverSessionId,
        ref: transfer.ref,
        until: new Date(now.getTime() + HANDOFF_TTL_MS).toISOString(),
      },
    };
    delete next.sharedTo;
    if (launch.agentName) next.agentName = launch.agentName;
    else delete next.agentName;
    if (fresh) {
      const { worktree } = fresh;
      next.worktreePath = worktree.path;
      if (worktree.identityToken) next.worktreeIdentity = worktree.identityToken;
      else delete next.worktreeIdentity;
      next.worktreeBranch = worktree.branch;
      next.worktreeSourceBranch = worktree.sourceBranch;
      delete next.worktreeOwnerSessionId;
      delete next.worktreeCleanupBranchHead;
    }
    index.upsert(next);
    if (envelope.draft) {
      try {
        ctx.composerDrafts?.put(id, envelope.draft);
      } catch {
        // The unsent text is a convenience: the session is back either way.
      }
    }
    ctx.events.sessionShared(next, actor, {
      direction: "return",
      mode: "snapshot",
      serverOrigin: link.serverOrigin,
      serverSessionId: link.serverSessionId,
    });
    // The device fetched it, so the device deletes it too (the server does as well).
    const transferRefDeleted = await gitDeleteTransferRef(repo, transfer.ref).then(
      () => true,
      () => false,
    );
    const decorated = decorate(next);
    broadcast({ type: "session_meta", session: decorated });
    return {
      session: decorated,
      restored: restoredInPlace ? "checkout" : "worktree",
      transferRefDeleted,
      ...(launch.droppedAgent ? { dropped: ["agent"] } : {}),
      ...(restoredInPlace
        ? {}
        : {
            notice: `The original checkout had changes of its own (or HEAD had moved), so the session came back in a new worktree: ${cwd}.`,
          }),
    };
  }

  // The server copy is closed (or the owner gave up on it): the return is done here.
  fastify.patch("/sessions/:id/return-pending", async (request, reply) => {
    if (ctx.sharedServer) return reply.status(409).send({ error: "Device sessions only." });
    if (!z.object({ returnPending: z.null() }).strict().safeParse(request.body).success)
      return reply.status(400).send({ error: "Send { returnPending: null }." });
    const { id } = request.params as { id: string };
    const meta = metaOf(id);
    if (!meta) return reply.status(404).send({ error: "unknown session" });
    if (!meta.returnPending) return { session: decorate(meta) };
    const live = sessions.get(id);
    if (live) delete live.meta.returnPending;
    const next: SessionMeta = { ...(index.find((s) => s.id === id) ?? meta) };
    delete next.returnPending;
    index.upsert(next);
    const decorated = decorate(next);
    broadcast({ type: "session_meta", session: decorated });
    return { session: decorated };
  });
}
