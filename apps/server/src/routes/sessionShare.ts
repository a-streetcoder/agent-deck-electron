import { statSync } from "node:fs";
import { hostname } from "node:os";
import type { ProjectMeta, SessionMeta } from "@agent-deck/contracts";
import {
  liveCopy,
  operationRefusal,
  redactSecrets,
  sessionLifecycle,
  withoutLiveCopy,
} from "@agent-deck/domain";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { userActor } from "../eventProducers.ts";
import {
  gitCarriesLfs,
  gitDeleteTransferRef,
  gitErrorText,
  gitSharePlan,
  validTransferRef,
} from "../git.ts";
import { MAX_DETACHED_SUBAGENTS, type SessionManager } from "../SessionManager.ts";
import { createHandoffs, prepareSessionExport, type PushedTransfer } from "../sessionTransfer.ts";

import { requestUser } from "../trustedProxy.ts";

export { HANDOFF_TTL_MS } from "../sessionTransfer.ts";

/** What a live session is doing that a move would tear apart. */
export interface ShareLiveState {
  streaming: boolean;
  liveSubagents: boolean;
}

/** The device name as the server accepts it (letters, digits, dot, dash, underscore). */
export const deviceName = (name: string = hostname()): string =>
  name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 200) || "device";

/** Why this session cannot move to the shared server now, or undefined when it can.
 * The record's part (pointer, draft, Loop) is allowedOperations' "move". */
export function shareRefusal(
  meta: SessionMeta,
  project: ProjectMeta | undefined,
  live: ShareLiveState,
): string | undefined {
  const refused = operationRefusal(meta, "move");
  if (refused) return refused.error;
  if (!project?.sharedTo) return "Make this session's project shared first.";
  if (live.streaming) return "Wait until the session has finished responding.";
  if (live.liveSubagents) return "Wait until this session's subagents have finished.";
  return undefined;
}

/** Streaming needs a running Pi; subagents (detached ones too) can outlive it. */
export async function liveState(
  sessions: Pick<SessionManager, "get" | "detachedSlots">,
  id: string,
): Promise<ShareLiveState> {
  const live = sessions.get(id);
  if (!live) return { streaming: false, liveSubagents: false };
  const state = live.snapshot().state;
  let streaming = false;
  if (live.isRunning) {
    streaming = state.agentStatus !== "idle";
    if (!streaming)
      streaming = await live.getState().then(
        (s) => s.isStreaming === true,
        () => false,
      );
  }
  const liveSubagents =
    state.cells.some((cell) => cell.kind === "subagent" && cell.status === "running") ||
    sessions.detachedSlots(id) < MAX_DETACHED_SUBAGENTS;
  return { streaming, liveSubagents };
}

const shareBody = z
  .object({
    mode: z.enum(["snapshot", "conversation"]),
    /** The untracked files the user saw and agreed to send (snapshot). */
    untracked: z.array(z.string().max(4096)).max(100_000).optional(),
  })
  .strict();
const abortBody = z.object({ ref: z.string().optional(), handoff: z.string().optional() }).strict();
const sharedToBody = z
  .object({
    serverOrigin: z.string().url(),
    serverSessionId: z.string().uuid(),
    mode: z.enum(["snapshot", "conversation"]),
    handoff: z.string().uuid(),
  })
  .strict();

type Reply = { status(code: number): { send(body: unknown): unknown } };

/**
 * SRV-12c1, desktop (local backend): move a session to the shared server its
 * project is linked to (SRV-12b). The local backend never talks to the server:
 * it prepares the export (and, for a snapshot, pushes the working tree to a
 * transfer ref with the device's own git login); the renderer sends it through
 * Electron main, then records the link here, which freezes the session into a
 * read-only pointer. From the export until the link (or an abort) the session
 * is frozen by the "share" mutation claim: no prompt, delegation or history
 * change can slip into the gap.
 */
