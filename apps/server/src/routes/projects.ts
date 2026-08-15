import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import nodePath from "node:path";
import { promisify } from "node:util";
import type { ProjectMeta } from "@agent-deck/contracts";
import { detectProjectType, discoverProjects, scanAgents } from "@agent-deck/resources";
import { projectAllowsAgent } from "../agentCuration.ts";
import { z } from "zod";
import type { ServerContext } from "../context.ts";
import {
  normalizeGitHubIssueDetail,
  normalizeGitHubIssueList,
  normalizeIssueReference,
  type IssueRelationships,
  type RawGitHubIssueDetail,
  type RawGitHubIssueListRow,
  type RawIssueRelationship,
} from "../githubIssues.ts";
import {
  ancestorDirsOf,
  INSTRUCTIONS_MAX,
  projectPiDirEscapes,
  RESOURCE_NAME,
  instructionsBody,
  resolveInstructionsFile,
} from "./shared.ts";

const createProjectBody = z.object({
  path: z.string(),
  name: z.string().optional(),
});

const patchProjectBody = z.object({
  assignedAgentNames: z.array(RESOURCE_NAME).optional(),
  assignedSkills: z.array(RESOURCE_NAME).optional(),
  assignedPrompts: z.array(RESOURCE_NAME).optional(),
  assignedMcpServers: z.array(RESOURCE_NAME).optional(),
  defaultAgentName: RESOURCE_NAME.nullable().optional(),
  enabled: z.boolean().optional(),
});

/**
 * Project registry routes — list/add/patch/hide, discovery roots + scan,
 * project instructions, and the GitHub issues screens. Moved verbatim from
 * server.ts.
 */
