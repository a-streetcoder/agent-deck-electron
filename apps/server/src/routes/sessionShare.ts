import { randomUUID } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { hostname } from "node:os";
import type { ProjectMeta, SessionMeta } from "@agent-deck/contracts";
import { redactSecrets } from "@agent-deck/domain";
import type { LaunchPlan } from "@agent-deck/pi-host";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { userActor } from "../eventProducers.ts";
import {
  gitDeleteTransferRef,
  gitErrorText,
  gitPushTransfer,
  gitSharePlan,
  gitSnapshotCommit,
  SnapshotPlanChangedError,
  validTransferRef,
} from "../git.ts";
import { MAX_DETACHED_SUBAGENTS, type SessionManager } from "../SessionManager.ts";
import { ALWAYS_DROPPED, checkPiTranscript, MAX_TRANSFER_BYTES } from "../sessionTransfer.ts";
import { requestUser } from "../trustedProxy.ts";

/** What a live session is doing that a move would tear apart. */
export interface ShareLiveState {
  streaming: boolean;
  liveSubagents: boolean;
}

/** How long a prepared move holds the session frozen without being finished. */
export const HANDOFF_TTL_MS = 15 * 60_000;

const hostOf = (origin: string): string => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/** The device name as the server accepts it (letters, digits, dot, dash, underscore). */
export const deviceName = (name: string = hostname()): string =>
  name.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 200) || "device";

