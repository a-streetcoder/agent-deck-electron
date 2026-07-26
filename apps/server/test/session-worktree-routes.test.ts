import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import type * as GitModule from "../src/git.ts";

const gitMocks = vi.hoisted(() => ({
  createSessionWorktree: vi.fn(),
  gitWorktreePrune: vi.fn(),
  gitWorktreeRegistrationAtPath: vi.fn(),
  gitWorktreeRegistrationMatches: vi.fn(),
  gitDeleteOwnedWorktreeBranch: vi.fn(),
  gitCommitAll: vi.fn(),
  gitCommitsAhead: vi.fn(),
  gitMerge: vi.fn(),
}));

vi.mock("@agent-deck/resources", () => ({
  listProjectFiles: vi.fn(() => []),
  scanPrompts: vi.fn(() => []),
}));

vi.mock("../src/git.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof GitModule>()),
  createSessionWorktree: gitMocks.createSessionWorktree,
  gitWorktreePrune: gitMocks.gitWorktreePrune,
  gitWorktreeRegistrationAtPath: gitMocks.gitWorktreeRegistrationAtPath,
  gitWorktreeRegistrationMatches: gitMocks.gitWorktreeRegistrationMatches,
  gitDeleteOwnedWorktreeBranch: gitMocks.gitDeleteOwnedWorktreeBranch,
  gitCommitAll: gitMocks.gitCommitAll,
  gitCommitsAhead: gitMocks.gitCommitsAhead,
  gitMerge: gitMocks.gitMerge,
}));

import { SessionWorktreeAddError } from "../src/git.ts";
import { registerSessionRoutes } from "../src/routes/sessions.ts";
import { SessionCreationError } from "../src/SessionManager.ts";

const PROJECT_PATH = path.join(tmpdir(), "agent-deck-route-project");
const WORKTREES_ROOT = path.join(tmpdir(), "agent-deck-route-worktrees");
const WORKTREE_PATH = path.join(WORKTREES_ROOT, "a1b2c3d4");

