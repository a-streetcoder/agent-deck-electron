import { z } from "zod";
import {
  gitCommitAll,
  gitCommitSubjects,
  gitCreateAndPushReleaseTag,
  gitErrorText,
  gitLatestVersionTag,
  gitLocalTagExists,
  gitPush,
  gitReleaseSynchronization,
  gitRemoteTagExists,
  gitStatus,
  gitStatusAndDiff,
  nextReleaseVersions,
} from "../git.ts";
import { envDefaults, type ServerContext } from "../context.ts";
import { runtimeEnvFiles } from "@agent-deck/resources";

// Commit-message generator prompt (native PiAgentShipService.commitMessageSystemPrompt).
const COMMIT_MESSAGE_SYSTEM_PROMPT = `You are Agent Deck's git commit message generator. Your only job is to write a commit message from the supplied git status and diff.

The commit message must be concise and explanatory: capture the concrete code or product change being committed, not the mechanical act of editing files. Prefer the intended behavior or user-visible outcome when the diff makes it clear.

Output ONLY the commit message — an imperative title (max 72 chars), optionally followed by a blank line and a short body. No preamble, no code fences, no quotes. Do not invent changes not supported by the status or diff.`;

// Release-notes generator prompt (native ReleaseNotesGenerationService).
const RELEASE_NOTES_SYSTEM_PROMPT = `You are a release-notes writer. You are given the git commit subjects for everything that changed since the previous release. Turn them into a short, friendly changelog a user reads on the release page.

Write GitHub-flavored markdown grouped into these sections IN THIS ORDER, omitting any that would be empty:
### ✨ New features
### 💪 Improvements
### 🐛 Bug fixes

Aim for 2–6 bullets total; merge trivial/related commits; write from the user's side, not the code's. If the only changes are internal housekeeping, output a single line with no heading: "Performance and stability improvements."

Do NOT write a top-level title (no "# " or "## " line). Output ONLY the markdown described — no preamble, no code fences.`;

/**
 * Project git automation + the release action — status/commit/push, the
 * AI-drafted commit message and release notes, and tag-and-push. Moved
 * verbatim from server.ts.
 */
