import { randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { readFile, realpath } from "node:fs/promises";
import nodePath from "node:path";
import type { ProjectMeta, SessionModelInfo } from "@agent-deck/contracts";
import type { PromptInfo } from "@agent-deck/domain";
import { SubagentArtifactCapabilityError } from "@agent-deck/loop-catalog-native";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import { listProjectFiles, scanPrompts } from "@agent-deck/resources";
import { z } from "zod";
import {
  canonicalWorktreePath,
  createSessionWorktreeWithBranchRetries,
  gitCheckoutBranch,
  gitCommitAll,
  gitCommitsAhead,
  gitCurrentBranch,
  gitDeleteOwnedWorktreeBranch,
  gitDeleteOwnedWorktreeBranchCas,
  gitErrorText,
  gitHasUnmergedEntries,
  gitLocalBranchRef,
  gitMergeInProgress,
  gitMergeNoCheckout,
  gitOperationInProgress,
  gitOwnedWorktreeBranchOid,
  gitRepositoryIdentity,
  gitWorkingTreeClean,
  gitWorktreePrune,
  gitWorktreeRegistrationAtPath,
  gitWorktreeRegistrationMatches,
  gitWorktreeRegistrations,
  SessionWorktreeAddError,
  type GitWorktree,
} from "../git.ts";
import {
  SessionCreationError,
  SubagentTranscriptEvidenceError,
  type LaunchPlan,
} from "../SessionManager.ts";
import { asThinkingLevel, envDefaults, type ServerContext } from "../context.ts";
import { HistoryActionCoordinator, HistoryActionError } from "../historyActions.ts";
import { SessionMutationClaims } from "../sessionMutationClaims.ts";
import { finalizeExtensions } from "./shared.ts";

const mergeLocks = new Set<string>();

const createSessionBody = z.object({
  cwd: z.string().optional(),
  projectId: z.string().optional(),
  /** Launch an agent-backed session: inject this agent's system prompt/tools/skills. */
  agentName: z.string().optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  extensions: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  /** Extra env for the pi subprocess (tests use this for a hermetic HOME). */
  env: z.record(z.string()).optional(),
});

/**
 * Session routes — list/search, create (incl. worktree isolation and
 * agent-backed launches), resume/rename/delete, merge/fork, and the live pi
 * state screens. Moved verbatim from server.ts.
 */
export function registerSessionRoutes(ctx: ServerContext): void {
  const {
    fastify,
    sessions,
    index,
    projects,
    settings,
    bridgeTokens,
    askUser,
    worktreesRoot,
    sessionWorktreeStore,
    broadcast,
    rootsFor,
    skillStore,
    resolveNamedAgent,
    enabledExtensionPaths,
    dropDiffCache,
    prepareProjectMcpSession,
  } = ctx;

  const sessionMutations = new SessionMutationClaims();
  const historyActions = new HistoryActionCoordinator(
    sessions,
    index,
    ctx.sessionImages,
    ctx.sessionPastes,
    sessionMutations,
    () => envDefaults().env,
    (sessionId) => broadcast({ type: "session_rebind", sessionId }),
  );

  let fileSearchSequence = 0;
  const activeFileSearches = new Map<
    string,
    { controller: AbortController; sequence: number; token: symbol }
  >();
  fastify.addHook("onClose", async () => {
    for (const search of activeFileSearches.values()) search.controller.abort();
    activeFileSearches.clear();
  });

  // Electron receives only the stable opaque run UUID. The native capability
  // re-proves the app-owned root immediately before this path crosses to main.
  fastify.get("/subagent-runs/:id/artifact-directory", async (request, reply) => {
    const parsed = z
      .string()
      .uuid()
      .safeParse((request.params as { id: string }).id);
    if (!parsed.success) return reply.status(400).send({ error: "invalid subagent run id" });
    const supplied = request.headers["x-agent-deck-desktop-recovery-token"];
    const expected = process.env.AGENT_DECK_DESKTOP_RECOVERY_TOKEN;
    if (!expected || supplied !== expected) return reply.status(403).send({ error: "forbidden" });
    try {
      const directory = sessions.subagentArtifactDirectoryForReveal(parsed.data);
      if (!directory)
        return reply.status(404).send({ error: "Subagent artifacts are unavailable" });
      return { directory };
    } catch {
      return reply.status(409).send({ error: "Subagent artifacts could not be revalidated" });
    }
  });

  fastify.get(
    "/sessions/:parentSessionId/subagent-runs/:runId/transcript",
    async (request, reply) => {
      const parsed = z
        .object({ parentSessionId: z.string().uuid(), runId: z.string().uuid() })
        .safeParse(request.params);
      if (!parsed.success) {
        return reply.status(400).send({
          code: "SUBAGENT_TRANSCRIPT_INVALID_ID",
          error: "Parent session and child run IDs must be UUIDs.",
        });
      }
      const { parentSessionId, runId } = parsed.data;
      const parent =
        sessions.get(parentSessionId)?.meta ?? index.find((item) => item.id === parentSessionId);
      if (!parent) {
        return reply.status(404).send({
          code: "SUBAGENT_TRANSCRIPT_NOT_FOUND",
          error: "Child transcript was not found.",
        });
      }
      try {
        const snapshot = await sessions.subagentTranscript(parentSessionId, runId, parent.cwd);
        if (!snapshot) {
          return reply.status(404).send({
            code: "SUBAGENT_TRANSCRIPT_NOT_FOUND",
            error: "Child transcript was not found.",
          });
        }
        return { transcript: snapshot };
      } catch (error) {
        if (
          error instanceof SubagentArtifactCapabilityError ||
          error instanceof SubagentTranscriptEvidenceError
        ) {
          return reply.status(409).send({
            code: "SUBAGENT_TRANSCRIPT_UNSAFE_EVIDENCE",
            error: "The child session evidence could not be safely revalidated.",
          });
        }
        request.log.warn({ err: error, runId }, "child transcript reconstruction failed");
        return reply.status(502).send({
          code: "SUBAGENT_TRANSCRIPT_READER_FAILED",
          error:
            "The child transcript could not be reconstructed. Retry after restarting Agent Deck.",
        });
      }
    },
  );

  // Live pi session state (model, thinking level, streaming flags) and the
  // available-model catalog — the composer's picker data.
  fastify.get("/sessions/:id/state", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessions.get(id);
    if (!session) return reply.status(404).send({ error: "unknown session" });
    try {
      return { state: await session.getState() };
    } catch (error) {
      return reply.status(500).send({ error: String(error) });
    }
  });

  // Live token / cost / context-usage totals for a session (native session
  // context-usage indicator). Returns pi's get_session_stats verbatim; the
  // context-usage percent is null until the first LLM response.
  fastify.get("/sessions/:id/stats", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessions.get(id);
    if (!session) return reply.status(404).send({ error: "unknown session" });
    try {
      return { stats: await session.getSessionStats() };
    } catch (error) {
      return reply.status(500).send({ error: String(error) });
    }
  });

  fastify.get("/sessions/:id/models", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessions.get(id);
    if (!session) return reply.status(404).send({ error: "unknown session" });
    try {
      const models = await session.getAvailableModels();
      // Mark models the user hid from the picker (app-level, native "Disabled").
      const disabled = new Set(settings.get().disabledModels);
      return {
        models: models.map(
          (model) =>
            ({
              // Preserve the existing Pi catalog payload for older clients.
              ...model,
              // Pi owns model/provider-specific omissions (including xhigh/max).
              supportedThinkingLevels: getSupportedThinkingLevels(model),
              disabled: disabled.has(`${model.provider}:${model.id}`),
            }) satisfies SessionModelInfo,
        ),
      };
    } catch (error) {
      return reply.status(500).send({ error: String(error) });
    }
  });

  // Session slash commands (skills/prompts pi actually loaded) — also how
  // tests verify that assigned --skill flags landed inside pi.
  fastify.get("/sessions/:id/commands", async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = sessions.get(id);
    if (!session) return reply.status(404).send({ error: "unknown session" });
    try {
      return { commands: await session.getCommands() };
    } catch (error) {
      return reply.status(500).send({ error: String(error) });
    }
  });

  // Project-relative file list for `@`-file autocomplete, scoped to the
  // selected session's authoritative cwd. The exhaustive async walk remains
  // bounded in memory and is cancelled when its requester disconnects.
  fastify.get("/sessions/:id/files", async (request, reply) => {
    const { id } = request.params as { id: string };
    const { q } = request.query as { q?: string };
    const session = sessions.get(id);
    if (!session) return reply.status(404).send({ error: "unknown session" });
    const query = typeof q === "string" ? q.trim() : "";
    if (!query) return { files: [] as string[] };

    // Serialize scans for the same canonical cwd. A newer query supersedes the
    // older search, while token-checked cleanup cannot remove the replacement.
    // Sequence assignment precedes canonicalization so out-of-order realpath
    // completion cannot let an older request cancel a newer one.
    const sequence = ++fileSearchSequence;
    const token = Symbol("file-search");
    const controller = new AbortController();
    const onRequestAborted = (): void => controller.abort();
    const onReplyClose = (): void => {
      if (!reply.raw.writableEnded) controller.abort();
    };
    request.raw.once("aborted", onRequestAborted);
    reply.raw.once("close", onReplyClose);
    if (request.raw.aborted) controller.abort();

    const rootKey = await realpath(session.meta.cwd).catch(() =>
      nodePath.resolve(session.meta.cwd),
    );
    const activeSearch = activeFileSearches.get(rootKey);
    if (activeSearch && activeSearch.sequence > sequence) {
      controller.abort();
    } else if (!controller.signal.aborted) {
      activeSearch?.controller.abort();
      activeFileSearches.set(rootKey, { controller, sequence, token });
    }

    try {
      return {
        files: await listProjectFiles(session.meta.cwd, query, {
          limit: 50,
          signal: controller.signal,
        }),
      };
    } catch (error) {
      if (controller.signal.aborted) {
        return reply.status(499).send({ error: "file search cancelled" });
      }
      throw error;
    } finally {
      request.raw.off("aborted", onRequestAborted);
      reply.raw.off("close", onReplyClose);
      if (activeFileSearches.get(rootKey)?.token === token) activeFileSearches.delete(rootKey);
    }
  });

  fastify.get("/sessions", async (request) => {
    const { projectId } = request.query as { projectId?: string };
    // Live sessions win over persisted index entries (same id).
    const live = sessions.list();
    const liveIds = new Set(live.map((s) => s.id));
    const all = [...index.list().filter((s) => !liveIds.has(s.id)), ...live].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    return { sessions: projectId ? all.filter((s) => s.projectId === projectId) : all };
  });

  // Content search across sessions (native Sessions search 18.1 "by title or
  // content"): scans each session's pi session file — the canonical transcript,
  // uniform for live and ended sessions — for the query. Title matching stays on
  // the client; this adds the content half, returning the matching session ids.
  fastify.get("/sessions/search", async (request) => {
    const q = String((request.query as { q?: string }).q ?? "")
      .trim()
      .toLowerCase();
    if (!q) return { ids: [] as string[] };
    const withFiles = index.list().filter((meta) => meta.piSessionFile);
    const ids: string[] = [];
    // Scan in bounded batches so a large session history can't exhaust file
    // descriptors (EMFILE). The message text is embedded as JSON string values,
    // so a lowercase substring match over the whole file finds it (it may
    // occasionally match structural JSON — an acceptable false-positive for a
    // free-text search).
    const BATCH = 24;
    for (let i = 0; i < withFiles.length; i += BATCH) {
      const hits = await Promise.all(
        withFiles.slice(i, i + BATCH).map(async (meta) => {
          try {
            const content = await readFile(meta.piSessionFile!, "utf8");
            return content.toLowerCase().includes(q) ? meta.id : null;
          } catch {
            return null; // unreadable / since-deleted file — skip
          }
        }),
      );
      for (const id of hits) if (id) ids.push(id);
    }
    return { ids };
  });

  // Reopen a session: live ones are returned as-is; ended ones are relaunched
  // against their pi session file with the transcript rebuilt from pi's
  // canonical history (never from our own logs).
  fastify.post("/sessions/:id/resume", async (request, reply) => {
    const { id } = request.params as { id: string };
    const live = sessions.get(id);
    if (live?.isRunning) return { session: live.meta };
    const meta = live?.meta ?? index.find((s) => s.id === id);
    if (!meta) return reply.status(404).send({ error: "unknown session" });
    // A session with no pi session file never ran a turn (a draft, or an old
    // entry from before session files existed). It has nothing to restore, but
    // opening it should still work — sessions.resume launches a FRESH parent pi
    // (resumeSessionPath is undefined) with the session's project/agent context
    // and an empty transcript, rather than erroring.
    const defaults = envDefaults();
    try {
      const session = await sessions.resume(
        meta,
        {
          kind: "parent",
          resumeSessionPath: meta.piSessionFile,
          provider: defaults.provider,
          model: defaults.model,
          // Include provider-registration extensions so a session with no stored
          // launch plan (old/draft) still relaunches with its provider available.
          extensions: [...(defaults.extensions ?? []), ...(defaults.providerExtensions ?? [])],
        },
        defaults.env,
      );
      return { session: session.meta };
    } catch (error) {
      return reply.status(500).send({ error: String(error) });
    }
  });

  // Rename: updates pi's session name (when live) and the persisted title.
  fastify.patch("/sessions/:id", async (request, reply) => {
    const parsed = z.object({ title: z.string().trim().min(1).max(200) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { id } = request.params as { id: string };
    const live = sessions.get(id);
    if (live) {
      await live.rename(parsed.data.title);
      return { session: live.meta };
    }
    const meta = index.find((s) => s.id === id);
    if (!meta) return reply.status(404).send({ error: "unknown session" });
    const next = { ...meta, title: parsed.data.title, updatedAt: new Date().toISOString() };
    index.upsert(next);
    broadcast({ type: "session_meta", session: next });
    return { session: next };
  });

  // Acknowledge-only attention mutation. The backend is the sole authority
  // allowed to raise this marker; renderer callers can only send literal false.
  // Preserve updatedAt: reviewing a chat is not new chat activity.
  fastify.patch("/sessions/:id/attention", async (request, reply) => {
    const parsed = z
      .object({ needsAttention: z.literal(false) })
      .strict()
      .safeParse(request.body);
    if (!parsed.success)
      return reply.status(400).send({ error: "only attention acknowledgement is allowed" });
    const { id } = request.params as { id: string };
    const releaseMutation = sessionMutations.tryClaim(id, "attention");
    if (!releaseMutation) {
      return reply.status(409).send({ error: "another session mutation is in progress" });
    }
    try {
      const live = sessions.get(id);
      const current = live?.meta ?? index.find((session) => session.id === id);
      if (!current) return reply.status(404).send({ error: "unknown session" });
      if (current.needsAttention !== true) return { session: current };

      if (live) live.meta.needsAttention = false;
      // Delete/history share this claim. Re-prove membership and re-read the
      // authoritative metadata at the write edge: an internal audit callback may
      // have added sensitive prompt evidence after this handler's first snapshot.
      const latest = sessions.get(id)?.meta ?? index.find((session) => session.id === id);
      if (!latest) return reply.status(404).send({ error: "unknown session" });
      const next = { ...latest, needsAttention: false as const };
      index.upsert(next);
      broadcast({ type: "session_meta", session: next });
      return { session: next };
    } finally {
      releaseMutation();
    }
  });

  // Pinning is a structural list action, not session activity. Preserve
  // updatedAt, keep repeated pin requests idempotent, and order pins by the
  // first timestamp at which each session became pinned.
  fastify.patch("/sessions/:id/pin", async (request, reply) => {
    const parsed = z.object({ pinned: z.boolean() }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { id } = request.params as { id: string };
    const live = sessions.get(id);
    const current = live?.meta ?? index.find((session) => session.id === id);
    if (!current) return reply.status(404).send({ error: "unknown session" });

    const pinnedAt = parsed.data.pinned
      ? (current.pinnedAt ?? new Date().toISOString())
      : undefined;
    if (pinnedAt === current.pinnedAt) return { session: current };

    if (live) {
      if (pinnedAt) live.meta.pinnedAt = pinnedAt;
      else delete live.meta.pinnedAt;
    }
    // Re-read immediately before persistence so an internal prompt-audit write
    // cannot be clobbered by this route's earlier shallow metadata snapshot.
    const latest = sessions.get(id)?.meta ?? index.find((session) => session.id === id);
    if (!latest) return reply.status(404).send({ error: "unknown session" });
    const next = { ...latest, pinnedAt };
    index.upsert(next);
    broadcast({ type: "session_meta", session: next });
    return { session: next };
  });

  // Delete: stop the live process, drop the index entry, remove the pi
  // session file. Session content is destroyed — this is the explicit delete.
  fastify.delete("/sessions/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const releaseMutation = sessionMutations.tryClaim(id, "delete");
    if (!releaseMutation) {
      return reply.status(409).send({
        code: "session_mutation_busy",
        error: "Another session mutation is already in progress. Try again when it finishes.",
      });
    }
    try {
      let meta = sessions.get(id)?.meta ?? index.find((s) => s.id === id);
      if (!meta) return reply.status(404).send({ error: "unknown session" });
      let isolatedCleanup:
        | {
            projectPath: string;
            worktreePath: string;
            worktreeIdentity: string;
            worktreeBranch: string;
            sourceBranch: string;
            expectedOid: string;
          }
        | { alreadyGone: true }
        | undefined;
      const worktreeDependent = index
        .list()
        .find((candidate) => candidate.id !== id && candidate.worktreeOwnerSessionId === id);
      if (worktreeDependent) {
        return reply.status(409).send({
          code: "session_worktree_in_use",
          error:
            "A history-fork session still depends on this isolated worktree. Delete dependent sessions before deleting its owner.",
        });
      }
      // Retained Loop review evidence is explicitly outside this boundary. Before
      // stopping an ordinary session, prove no other session record owns the same
      // normalized path. Persisted metadata is untrusted and may be duplicated.
      if (meta.worktreePath && !meta.loopReviewRunId) {
        const targetKey = await canonicalWorktreePath(meta.worktreePath);
        const live = sessions.list();
        const otherRecords = [
          ...live,
          ...index.list().filter((candidate) => !live.some((item) => item.id === candidate.id)),
        ].filter((candidate) => candidate.id !== id && candidate.worktreePath);
        for (const candidate of otherRecords) {
          if ((await canonicalWorktreePath(candidate.worktreePath!)) === targetKey) {
            return reply.status(409).send({
              code: "session_worktree_cleanup_failed",
              error:
                "The isolated worktree is also referenced by another session. No session data was removed.",
            });
          }
        }
        const projectId = meta.projectId;
        const worktreePath = meta.worktreePath;
        const worktreeBranch = meta.worktreeBranch;
        const project = projectId
          ? projects.find((candidate) => candidate.id === projectId)
          : undefined;
        if (!projectId || !project || !worktreeBranch) {
          return reply.status(409).send({
            code: "session_worktree_cleanup_failed",
            error:
              "The isolated worktree lacks trusted project/branch ownership. The worktree path and session metadata were retained for manual recovery.",
          });
        }
        // Always inspect Git, including when the leaf is physically missing: a
        // stale registration for another branch must never be silently pruned.
        let registration: { path: string; branch?: string } | undefined;
        try {
          registration = await gitWorktreeRegistrationAtPath(project.path, worktreePath);
        } catch {
          return reply.status(409).send({
            code: "session_worktree_cleanup_failed",
            error: "Git worktree ownership could not be verified. Session metadata was retained.",
          });
        }
        const physicallyPresent = existsSync(worktreePath);
        if (physicallyPresent) {
          if (!registration || registration.branch !== worktreeBranch) {
            return reply.status(409).send({
              code: "session_worktree_cleanup_failed",
              error:
                "Git does not register this isolated worktree to the session's expected branch. Session metadata was retained.",
            });
          }
          if (!meta.worktreeIdentity) {
            try {
              const worktreeIdentity = sessionWorktreeStore.captureWorktreeIdentity(worktreePath);
              const adopted = { ...meta, worktreeIdentity };
              index.upsert(adopted);
              const liveSession = sessions.get(id);
              if (liveSession) liveSession.meta.worktreeIdentity = worktreeIdentity;
              meta = adopted;
            } catch {
              return reply.status(409).send({
                code: "session_worktree_cleanup_failed",
                error:
                  "This legacy session's worktree identity could not be safely adopted. Its path and metadata were retained.",
              });
            }
          }
          const worktreeIdentity = meta.worktreeIdentity;
          let expectedOid: string | undefined;
          try {
            if (
              !worktreeIdentity ||
              sessionWorktreeStore.captureWorktreeIdentity(worktreePath) !== worktreeIdentity ||
              (await gitRepositoryIdentity(worktreePath)) !==
                (await gitRepositoryIdentity(project.path))
            ) {
              throw new Error("worktree ownership mismatch");
            }
            expectedOid = await gitOwnedWorktreeBranchOid(project.path, worktreeBranch);
            if (!expectedOid) throw new Error("owned branch missing");
          } catch {
            return reply.status(409).send({
              code: "session_worktree_cleanup_failed",
              error:
                "The isolated worktree's native, repository, or branch identity could not be verified. Session metadata was retained.",
            });
          }
          try {
            const prepared = { ...meta, worktreeCleanupBranchHead: expectedOid };
            index.upsert(prepared);
            const liveSession = sessions.get(id);
            if (liveSession) liveSession.meta.worktreeCleanupBranchHead = expectedOid;
            meta = prepared;
          } catch {
            return reply.status(409).send({
              code: "session_worktree_cleanup_failed",
              error:
                "The expected branch object could not be durably recorded. No worktree data was removed.",
            });
          }
          isolatedCleanup = {
            projectPath: project.path,
            worktreePath,
            worktreeIdentity,
            worktreeBranch,
            sourceBranch: meta.worktreeSourceBranch ?? "",
            expectedOid,
          };
        } else if (registration) {
          const expectedOid = meta.worktreeCleanupBranchHead;
          if (
            registration.branch !== worktreeBranch ||
            !meta.worktreeIdentity ||
            !expectedOid ||
            !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(expectedOid)
          ) {
            return reply.status(409).send({
              code: "session_worktree_cleanup_failed",
              error:
                "The missing worktree does not retain exact registered branch cleanup evidence. Metadata was retained and no branch was touched.",
            });
          }
          isolatedCleanup = {
            projectPath: project.path,
            worktreePath,
            worktreeIdentity: meta.worktreeIdentity,
            worktreeBranch,
            sourceBranch: meta.worktreeSourceBranch ?? "",
            expectedOid,
          };
        } else {
          let branchOid: string | undefined;
          try {
            branchOid = await gitOwnedWorktreeBranchOid(project.path, worktreeBranch);
          } catch {
            return reply.status(409).send({
              code: "session_worktree_cleanup_failed",
              error: "Branch state could not be verified. Session metadata was retained.",
            });
          }
          if (branchOid) {
            return reply.status(409).send({
              code: "session_worktree_cleanup_failed",
              error:
                "The worktree registration is absent while its branch still exists. Metadata was retained and the branch was not touched.",
            });
          }
          isolatedCleanup = { alreadyGone: true };
        }
      }
      // Resolve parent bridge waits before destroying their transcript owner.
      askUser.cancelSession(id);
      await sessions.destroy(id);
      // Child worktrees are rooted in the parent's authoritative checkout. Remove
      // them after all child scopes settle but before an isolated parent checkout
      // itself can be deleted. Any proof/cleanup failure retains every remaining
      // child record, artifact, and parent session row for a safe retry.
      try {
        await sessions.removeSubagentRuns?.(id);
      } catch {
        return reply.status(409).send({
          code: "subagent_worktree_cleanup_failed",
          error:
            "The session was stopped, but app-owned child cleanup could not complete safely. Metadata for every unfinished child was retained; a worktree already marked physically removed may remain removed. Resolve the Git/worktree issue and retry deletion.",
        });
      }
      // The stale exact Git registration remains the destructive-cleanup authority:
      // native removal -> CAS ref deletion -> prune. A CAS failure deliberately leaves
      // the registration untouched so a restart can prove and retry the same operation.
      if (isolatedCleanup && !("alreadyGone" in isolatedCleanup)) {
        try {
          await sessionWorktreeStore.deleteWorktree(
            isolatedCleanup.worktreePath,
            isolatedCleanup.worktreeIdentity,
          );
        } catch {
          return reply.status(409).send({
            code: "session_worktree_cleanup_failed",
            error:
              "The session was stopped, but its isolated worktree could not be safely removed. Session metadata was retained; retry deletion after resolving the cleanup issue.",
          });
        }
        let registration: { path: string; branch?: string } | undefined;
        try {
          registration = await gitWorktreeRegistrationAtPath(
            isolatedCleanup.projectPath,
            isolatedCleanup.worktreePath,
          );
        } catch {
          return reply.status(409).send({
            code: "session_worktree_branch_cleanup_failed",
            error:
              "The worktree was removed, but its Git registration could not be reverified. Metadata was retained and no branch was touched.",
          });
        }
        if (!registration) {
          const branchOid = await gitOwnedWorktreeBranchOid(
            isolatedCleanup.projectPath,
            isolatedCleanup.worktreeBranch,
          ).catch(() => "unknown");
          if (branchOid) {
            return reply.status(409).send({
              code: "session_worktree_branch_cleanup_failed",
              error:
                "The worktree registration disappeared while its branch still exists. Metadata was retained and the branch was not touched.",
            });
          }
        } else {
          if (registration.branch !== isolatedCleanup.worktreeBranch) {
            return reply.status(409).send({
              code: "session_worktree_branch_cleanup_failed",
              error:
                "The retained worktree registration no longer matches the expected branch. Metadata was retained and no branch was touched.",
            });
          }
          try {
            await gitDeleteOwnedWorktreeBranchCas(
              isolatedCleanup.projectPath,
              {
                path: isolatedCleanup.worktreePath,
                branch: isolatedCleanup.worktreeBranch,
                sourceBranch: isolatedCleanup.sourceBranch,
                identityToken: isolatedCleanup.worktreeIdentity,
                branchOwned: true,
              },
              isolatedCleanup.expectedOid,
            );
            await gitWorktreePrune(isolatedCleanup.projectPath);
          } catch {
            return reply.status(409).send({
              code: "session_worktree_branch_cleanup_failed",
              error: `The session was stopped and its worktree was removed, but exact app-owned branch ${isolatedCleanup.worktreeBranch} cleanup could not complete. Its Git registration and durable metadata were retained; resolve the Git issue and retry deletion.`,
            });
          }
        }
      }
      sessions.removeLoopSessionSnapshot(id);
      index.remove(id);
      bridgeTokens.delete(id);
      // Image ownership is removed only after every authoritative session deletion
      // step above succeeded; failed worktree cleanup intentionally retains it.
      try {
        ctx.sessionImages.deleteSession(id);
      } catch {
        // Session deletion already committed; retain shared blobs for conservative GC.
      }
      try {
        ctx.sessionPastes.deleteSession(id);
      } catch {
        // Session deletion already committed; retain optional paste metadata conservatively.
      }
      if (meta.piSessionFile) {
        try {
          rmSync(meta.piSessionFile, { force: true });
        } catch {
          // pi may still hold the file briefly; best-effort.
        }
      }
      broadcast({ type: "session_removed", sessionId: id });
      return { ok: true };
    } finally {
      releaseMutation();
    }
  });

  // Merge an ordinary isolated session into its source branch. Ownership and
  // every non-mutating preflight complete before auto-commit or checkout.
  fastify.post("/sessions/:id/merge", async (request, reply) => {
    const { id } = request.params as { id: string };
    const releaseMutation = sessionMutations.tryClaim(id, "merge");
    if (!releaseMutation) {
      return reply.status(409).send({
        code: "session_mutation_busy",
        outcome: "busy",
        error: "Another session mutation is already in progress. Try again when it finishes.",
        worktreeCommitted: false,
      });
    }
    try {
      const liveSession = sessions.get(id);
      const meta = liveSession?.meta ?? index.find((s) => s.id === id);
      if (!meta)
        return reply.status(404).send({
          code: "merge_session_missing",
          outcome: "failed",
          error: "Unknown session.",
          worktreeCommitted: false,
        });
      // This must remain before native identity and all Git calls.
      if (meta.loopReviewRunId) {
        return reply.status(409).send({
          code: "loop_review_read_only",
          outcome: "read_only",
          error: "Loop review sessions are read-only. Merge and apply are unavailable.",
          worktreeCommitted: false,
        });
      }

      const worktreeDependent = index
        .list()
        .find((candidate) => candidate.id !== id && candidate.worktreeOwnerSessionId === id);
      if (worktreeDependent) {
        return reply.status(409).send({
          code: "merge_worktree_in_use",
          outcome: "stale_ownership",
          error:
            "A history-fork session still depends on this isolated worktree. Delete dependent sessions before merging its owner.",
          worktreeCommitted: false,
        });
      }

      const fail = (
        status: number,
        code: string,
        outcome: string,
        error: string,
        worktreeCommitted = false,
      ) => reply.status(status).send({ code, outcome, error, worktreeCommitted });
      const {
        cwd,
        worktreePath,
        worktreeIdentity,
        worktreeBranch,
        worktreeSourceBranch,
        projectId,
      } = meta;
      // One merge follows the policy selected when it started; a concurrent
      // preference toggle applies to the next merge, not halfway through this one.
      const keepWorktreeAfterMerge = settings.get().keepWorktreeAfterMerge;
      // Renderer idle state is advisory. Refuse from server truth when Pi is
      // writing, and fail closed if its state cannot be read. Cleanup may later
      // stop an idle Pi before removing the cwd, but it must never race a turn.
      if (liveSession?.isRunning) {
        try {
          if ((await liveSession.getState()).isStreaming) {
            return fail(
              409,
              "merge_runtime_busy",
              "busy",
              "Wait for the current Pi turn to finish before merging.",
            );
          }
        } catch {
          return fail(
            409,
            "merge_runtime_state_unavailable",
            "busy",
            "Pi runtime state could not be verified. Stop or reopen the session before merging.",
          );
        }
      }
      if (
        !cwd ||
        !projectId ||
        !worktreePath ||
        !worktreeIdentity ||
        !worktreeBranch ||
        !worktreeSourceBranch
      ) {
        return fail(
          409,
          "merge_stale_ownership",
          "stale_ownership",
          "This session's isolated-worktree ownership metadata is incomplete.",
        );
      }
      const project = projects.find((p) => p.id === projectId);
      if (!project)
        return fail(
          409,
          "merge_stale_ownership",
          "stale_ownership",
          "This session no longer belongs to an exact registered project.",
        );

      let worktreeKey: string;
      let sessionCwdKey: string;
      try {
        [worktreeKey, sessionCwdKey] = await Promise.all([
          canonicalWorktreePath(worktreePath),
          canonicalWorktreePath(cwd),
        ]);
      } catch {
        return fail(
          409,
          "merge_path_validation_failed",
          "stale_ownership",
          "The session and isolated-worktree paths can no longer be safely resolved.",
        );
      }
      if (sessionCwdKey !== worktreeKey) {
        return fail(
          409,
          "merge_stale_ownership",
          "stale_ownership",
          "The session checkout no longer matches its registered worktree.",
        );
      }
      const owners = [...index.list(), ...sessions.list()];
      const ownerIds = new Set<string>();
      try {
        for (const owner of owners) {
          if (
            owner.worktreePath &&
            (await canonicalWorktreePath(owner.worktreePath)) === worktreeKey
          )
            ownerIds.add(owner.id);
        }
      } catch {
        return fail(
          409,
          "merge_path_validation_failed",
          "stale_ownership",
          "Persisted session worktree paths can no longer be safely resolved.",
        );
      }
      if (ownerIds.size !== 1 || !ownerIds.has(id)) {
        return fail(
          409,
          "merge_stale_ownership",
          "stale_ownership",
          "Multiple sessions claim this isolated worktree.",
        );
      }
      let capturedIdentity: string;
      try {
        capturedIdentity = sessionWorktreeStore.captureWorktreeIdentity(worktreePath);
      } catch {
        return fail(
          409,
          "merge_stale_ownership",
          "stale_ownership",
          "The isolated worktree's native identity can no longer be verified.",
        );
      }
      if (capturedIdentity !== worktreeIdentity) {
        return fail(
          409,
          "merge_stale_ownership",
          "stale_ownership",
          "The isolated worktree has been replaced since this session was created.",
        );
      }

      let projectKey: string;
      try {
        projectKey = await canonicalWorktreePath(project.path);
      } catch {
        return fail(
          409,
          "merge_path_validation_failed",
          "stale_ownership",
          "The registered project path can no longer be safely resolved.",
        );
      }
      if (mergeLocks.has(projectKey)) {
        return fail(
          409,
          "merge_busy",
          "busy",
          "Another merge is already in progress for this project.",
        );
      }
      mergeLocks.add(projectKey);
      let worktreeCommitted = false;
      try {
        let registration;
        try {
          registration = await gitWorktreeRegistrationAtPath(project.path, worktreePath);
          if (!registration || registration.branch !== worktreeBranch)
            throw new Error("registration mismatch");
          if (
            (await gitRepositoryIdentity(project.path)) !==
            (await gitRepositoryIdentity(worktreePath))
          )
            throw new Error("repository mismatch");
          await gitLocalBranchRef(project.path, worktreeBranch);
        } catch {
          return fail(
            409,
            "merge_stale_ownership",
            "stale_ownership",
            "Git no longer registers this exact worktree, branch, and project repository.",
          );
        }
        try {
          await gitLocalBranchRef(project.path, worktreeSourceBranch);
        } catch {
          return fail(
            409,
            "merge_source_missing",
            "stale_ownership",
            "The registered source branch no longer exists or is invalid.",
          );
        }

        let parentBranch: string;
        try {
          if (await gitOperationInProgress(project.path))
            return fail(
              409,
              "merge_parent_busy",
              "busy",
              "Finish or abort the Git operation in the project checkout before merging.",
            );
          if (!(await gitWorkingTreeClean(project.path)))
            return fail(
              409,
              "merge_parent_dirty",
              "dirty",
              "Commit, stash, or discard all project-checkout changes before merging.",
            );
          parentBranch = await gitCurrentBranch(project.path);
          const registrations = await gitWorktreeRegistrations(project.path);
          const sourceOwners = registrations.filter((item) => item.branch === worktreeSourceBranch);
          for (const owner of sourceOwners) {
            let ownerKey: string;
            try {
              ownerKey = await canonicalWorktreePath(owner.path);
            } catch {
              return fail(
                409,
                "merge_path_validation_failed",
                "stale_ownership",
                "A registered Git worktree path can no longer be safely resolved.",
              );
            }
            if (ownerKey !== projectKey) {
              return fail(
                409,
                "merge_source_occupied",
                "stale_ownership",
                "The source branch is checked out in another worktree. Close or switch that checkout before merging.",
              );
            }
          }
          if (await gitOperationInProgress(worktreePath))
            return fail(
              409,
              "merge_worktree_busy",
              "busy",
              "Finish or abort the Git operation in the session worktree before merging.",
            );
          if ((await gitCurrentBranch(worktreePath)) !== worktreeBranch)
            return fail(
              409,
              "merge_stale_ownership",
              "stale_ownership",
              "The session worktree is no longer on its registered branch.",
            );
        } catch (error) {
          return fail(
            409,
            "merge_preflight_failed",
            "failed",
            `Merge preflight failed: ${gitErrorText(error)}`,
          );
        }

        if (parentBranch !== worktreeSourceBranch) {
          try {
            await gitCheckoutBranch(project.path, worktreeSourceBranch);
          } catch (error) {
            return fail(
              409,
              "merge_source_checkout_failed",
              "failed",
              `Couldn't check out the source branch: ${gitErrorText(error)}`,
            );
          }
        }
        try {
          if (
            (await gitCurrentBranch(project.path)) !== worktreeSourceBranch ||
            (await gitOperationInProgress(project.path)) ||
            !(await gitWorkingTreeClean(project.path))
          ) {
            return fail(
              409,
              "merge_parent_changed",
              "stale_ownership",
              "The project checkout changed during merge preflight. Review it and try again.",
            );
          }
          const currentRegistration = await gitWorktreeRegistrationAtPath(
            project.path,
            worktreePath,
          );
          if (
            currentRegistration?.branch !== worktreeBranch ||
            (await gitCurrentBranch(worktreePath)) !== worktreeBranch
          ) {
            return fail(
              409,
              "merge_stale_ownership",
              "stale_ownership",
              "The session worktree ownership changed during merge preflight.",
            );
          }
          if (await gitOperationInProgress(worktreePath)) {
            return fail(
              409,
              "merge_worktree_busy",
              "busy",
              "Finish or abort the Git operation in the session worktree before merging.",
            );
          }
        } catch (error) {
          return fail(
            409,
            "merge_preflight_failed",
            "failed",
            `Merge preflight failed: ${gitErrorText(error)}`,
          );
        }

        try {
          await gitCommitAll(worktreePath, `Agent Deck: ${meta.title ?? "session"} changes`);
          worktreeCommitted = true;
          // Auto-commit empties the session's working-tree diff even when a later
          // ahead check or merge fails; never replay the stale pre-commit cache.
          dropDiffCache(id);
        } catch (error) {
          if (!(error instanceof Error && error.message === "nothing_to_commit")) {
            return fail(
              409,
              "merge_worktree_commit_failed",
              "failed",
              `Couldn't commit the session worktree: ${gitErrorText(error)}`,
              worktreeCommitted,
            );
          }
        }

        let ahead: number;
        try {
          ahead = await gitCommitsAhead(project.path, worktreeBranch, worktreeSourceBranch);
        } catch (error) {
          return fail(
            500,
            "merge_ahead_failed",
            "failed",
            `Couldn't determine commits ahead: ${gitErrorText(error)}`,
            worktreeCommitted,
          );
        }
        if (ahead === 0)
          return fail(
            400,
            "merge_nothing_to_merge",
            "nothing_to_merge",
            "Nothing to merge — the session made no commits.",
            worktreeCommitted,
          );

        try {
          await gitMergeNoCheckout(project.path, worktreeBranch);
        } catch (error) {
          const conflict = await gitHasUnmergedEntries(project.path).catch(() => false);
          const mergeActive = await gitMergeInProgress(project.path).catch(() => false);
          if (conflict) {
            return fail(
              409,
              "merge_conflict",
              "conflict",
              "Merge conflict detected. Resolve the conflicts and commit the merge, or abort it in the project checkout.",
              worktreeCommitted,
            );
          }
          if (mergeActive) {
            return fail(
              409,
              "merge_active_failure",
              "failed",
              `Git prepared the merge but couldn't create its commit: ${gitErrorText(error)} Fix the reported issue and complete the merge commit, or abort the merge in the project checkout.`,
              worktreeCommitted,
            );
          }
          return fail(
            500,
            "merge_failed",
            "failed",
            `Merge failed: ${gitErrorText(error)}`,
            worktreeCommitted,
          );
        }
        dropDiffCache(id);

        const retainedSuccess = () => ({
          ok: true as const,
          code: "merge_succeeded" as const,
          outcome: "merged" as const,
          branch: worktreeBranch,
          sourceBranch: worktreeSourceBranch,
          commits: ahead,
          worktreeCommitted,
          cleanup: { status: "retained" as const, runtimeStopped: false },
        });
        if (keepWorktreeAfterMerge) return retainedSuccess();

        // The merge is committed at this point. Cleanup is deliberately a typed
        // secondary outcome: it can never turn the successful merge into an HTTP
        // failure. Re-check Pi immediately before teardown, then await process and
        // session-owned child cleanup before deleting its cwd (especially required
        // for Windows directory locks).
        let runtimeStopped = false;
        if (liveSession) {
          try {
            const runtimeWasRunning = liveSession.isRunning;
            if (runtimeWasRunning && (await liveSession.getState()).isStreaming) {
              return {
                ...retainedSuccess(),
                cleanup: {
                  status: "failed" as const,
                  runtimeStopped,
                  code: "runtime_busy" as const,
                  error:
                    "The merge succeeded, but Pi started another turn before cleanup. Wait for it to finish, then delete the session to retry worktree removal.",
                },
              };
            }
            await sessions.destroy(id);
            runtimeStopped = runtimeWasRunning;
          } catch {
            return {
              ...retainedSuccess(),
              cleanup: {
                status: "failed" as const,
                runtimeStopped,
                code: "runtime_shutdown_failed" as const,
                error:
                  "The merge succeeded, but Pi could not be stopped safely. The worktree and branch were retained; wait for or stop Pi, then delete the session to retry worktree removal.",
              },
            };
          }
        }
        if (sessions.get(id)) {
          return {
            ...retainedSuccess(),
            cleanup: {
              status: "failed" as const,
              runtimeStopped,
              code: "runtime_shutdown_failed" as const,
              error:
                "The merge succeeded, but the session runtime still owns its worktree. Wait for or stop Pi, then delete the session to retry worktree removal.",
            },
          };
        }

        try {
          await sessionWorktreeStore.deleteWorktree(worktreePath, worktreeIdentity);
        } catch {
          return {
            ...retainedSuccess(),
            cleanup: {
              status: "failed" as const,
              runtimeStopped,
              code: "worktree_remove_failed" as const,
              error:
                "The merge succeeded, but the worktree could not be removed. Its session metadata and branch were retained; close programs using it, then delete the session to retry worktree removal.",
            },
          };
        }

        // Physical removal succeeded, so returning cwd to the registered project
        // is now mandatory before publishing metadata. Keep branch metadata until
        // its conclusively-owned ref has also been deleted.
        const withoutWorktree = { ...meta, cwd: project.path };
        delete withoutWorktree.worktreePath;
        delete withoutWorktree.worktreeIdentity;
        delete withoutWorktree.worktreeSourceBranch;
        delete withoutWorktree.worktreeCleanupBranchHead;
        index.upsert(withoutWorktree);
        broadcast({ type: "session_meta", session: withoutWorktree });

        try {
          await gitWorktreePrune(project.path);
          await gitDeleteOwnedWorktreeBranch(project.path, {
            path: worktreePath,
            branch: worktreeBranch,
            sourceBranch: worktreeSourceBranch,
            identityToken: worktreeIdentity,
            branchOwned: true,
          });
        } catch {
          return {
            ...retainedSuccess(),
            cleanup: {
              status: "failed" as const,
              runtimeStopped,
              code: "branch_remove_failed" as const,
              error: `The merge succeeded and the worktree was removed, but branch ${worktreeBranch} could not be deleted. Inspect it and delete it manually when safe.`,
            },
          };
        }

        const cleaned = { ...withoutWorktree };
        delete cleaned.worktreeBranch;
        index.upsert(cleaned);
        broadcast({ type: "session_meta", session: cleaned });
        return {
          ...retainedSuccess(),
          cleanup: { status: "removed" as const, runtimeStopped },
        };
      } finally {
        mergeLocks.delete(projectKey);
      }
    } finally {
      releaseMutation();
    }
  });

  const historyActionBody = z.object({ entryId: z.string().trim().min(1).max(500) });
  for (const action of ["fork", "rerun"] as const) {
    fastify.post(`/sessions/:id/history/${action}`, async (request, reply) => {
      const parsed = historyActionBody.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          code: "history_invalid_request",
          error: "A stable Pi entry id is required.",
        });
      }
      const { id } = request.params as { id: string };
      try {
        const result = await historyActions.run(id, parsed.data.entryId, action);
        return reply.status(result.outcome === "forked" ? 201 : 200).send(result);
      } catch (error) {
        if (error instanceof HistoryActionError) {
          return reply
            .status(error.code === "history_source_missing" ? 404 : 409)
            .send({ code: error.code, error: error.message });
        }
        request.log.warn({ err: error, sessionId: id, action }, "history action failed");
        return reply.status(500).send({
          code: "history_failed",
          error: "The history action failed. Reopen the session and try again.",
        });
      }
    });
  }

  // Fork/duplicate: copy the source's pi session file and launch an
  // independent resumed session from the copy. The original is untouched.
  fastify.post("/sessions/:id/fork", async (request, reply) => {
    const { id } = request.params as { id: string };
    const live = sessions.get(id);
    const meta = live?.meta ?? index.find((s) => s.id === id);
    if (!meta) return reply.status(404).send({ error: "unknown session" });
    if (!meta.piSessionFile || !existsSync(meta.piSessionFile)) {
      return reply.status(409).send({ error: "session has no history to fork yet" });
    }
    // Copying a session file mid-write (streaming) can yield a torn copy the
    // fork can't resume — refuse while the source is actively responding.
    if (live?.isRunning) {
      try {
        const state = await live.getState();
        if (state.isStreaming) {
          return reply.status(409).send({ error: "cannot fork while the session is responding" });
        }
      } catch {
        // Couldn't read state — proceed; the source file is only appended to.
      }
    }
    const ext = nodePath.extname(meta.piSessionFile);
    const base = nodePath.basename(meta.piSessionFile, ext);
    const dir = nodePath.dirname(meta.piSessionFile);
    // Full UUID + existence check so the fork can never overwrite another file.
    let copyTo = "";
    do {
      copyTo = nodePath.join(dir, `${base}-fork-${randomUUID()}${ext}`);
    } while (existsSync(copyTo));
    try {
      const session = await sessions.fork(meta, meta.piSessionFile, copyTo, envDefaults().env);
      index.upsert(session.meta);
      return reply.status(201).send({ session: session.meta });
    } catch (error) {
      return reply.status(500).send({ error: String(error) });
    }
  });

  fastify.post("/sessions", async (request, reply) => {
    const parsed = createSessionBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    const body = parsed.data;
    const defaults = envDefaults();
    let cwd = body.cwd ?? defaults.cwd ?? process.cwd();
    let project: ProjectMeta | undefined;
    if (body.projectId) {
      project = projects.find((p) => p.id === body.projectId);
      if (!project) return reply.status(404).send({ error: "unknown project" });
      cwd = project.path;
    }

    // Resolve every non-mutating launch input before allocating a worktree. Once
    // isolation is requested for a registered project it is mandatory: no
    // validation failure may leave a branch/worktree behind, and no Git failure
    // may silently redirect Pi into the primary checkout.
    let worktree: GitWorktree | null = null;

    // Resolve provider + model. Precedence: explicit request → the user's default
    // model (native onboarding preference) → env default. The default model is
    // stored provider-qualified ("provider:id") so it launches under the RIGHT
    // provider — a bare id can't disambiguate two providers exposing the same id.
    let provider = body.provider ?? defaults.provider;
    let model = body.model;
    if (model === undefined) {
      const defaultModel = settings.get().defaultModel; // "provider:id" | "id" | null
      if (defaultModel) {
        const sep = defaultModel.indexOf(":");
        if (sep > 0) {
          if (body.provider === undefined) provider = defaultModel.slice(0, sep);
          model = defaultModel.slice(sep + 1);
        } else {
          model = defaultModel; // unqualified — launch under the resolved provider
        }
      }
    }
    model = model ?? defaults.model;
    // Base extensions (request or env defaults) + the user's enabled ones,
    // deduped and re-validated as real files at launch time.
    const baseExtensions = body.extensions ?? defaults.extensions ?? [];
    // Named agents resolve their own default-vs-explicit catalog policy below.
    // Plain/anonymous parents retain the global enabled catalog behavior.
    const finalizedBase = finalizeExtensions([
      ...baseExtensions,
      ...(body.agentName ? [] : enabledExtensionPaths(body.projectId)),
    ]);
    const extensions = finalizedBase.length > 0 ? finalizedBase : undefined;

    // Default + project skill assignments become explicit --skill paths on
    // parent sessions (pi-rpc-launch-flags.md §1: "Default + current Project
    // skill assignments"). Applied at session creation; a running session
    // keeps its flags until relaunched.
    // CONTRACT GAP: bridge/audit/web extensions and APPEND_SYSTEM.md
    // preservation are still missing here (M2).
    let assignedSkillPaths: string[] | undefined;
    {
      const disabledSkills = new Set(settings.get().disabledSkills);
      const names = [...settings.get().defaultSkills, ...(project?.assignedSkills ?? [])].filter(
        (name) => !disabledSkills.has(name), // disabled skills are never injected
      );
      if (names.length > 0) {
        // Combined discovery is already deterministic: standard catalogs win
        // same-name collisions over read-only in-place collections.
        const skillsByName = new Map(skillStore.listSkills(body.projectId).map((s) => [s.name, s]));
        const missing = [...new Set(names)].filter((name) => !skillsByName.has(name));
        if (missing.length > 0) {
          fastify.log.warn({ missing }, "assigned skills not found in catalog");
        }
        const paths = [...new Set(names)]
          .map((name) => skillsByName.get(name)?.baseDir)
          .filter((p): p is string => Boolean(p));
        if (paths.length > 0) assignedSkillPaths = paths;
      }
    }

    // Prompt templates (native: defaultPromptTemplateNames ∪ the project's
    // assignedPromptTemplateNames): the user's "All Projects" defaults PLUS this
    // project's assigned prompts become `--prompt-template <path>` flags so pi
    // exposes them as /<name> slash commands. On a name collision we resolve to
    // the GLOBAL entry (first-wins) — matching pi's own prompt-template loader,
    // which loads global before project and keeps the first (unlike skills, where
    // a project skill deliberately shadows the global one). scanPrompts sorts a
    // same-named collision global-before-project, so keeping the first occurrence
    // yields the global file.
    let defaultPromptTemplatePaths: string[] | undefined;
    {
      const names = [...settings.get().defaultPromptTemplates, ...(project?.assignedPrompts ?? [])];
      if (names.length > 0) {
        const promptsByName = new Map<string, PromptInfo>();
        for (const prompt of scanPrompts(rootsFor(body.projectId))) {
          if (!promptsByName.has(prompt.name)) promptsByName.set(prompt.name, prompt);
        }
        const paths = [...new Set(names)]
          .map((name) => promptsByName.get(name)?.filePath)
          .filter((p): p is string => Boolean(p));
        if (paths.length > 0) defaultPromptTemplatePaths = paths;
      }
    }

    let namedMcpIds: string[] = [];
    let plan: LaunchPlan = {
      kind: "parent",
      provider,
      model,
      // The user's default thinking level (native onboarding preference) seeds a
      // plain parent session; launchPlan encodes it as the `--model model:level`
      // suffix when a model is known, else `--thinking`.
      thinking: settings.get().defaultThinking ?? undefined,
      extensions,
      skills: body.skills ?? assignedSkillPaths,
      promptTemplates: defaultPromptTemplatePaths,
    };

    if (body.agentName) {
      // Agent-backed session: the picked agent's body becomes the system
      // prompt; frontmatter tools/skills/model apply per the launch contract.
      // Resolved via the same helper the subagent delegation uses, so both paths
      // stay in lock-step.
      const resolved = resolveNamedAgent(body.agentName, body.projectId);
      if (resolved.status === "not_found") {
        return reply.status(404).send({ error: `unknown agent: ${body.agentName}` });
      }
      if (resolved.status === "disabled") {
        return reply.status(409).send({ error: `agent is disabled: ${body.agentName}` });
      }
      const { agent } = resolved;
      const projectAssignments = new Set(project?.assignedMcpServers ?? []);
      namedMcpIds = (agent.mcpServers ?? []).filter((id) => projectAssignments.has(id));
      plan = {
        kind: "agent",
        systemPrompt: { mode: agent.systemPromptMode, text: agent.body },
        tools: agent.tools,
        extensions: finalizeExtensions([...(extensions ?? []), ...agent.extensions]),
        skills: agent.skillDirs,
        provider,
        // Agent model/thinking, else the inherited defaults (frontmatter wins;
        // an agent that specifies neither falls back to the user's default model
        // AND default thinking, the same precedence a plain parent gets).
        model: agent.model ?? model,
        thinking: asThinkingLevel(agent.thinking) ?? settings.get().defaultThinking ?? undefined,
      };
    }

    if (settings.get().worktreeIsolation && project) {
      const suffix = randomUUID().slice(0, 8);
      const target = nodePath.join(worktreesRoot, suffix);
      let reservationIdentity: string | undefined;
      try {
        // Reserve the exact private leaf and bind its native identity before Git
        // creates any ref or writes checkout content. Existing leaves fail
        // atomically and are never candidates for rollback deletion.
        reservationIdentity = sessionWorktreeStore.reserveWorktree(target);
        // Deliberately attempt the operation directly. A repo precheck would
        // collapse unavailable Git/non-repo into a silent primary-cwd fallback.
        // Keep the reservation and native identity stable while trying the base
        // branch and then numbered candidates. The Git helper retries only an
        // exact post-failure ref collision; every other failure stops immediately.
        worktree = await createSessionWorktreeWithBranchRetries(
          project.path,
          target,
          `agent-deck/session-${suffix}`,
          reservationIdentity,
        );
        cwd = target;
      } catch (error) {
        // Preserve the primary allocation error. A successful reservation is
        // sufficient deletion authority even if source/branch/add fails before
        // Git can return branch ownership proof.
        const physicallyRemoved = reservationIdentity
          ? await sessionWorktreeStore
              .deleteWorktree(target, reservationIdentity)
              .then(() => true)
              .catch((cleanupError) => {
                fastify.log.warn(
                  { err: cleanupError },
                  "failed to clean reserved session worktree",
                );
                return false;
              })
          : false;
        if (error instanceof SessionWorktreeAddError) {
          // Prune only after proving this exact stale registration belongs to the
          // branch conclusively created by this attempt.
          const registeredToAttempt = physicallyRemoved
            ? await gitWorktreeRegistrationMatches(
                project.path,
                target,
                error.worktree.branch,
              ).catch(() => false)
            : false;
          if (registeredToAttempt) await gitWorktreePrune(project.path).catch(() => {});
          // This deletes only the conclusively-owned branch and naturally fails
          // while Git still considers it checked out. Never mask the add error.
          await gitDeleteOwnedWorktreeBranch(project.path, error.worktree).catch(() => {});
        }
        return reply.status(409).send({
          code: "worktree_isolation_failed",
          error: `Session creation stopped because an isolated worktree couldn't be created: ${gitErrorText(error)} — Fix the project's Git state or disable worktree isolation, then try again.`,
        });
      }
    }

    const mcpPreparation = project
      ? await prepareProjectMcpSession(project.id, namedMcpIds)
      : undefined;
    const mcpPreparationResult = mcpPreparation?.result;
    if (mcpPreparationResult && !mcpPreparationResult.ok) {
      await mcpPreparation.release();
      return reply.status(422).send({ error: mcpPreparationResult.error });
    }
    const missingNamed = mcpPreparationResult?.ok
      ? namedMcpIds.filter((id) => mcpPreparationResult.missing.includes(id))
      : [];
    if (missingNamed.length > 0) {
      await mcpPreparation!.release();
      return reply.status(409).send({
        error: `Assigned MCP server definition missing: ${missingNamed.join(", ")}. Add it to global or project .pi/mcp.json, or remove it from the agent.`,
      });
    }

    let createdSession: ReturnType<typeof sessions.create> | undefined;
    let announcementAttempted = false;
    try {
      const session = sessions.create({
        cwd,
        projectId: body.projectId,
        agentName: body.agentName,
        env: { ...defaults.env, ...body.env },
        plan,
        // Defer persistence/broadcast/receipt until create + immediate setup has
        // completed. This gives the route a real commit point for the allocation.
        deferAnnouncement: true,
        ...(worktree ? { worktree } : {}),
      });
      createdSession = session;
      announcementAttempted = true;
      sessions.announceCreated(session);
      await mcpPreparation?.release();
      return reply.status(201).send({ session: session.meta });
    } catch (error) {
      const partialId =
        createdSession?.meta.id ??
        (error instanceof SessionCreationError ? error.sessionId : undefined);
      // A pre-return SessionCreationError owns its close promise; awaiting it is
      // stronger than destroy(id), because launch may already have removed the
      // map entry. Once create returned, this route owns the live session and
      // destroy performs the exactly-once awaited close.
      if (createdSession) await sessions.destroy(createdSession.meta.id).catch(() => {});
      else if (error instanceof SessionCreationError) await error.cleanup;
      if (partialId) bridgeTokens.delete(partialId);
      await mcpPreparation?.release();

      // Only announcement can make this route own an index row. Never erase a
      // stale/unrelated collision on a pre-return launch failure.
      if (announcementAttempted && createdSession) {
        const owned = createdSession.meta;
        const indexed = index.find((meta) => meta.id === owned.id);
        if (
          indexed &&
          indexed.createdAt === owned.createdAt &&
          indexed.cwd === owned.cwd &&
          indexed.projectId === owned.projectId
        ) {
          index.remove(owned.id);
        }
      }

      // Pi cleanup must settle before worktree removal on Windows. The generated
      // branch is then safe to delete; cleanup failures are logged but never
      // replace the typed fail-closed response.
      if (worktree && project) {
        const physicallyRemoved = await sessionWorktreeStore
          .deleteWorktree(worktree.path, worktree.identityToken!)
          .then(() => true)
          .catch((cleanupError) => {
            fastify.log.warn(
              { err: cleanupError },
              "failed to remove session worktree after startup",
            );
            return false;
          });
        if (physicallyRemoved) {
          await gitWorktreePrune(project.path).catch(() => {});
          await gitDeleteOwnedWorktreeBranch(project.path, worktree).catch((cleanupError) => {
            fastify.log.warn(
              { err: cleanupError, branch: worktree?.branch },
              "failed to remove generated session branch after startup",
            );
          });
        }
      }
      return reply.status(500).send({
        code: "session_creation_failed",
        error: `The session couldn't be started or activated. Fix the launch error and try again: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });
}
