import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import type * as GitModule from "../src/git.ts";

const gitMocks = vi.hoisted(() => ({
  createSessionWorktree: vi.fn(),
  gitWorktreeRemove: vi.fn(),
  gitDeleteOwnedWorktreeBranch: vi.fn(),
}));

vi.mock("../src/git.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof GitModule>()),
  createSessionWorktree: gitMocks.createSessionWorktree,
  gitWorktreeRemove: gitMocks.gitWorktreeRemove,
  gitDeleteOwnedWorktreeBranch: gitMocks.gitDeleteOwnedWorktreeBranch,
}));

import { registerSessionRoutes } from "../src/routes/sessions.ts";
import { SessionCreationError } from "../src/SessionManager.ts";

const PROJECT_PATH = path.join(tmpdir(), "agent-deck-route-project");
const WORKTREES_ROOT = path.join(tmpdir(), "agent-deck-route-worktrees");
const WORKTREE_PATH = path.join(WORKTREES_ROOT, "allocated");

interface Meta {
  id: string;
  cwd: string;
  projectId?: string;
  agentName?: string;
  worktreePath?: string;
}

function makeRoute(
  overrides: {
    isolated?: boolean;
    resolveAgent?: ServerContext["resolveNamedAgent"];
    create?: (options: Record<string, unknown>, state: ReturnType<typeof makeState>) => Meta;
    announce?: (session: { meta: Meta }, state: ReturnType<typeof makeState>) => void;
  } = {},
) {
  const fastify = Fastify();
  const state = makeState();
  const project = { id: "project-1", name: "project", path: PROJECT_PATH };
  const sessions = {
    list: vi.fn(() => [...state.live.values()]),
    get: vi.fn((id: string) => state.live.get(id)),
    create: vi.fn((options: Record<string, unknown>) => {
      if (overrides.create) return { meta: overrides.create(options, state) };
      const worktree = options.worktree as { path: string } | undefined;
      const meta: Meta = {
        id: "new-session",
        cwd: options.cwd as string,
        projectId: options.projectId as string | undefined,
        agentName: options.agentName as string | undefined,
        ...(worktree ? { worktreePath: worktree.path } : {}),
      };
      state.live.set(meta.id, meta);
      return { meta };
    }),
    announceCreated: vi.fn((session: { meta: Meta }) => {
      if (overrides.announce) return overrides.announce(session, state);
      state.index.set(session.meta.id, session.meta);
      state.broadcasts.push({ type: "session_meta", session: session.meta });
      state.receipts.push(session.meta.id);
    }),
    destroy: vi.fn(async (id: string) => {
      state.live.delete(id);
    }),
  };
  const index = {
    list: vi.fn(() => [...state.index.values()]),
    find: vi.fn((predicate: (meta: Meta) => boolean) => [...state.index.values()].find(predicate)),
    upsert: vi.fn((meta: Meta) => state.index.set(meta.id, meta)),
    remove: vi.fn((id: string) => state.index.delete(id)),
  };
  const settingsValue = {
    worktreeIsolation: overrides.isolated ?? true,
    defaultModel: null,
    defaultThinking: null,
    disabledSkills: [],
    defaultSkills: [],
    defaultPromptTemplates: [],
    disabledModels: [],
  };
  const ctx = {
    fastify,
    sessions,
    index,
    projects: {
      find: (predicate: (value: typeof project) => boolean) => [project].find(predicate),
    },
    settings: { get: () => settingsValue },
    bridgeTokens: state.tokens,
    worktreesRoot: WORKTREES_ROOT,
    broadcast: (message: unknown) => state.broadcasts.push(message),
    rootsFor: () => ({}),
    scanSkillsFor: () => [],
    resolveNamedAgent:
      overrides.resolveAgent ??
      (() => ({
        status: "ok" as const,
        agent: {
          body: "agent",
          systemPromptMode: "replace" as const,
          skillDirs: [],
          extensions: [],
        },
      })),
    enabledExtensionPaths: () => [],
    dropDiffCache: () => {},
  } as unknown as ServerContext;
  registerSessionRoutes(ctx);
  return { fastify, state, sessions, index };
}

function makeState() {
  return {
    live: new Map<string, Meta>(),
    index: new Map<string, Meta>(),
    tokens: new Map<string, string>(),
    broadcasts: [] as unknown[],
    receipts: [] as string[],
  };
}

beforeEach(() => {
  gitMocks.createSessionWorktree.mockReset();
  gitMocks.gitWorktreeRemove.mockReset().mockResolvedValue(undefined);
  gitMocks.gitDeleteOwnedWorktreeBranch.mockReset().mockResolvedValue(undefined);
  gitMocks.createSessionWorktree.mockResolvedValue({
    path: WORKTREE_PATH,
    branch: "agent-deck/session-allocated",
    sourceBranch: "main",
    branchOwned: true,
  });
});