export function registerProjectRoutes(ctx: ServerContext): void {
  const {
    fastify,
    projects,
    sessions,
    settings,
    watchProject,
    reconcileProjectMcp,
    broadcast,
    rootsFor,
  } = ctx;

  fastify.get("/projects", async () => ({
    projects: projects.list().filter((p) => !p.hidden),
  }));

  // Root folders that are too broad to scan (filesystem/system roots) — a
  // huge fan-out would block the sync scan. Users add specific dev folders.
  const FORBIDDEN_ROOTS = new Set(
    [
      "/",
      "/etc",
      "/usr",
      "/bin",
      "/sbin",
      "/var",
      "/sys",
      "/proc",
      "/dev",
      "/System",
      "/Library",
      "/private",
      homedir(), // the bare home dir fans out enormously; a subfolder is fine
    ].map((p) => nodePath.resolve(p)),
  );

  const canonicalPath = (p: string): string => {
    try {
      return realpathSync.native(p);
    } catch {
      return nodePath.resolve(p);
    }
  };

  // Discovery roots + scan. GET returns the configured roots and every
  // project candidate found under them (flagged if already registered).
  fastify.get("/projects/discovery", async () => {
    const roots = settings.get().projectRoots;
    const known = new Set(projects.list().map((p) => canonicalPath(p.path)));
    const discovered = discoverProjects(roots).map((c) => ({
      ...c,
      registered: known.has(canonicalPath(c.path)),
    }));
    return { roots, discovered };
  });

  fastify.post("/projects/discovery/roots", async (request, reply) => {
    const parsed = z.object({ root: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const root = nodePath.resolve(parsed.data.root);
    if (!existsSync(root) || !statSync(root).isDirectory()) {
      return reply.status(400).send({ error: `not a directory: ${root}` });
    }
    if (FORBIDDEN_ROOTS.has(root) || nodePath.dirname(root) === root) {
      return reply.status(400).send({ error: "root is too broad to scan; pick a project folder" });
    }
    return { roots: settings.setProjectRoot(root, true).projectRoots };
  });

  fastify.delete("/projects/discovery/roots", async (request, reply) => {
    const parsed = z.object({ root: z.string().min(1) }).safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    return {
      roots: settings.setProjectRoot(nodePath.resolve(parsed.data.root), false).projectRoots,
    };
  });

  fastify.post("/projects", async (request, reply) => {
    const parsed = createProjectBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }
    const projectPath = nodePath.resolve(parsed.data.path);
    if (!existsSync(projectPath) || !statSync(projectPath).isDirectory()) {
      return reply.status(400).send({ error: `not a directory: ${projectPath}` });
    }
    // Idempotent by path: re-adding an existing (possibly hidden) project
    // returns it with its metadata intact — hide is never data loss.
    const existing = projects.find((p) => p.path === projectPath);
    if (existing) {
      if (existing.hidden) {
        const restored = { ...existing, hidden: false };
        projects.upsert(restored);
        await reconcileProjectMcp(restored.id);
        return reply.status(200).send({ project: restored });
      }
      return reply.status(200).send({ project: existing });
    }
    const project: ProjectMeta = {
      id: randomUUID(),
      path: projectPath,
      name: parsed.data.name ?? nodePath.basename(projectPath),
      type: detectProjectType(projectPath),
      createdAt: new Date().toISOString(),
    };
    projects.upsert(project);
    watchProject(project.path);
    return reply.status(201).send({ project });
  });

  fastify.patch("/projects/:id", async (request, reply) => {
    const parsed = patchProjectBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    const { id } = request.params as { id: string };
    const project = projects.find((p) => p.id === id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    const next: ProjectMeta = { ...project };
    if (parsed.data.assignedAgentNames !== undefined) {
      next.assignedAgentNames = [...new Set(parsed.data.assignedAgentNames)];
    }
    if (parsed.data.assignedSkills !== undefined) next.assignedSkills = parsed.data.assignedSkills;
    if (parsed.data.assignedPrompts !== undefined)
      next.assignedPrompts = parsed.data.assignedPrompts;
    if (parsed.data.assignedMcpServers !== undefined)
      next.assignedMcpServers = [...new Set(parsed.data.assignedMcpServers)];
    if (parsed.data.defaultAgentName !== undefined) {
      next.defaultAgentName = parsed.data.defaultAgentName ?? undefined;
    }
    if (parsed.data.enabled !== undefined) next.enabled = parsed.data.enabled;

    const effectiveAgents = scanAgents(rootsFor(id)).filter(
      (agent) => !agent.shadowed && !agent.disabled,
    );
    if (next.defaultAgentName) {
      const defaultAgent = effectiveAgents.find((agent) => agent.name === next.defaultAgentName);
      if (!defaultAgent || !projectAllowsAgent(next, defaultAgent)) {
        if (parsed.data.defaultAgentName !== undefined) {
          return reply.status(400).send({ error: "agent is unavailable for this project" });
        }
        // Tightening curation cannot leave an inaccessible active-session default.
        next.defaultAgentName = undefined;
      }
    }
    projects.upsert(next);
    if (parsed.data.assignedMcpServers !== undefined) {
      const reconciled = await reconcileProjectMcp(id);
      if (!reconciled.ok) {
        // The assignment is still safely persisted; malformed config preserves
        // already-live clients and the response gives the user an actionable state.
        broadcast({ type: "resources_changed" });
        return reply.status(422).send({ error: reconciled.error, project: next });
      }
    }
    broadcast({ type: "resources_changed" });
    return { project: next };
  });

  // "Hide from list" (native): soft-hide — metadata and session links are
  // preserved and re-adding the same path restores them. The project hosting
  // a LIVE session can't be hidden.
  fastify.delete("/projects/:id", async (request, reply) => {
    const { id } = request.params as { id: string };
    const project = projects.find((p) => p.id === id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    const hasLiveSession = sessions.list().some((s) => s.projectId === id && !s.endedAt);
    if (hasLiveSession) {
      return reply.status(409).send({ error: "project has a live session" });
    }
    projects.upsert({ ...project, hidden: true });
    await ctx.mcp.reconcile([], id);
    return { ok: true };
  });

  const agentsFileFor = (id: string): { path: string } | null => {
    const project = projects.find((p) => p.id === id);
    return project ? { path: resolveInstructionsFile(project.path) } : null;
  };

  fastify.get("/projects/:id/instructions", async (request, reply) => {
    const target = agentsFileFor((request.params as { id: string }).id);
    if (!target) return reply.status(404).send({ error: "unknown project" });
    let content = "";
    if (existsSync(target.path)) {
      if (statSync(target.path).size > INSTRUCTIONS_MAX) {
        return reply.status(413).send({ error: "the instructions file is too large to edit here" });
      }
      content = readFileSync(target.path, "utf8");
    }
    return { content, path: target.path };
  });

  fastify.put("/projects/:id/instructions", async (request, reply) => {
    const target = agentsFileFor((request.params as { id: string }).id);
    if (!target) return reply.status(404).send({ error: "unknown project" });
    const parsed = instructionsBody.safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
    // Never write THROUGH a symlink — a symlinked AGENTS.md could redirect the
    // write to a file outside the project.
    if (existsSync(target.path) && lstatSync(target.path).isSymbolicLink()) {
      return reply
        .status(400)
        .send({ error: "the instructions file is a symlink; refusing to write" });
    }
    writeFileSync(target.path, parsed.data.content, "utf8");
    return { ok: true, path: target.path };
  });

  // INS-01/02: the PROJECT base-prompt override <project>/.pi/SYSTEM.md and the
  // append prompt <project>/.pi/APPEND_SYSTEM.md — both win over their global
  // counterpart (pi resolves; we only catalog and edit). One registrar serves
  // both files so every guard is shared, not copied.
  const piPromptFileFor = (
    id: string,
    fileName: string,
  ): { path: string; projectPath: string } | null => {
    const project = projects.find((p) => p.id === id);
    return project
      ? { path: nodePath.join(project.path, ".pi", fileName), projectPath: project.path }
      : null;
  };

  // Repo-checked-in links are untrusted: a `.pi` (or deeper) symlink/junction must
  // never redirect a read/write/delete outside the project (review, Codex). REAL-path
  // containment, fail closed on unresolvable paths; the file itself may not exist yet,
  // so the check anchors on its nearest existing ancestor via the dirname.
  const piPromptDirEscapes = (target: { path: string; projectPath: string }): boolean =>
    projectPiDirEscapes(target.projectPath);

  const registerPiPromptRoutes = (routeName: string, fileName: string): void => {
    fastify.get(`/projects/:id/${routeName}`, async (request, reply) => {
      const target = piPromptFileFor((request.params as { id: string }).id, fileName);
      if (!target) return reply.status(404).send({ error: "unknown project" });
      if (piPromptDirEscapes(target)) {
        return reply.status(400).send({ error: "the .pi directory resolves outside the project" });
      }
      let content = "";
      const exists = existsSync(target.path);
      if (exists) {
        if (statSync(target.path).size > INSTRUCTIONS_MAX) {
          return reply
            .status(413)
            .send({ error: "the instructions file is too large to edit here" });
        }
        content = readFileSync(target.path, "utf8");
      }
      return { content, path: target.path, exists };
    });

    fastify.put(`/projects/:id/${routeName}`, async (request, reply) => {
      const target = piPromptFileFor((request.params as { id: string }).id, fileName);
      if (!target) return reply.status(404).send({ error: "unknown project" });
      // never recreate a project whose directory vanished (moved/deleted) — that
      // would silently reconstruct a stale path (review, Codex)
      if (!existsSync(target.projectPath)) {
        return reply.status(404).send({ error: "the project directory no longer exists" });
      }
      if (piPromptDirEscapes(target)) {
        return reply.status(400).send({ error: "the .pi directory resolves outside the project" });
      }
      const parsed = instructionsBody.safeParse(request.body);
      if (!parsed.success) return reply.status(400).send({ error: parsed.error.message });
      if (existsSync(target.path) && lstatSync(target.path).isSymbolicLink()) {
        return reply
          .status(400)
          .send({ error: "the instructions file is a symlink; refusing to write" });
      }
      mkdirSync(nodePath.dirname(target.path), { recursive: true });
      writeFileSync(target.path, parsed.data.content, "utf8");
      return { ok: true, path: target.path };
    });

    fastify.delete(`/projects/:id/${routeName}`, async (request, reply) => {
      const target = piPromptFileFor((request.params as { id: string }).id, fileName);
      if (!target) return reply.status(404).send({ error: "unknown project" });
      if (piPromptDirEscapes(target)) {
        return reply.status(400).send({ error: "the .pi directory resolves outside the project" });
      }
      // rmSync on a symlink removes the ENTRY, never its target — deleting the link
      // is exactly how the user restores pi's fallback, so it is allowed (review, Codex)
      try {
        if (lstatSync(target.path)) rmSync(target.path);
      } catch {
        // already absent — idempotent
      }
      return { ok: true };
    });
  };
  registerPiPromptRoutes("system-prompt", "SYSTEM.md");
  registerPiPromptRoutes("append-prompt", "APPEND_SYSTEM.md");

  // INS-03: the inherited ANCESTOR context candidates. pi walks every parent
  // directory from the filesystem root down to the project dir, loading
  // AGENTS.md (preferred) or CLAUDE.md per level — this read-only listing shows
  // which parent folders contribute instructions. Only EXISTING files appear
  // (the project's own file belongs to the editor); names are matched against
  // the real directory listing so a case-insensitive filesystem never invents
  // candidates that are not on disk (native insertCaseSensitiveContextMatches).
  const CONTEXT_CANDIDATE_NAMES = ["AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
  const MAX_ANCESTOR_DEPTH = 32;

  fastify.get("/projects/:id/instruction-ancestors", async (request, reply) => {
    const project = projects.find((p) => p.id === (request.params as { id: string }).id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    const { dirs, truncated } = ancestorDirsOf(project.path, MAX_ANCESTOR_DEPTH);
    const items: Array<{ dir: string; name: string; path: string }> = [];
    for (const dir of dirs) {
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      const onDisk = new Set(entries);
      for (const name of CONTEXT_CANDIDATE_NAMES) {
        if (onDisk.has(name)) items.push({ dir, name, path: nodePath.join(dir, name) });
      }
    }
    return { items, truncated };
  });

  // GitHub issues for a project, via the gh CLI (reuses the user's gh auth so
  // there's no OAuth to build). AGENT_DECK_GH_BIN overrides the binary (tests).
  const execFileAsync = promisify(execFile);
  fastify.get("/projects/:id/issues", async (request, reply) => {
    const project = projects.find((p) => p.id === (request.params as { id: string }).id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    // Filter by issue state (native Issues screen's Open / Closed / All segmented control).
    const stateParsed = z
      .enum(["open", "closed", "all"])
      .default("open")
      .safeParse((request.query as { state?: string }).state);
    if (!stateParsed.success) return reply.status(400).send({ error: "invalid state filter" });
    const ghBin = process.env.AGENT_DECK_GH_BIN || "gh";
    try {
      const { stdout } = await execFileAsync(
        ghBin,
        [
          "issue",
          "list",
          "--state",
          stateParsed.data,
          "--json",
          // assignees/author are included so the Issues screen can offer the
          // native client-side assignee + author facet filters (native
          // filteredBoardItems) and search over the already-loaded board
          // without a per-filter re-query.
          "number,title,state,url,labels,assignees,author,updatedAt",
          "--limit",
          // Fetch one sentinel beyond the visible cap so the response can
          // truthfully disclose truncation without introducing pagination.
          "51",
        ],
        { cwd: project.path, timeout: 15_000, maxBuffer: 8_000_000 },
      );
      const raw = JSON.parse(stdout) as RawGitHubIssueListRow[];
      return normalizeGitHubIssueList(raw);
    } catch {
      return {
        issues: [],
        incompleteResults: false,
        error:
          "Couldn't list issues — needs the gh CLI installed, authenticated, and a GitHub remote.",
      };
    }
  });

  // A single issue's detail (native GitHubIssueDetailView 10.6): title + state +
  // labels + assignees + author + Markdown body, for the detail pane.
  fastify.get("/projects/:id/issues/:number", async (request, reply) => {
    const { id, number } = request.params as { id: string; number: string };
    const project = projects.find((p) => p.id === id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    if (!/^\d+$/.test(number)) return reply.status(400).send({ error: "invalid issue number" });
    const ghBin = process.env.AGENT_DECK_GH_BIN || "gh";
    try {
      const { stdout } = await execFileAsync(
        ghBin,
        [
          "issue",
          "view",
          number,
          "--json",
          "number,title,body,state,stateReason,url,createdAt,updatedAt,closedAt," +
            "labels,assignees,author,comments",
        ],
        { cwd: project.path, timeout: 15_000, maxBuffer: 8_000_000 },
      );
      const raw = JSON.parse(stdout) as RawGitHubIssueDetail;
      // ISS-04 (native GitHubIssueService): parent / sub-issues / blocked-by /
      // blocking via the REST endpoints, BEST-EFFORT — relationships are context
      // enrichment, so any failure (older gh, no GitHub remote, endpoint 404)
      // degrades to none rather than failing the detail.
      const repoMatch = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\//i.exec(raw.url);
      const relationships: IssueRelationships = {
        parent: null,
        subIssues: [],
        blockedBy: [],
        blocking: [],
      };
      let issueType: string | null = null;
      if (repoMatch) {
        const base = `repos/${repoMatch[1]}/${repoMatch[2]}/issues/${number}`;
        const fetchRefs = async (path: string): Promise<RawIssueRelationship[]> => {
          try {
            const out = await execFileAsync(ghBin, ["api", path], {
              cwd: project.path,
              timeout: 15_000,
              maxBuffer: 8_000_000,
            });
            const parsed = JSON.parse(out.stdout) as RawIssueRelationship | RawIssueRelationship[];
            return Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            return [];
          }
        };
        const [selves, parents, subIssues, blockedBy, blocking] = await Promise.all([
          // the issue's own REST payload — the only place its TYPE lives (ISS-05)
          fetchRefs(base),
          fetchRefs(`${base}/parent`),
          fetchRefs(`${base}/sub_issues`),
          fetchRefs(`${base}/dependencies/blocked_by`),
          fetchRefs(`${base}/dependencies/blocking`),
        ]);
        issueType = selves[0]?.type?.name ?? null;
        relationships.parent = parents[0] ? normalizeIssueReference(parents[0]) : null;
        relationships.subIssues = subIssues.map(normalizeIssueReference);
        relationships.blockedBy = blockedBy.map(normalizeIssueReference);
        relationships.blocking = blocking.map(normalizeIssueReference);
      }
      return { issue: { ...normalizeGitHubIssueDetail(raw), type: issueType, relationships } };
    } catch {
      return reply.status(502).send({
        error: "Couldn't load the issue — needs the gh CLI installed, authenticated, and a remote.",
      });
    }
  });

  // Aggregate cross-repository search (ISS-10, native
  // GitHubSearchService.fetchAggregateIssues): one `gh search issues` across
  // every registered project's GitHub origin, each row tagged with the project
  // that owns its repository so the UI opens details in the right place.
  fastify.get("/issues/search", async (request, reply) => {
    const stateParsed = z
      .enum(["open", "closed", "all"])
      .default("open")
      .safeParse((request.query as { state?: string }).state);
    if (!stateParsed.success) return reply.status(400).send({ error: "invalid state filter" });
    const ghBin = process.env.AGENT_DECK_GH_BIN || "gh";
    // Each project's GitHub repo from its origin remote (https or ssh form);
    // projects without one contribute nothing and break nothing.
    const repoOf = async (projectPath: string): Promise<string | null> => {
      try {
        const { stdout } = await execFileAsync(
          "git",
          ["-C", projectPath, "remote", "get-url", "origin"],
          { timeout: 10_000 },
        );
        const url = stdout.trim();
        const match =
          /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url) ??
          /^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i.exec(url);
        return match ? `${match[1]}/${match[2]}` : null;
      } catch {
        return null;
      }
    };
    const visible = projects.list().filter((p) => !p.hidden);
    const repoProjects = (
      await Promise.all(visible.map(async (p) => ({ projectId: p.id, repo: await repoOf(p.path) })))
    ).filter((entry): entry is { projectId: string; repo: string } => entry.repo !== null);
    // first project wins a shared repo — one row, one deterministic owner
    const projectByRepo = new Map<string, string>();
    for (const { projectId, repo } of repoProjects) {
      if (!projectByRepo.has(repo.toLowerCase())) projectByRepo.set(repo.toLowerCase(), projectId);
    }
    if (projectByRepo.size === 0) {
      return { issues: [], incompleteResults: false, error: "No GitHub repositories discovered." };
    }
    const repoArgs = [...new Set(repoProjects.map(({ repo }) => repo))].flatMap((repo) => [
      "--repo",
      repo,
    ]);
    try {
      const { stdout } = await execFileAsync(
        ghBin,
        [
          "search",
          "issues",
          ...repoArgs,
          "--state",
          stateParsed.data === "all" ? "open" : stateParsed.data,
          "--sort",
          "updated",
          "--json",
          "number,title,state,url,labels,assignees,author,updatedAt,repository",
          "--limit",
          "51",
        ].filter(
          // gh search has no state:all — omit the flag entirely for "all"
          (arg, index, argv) =>
            stateParsed.data !== "all" || (arg !== "--state" && argv[index - 1] !== "--state"),
        ),
        { timeout: 15_000, maxBuffer: 8_000_000 },
      );
      const raw = JSON.parse(stdout) as Array<
        RawGitHubIssueListRow & { repository?: { nameWithOwner?: string } }
      >;
      const normalized = normalizeGitHubIssueList(raw);
      return {
        issues: normalized.issues.map((issue, index) => {
          const repository = raw[index]?.repository?.nameWithOwner ?? null;
          return {
            ...issue,
            repository,
            projectId: repository ? (projectByRepo.get(repository.toLowerCase()) ?? null) : null,
          };
        }),
        incompleteResults: normalized.incompleteResults,
      };
    } catch {
      return {
        issues: [],
        incompleteResults: false,
        error:
          "Couldn't search issues — needs the gh CLI installed, authenticated, and GitHub remotes.",
      };
    }
  });

  // Reopen a closed issue (ISS-02, native Issues reopen): `gh issue reopen <n>`.
  fastify.post("/projects/:id/issues/:number/reopen", async (request, reply) => {
    const { id, number } = request.params as { id: string; number: string };
    const project = projects.find((p) => p.id === id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    if (!/^\d+$/.test(number)) return reply.status(400).send({ error: "invalid issue number" });
    const ghBin = process.env.AGENT_DECK_GH_BIN || "gh";
    try {
      await execFileAsync(ghBin, ["issue", "reopen", number], {
        cwd: project.path,
        timeout: 15_000,
        maxBuffer: 8_000_000,
      });
    } catch {
      return reply.status(502).send({
        error:
          "Couldn't reopen the issue — needs the gh CLI installed, authenticated, and a remote.",
      });
    }
    return { ok: true };
  });

  // Post a comment on an issue (ISS-01, native GitHubIssueDetailView reply).
  // The body travels as a FILE (`--body-file`), never argv — a long or
  // multiline comment survives Windows argv limits and needs no escaping.
  fastify.post("/projects/:id/issues/:number/comment", async (request, reply) => {
    const { id, number } = request.params as { id: string; number: string };
    const project = projects.find((p) => p.id === id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    if (!/^\d+$/.test(number)) return reply.status(400).send({ error: "invalid issue number" });
    const parsed = z.object({ body: z.string().trim().min(1).max(65_536) }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "a non-empty comment body is required" });
    }
    const ghBin = process.env.AGENT_DECK_GH_BIN || "gh";
    const bodyFile = nodePath.join(tmpdir(), `agent-deck-issue-comment-${randomUUID()}.md`);
    try {
      // exclusive private create: never follows a pre-existing path, unreadable
      // to other local users while gh reads it
      writeFileSync(bodyFile, parsed.data.body, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await execFileAsync(ghBin, ["issue", "comment", number, "--body-file", bodyFile], {
        cwd: project.path,
        timeout: 15_000,
        maxBuffer: 8_000_000,
      });
    } catch {
      return reply.status(502).send({
        error:
          "Couldn't post the comment — needs the gh CLI installed, authenticated, and a remote.",
      });
    } finally {
      rmSync(bodyFile, { force: true });
    }
    return { ok: true };
  });

  // Close an issue (native Issues close split-button 10.9): completed or not
  // planned. `gh issue close <n> --reason <reason>`.
  fastify.post("/projects/:id/issues/:number/close", async (request, reply) => {
    const { id, number } = request.params as { id: string; number: string };
    const project = projects.find((p) => p.id === id);
    if (!project) return reply.status(404).send({ error: "unknown project" });
    if (!/^\d+$/.test(number)) return reply.status(400).send({ error: "invalid issue number" });
    const parsed = z
      .object({ reason: z.enum(["completed", "not_planned"]) })
      .safeParse(request.body);
    if (!parsed.success) return reply.status(400).send({ error: "invalid close reason" });
    // gh spells the reason with a space; our API uses a snake_case enum.
    const ghReason = parsed.data.reason === "completed" ? "completed" : "not planned";
    const ghBin = process.env.AGENT_DECK_GH_BIN || "gh";
    try {
      await execFileAsync(ghBin, ["issue", "close", number, "--reason", ghReason], {
        cwd: project.path,
        timeout: 15_000,
        maxBuffer: 8_000_000,
      });
    } catch {
      return reply.status(502).send({
        error:
          "Couldn't close the issue — needs the gh CLI installed, authenticated, and a remote.",
      });
    }
    return { ok: true };
  });
}