/** Why this session cannot move to the shared server now, or undefined when it can. */
export function shareRefusal(
  meta: SessionMeta,
  project: ProjectMeta | undefined,
  live: ShareLiveState,
): string | undefined {
  if (meta.sharedTo)
    return `This session already continues on ${hostOf(meta.sharedTo.serverOrigin)}.`;
  if (meta.lifecycle === "draft" || !meta.piSessionFile)
    return "This session has nothing to move yet: send a first message.";
  if (meta.loopReviewRunId || meta.agentName?.startsWith("Loop ·"))
    return "A Loop session cannot move to a server.";
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

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const left = [...a].sort();
  const right = [...b].sort();
  return left.length === right.length && left.every((name, i) => name === right[i]);
};

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
type Transfer =
  | { mode: "snapshot"; ref: string; commit: string; baseHead: string }
  | { mode: "conversation" };

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
  const handoffs = new Map<
    string,
    {
      token: string;
      release: () => void;
      timer: NodeJS.Timeout;
      ref?: string;
      root?: string;
      /** shared-to is publishing the pointer: nothing may end or replace it now. */
      finalizing?: boolean;
    }
  >();
  const inProgress = (reply: Reply, error: string) =>
    reply.status(409).send({ code: "share_in_progress", error });
  const endHandoff = (id: string, token?: string, dropRef = false): boolean => {
    const handoff = handoffs.get(id);
    if (!handoff || (token !== undefined && handoff.token !== token)) return false;
    clearTimeout(handoff.timer);
    handoffs.delete(id);
    handoff.release();
    if (dropRef && handoff.ref && handoff.root)
      void gitDeleteTransferRef(handoff.root, handoff.ref).catch(() => {});
    return true;
  };
  fastify.addHook("onClose", async () => {
    for (const id of [...handoffs.keys()]) endHandoff(id);
  });

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
      return {
        plan: {
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
    const previous = handoffs.get(id);
    if (previous?.finalizing)
      return inProgress(reply, "This session is being linked to the server right now.");
    if (previous?.ref && previous.root) {
      try {
        await gitDeleteTransferRef(previous.root, previous.ref);
      } catch {
        return inProgress(
          reply,
          "The earlier move's transfer ref could not be removed. Cancel that move first.",
        );
      }
    }
    if (previous) {
      if (handoffs.get(id) !== previous || previous.finalizing)
        return inProgress(reply, "This session is being linked to the server right now.");
      endHandoff(id, previous.token);
    }
    const release = claims.tryClaim(id, "share");
    if (!release)
      return reply.status(409).send({
        code: "session_mutation_busy",
        error: "Another session mutation is already in progress. Try again when it finishes.",
      });
    let pushed: { ref: string; root: string } | undefined;
    let kept = false;
    try {
      const meta = metaOf(id);
      if (!meta) return reply.status(404).send({ error: "unknown session" });
      const project = projectOf(meta);
      const refusal = shareRefusal(meta, project, await liveState(sessions, id));
      if (refusal) return refuse(reply, refusal);
      const link = project!.sharedTo!;

      // Everything that can fail is read before anything is pushed.
      let transcript: string;
      try {
        if (statSync(meta.piSessionFile!).size > MAX_TRANSFER_BYTES) throw new Error("too large");
        transcript = readFileSync(meta.piSessionFile!, "utf8");
        checkPiTranscript(transcript);
      } catch (error) {
        return refuse(
          reply,
          (error as Error).message === "too large"
            ? "This session's transcript is larger than 16 MB and cannot move."
            : `This session's transcript cannot move: ${(error as Error).message}.`,
        );
      }
      const plan = meta.launchPlan as LaunchPlan | undefined;
      const model = plan && plan.kind !== "helper" ? plan : undefined;
      let stored;
      try {
        stored = ctx.composerDrafts?.get(id) ?? null;
      } catch {
        return refuse(reply, "This session's unsent message could not be read.");
      }
      const dropped: string[] = [...ALWAYS_DROPPED];
      if (stored && (stored.files.length > 0 || stored.folders.length > 0))
        dropped.push("draft attachments");
      const envelope = {
        version: 1 as const,
        localSessionId: id,
        device: deviceName(),
        meta: {
          ...(meta.title ? { title: meta.title.slice(0, 200) } : {}),
          ...(meta.titleUserEdited ? { titleUserEdited: true } : {}),
          ...(meta.agentName ? { agentName: meta.agentName } : {}),
          ...(model?.provider ? { provider: model.provider } : {}),
          ...(model?.model ? { model: model.model } : {}),
          ...(meta.subagentsEnabled !== undefined
            ? { subagentsEnabled: meta.subagentsEnabled }
            : {}),
          ...(meta.plan?.length
            ? { plan: meta.plan.map(({ runId: _runId, note: _note, ...item }) => item) }
            : {}),
        },
        transcript,
        authors: ctx.sessionAuthors?.exportTurns(id) ?? [],
        pastes: ctx.sessionPastes.exportTurns(id),
        draft: stored ? { ...stored, files: [], folders: [] } : null,
        transfer: { mode: "conversation" } as Transfer,
        dropped,
      };
      // Sized with the longest transfer it can carry, so a push never happens for nothing.
      const longest: Transfer = {
        mode: "snapshot",
        ref: `refs/heads/agent-deck/transfer/${id}`,
        commit: "0".repeat(64),
        baseHead: "0".repeat(64),
      };
      if (
        Buffer.byteLength(JSON.stringify({ ...envelope, transfer: longest })) > MAX_TRANSFER_BYTES
      )
        return refuse(
          reply,
          "This session is larger than 16 MB with its attachments and cannot move.",
        );

      if (mode === "snapshot") {
        let sharePlan;
        try {
          sharePlan = await gitSharePlan(meta.cwd);
        } catch (error) {
          return refuse(
            reply,
            `The session's repository could not be read: ${gitErrorText(error)}`,
          );
        }
        // The user agreed to a list of untracked files: send that list or ask again.
        if (!parsed.data.untracked || !sameSet(parsed.data.untracked, sharePlan.untracked))
          return reply.status(409).send({
            code: "share_plan_changed",
            error: "The untracked files changed since you looked. Check the list again.",
            untracked: sharePlan.untracked,
          });
        if (sharePlan.dirtySubmodules.length > 0)
          return reply.status(409).send({
            code: "share_snapshot_unavailable",
            error: `Submodules with their own changes cannot travel in a snapshot (${sharePlan.dirtySubmodules.join(", ")}).`,
            fallback: "conversation",
          });
        try {
          // Stages exactly the consented untracked files, or refuses before writing.
          const commit = await gitSnapshotCommit(
            sharePlan.root,
            `agent-deck transfer ${id}`,
            parsed.data.untracked,
          );
          const ref = await gitPushTransfer(sharePlan.root, commit, id);
          pushed = { ref, root: sharePlan.root };
          envelope.transfer = { mode: "snapshot", ref, commit, baseHead: sharePlan.head };
        } catch (error) {
          if (error instanceof SnapshotPlanChangedError) {
            const now = await gitSharePlan(meta.cwd).catch(() => sharePlan);
            return reply.status(409).send({
              code: "share_plan_changed",
              error: "The untracked files changed since you looked. Check the list again.",
              untracked: now.untracked,
            });
          }
          // The working tree was not touched; offer the conversation-only move.
          return reply.status(409).send({
            code: "share_push_failed",
            error: `The snapshot could not be pushed: ${redactSecrets(gitErrorText(error)).slice(-1_000)}`,
            fallback: "conversation",
          });
        }
      }

      // Frozen until the link is written or the move is aborted (or expires).
      const token = randomUUID();
      handoffs.set(id, {
        token,
        release,
        // Expiry gives way to a finalizing link, which ends the hand-off itself.
        timer: setTimeout(() => {
          if (!handoffs.get(id)?.finalizing) endHandoff(id, token, true);
        }, HANDOFF_TTL_MS).unref(),
        ...(pushed ?? {}),
      });
      kept = true;
      return {
        envelope,
        serverOrigin: link.serverOrigin,
        projectId: link.projectId,
        handoff: token,
      };
    } finally {
      if (!kept) {
        release();
        // A pushed ref never outlives a failed answer.
        if (pushed) await gitDeleteTransferRef(pushed.root, pushed.ref).catch(() => {});
      }
    }
  });

  // Cancel a prepared move (unfreeze), and/or remove the transfer ref the device
  // pushed: after a refused import, and after every successful one (the device
  // proved it may push; the server's own delete can lack the rights).
  fastify.post("/sessions/:id/share/abort", async (request, reply) => {
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
      if (!meta.sharedTo) return { session: ctx.withActivity?.([meta])[0] ?? meta };
      const next: SessionMeta = { ...meta };
      delete next.sharedTo;
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
    const ours = () => handoffs.get(id) === current;
    try {
      return await finalize();
    } finally {
      if (ours()) current.finalizing = false;
    }

    async function finalize() {
      const meta = metaOf(id);
      if (!meta) return reply.status(404).send({ error: "unknown session" });
      if (meta.sharedTo)
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
        sharedTo: { ...link, sharedAt: new Date().toISOString() },
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
      const decorated = ctx.withActivity?.([next])[0] ?? next;
      broadcast({ type: "session_meta", session: decorated });
      return { session: decorated };
    }
  });
}