export function registerSessionShareRoutes(ctx: ServerContext): void {
  const { fastify, sessions, index, projects, broadcast } = ctx;
  const claims = sessions.mutationClaims;
  const metaOf = (id: string) => sessions.get(id)?.meta ?? index.find((s) => s.id === id);
  const projectOf = (meta: SessionMeta) =>
    meta.projectId ? projects.find((p) => p.id === meta.projectId) : undefined;
  const refuse = (reply: Reply, error: string) =>
    reply.status(409).send({ code: "share_refused", error });

  // One prepared move per session: the claim, its token and the pushed ref.
  const handoffs = createHandoffs(fastify, claims);
  const endHandoff = handoffs.end;
  const inProgress = (reply: Reply, error: string) =>
    reply.status(409).send({ code: "share_in_progress", error });

  fastify.post("/sessions/:id/share/preflight", async (request, reply) => {
    const { id } = request.params as { id: string };
    const meta = metaOf(id);
    if (!meta) return reply.status(404).send({ error: "unknown session" });
    if (ctx.sharedServer) return refuse(reply, "This session is already on a shared server.");
    const project = projectOf(meta);
    const refusal = shareRefusal(meta, project, await liveState(sessions, id));
    if (refusal) return refuse(reply, refusal);
    try {
      const plan = await gitSharePlan(meta.cwd);
      // ade-q0pz: the hook-free transfer push would leave LFS objects behind, so
      // only the conversation can move (a snapshot share is refused). A failed
      // detection counts as LFS.
      const lfs = await gitCarriesLfs(meta.cwd, { untracked: plan.untracked }).catch(() => true);
      return {
        plan: {
          ...(lfs ? { lfs: true } : {}),
          branch: plan.branch,
          head: plan.head,
          files: { tracked: plan.tracked, untracked: plan.untracked },
          dirtySubmodules: plan.dirtySubmodules,
          localCommits: plan.localCommits,
          sizeBytes: statSync(meta.piSessionFile!).size,
          serverOrigin: project!.sharedTo!.serverOrigin,
          projectId: project!.sharedTo!.projectId,
        },
      };
    } catch (error) {
      return refuse(reply, `The session's repository could not be read: ${gitErrorText(error)}`);
    }
  });

  fastify.post("/sessions/:id/share", async (request, reply) => {
    const parsed = shareBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { mode } = parsed.data;
    const { id } = request.params as { id: string };
    if (ctx.sharedServer) return refuse(reply, "This session is already on a shared server.");
    // A retry replaces this device's unfinished move of the same session, but
    // never one being finalized, and never forgets the ref the earlier one pushed.
    const blocked = await handoffs.replace(id);
    if (blocked === "finalizing")
      return inProgress(reply, "This session is being linked to the server right now.");
    if (blocked === "ref_left")
      return inProgress(
        reply,
        "The earlier move's transfer ref could not be removed. Cancel that move first.",
      );
    const release = handoffs.claim(id);
    if (!release)
      return reply.status(409).send({
        code: "session_mutation_busy",
        error: "Another session mutation is already in progress. Try again when it finishes.",
      });
    let kept = false;
    let pushed: PushedTransfer | undefined;
    try {
      const meta = metaOf(id);
      if (!meta) return reply.status(404).send({ error: "unknown session" });
      const project = projectOf(meta);
      const refusal = shareRefusal(meta, project, await liveState(sessions, id));
      if (refusal) return refuse(reply, refusal);
      // A snapshot of an LFS checkout is refused by prepareSessionExport (share_refused).
      const link = project!.sharedTo!;
      const prepared = await prepareSessionExport(ctx, meta, {
        mode,
        ...(parsed.data.untracked ? { untracked: parsed.data.untracked } : {}),
        device: deviceName(),
      });
      if ("status" in prepared) return reply.status(prepared.status).send(prepared.body);
      pushed = prepared.pushed;
      // Frozen until the link is written or the move is aborted (or expires).
      const token = handoffs.start(id, release, pushed, prepared.envelope.transcript);
      kept = true;
      return {
        envelope: prepared.envelope,
        serverOrigin: link.serverOrigin,
        projectId: link.projectId,
        handoff: token,
      };
    } finally {
      if (!kept) {
        release();
        // A pushed ref never outlives a failed answer.
        if (pushed) await handoffs.dropRef(id, pushed);
      }
    }
  });

  // Cancel a prepared move (unfreeze), and/or remove the transfer ref the device
  // pushed: after a refused import, and after every successful one (the device
  // proved it may push; the server's own delete can lack the rights).
  fastify.post("/sessions/:id/share/abort", async (request, reply) => {
    // Device-only, as preflight and share: on a shared server any member could
    // end another's hand-off (a return has its own owner-checked abort).
    if (ctx.sharedServer) return refuse(reply, "This session is already on a shared server.");
    const { id } = request.params as { id: string };
    const parsed = abortBody.safeParse(request.body);
    const ref = parsed.success ? parsed.data.ref : undefined;
    if (
      !parsed.success ||
      (ref !== undefined && (!validTransferRef(ref) || !ref.endsWith(`/${id}`)))
    )
      return reply.status(400).send({ error: "invalid transfer ref" });
    const meta = metaOf(id);
    if (!meta) return reply.status(404).send({ error: "unknown session" });
    // A finalizing link is never cancelled underneath it.
    if (parsed.data.handoff && !handoffs.get(id)?.finalizing) endHandoff(id, parsed.data.handoff);
    if (!ref) return { ok: true };
    try {
      const { root } = await gitSharePlan(meta.cwd);
      await gitDeleteTransferRef(root, ref);
      return { ok: true };
    } catch (error) {
      return reply.status(409).send({
        error: `The transfer ref could not be removed: ${redactSecrets(gitErrorText(error)).slice(-500)}`,
      });
    }
  });

  // The server took the session: freeze this copy into a pointer to it.
  fastify.patch("/sessions/:id/shared-to", async (request, reply) => {
    if (ctx.sharedServer)
      return reply.status(409).send({ error: "sharedTo is for local sessions only" });
    // SRV-12c2 Unlink: the pointer becomes a normal local session again, resumed
    // from its own Pi file (the server copy, if any, is left as it is).
    if (z.object({ sharedTo: z.null() }).strict().safeParse(request.body).success) {
      const { id } = request.params as { id: string };
      const meta = metaOf(id);
      if (!meta) return reply.status(404).send({ error: "unknown session" });
      if (!liveCopy(meta)) return { session: ctx.withActivity?.([meta])[0] ?? meta };
      const next: SessionMeta = { ...meta, location: withoutLiveCopy(meta.location) };
      index.upsert(next);
      const decorated = ctx.withActivity?.([next])[0] ?? next;
      broadcast({ type: "session_meta", session: decorated });
      return { session: decorated };
    }
    const parsed = sharedToBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { id } = request.params as { id: string };
    const { handoff, ...link } = parsed.data;
    // Only the move this export belongs to: a stale one (expired, replaced) is refused.
    const stale = () =>
      reply.status(409).send({
        code: "share_stale",
        error: "This move is no longer prepared here. Share the session again.",
      });
    const current = handoffs.get(id);
    if (current?.token !== handoff) return stale();
    if (current.finalizing)
      return inProgress(reply, "This session is being linked to the server right now.");
    // Exclusive from here: expiry, abort and a replacing share all give way.
    current.finalizing = true;
    const carried = current.transcriptSha256;
    const ours = () => handoffs.get(id) === current;
    try {
      return await finalize();
    } finally {
      if (ours()) current.finalizing = false;
    }

    async function finalize() {
      const meta = metaOf(id);
      if (!meta) return reply.status(404).send({ error: "unknown session" });
      if (sessionLifecycle(meta) === "pointer")
        return reply
          .status(409)
          .send({ code: "session_shared", error: "This session is already shared." });
      // Only the server this session's project is linked to.
      if (projectOf(meta)?.sharedTo?.serverOrigin !== link.serverOrigin)
        return reply
          .status(409)
          .send({ error: "The session's project is not shared on that server." });
      const live = await liveState(sessions, id);
      if (!ours()) return stale();
      if (live.streaming)
        return refuse(reply, "A turn is running in this session; stop it, then finish the move.");
      // The pointer runs no Pi: end the live process before freezing it.
      ctx.askUser.cancelSession(id);
      await sessions.destroy(id);
      if (!ours()) return stale();
      const latest = index.find((s) => s.id === id) ?? meta;
      const next: SessionMeta = {
        ...latest,
        location: {
          ...latest.location,
          kind: "local",
          live: {
            serverOrigin: link.serverOrigin,
            sessionId: link.serverSessionId,
            at: new Date().toISOString(),
            mode: link.mode,
          },
        },
        // The transcript the server copy started from.
        ...(carried ? { transcriptSha256: carried } : {}),
      };
      // A pointer is idle: not ended, parked, failed or waiting for review.
      delete next.endedAt;
      delete next.parkedAt;
      delete next.status;
      delete next.lastError;
      delete next.needsAttention;
      delete next.needsAttentionAt;
      index.upsert(next);
      endHandoff(id, handoff);
      ctx.events.sessionShared(next, userActor(requestUser(request.raw)), {
        direction: "out",
        mode: link.mode,
        serverOrigin: link.serverOrigin,
        serverSessionId: link.serverSessionId,
      });
      ctx.analytics?.track("session_moved", { direction: "out" });
      const decorated = ctx.withActivity?.([next])[0] ?? next;
      broadcast({ type: "session_meta", session: decorated });
      return { session: decorated };
    }
  });
}
