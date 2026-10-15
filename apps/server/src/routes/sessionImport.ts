import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import nodePath from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import { redactSecrets } from "@agent-deck/domain";
import type { LaunchPlan } from "@agent-deck/pi-host";
import { z } from "zod";
import { envDefaults, type ServerContext } from "../context.ts";
import { userActor } from "../eventProducers.ts";
import {
  createSessionWorktreeWithBranchRetries,
  gitCommitParents,
  gitDeleteOwnedWorktreeBranch,
  gitDeleteTransferRef,
  gitErrorText,
  gitFetchTransfer,
  gitResetMixedTo,
  gitWorktreePrune,
  gitWorktreeRegistrationMatches,
  SessionWorktreeAddError,
  type GitWorktree,
} from "../git.ts";
import { githubEnv, noCredentialHelperEnv } from "../githubConnections.ts";
import { resolveLaunchResources } from "../launchResources.ts";
import { serverLog } from "../serverLog.ts";
import {
  appendImportNotice,
  checkPiTranscript,
  MAX_TRANSFER_BYTES,
  rewriteTranscriptCwd,
  transcriptThinkingLevel,
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
  const { fastify, projects, index, sessionWorktreeStore, worktreesRoot, broadcast } = ctx;
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
      const earlier = index
        .list()
        .find(
          (s) =>
            s.sharedFrom?.localSessionId === envelope.localSessionId && s.createdBy?.id === user.id,
        );
      // The export's identity: a retry of the same move sends the same transcript.
      const exportSha256 = createHash("sha256").update(envelope.transcript).digest("hex");
      if (importing.has(key))
        return reply.status(409).send({
          code: "session_already_imported",
          error: "This session is being moved here right now. Try again later.",
          pending: true,
        });
      if (earlier) {
        const known = earlier.sharedFrom?.exportSha256;
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
        let startPoint: string | undefined;
        if (transfer.mode === "snapshot") {
          let fetched: string;
          try {
            fetched = await gitFetchTransfer(project!.path, transfer.ref, gitEnv);
          } catch (error) {
            return reply.status(409).send({
              code: "transfer_fetch_failed",
              error: token
                ? `The device's snapshot could not be fetched: ${redact(gitErrorText(error)).slice(-1_000)}`
                : "The device's snapshot could not be fetched. If the repository is private, connect GitHub first.",
            });
          }
          const parents = await gitCommitParents(project!.path, fetched).catch(() => []);
          if (
            fetched !== transfer.commit ||
            parents.length !== 1 ||
            parents[0] !== transfer.baseHead
          ) {
            return reply.status(409).send({
              code: "transfer_mismatch",
              error: "The fetched snapshot is not the one this session sent.",
            });
          }
          startPoint = fetched;
        }

        const id = randomUUID();
        const suffix = randomUUID().slice(0, 8);
        const target = nodePath.join(worktreesRoot, suffix);
        const transcriptDir =
          ctx.importedSessionsDir ?? nodePath.join(nodePath.dirname(worktreesRoot), "imported");
        const transcriptFile = nodePath.join(transcriptDir, `${id}.jsonl`);
        let reservation: string | undefined;
        let worktree: GitWorktree | undefined;
        let meta: SessionMeta;
        try {
          // The same allocation as an isolated session, always: the snapshot must
          // never land in the project's main checkout.
          reservation = sessionWorktreeStore.reserveWorktree(target);
          worktree = await createSessionWorktreeWithBranchRetries(
            project!.path,
            target,
            `agent-deck/session-${suffix}`,
            reservation,
            50,
            startPoint,
          );
          // --mixed (not --soft): the device's edits come back as unstaged changes
          // and its untracked files as untracked, as they were before the snapshot.
          if (transfer.mode === "snapshot") await gitResetMixedTo(target, transfer.baseHead);

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

          const defaults = envDefaults();
          // The level the session ran at is durable launch configuration: no
          // server default or agent level replaces it on this or any later resume.
          const thinking = transcriptThinkingLevel(envelope.transcript);
          const resolve = (choice: { provider?: string; model?: string }, agentName?: string) =>
            resolveLaunchResources(
              ctx,
              {
                cwd: target,
                projectId: project!.id,
                ...choice,
                ...(agentName ? { agentName } : {}),
              },
              defaults,
              {
                version: 1,
                ...(choice.provider ? { providerOverride: choice.provider } : {}),
                ...(choice.model ? { modelOverride: choice.model } : {}),
                ...(thinking ? { thinkingOverride: thinking } : {}),
              },
            );
          const choice = {
            ...(envelope.meta.provider ? { provider: envelope.meta.provider } : {}),
            ...(envelope.meta.model ? { model: envelope.meta.model } : {}),
          };
          let agentName = envelope.meta.agentName;
          let resolved;
          try {
            resolved = resolve(choice, agentName);
          } catch {
            // An agent this server does not have (or disabled): continue as a plain chat.
            if (!agentName)
              throw new Error("The session's launch settings are not available here.");
            agentName = undefined;
            dropped.push("agent");
            resolved = resolve(choice);
          }
          // The thinking level is not a launch flag here: Pi restores it on every
          // resume from the transcript's own thinking_level_change entries.
          const now = new Date().toISOString();
          meta = {
            id,
            cwd: target,
            createdAt: now,
            updatedAt: now,
            lifecycle: "started",
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
            launchPlan: resolved.plan,
            launchResourceConfig: resolved.config,
            launchResourceFingerprint: resolved.fingerprint,
            worktreePath: worktree.path,
            ...(worktree.identityToken ? { worktreeIdentity: worktree.identityToken } : {}),
            worktreeBranch: worktree.branch,
            worktreeSourceBranch: worktree.sourceBranch,
            sharedFrom: {
              device: envelope.device,
              localSessionId: envelope.localSessionId,
              sharedAt: now,
              mode: transfer.mode,
              exportSha256,
            },
          };
          // SRV-15a, as for a fork: the copy runs on the requester's providers, so
          // the model it inherits must be one they are offered.
          const gate = ctx.sessionModelGate;
          if (gate) {
            let pinned: SessionMeta;
            try {
              pinned = await gate.pin(meta, owner);
            } catch (error) {
              throw Object.assign(new Error((error as Error).message), { statusCode: 409 });
            }
            const refusal = await gate.refusal(pinned, owner);
            if (refusal) throw Object.assign(new Error(refusal), { statusCode: 409 });
            const plan = pinned.launchPlan as LaunchPlan;
            const before = meta.launchPlan as LaunchPlan;
            if (plan.provider !== before.provider || plan.model !== before.model) {
              // A refused model moved to its twin: record it like a launch override.
              const repinned = resolve({ provider: plan.provider, model: plan.model }, agentName);
              meta.launchPlan = repinned.plan;
              meta.launchResourceConfig = repinned.config;
              meta.launchResourceFingerprint = repinned.fingerprint;
            }
          }
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
          // A failed `git worktree add` still owns the branch it created.
          const attempt =
            worktree ?? (error instanceof SessionWorktreeAddError ? error.worktree : undefined);
          if (reservation) {
            const removed = await sessionWorktreeStore
              .deleteWorktree(target, reservation)
              .then(() => true)
              .catch(() => false);
            if (removed && attempt) {
              // Prune only a registration proven to be this attempt's.
              const registered = await gitWorktreeRegistrationMatches(
                project!.path,
                target,
                attempt.branch,
              ).catch(() => false);
              if (registered) await gitWorktreePrune(project!.path).catch(() => {});
              await gitDeleteOwnedWorktreeBranch(project!.path, attempt).catch(() => {});
            }
          }
          const status = (error as { statusCode?: unknown }).statusCode;
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
