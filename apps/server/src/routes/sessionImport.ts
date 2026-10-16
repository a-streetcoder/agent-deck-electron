import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import { SESSION_RECORD_VERSION, type SessionMeta } from "@agent-deck/contracts";
import { actorRef, liveCopy, redactSecrets, sessionOwner } from "@agent-deck/domain";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import { userActor } from "../eventProducers.ts";
import { gitDeleteTransferRef, gitErrorText } from "../git.ts";
import { githubEnv, noCredentialHelperEnv } from "../githubConnections.ts";
import { serverLog } from "../serverLog.ts";
import {
  appendImportNotice,
  checkPiTranscript,
  createTransferWorktree,
  fetchTransferSnapshot,
  MAX_TRANSFER_BYTES,
  rewriteTranscriptCwd,
  transcriptSha256,
  TransferFetchError,
  resolveTransferLaunch,
  TransferModelError,
  transferEnvelopeSchema,
} from "../sessionTransfer.ts";
import { requestUser } from "../trustedProxy.ts";

/**
 * SRV-12c1, shared server: `POST /projects/:id/sessions/import` takes a session a
 * member's device moved here (sessionTransfer.ts) and makes it a NEW session of
 * the shared project, owned by the requester. A snapshot move fetches the
 * device's transfer ref first, branches the session worktree from it and undoes
 * the snapshot commit, so the device's edits are uncommitted changes again. The
 * session is registered resumable, not live: opening it resumes Pi from the
 * imported transcript.
 */