describe("POST /sessions worktree transaction", () => {
  it("returns a typed 409 and creates no state when mandatory allocation fails", async () => {
    gitMocks.createSessionWorktree.mockRejectedValue(
      new Error("detached HEAD — check out a branch first"),
    );
    const { fastify, state, sessions } = makeRoute();

    const response = await fastify.inject({
      method: "POST",
      url: "/sessions",
      payload: { projectId: "project-1" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "worktree_isolation_failed",
      error:
        "Session creation stopped because an isolated worktree couldn't be created: detached HEAD — check out a branch first — Fix the project's Git state or disable worktree isolation, then try again.",
    });
    expect(sessions.create).not.toHaveBeenCalled();
    expect(state.live.size).toBe(0);
    expect(state.index.size).toBe(0);
    expect(state.tokens.size).toBe(0);
    expect(state.broadcasts).toEqual([]);
    expect(state.receipts).toEqual([]);
    await fastify.close();
  });

  it("validates a named agent before allocating a worktree", async () => {
    const { fastify } = makeRoute({ resolveAgent: () => ({ status: "disabled" }) });
    const response = await fastify.inject({
      method: "POST",
      url: "/sessions",
      payload: { projectId: "project-1", agentName: "blocked" },
    });
    expect(response.statusCode).toBe(409);
    expect(gitMocks.createSessionWorktree).not.toHaveBeenCalled();
    await fastify.close();
  });

  it("awaits pre-return manager cleanup without deleting a stale index collision", async () => {
    let releaseCleanup!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    const { fastify, state, sessions, index } = makeRoute({
      create: (_options, current) => {
        const meta = { id: "failed-create", cwd: WORKTREE_PATH, projectId: "project-1" };
        current.tokens.set(meta.id, "secret");
        current.index.set(meta.id, { ...meta, cwd: "stale-unrelated-cwd" });
        throw new SessionCreationError(meta.id, new Error("spawn failed"), cleanup);
      },
    });
    const responsePromise = fastify.inject({
      method: "POST",
      url: "/sessions",
      payload: { projectId: "project-1" },
    });
    await Promise.resolve();
    expect(gitMocks.gitWorktreeRemove).not.toHaveBeenCalled();
    releaseCleanup();
    const response = await responsePromise;

    expect(response.statusCode).toBe(500);
    expect(sessions.destroy).not.toHaveBeenCalled();
    expect(state.index.get("failed-create")?.cwd).toBe("stale-unrelated-cwd");
    expect(index.remove).not.toHaveBeenCalledWith("failed-create");
    expect(state.tokens.size).toBe(0);
    expect(state.broadcasts).toEqual([]);
    expect(state.receipts).toEqual([]);
    expect(gitMocks.gitWorktreeRemove).toHaveBeenCalledWith(PROJECT_PATH, WORKTREE_PATH);
    expect(gitMocks.gitDeleteOwnedWorktreeBranch).toHaveBeenCalledWith(
      PROJECT_PATH,
      expect.objectContaining({ branch: "agent-deck/session-allocated", branchOwned: true }),
    );
    await fastify.close();
  });

  it("rolls back partial session/index/token state and awaits worktree cleanup", async () => {
    const { fastify, state, sessions, index } = makeRoute({
      create: (_options, current) => {
        const meta = { id: "partial", cwd: WORKTREE_PATH, projectId: "project-1" };
        current.live.set(meta.id, meta);
        return meta;
      },
      announce: (session, current) => {
        current.index.set(session.meta.id, session.meta);
        current.tokens.set(session.meta.id, "secret");
        throw new Error("Pi executable is unavailable");
      },
    });
    const response = await fastify.inject({
      method: "POST",
      url: "/sessions",
      payload: { projectId: "project-1" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({
      code: "session_creation_failed",
      error:
        "The session couldn't be started or activated. Fix the launch error and try again: Pi executable is unavailable",
    });
    expect(sessions.destroy).toHaveBeenCalledWith("partial");
    expect(index.remove).toHaveBeenCalledWith("partial");
    expect(gitMocks.gitWorktreeRemove).toHaveBeenCalledWith(PROJECT_PATH, WORKTREE_PATH);
    expect(gitMocks.gitDeleteOwnedWorktreeBranch).toHaveBeenCalledWith(
      PROJECT_PATH,
      expect.objectContaining({ branch: "agent-deck/session-allocated", branchOwned: true }),
    );
    expect(state.live.size).toBe(0);
    expect(state.index.size).toBe(0);
    expect(state.tokens.size).toBe(0);
    expect(state.broadcasts).toEqual([]);
    expect(state.receipts).toEqual([]);
    await fastify.close();
  });

  it("keeps isolation-off project sessions in the project root", async () => {
    const { fastify, sessions } = makeRoute({ isolated: false });
    const response = await fastify.inject({
      method: "POST",
      url: "/sessions",
      payload: { projectId: "project-1" },
    });
    expect(response.statusCode).toBe(201);
    expect(gitMocks.createSessionWorktree).not.toHaveBeenCalled();
    expect(sessions.create).toHaveBeenCalledWith(expect.objectContaining({ cwd: PROJECT_PATH }));
    await fastify.close();
  });

  it("does not apply isolation to no-project sessions", async () => {
    const { fastify, sessions } = makeRoute();
    const standalone = path.join(tmpdir(), "standalone");
    const response = await fastify.inject({
      method: "POST",
      url: "/sessions",
      payload: { cwd: standalone },
    });
    expect(response.statusCode).toBe(201);
    expect(gitMocks.createSessionWorktree).not.toHaveBeenCalled();
    expect(sessions.create).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: standalone, projectId: undefined }),
    );
    await fastify.close();
  });
});