interface Meta {
  id: string;
  cwd: string;
  projectId?: string;
  agentName?: string;
  worktreePath?: string;
  worktreeIdentity?: string;
  worktreeBranch?: string;
  worktreeSourceBranch?: string;
  loopReviewRunId?: string;
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
    get: vi.fn((id: string) => {
      const meta = state.live.get(id);
      return meta ? { meta } : undefined;
    }),
    create: vi.fn((options: Record<string, unknown>) => {
      if (overrides.create) return { meta: overrides.create(options, state) };
      const worktree = options.worktree as { path: string; identityToken?: string } | undefined;
      const meta: Meta = {
        id: "new-session",
        cwd: options.cwd as string,
        projectId: options.projectId as string | undefined,
        agentName: options.agentName as string | undefined,
        ...(worktree
          ? {
              worktreePath: worktree.path,
              worktreeIdentity: worktree.identityToken as string | undefined,
            }
          : {}),
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
    removeLoopSessionSnapshot: vi.fn(),
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
    sessionWorktreeStore: {
      rootPath: WORKTREES_ROOT,
      captureWorktreeIdentity: state.captureWorktreeIdentity,
      deleteWorktree: state.deleteWorktree,
    },
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
    captureWorktreeIdentity: vi.fn(() => "v1:0000000000000001:0000000000000002"),
    deleteWorktree: vi.fn(async () => {}),
  };
}

beforeEach(() => {
  gitMocks.createSessionWorktree.mockReset();
  gitMocks.gitWorktreePrune.mockReset().mockResolvedValue(undefined);
  gitMocks.gitWorktreeRegistrationAtPath.mockReset().mockResolvedValue({
    path: WORKTREE_PATH,
    branch: "agent-deck/session-a1b2c3d4",
  });
  gitMocks.gitWorktreeRegistrationMatches.mockReset().mockResolvedValue(true);
  gitMocks.gitDeleteOwnedWorktreeBranch.mockReset().mockResolvedValue(undefined);
  gitMocks.gitCommitAll.mockReset().mockResolvedValue({ committed: true });
  gitMocks.gitCommitsAhead.mockReset().mockResolvedValue(1);
  gitMocks.gitMerge.mockReset().mockResolvedValue(undefined);
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

  it("preserves an unregistered collision while deleting only the owned branch", async () => {
    gitMocks.createSessionWorktree.mockRejectedValue(
      new SessionWorktreeAddError(
        {
          path: WORKTREE_PATH,
          branch: "agent-deck/session-a1b2c3d4",
          sourceBranch: "main",
          branchOwned: true,
        },
        new Error("target occupied"),
      ),
    );
    gitMocks.gitWorktreeRegistrationMatches.mockResolvedValue(false);
    const { fastify, state } = makeRoute();

    const response = await fastify.inject({
      method: "POST",
      url: "/sessions",
      payload: { projectId: "project-1" },
    });

    expect(response.statusCode).toBe(409);
    expect(state.deleteWorktree).not.toHaveBeenCalled();
    expect(gitMocks.gitWorktreePrune).not.toHaveBeenCalled();
    expect(gitMocks.gitDeleteOwnedWorktreeBranch).toHaveBeenCalledWith(
      PROJECT_PATH,
      expect.objectContaining({ branch: "agent-deck/session-a1b2c3d4" }),
    );
    await fastify.close();
  });

  it("cleans a partial target only with exact owned Git registration", async () => {
    gitMocks.createSessionWorktree.mockRejectedValue(
      new SessionWorktreeAddError(
        {
          path: WORKTREE_PATH,
          branch: "agent-deck/session-a1b2c3d4",
          sourceBranch: "main",
          branchOwned: true,
        },
        new Error("add interrupted"),
      ),
    );
    const { fastify, state } = makeRoute();

    const response = await fastify.inject({
      method: "POST",
      url: "/sessions",
      payload: { projectId: "project-1" },
    });

    expect(response.statusCode).toBe(409);
    expect(state.deleteWorktree).toHaveBeenCalledOnce();
    expect(gitMocks.gitWorktreePrune).toHaveBeenCalledWith(PROJECT_PATH);
    expect(gitMocks.gitDeleteOwnedWorktreeBranch).toHaveBeenCalled();
    expect(state.deleteWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      gitMocks.gitWorktreePrune.mock.invocationCallOrder[0]!,
    );
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
    expect(state.deleteWorktree).not.toHaveBeenCalled();
    releaseCleanup();
    const response = await responsePromise;

    expect(response.statusCode).toBe(500);
    expect(sessions.destroy).not.toHaveBeenCalled();
    expect(state.index.get("failed-create")?.cwd).toBe("stale-unrelated-cwd");
    expect(index.remove).not.toHaveBeenCalledWith("failed-create");
    expect(state.tokens.size).toBe(0);
    expect(state.broadcasts).toEqual([]);
    expect(state.receipts).toEqual([]);
    expect(state.deleteWorktree).toHaveBeenCalledWith(
      WORKTREE_PATH,
      "v1:0000000000000001:0000000000000002",
    );
    expect(gitMocks.gitWorktreePrune).toHaveBeenCalledWith(PROJECT_PATH);
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
    expect(state.deleteWorktree).toHaveBeenCalledWith(
      WORKTREE_PATH,
      "v1:0000000000000001:0000000000000002",
    );
    expect(gitMocks.gitWorktreePrune).toHaveBeenCalledWith(PROJECT_PATH);
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

  it("retains persisted metadata when an unsafe external worktree target is refused", async () => {
    const { fastify, state, sessions, index } = makeRoute();
    const external = path.join(tmpdir(), "external-session-target");
    state.index.set("persisted-unsafe", {
      id: "persisted-unsafe",
      cwd: external,
      projectId: "project-1",
      worktreePath: external,
    });
    state.deleteWorktree.mockRejectedValue(
      Object.assign(new Error("refused"), { code: "SESSION_WORKTREE_INVALID_PATH" }),
    );

    const response = await fastify.inject({
      method: "DELETE",
      url: "/sessions/persisted-unsafe",
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "session_worktree_cleanup_failed" });
    expect(sessions.destroy).not.toHaveBeenCalledWith("persisted-unsafe");
    expect(state.deleteWorktree).not.toHaveBeenCalled();
    expect(gitMocks.gitWorktreePrune).not.toHaveBeenCalled();
    expect(index.remove).not.toHaveBeenCalledWith("persisted-unsafe");
    expect(state.index.has("persisted-unsafe")).toBe(true);
    expect(state.broadcasts).toEqual([]);
    await fastify.close();
  });

  it("durably adopts a proven live legacy identity before teardown", async () => {
    const { fastify, state, sessions, index } = makeRoute();
    const present = mkdtempSync(path.join(tmpdir(), "live-legacy-"));
    const legacy: Meta = {
      id: "live-legacy",
      cwd: present,
      projectId: "project-1",
      worktreePath: present,
      worktreeBranch: "agent-deck/session-a1b2c3d4",
    };
    state.live.set(legacy.id, legacy);
    state.index.set(legacy.id, legacy);
    gitMocks.gitWorktreeRegistrationAtPath.mockResolvedValue({
      path: present,
      branch: legacy.worktreeBranch,
    });

    const response = await fastify.inject({ method: "DELETE", url: "/sessions/live-legacy" });

    expect(response.statusCode, response.body).toBe(200);
    expect(legacy.worktreeIdentity).toBe("v1:0000000000000001:0000000000000002");
    const adoptedCall = index.upsert.mock.calls.find(([record]) => record.id === legacy.id);
    expect(adoptedCall?.[0].worktreeIdentity).toBe("v1:0000000000000001:0000000000000002");
    expect(index.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      sessions.destroy.mock.invocationCallOrder[0]!,
    );
    expect(state.deleteWorktree).toHaveBeenCalledWith(
      present,
      "v1:0000000000000001:0000000000000002",
    );
    await fastify.close();
  });

  it("rejects a missing target still registered to another branch", async () => {
    const { fastify, state, sessions, index } = makeRoute();
    const missing = path.join(tmpdir(), "missing-registered-a1b2c3d4");
    state.index.set("missing-mismatch", {
      id: "missing-mismatch",
      cwd: missing,
      projectId: "project-1",
      worktreePath: missing,
      worktreeIdentity: "v1:0000000000000001:0000000000000002",
      worktreeBranch: "agent-deck/session-a1b2c3d4",
    });
    gitMocks.gitWorktreeRegistrationAtPath.mockResolvedValue({
      path: missing,
      branch: "agent-deck/session-other",
    });

    const response = await fastify.inject({
      method: "DELETE",
      url: "/sessions/missing-mismatch",
    });

    expect(response.statusCode).toBe(409);
    expect(sessions.destroy).not.toHaveBeenCalledWith("missing-mismatch");
    expect(state.deleteWorktree).not.toHaveBeenCalled();
    expect(gitMocks.gitWorktreePrune).not.toHaveBeenCalled();
    expect(index.remove).not.toHaveBeenCalledWith("missing-mismatch");
    expect(state.index.has("missing-mismatch")).toBe(true);
    await fastify.close();
  });

  it("rejects a present target whose Git registration does not match the persisted branch", async () => {
    const { fastify, state, sessions, index } = makeRoute();
    const present = mkdtempSync(path.join(tmpdir(), "branch-mismatch-"));
    state.index.set("branch-mismatch", {
      id: "branch-mismatch",
      cwd: present,
      projectId: "project-1",
      worktreePath: present,
      worktreeIdentity: "v1:0000000000000001:0000000000000002",
      worktreeBranch: "agent-deck/session-a1b2c3d4",
    });
    gitMocks.gitWorktreeRegistrationAtPath.mockResolvedValue({
      path: present,
      branch: "agent-deck/session-other",
    });

    const response = await fastify.inject({
      method: "DELETE",
      url: "/sessions/branch-mismatch",
    });

    expect(response.statusCode).toBe(409);
    expect(sessions.destroy).not.toHaveBeenCalledWith("branch-mismatch");
    expect(state.deleteWorktree).not.toHaveBeenCalled();
    expect(index.remove).not.toHaveBeenCalledWith("branch-mismatch");
    expect(state.index.has("branch-mismatch")).toBe(true);
    await fastify.close();
  });

  it("rejects duplicate persisted worktree ownership before teardown", async () => {
    const { fastify, state, sessions, index } = makeRoute();
    for (const id of ["first", "second"]) {
      state.index.set(id, {
        id,
        cwd: WORKTREE_PATH,
        projectId: "project-1",
        worktreePath: WORKTREE_PATH,
        worktreeIdentity: "v1:0000000000000001:0000000000000002",
        worktreeBranch: "agent-deck/session-a1b2c3d4",
      });
    }

    const response = await fastify.inject({ method: "DELETE", url: "/sessions/first" });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "session_worktree_cleanup_failed" });
    expect(sessions.destroy).not.toHaveBeenCalledWith("first");
    expect(state.deleteWorktree).not.toHaveBeenCalled();
    expect(gitMocks.gitWorktreeRegistrationAtPath).not.toHaveBeenCalled();
    expect(index.remove).not.toHaveBeenCalledWith("first");
    expect(state.index.has("first")).toBe(true);
    expect(state.index.has("second")).toBe(true);
    await fastify.close();
  });

  it("refuses Loop review merge before any Git mutation", async () => {
    const { fastify, state } = makeRoute();
    state.index.set("loop-review-session", {
      id: "loop-review-session",
      cwd: WORKTREE_PATH,
      projectId: "project-1",
      worktreePath: WORKTREE_PATH,
      worktreeBranch: "agent-deck/loop-review",
      worktreeSourceBranch: "main",
      loopReviewRunId: "12345678-1234-4123-8123-123456789abc",
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/sessions/loop-review-session/merge",
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "loop_review_read_only",
      error: "Loop review sessions are read-only. Merge and apply are unavailable.",
    });
    expect(gitMocks.gitCommitAll).not.toHaveBeenCalled();
    expect(gitMocks.gitCommitsAhead).not.toHaveBeenCalled();
    expect(gitMocks.gitMerge).not.toHaveBeenCalled();

    const removed = await fastify.inject({
      method: "DELETE",
      url: "/sessions/loop-review-session",
    });
    expect(removed.statusCode).toBe(200);
    expect(state.deleteWorktree).not.toHaveBeenCalled();
    expect(gitMocks.gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();
    await fastify.close();
  });
});