export function registerSessionImportRoutes(ctx: ServerContext): void {
  const { fastify, projects, index, worktreesRoot, broadcast } = ctx;
  /** Imports in flight, by requester and device session (see the duplicate check). */
  const importing = new Set<string>();

  fastify.post(
    "/projects/:id/sessions/import",
    // The transcript can be large; JSON escaping adds a little on top of the cap.
    { bodyLimit: MAX_TRANSFER_BYTES + 1024 * 1024 },
    async (request, reply) => {
      if (!ctx.sharedServer)
        return reply.status(409).send({ error: "Importing a session needs a shared server." });
      const user = requestUser(request.raw);
      if (!user) return reply.status(403).send({ error: "sign in to import a session" });
      const projectId = z
        .string()
        .uuid()
        .safeParse((request.params as { id: string }).id);
      if (!projectId.success) return reply.status(400).send({ error: "invalid project id" });
      const project = projects.find((item) => item.id === projectId.data && !item.hidden);
      if (!project) return reply.status(404).send({ error: "unknown project" });
      if (!project.origin)
        return reply
          .status(409)
          .send({ error: "Sessions can move only into a project shared from a repository." });
      const parsed = transferEnvelopeSchema.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return reply.status(400).send({
          code: "invalid_envelope",
          error: `The session export is not valid: ${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}`,
        });
      }
      const envelope = parsed.data;
      // SRV-12c3: a return goes to a device (import-return), never into a server project.
      if (envelope.direction === "return")
        return reply.status(400).send({
          code: "invalid_envelope",
          error: "The session export is not valid: a returned session is not imported here.",
        });
      try {
        checkPiTranscript(envelope.transcript);
      } catch (error) {
        return reply.status(400).send({
          code: "invalid_envelope",
          error: `The session export is not valid: ${(error as Error).message}`,
        });
      }
      const transfer = envelope.transfer;
      const dropped = [...envelope.dropped];
      // One import per member and device session. The key is the verified
      // requester plus the session id (the device name is the device's word),
      // reserved before the first await so two concurrent posts cannot both pass.
      const key = `${user.id}\u0000${envelope.localSessionId}`;
      // SRV-12c3: a copy that went back to the device is not the session any more;
      // moving it here again makes a new copy.
      const earlier = index.list().find((s) => {
        const from = s.provenance?.kind === "imported" ? s.provenance.from : undefined;
        return (
          !!from &&
          "localSessionId" in from &&
          from.localSessionId === envelope.localSessionId &&
          sessionOwner(s)?.id === user.id &&
          !liveCopy(s)
        );
      });
      // The export's identity: a retry of the same move sends the same transcript.
      const exportSha256 = transcriptSha256(envelope.transcript);
      if (importing.has(key))
        return reply.status(409).send({
          code: "session_already_imported",
          error: "This session is being moved here right now. Try again later.",
          pending: true,
        });
      if (earlier) {
        const known = earlier.transcriptSha256;
        if (known !== undefined && known !== exportSha256)
          return reply.status(409).send({
            code: "export_changed",
            error:
              "This server already has an earlier copy of this session, and this export differs from it.",
            sessionId: earlier.id,
          });
        return reply.status(409).send({
          code: "session_already_imported",
          error: "This session was already moved here.",
          sessionId: earlier.id,
        });
      }
      importing.add(key);
      try {
        return await importOne();
      } finally {
        importing.delete(key);
      }

      async function importOne() {
        // The requester's GitHub connection fetches and deletes the transfer ref;
        // without one, inherited helpers are cleared (never the server's credentials).
        const tokenEnv = githubEnv(user, ctx.githubConnections);
        const token = tokenEnv.GH_TOKEN;
        const gitEnv = token ? tokenEnv : noCredentialHelperEnv();
        const redact = (text: string) =>
          redactSecrets(token ? text.split(token).join("<secret>") : text);
        const owner = { id: user!.id, ...(user!.name ? { name: user!.name } : {}) };

        // Fetch first (oracle): nothing is allocated until the snapshot is here.
        if (transfer.mode === "snapshot") {
          try {
            await fetchTransferSnapshot(project!.path, transfer, gitEnv);
          } catch (error) {
            if (!(error instanceof TransferFetchError) || error.code === "transfer_mismatch")
              return reply.status(409).send({
                code: "transfer_mismatch",
                error: "The fetched snapshot is not the one this session sent.",
              });
            return reply.status(409).send({
              code: "transfer_fetch_failed",
              error: token
                ? `The device's snapshot could not be fetched: ${redact(error.message).slice(-1_000)}`
                : "The device's snapshot could not be fetched. If the repository is private, connect GitHub first.",
            });
          }
        }

        const id = randomUUID();
        const transcriptDir =
          ctx.importedSessionsDir ?? nodePath.join(nodePath.dirname(worktreesRoot), "imported");
        const transcriptFile = nodePath.join(transcriptDir, `${id}.jsonl`);
        let made: Awaited<ReturnType<typeof createTransferWorktree>> | undefined;
        let meta: SessionMeta;
        try {
          // The same allocation as an isolated session, always: the snapshot must
          // never land in the project's main checkout.
          made = await createTransferWorktree(
            ctx,
            project!.path,
            transfer.mode === "snapshot" ? transfer : undefined,
          );
          const { worktree } = made;
          const target = worktree.path;

          // The header cwd is the only rewrite (Pi resumes in it); a conversation
          // move also tells the model the device's edits did not come along.
          let transcript = rewriteTranscriptCwd(envelope.transcript, target);
          if (transfer.mode === "conversation") {
            transcript = appendImportNotice(
              transcript,
              `Earlier edits from ${envelope.device} are not in this workspace.`,
            );
          }
          mkdirSync(transcriptDir, { recursive: true, mode: 0o700 });
          writeFileSync(transcriptFile, transcript, { flag: "wx", mode: 0o600 });

          // The level the session ran at, its agent and model: the same
          // resolution a return uses (sessionTransfer.ts), checked against the
          // requester's providers (SRV-15a, as for a fork).
          const launch = await resolveTransferLaunch(
            ctx,
            envelope,
            { id, cwd: target, projectId: project!.id, sessionFile: transcriptFile },
            owner,
          );
          if (launch.droppedAgent) dropped.push("agent");
          const agentName = launch.agentName;
          const now = new Date().toISOString();
          meta = {
            id,
            cwd: target,
            createdAt: now,
            updatedAt: now,
            schemaVersion: SESSION_RECORD_VERSION,
            createdBy: owner,
            projectId: project!.id,
            ...(agentName ? { agentName } : {}),
            ...(envelope.meta.title ? { title: envelope.meta.title } : {}),
            ...(envelope.meta.titleUserEdited ? { titleUserEdited: true } : {}),
            piSessionFile: transcriptFile,
            ...(envelope.meta.plan?.length ? { plan: envelope.meta.plan } : {}),
            ...(envelope.meta.subagentsEnabled !== undefined
              ? { subagentsEnabled: envelope.meta.subagentsEnabled }
              : {}),
            launch: launch.launch,
            workspace: {
              path: worktree.path,
              ...(worktree.identityToken ? { identity: worktree.identityToken } : {}),
              branch: worktree.branch,
              sourceBranch: worktree.sourceBranch,
            },
            provenance: {
              kind: "imported",
              from: { device: envelope.device, localSessionId: envelope.localSessionId },
              by: actorRef(owner),
              at: now,
              mode: transfer.mode,
            },
            location: { kind: "server", owner },
            // The export's identity: a retry must send the same transcript.
            transcriptSha256: exportSha256,
          };
          // Re-keyed under the new id; the paste store re-checks every turn.
          try {
            ctx.sessionPastes.importTurns(id, envelope.pastes);
          } catch {
            throw Object.assign(new Error("The session export has an invalid paste."), {
              statusCode: 400,
            });
          }
          // Attribution is not the device's to assign: every imported turn is the
          // requester's (a member cannot import messages in another's name).
          ctx.sessionAuthors?.importTurns(
            id,
            envelope.authors.map((turn) => ({ ...turn, author: owner })),
          );
          if (envelope.draft) ctx.composerDrafts?.put(id, envelope.draft);
          index.upsert(meta);
        } catch (error) {
          // Nothing was published: remove every piece this attempt wrote.
          try {
            ctx.sessionPastes.deleteSession(id);
            ctx.sessionAuthors?.deleteSession(id);
            ctx.composerDrafts?.delete(id);
          } catch {
            // Best effort: the session id was never published.
          }
          rmSync(transcriptFile, { force: true });
          await made?.discard();
          const status =
            error instanceof TransferModelError
              ? 409
              : (error as { statusCode?: unknown }).statusCode;
          if (status === 400)
            return reply
              .status(400)
              .send({ code: "invalid_envelope", error: (error as Error).message });
          if (status === 409)
            return reply
              .status(409)
              .send({ code: "model_unavailable", error: (error as Error).message });
          serverLog.warn("sessions", "session import failed", error);
          return reply.status(500).send({
            code: "session_import_failed",
            error: `The session could not be imported: ${redact(gitErrorText(error)).slice(-500)}`,
          });
        }
        const actor = userActor(user);
        ctx.events.sessionCreated(meta, actor);
        ctx.events.sessionShared(meta, actor, {
          direction: "in",
          mode: transfer.mode,
          localSessionId: envelope.localSessionId,
          device: envelope.device,
        });
        broadcast({ type: "session_meta", session: ctx.withActivity?.([meta])[0] ?? meta });
        // The ref did its job. The requester may not be allowed to delete it (no
        // token for a public repository, a read-only one): the device, which
        // pushed it, deletes it too after recording the link.
        let transferRefDeleted = false;
        if (transfer.mode === "snapshot") {
          transferRefDeleted = await gitDeleteTransferRef(project!.path, transfer.ref, gitEnv).then(
            () => true,
            (error: unknown) => {
              serverLog.warn(
                "sessions",
                "transfer ref could not be deleted",
                redact(gitErrorText(error)),
              );
              return false;
            },
          );
        }
        return reply.status(201).send({
          sessionId: id,
          dropped,
          mode: transfer.mode,
          worktree: true,
          transferRefDeleted,
        });
      }
    },
  );
}