export function registerGitRoutes(ctx: ServerContext): void {
  const { fastify, projects, sessions, broadcast, rootsFor } = ctx;

  // Git automation (native GitRepositoryService): the working-tree status of a
  // project + commit-all. Push/remote is a follow-up. Project-scoped: git runs
  // in the project's path.
  fastify.get("/projects/:id/git/status", async (request, reply) => {
    const project = projects.find((p) => p.id === (request.params as { id: string }).id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    return gitStatus(project.path);
  });

  fastify.post("/projects/:id/git/commit", async (request, reply) => {
    const project = projects.find((p) => p.id === (request.params as { id: string }).id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    const parsed = z
      .object({
        message: z.string().trim().min(1, "a commit message is required").max(10_000),
        push: z.boolean().optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    try {
      await gitCommitAll(project.path, parsed.data.message);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message === "nothing_to_commit") {
        return reply.status(400).send({ error: "There are no changes to commit." });
      }
      if (message === "not_a_repo") {
        return reply.status(400).send({ error: "This project isn't a git repository." });
      }
      return reply.status(500).send({ error: message });
    }
    // The commit landed; a subsequent push failure is reported separately so the
    // user knows the commit is safe locally even if the push didn't go out.
    if (parsed.data.push) {
      try {
        await gitPush(project.path);
      } catch (error) {
        broadcast({ type: "resources_changed" });
        return reply.status(502).send({
          error: `Committed, but the push failed: ${error instanceof Error ? error.message : String(error)}`,
          committed: true,
          pushed: false,
        });
      }
    }
    broadcast({ type: "resources_changed" });
    return { committed: true, pushed: parsed.data.push === true };
  });

  // Push the current branch (native pushCurrentBranch). Used on its own to push
  // already-made commits when the tree is clean.
  fastify.post("/projects/:id/git/push", async (request, reply) => {
    const project = projects.find((p) => p.id === (request.params as { id: string }).id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    try {
      await gitPush(project.path);
    } catch (error) {
      return reply
        .status(502)
        .send({ error: `Push failed: ${error instanceof Error ? error.message : String(error)}` });
    }
    return { pushed: true };
  });

  // Generate a commit message from the working-tree changes via a one-shot pi
  // helper (native PiAgentShipService.generateCommitMessage). No side effects —
  // it reads the diff, it doesn't stage or commit.
  fastify.post("/projects/:id/git/generate-message", async (request, reply) => {
    const project = projects.find((p) => p.id === (request.params as { id: string }).id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    let status: string;
    let diff: string;
    try {
      ({ status, diff } = await gitStatusAndDiff(project.path));
    } catch (error) {
      return reply.status(400).send({ error: String(error) });
    }
    if (!status) return reply.status(400).send({ error: "There are no changes to describe." });
    const defaults = envDefaults();
    try {
      const message = await sessions.runHelper({
        systemPrompt: COMMIT_MESSAGE_SYSTEM_PROMPT,
        userPrompt: `Generate a git commit message for these changes.\n\nGit status:\n${status}\n\nDiff:\n${diff}`,
        cwd: project.path,
        provider: defaults.provider,
        model: defaults.model,
        extensions: defaults.providerExtensions,
        env: { ...runtimeEnvFiles(rootsFor(project.id)), ...defaults.env },
      });
      const trimmed = message.trim();
      if (!trimmed)
        return reply.status(502).send({ error: "The model returned an empty message." });
      return { message: trimmed };
    } catch (error) {
      return reply.status(502).send({
        error: `Couldn't generate a message: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  // Release (native ReleaseService, generalized to any repo): fail closed unless
  // the checked-out branch is clean and exactly synchronized with its configured
  // remote upstream. The same helper runs again in POST immediately before tag
  // mutation, so a panel-open preflight is never treated as authorization.
  fastify.get("/projects/:id/release/preflight", async (request, reply) => {
    const project = projects.find((p) => p.id === (request.params as { id: string }).id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    try {
      const synchronization = await gitReleaseSynchronization(project.path);
      const latestTag = await gitLatestVersionTag(project.path);
      return {
        ...synchronization,
        latestTag,
        nextVersions: nextReleaseVersions(latestTag),
      };
    } catch (error) {
      return reply.status(500).send({
        code: "preflight_failed",
        error: `Release preflight failed: ${gitErrorText(error)}`,
      });
    }
  });

  fastify.post("/projects/:id/release/notes", async (request, reply) => {
    const project = projects.find((p) => p.id === (request.params as { id: string }).id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    const parsed = z
      .object({ version: z.string().trim().min(1).max(60) })
      .safeParse(request.body ?? {});
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const latestTag = await gitLatestVersionTag(project.path);
    // Commit subjects since the last release (or the whole history for a first one).
    const range = latestTag ? `${latestTag}..HEAD` : "HEAD";
    let subjects: string[];
    try {
      subjects = (await gitCommitSubjects(project.path, range)).slice(0, 80);
    } catch (error) {
      return reply.status(400).send({ error: gitErrorText(error) });
    }
    if (subjects.length === 0) {
      return { notes: "Performance and stability improvements." };
    }
    const defaults = envDefaults();
    try {
      const notes = await sessions.runHelper({
        systemPrompt: RELEASE_NOTES_SYSTEM_PROMPT,
        userPrompt: `These are the commit subjects added since the previous release — everything new in ${parsed.data.version}. Write the changelog from them:\n\n${subjects.map((s) => `- ${s}`).join("\n")}`,
        cwd: project.path,
        provider: defaults.provider,
        model: defaults.model,
        extensions: defaults.providerExtensions,
        env: { ...runtimeEnvFiles(rootsFor(project.id)), ...defaults.env },
      });
      const trimmed = notes.trim().replace(/^```[a-z]*\n?|\n?```$/g, "");
      return { notes: trimmed || "Performance and stability improvements." };
    } catch (error) {
      return reply.status(502).send({
        error: `Couldn't generate release notes: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  });

  fastify.post("/projects/:id/release", async (request, reply) => {
    const project = projects.find((p) => p.id === (request.params as { id: string }).id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    const parsed = z
      .object({
        tag: z
          .string()
          .trim()
          .regex(/^v\d+\.\d+\.\d+$/, "expected a vX.Y.Z tag"),
        notes: z.string().max(50_000).optional(),
      })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { tag, notes } = parsed.data;
    let synchronization: Awaited<ReturnType<typeof gitReleaseSynchronization>>;
    try {
      synchronization = await gitReleaseSynchronization(project.path);
    } catch (error) {
      return reply.status(500).send({ code: "preflight_failed", error: gitErrorText(error) });
    }
    if (synchronization.state !== "ready") {
      const status =
        synchronization.state === "not_repo"
          ? 400
          : synchronization.state === "fetch_failed"
            ? 502
            : 409;
      return reply.status(status).send({
        code: synchronization.state,
        error: synchronization.blocker?.message ?? "Release synchronization failed.",
        synchronization,
      });
    }
    const { remote, remoteRef, headSha } = synchronization;
    if (!remote || !remoteRef || !headSha) {
      return reply.status(500).send({
        code: "preflight_failed",
        error: "Release synchronization did not produce a remote and commit.",
      });
    }

    // Check the remote first: the synchronization fetch may also have created a
    // local copy of a remote-only tag, but that remains a remote conflict.
    try {
      if (await gitRemoteTagExists(project.path, remote, tag)) {
        return reply.status(409).send({
          code: "remote_tag_exists",
          error: `Tag ${tag} already exists on ${remote}. Choose another version or inspect the remote tag.`,
        });
      }
    } catch (error) {
      return reply.status(502).send({
        code: "remote_tag_lookup_failed",
        error: `Couldn't check tag ${tag} on ${remote}: ${gitErrorText(error)}`,
      });
    }
    try {
      if (await gitLocalTagExists(project.path, tag)) {
        return reply.status(409).send({
          code: "local_tag_exists",
          error: `Local tag ${tag} already exists. Choose another version or inspect the local tag.`,
        });
      }
    } catch (error) {
      return reply.status(500).send({
        code: "local_tag_lookup_failed",
        error: `Couldn't check local tag ${tag}: ${gitErrorText(error)}`,
      });
    }

    let result: Awaited<ReturnType<typeof gitCreateAndPushReleaseTag>>;
    try {
      result = await gitCreateAndPushReleaseTag(
        project.path,
        tag,
        notes ?? tag,
        headSha,
        remote,
        remoteRef,
      );
    } catch (error) {
      return reply.status(500).send({
        code: "tag_creation_failed",
        error: `Couldn't create local tag ${tag}: ${gitErrorText(error)}`,
      });
    }
    if (!result.ok) {
      if (result.failure.code === "stale_local") {
        return reply.status(409).send({
          code: result.failure.code,
          error: result.failure.message,
        });
      }
      return reply.status(502).send({
        code: result.failure.code,
        error: result.failure.message,
        localRollback: result.failure.localRollback,
        remoteTag: result.failure.remoteTag,
      });
    }
    return { ok: true, tag, headSha, remote };
  });
}
