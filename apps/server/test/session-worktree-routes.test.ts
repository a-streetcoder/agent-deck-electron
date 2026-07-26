import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import type * as GitModule from "../src/git.ts";

const gitMocks = vi.hoisted(() => ({
  canonicalWorktreePath: vi.fn(),
  createSessionWorktree: vi.fn(),
  gitWorktreePrune: vi.fn(),
  gitWorktreeRegistrationAtPath: vi.fn(),
  gitWorktreeRegistrationMatches: vi.fn(),
  gitDeleteOwnedWorktreeBranch: vi.fn(),
  gitCheckoutBranch: vi.fn(),
  gitCommitAll: vi.fn(),
  gitCommitsAhead: vi.fn(),
  gitCurrentBranch: vi.fn(),
  gitHasUnmergedEntries: vi.fn(),
  gitLocalBranchRef: vi.fn(),
  gitMergeInProgress: vi.fn(),
  gitMergeNoCheckout: vi.fn(),
  gitOperationInProgress: vi.fn(),
  gitRepositoryIdentity: vi.fn(),
  gitWorkingTreeClean: vi.fn(),
  gitWorktreeRegistrations: vi.fn(),
}));

vi.mock("@agent-deck/resources", () => ({
  listProjectFiles: vi.fn(() => []),
  scanPrompts: vi.fn(() => []),
}));

vi.mock("../src/git.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof GitModule>()),
  canonicalWorktreePath: gitMocks.canonicalWorktreePath,
  createSessionWorktree: gitMocks.createSessionWorktree,
  gitWorktreePrune: gitMocks.gitWorktreePrune,
  gitWorktreeRegistrationAtPath: gitMocks.gitWorktreeRegistrationAtPath,
  gitWorktreeRegistrationMatches: gitMocks.gitWorktreeRegistrationMatches,
  gitDeleteOwnedWorktreeBranch: gitMocks.gitDeleteOwnedWorktreeBranch,
  gitCheckoutBranch: gitMocks.gitCheckoutBranch,
  gitCommitAll: gitMocks.gitCommitAll,
  gitCommitsAhead: gitMocks.gitCommitsAhead,
  gitCurrentBranch: gitMocks.gitCurrentBranch,
  gitHasUnmergedEntries: gitMocks.gitHasUnmergedEntries,
  gitLocalBranchRef: gitMocks.gitLocalBranchRef,
  gitMergeInProgress: gitMocks.gitMergeInProgress,
  gitMergeNoCheckout: gitMocks.gitMergeNoCheckout,
  gitOperationInProgress: gitMocks.gitOperationInProgress,
  gitRepositoryIdentity: gitMocks.gitRepositoryIdentity,
  gitWorkingTreeClean: gitMocks.gitWorkingTreeClean,
  gitWorktreeRegistrations: gitMocks.gitWorktreeRegistrations,
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
      reserveWorktree: state.reserveWorktree,
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
    dropDiffCache: state.dropDiffCache,
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
    reserveWorktree: vi.fn((_target: string) => "v1:0000000000000001:0000000000000002"),
    captureWorktreeIdentity: vi.fn(() => "v1:0000000000000001:0000000000000002"),
    deleteWorktree: vi.fn(async () => {}),
    dropDiffCache: vi.fn(),
  };
}

beforeEach(() => {
  gitMocks.canonicalWorktreePath
    .mockReset()
    .mockImplementation(async (candidate: string) => path.resolve(candidate));
  gitMocks.createSessionWorktree.mockReset();
  gitMocks.gitWorktreePrune.mockReset().mockResolvedValue(undefined);
  gitMocks.gitWorktreeRegistrationAtPath.mockReset().mockResolvedValue({
    path: WORKTREE_PATH,
    branch: "agent-deck/session-a1b2c3d4",
  });
  gitMocks.gitWorktreeRegistrationMatches.mockReset().mockResolvedValue(true);
  gitMocks.gitDeleteOwnedWorktreeBranch.mockReset().mockResolvedValue(undefined);
  gitMocks.gitCheckoutBranch.mockReset().mockResolvedValue(undefined);
  gitMocks.gitCommitAll.mockReset().mockResolvedValue({ committed: true });
  gitMocks.gitCommitsAhead.mockReset().mockResolvedValue(1);
  gitMocks.gitCurrentBranch
    .mockReset()
    .mockImplementation(async (cwd: string) =>
      cwd === WORKTREE_PATH ? "agent-deck/session-a1b2c3d4" : "main",
    );
  gitMocks.gitHasUnmergedEntries.mockReset().mockResolvedValue(false);
  gitMocks.gitLocalBranchRef.mockReset().mockResolvedValue("refs/heads/main");
  gitMocks.gitMergeInProgress.mockReset().mockResolvedValue(false);
  gitMocks.gitMergeNoCheckout.mockReset().mockResolvedValue(undefined);
  gitMocks.gitOperationInProgress.mockReset().mockResolvedValue(false);
  gitMocks.gitRepositoryIdentity.mockReset().mockResolvedValue("repo-identity");
  gitMocks.gitWorkingTreeClean.mockReset().mockResolvedValue(true);
  gitMocks.gitWorktreeRegistrations.mockReset().mockResolvedValue([
    { path: PROJECT_PATH, branch: "main" },
    { path: WORKTREE_PATH, branch: "agent-deck/session-a1b2c3d4" },
  ]);
  gitMocks.createSessionWorktree.mockResolvedValue({
    path: WORKTREE_PATH,
    branch: "agent-deck/session-allocated",
    sourceBranch: "main",
    identityToken: "v1:0000000000000001:0000000000000002",
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
    expect(state.reserveWorktree).toHaveBeenCalledOnce();
    expect(state.deleteWorktree).toHaveBeenCalledWith(
      state.reserveWorktree.mock.calls[0]![0],
      "v1:0000000000000001:0000000000000002",
    );
    expect(gitMocks.gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();
    await fastify.close();
  });

  it("leaves a reservation collision untouched and creates no branch", async () => {
    const { fastify, state } = makeRoute();
    state.reserveWorktree.mockImplementation(() => {
      throw new Error("target occupied");
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/sessions",
      payload: { projectId: "project-1" },
    });

    expect(response.statusCode).toBe(409);
    expect(gitMocks.createSessionWorktree).not.toHaveBeenCalled();
    expect(state.deleteWorktree).not.toHaveBeenCalled();
    expect(gitMocks.gitWorktreePrune).not.toHaveBeenCalled();
    expect(gitMocks.gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();
    await fastify.close();
  });

  it("cleans an unregistered partial target with its reservation token", async () => {
    gitMocks.createSessionWorktree.mockRejectedValue(
      new SessionWorktreeAddError(
        {
          path: WORKTREE_PATH,
          branch: "agent-deck/session-a1b2c3d4",
          sourceBranch: "main",
          identityToken: "v1:0000000000000001:0000000000000002",
          branchOwned: true,
        },
        new Error("add interrupted"),
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
    expect(state.deleteWorktree).toHaveBeenCalledOnce();
    expect(gitMocks.gitWorktreePrune).not.toHaveBeenCalled();
    expect(gitMocks.gitDeleteOwnedWorktreeBranch).toHaveBeenCalled();
    await fastify.close();
  });

  it("cleans a registered partial target before pruning its exact registration", async () => {
    gitMocks.createSessionWorktree.mockRejectedValue(
      new SessionWorktreeAddError(
        {
          path: WORKTREE_PATH,
          branch: "agent-deck/session-a1b2c3d4",
          sourceBranch: "main",
          identityToken: "v1:0000000000000001:0000000000000002",
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

  it("persists the reservation identity without post-add capture", async () => {
    const { fastify, state } = makeRoute();

    const response = await fastify.inject({
      method: "POST",
      url: "/sessions",
      payload: { projectId: "project-1" },
    });

    expect(response.statusCode).toBe(201);
    expect(gitMocks.createSessionWorktree).toHaveBeenCalledWith(
      PROJECT_PATH,
      expect.any(String),
      expect.stringMatching(/^agent-deck\/session-/),
      "v1:0000000000000001:0000000000000002",
    );
    expect(state.captureWorktreeIdentity).not.toHaveBeenCalled();
    expect(response.json()).toMatchObject({
      session: { worktreeIdentity: "v1:0000000000000001:0000000000000002" },
    });
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

  it("returns typed preflight, ahead, conflict, generic, and success outcomes", async () => {
    const seed = (state: ReturnType<typeof makeState>) => {
      state.index.set("merge-session", {
        id: "merge-session",
        cwd: WORKTREE_PATH,
        projectId: "project-1",
        worktreePath: WORKTREE_PATH,
        worktreeIdentity: "v1:0000000000000001:0000000000000002",
        worktreeBranch: "agent-deck/session-a1b2c3d4",
        worktreeSourceBranch: "main",
      });
    };

    const dirtyRoute = makeRoute();
    seed(dirtyRoute.state);
    gitMocks.gitWorkingTreeClean.mockResolvedValueOnce(false);
    const dirty = await dirtyRoute.fastify.inject({
      method: "POST",
      url: "/sessions/merge-session/merge",
    });
    expect(dirty.json()).toMatchObject({
      code: "merge_parent_dirty",
      outcome: "dirty",
      worktreeCommitted: false,
    });
    expect(gitMocks.gitCommitAll).not.toHaveBeenCalled();
    await dirtyRoute.fastify.close();

    const missingRoute = makeRoute();
    seed(missingRoute.state);
    gitMocks.gitLocalBranchRef
      .mockResolvedValueOnce("refs/heads/session")
      .mockRejectedValueOnce(new Error("missing"));
    const missing = await missingRoute.fastify.inject({
      method: "POST",
      url: "/sessions/merge-session/merge",
    });
    expect(missing.json()).toMatchObject({
      code: "merge_source_missing",
      outcome: "stale_ownership",
    });
    await missingRoute.fastify.close();

    const occupiedRoute = makeRoute();
    seed(occupiedRoute.state);
    gitMocks.gitWorktreeRegistrations.mockResolvedValueOnce([
      { path: PROJECT_PATH, branch: "other" },
      { path: path.join(tmpdir(), "other-worktree"), branch: "main" },
      { path: WORKTREE_PATH, branch: "agent-deck/session-a1b2c3d4" },
    ]);
    const occupied = await occupiedRoute.fastify.inject({
      method: "POST",
      url: "/sessions/merge-session/merge",
    });
    expect(occupied.json()).toMatchObject({ code: "merge_source_occupied" });
    await occupiedRoute.fastify.close();

    const aheadRoute = makeRoute();
    seed(aheadRoute.state);
    gitMocks.gitCommitsAhead.mockRejectedValueOnce(new Error("rev-list failed"));
    const ahead = await aheadRoute.fastify.inject({
      method: "POST",
      url: "/sessions/merge-session/merge",
    });
    expect(ahead.statusCode).toBe(500);
    expect(ahead.json()).toMatchObject({ code: "merge_ahead_failed", worktreeCommitted: true });
    expect(aheadRoute.state.dropDiffCache).toHaveBeenCalledWith("merge-session");
    await aheadRoute.fastify.close();

    const zeroRoute = makeRoute();
    seed(zeroRoute.state);
    gitMocks.gitCommitsAhead.mockResolvedValueOnce(0);
    const zero = await zeroRoute.fastify.inject({
      method: "POST",
      url: "/sessions/merge-session/merge",
    });
    expect(zero.json()).toMatchObject({
      code: "merge_nothing_to_merge",
      outcome: "nothing_to_merge",
      worktreeCommitted: true,
    });
    await zeroRoute.fastify.close();

    const conflictRoute = makeRoute();
    seed(conflictRoute.state);
    gitMocks.gitMergeNoCheckout.mockRejectedValueOnce(new Error("merge stopped"));
    gitMocks.gitHasUnmergedEntries.mockResolvedValueOnce(true);
    const conflict = await conflictRoute.fastify.inject({
      method: "POST",
      url: "/sessions/merge-session/merge",
    });
    expect(conflict.json()).toMatchObject({
      code: "merge_conflict",
      outcome: "conflict",
      worktreeCommitted: true,
    });
    expect(conflictRoute.state.dropDiffCache).toHaveBeenCalledWith("merge-session");
    expect(gitMocks.gitCheckoutBranch).not.toHaveBeenCalled();
    await conflictRoute.fastify.close();

    const activeRoute = makeRoute();
    seed(activeRoute.state);
    gitMocks.gitMergeNoCheckout.mockRejectedValueOnce(new Error("commit hook rejected merge"));
    gitMocks.gitMergeInProgress.mockResolvedValueOnce(true);
    const active = await activeRoute.fastify.inject({
      method: "POST",
      url: "/sessions/merge-session/merge",
    });
    expect(active.json()).toMatchObject({
      code: "merge_active_failure",
      outcome: "failed",
      error: expect.stringContaining("commit hook rejected merge"),
      worktreeCommitted: true,
    });
    await activeRoute.fastify.close();

    const failedRoute = makeRoute();
    seed(failedRoute.state);
    gitMocks.gitMergeNoCheckout.mockRejectedValueOnce(new Error("hook failed"));
    const failed = await failedRoute.fastify.inject({
      method: "POST",
      url: "/sessions/merge-session/merge",
    });
    expect(failed.statusCode).toBe(500);
    expect(failed.json()).toMatchObject({ code: "merge_failed", outcome: "failed" });
    await failedRoute.fastify.close();

    const successRoute = makeRoute();
    seed(successRoute.state);
    const success = await successRoute.fastify.inject({
      method: "POST",
      url: "/sessions/merge-session/merge",
    });
    expect(success.json()).toMatchObject({
      code: "merge_succeeded",
      outcome: "merged",
      commits: 1,
      worktreeCommitted: true,
    });
    await successRoute.fastify.close();
  });

  it("rejects duplicate, replaced, non-source, and operation-busy session ownership before commit", async () => {
    const createOwned = () => {
      const route = makeRoute();
      route.state.index.set("merge-session", {
        id: "merge-session",
        cwd: WORKTREE_PATH,
        projectId: "project-1",
        worktreePath: WORKTREE_PATH,
        worktreeIdentity: "v1:0000000000000001:0000000000000002",
        worktreeBranch: "agent-deck/session-a1b2c3d4",
        worktreeSourceBranch: "main",
      });
      return route;
    };

    const duplicate = createOwned();
    duplicate.state.index.set("duplicate", {
      ...duplicate.state.index.get("merge-session")!,
      id: "duplicate",
    });
    expect(
      (
        await duplicate.fastify.inject({ method: "POST", url: "/sessions/merge-session/merge" })
      ).json(),
    ).toMatchObject({ code: "merge_stale_ownership" });
    await duplicate.fastify.close();

    const replaced = createOwned();
    replaced.state.captureWorktreeIdentity.mockReturnValueOnce(
      "v1:ffffffffffffffff:eeeeeeeeeeeeeeee",
    );
    expect(
      (
        await replaced.fastify.inject({ method: "POST", url: "/sessions/merge-session/merge" })
      ).json(),
    ).toMatchObject({ code: "merge_stale_ownership" });
    await replaced.fastify.close();

    const registrationChanged = createOwned();
    gitMocks.gitWorktreeRegistrationAtPath.mockResolvedValueOnce({
      path: WORKTREE_PATH,
      branch: "agent-deck/session-other",
    });
    expect(
      (
        await registrationChanged.fastify.inject({
          method: "POST",
          url: "/sessions/merge-session/merge",
        })
      ).json(),
    ).toMatchObject({ code: "merge_stale_ownership" });
    await registrationChanged.fastify.close();

    const branchChanged = createOwned();
    gitMocks.gitCurrentBranch
      .mockImplementationOnce(async () => "main")
      .mockImplementationOnce(async () => "other");
    expect(
      (
        await branchChanged.fastify.inject({ method: "POST", url: "/sessions/merge-session/merge" })
      ).json(),
    ).toMatchObject({ code: "merge_stale_ownership" });
    await branchChanged.fastify.close();

    const busy = createOwned();
    gitMocks.gitOperationInProgress.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    expect(
      (await busy.fastify.inject({ method: "POST", url: "/sessions/merge-session/merge" })).json(),
    ).toMatchObject({ code: "merge_worktree_busy", outcome: "busy" });
    expect(gitMocks.gitCommitAll).not.toHaveBeenCalled();
    await busy.fastify.close();
  });

  it("wraps deleted, unreadable, and canonical path failures in typed envelopes", async () => {
    const owned = () => {
      const route = makeRoute();
      route.state.index.set("merge-session", {
        id: "merge-session",
        cwd: WORKTREE_PATH,
        projectId: "project-1",
        worktreePath: WORKTREE_PATH,
        worktreeIdentity: "v1:0000000000000001:0000000000000002",
        worktreeBranch: "agent-deck/session-a1b2c3d4",
        worktreeSourceBranch: "main",
      });
      return route;
    };

    const deleted = owned();
    deleted.state.captureWorktreeIdentity.mockImplementationOnce(() => {
      throw Object.assign(new Error("deleted"), { code: "ENOENT" });
    });
    expect(
      (
        await deleted.fastify.inject({ method: "POST", url: "/sessions/merge-session/merge" })
      ).json(),
    ).toMatchObject({
      code: "merge_stale_ownership",
      outcome: "stale_ownership",
      worktreeCommitted: false,
    });
    await deleted.fastify.close();

    const unresolvedSession = owned();
    gitMocks.canonicalWorktreePath.mockRejectedValueOnce(
      Object.assign(new Error("unreadable"), { code: "EACCES" }),
    );
    expect(
      (
        await unresolvedSession.fastify.inject({
          method: "POST",
          url: "/sessions/merge-session/merge",
        })
      ).json(),
    ).toMatchObject({
      code: "merge_path_validation_failed",
      outcome: "stale_ownership",
      worktreeCommitted: false,
    });
    await unresolvedSession.fastify.close();

    const unresolvedProject = owned();
    gitMocks.canonicalWorktreePath.mockImplementation(async (candidate: string) => {
      if (candidate === PROJECT_PATH)
        throw Object.assign(new Error("unreadable"), { code: "EACCES" });
      return path.resolve(candidate);
    });
    expect(
      (
        await unresolvedProject.fastify.inject({
          method: "POST",
          url: "/sessions/merge-session/merge",
        })
      ).json(),
    ).toMatchObject({
      code: "merge_path_validation_failed",
      outcome: "stale_ownership",
      worktreeCommitted: false,
    });
    await unresolvedProject.fastify.close();
  });

  it("fails fast when another merge holds the canonical project lock", async () => {
    const { fastify, state } = makeRoute();
    state.index.set("merge-session", {
      id: "merge-session",
      cwd: WORKTREE_PATH,
      projectId: "project-1",
      worktreePath: WORKTREE_PATH,
      worktreeIdentity: "v1:0000000000000001:0000000000000002",
      worktreeBranch: "agent-deck/session-a1b2c3d4",
      worktreeSourceBranch: "main",
    });
    let release!: () => void;
    const held = new Promise<boolean>((resolve) => {
      release = () => resolve(false);
    });
    gitMocks.gitOperationInProgress.mockImplementationOnce(() => held);

    const first = fastify.inject({ method: "POST", url: "/sessions/merge-session/merge" });
    await vi.waitFor(() => expect(gitMocks.gitOperationInProgress).toHaveBeenCalledOnce());
    const second = await fastify.inject({ method: "POST", url: "/sessions/merge-session/merge" });
    expect(second.json()).toMatchObject({
      code: "merge_busy",
      outcome: "busy",
      worktreeCommitted: false,
    });
    release();
    expect((await first).statusCode).toBe(200);
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
      outcome: "read_only",
      error: "Loop review sessions are read-only. Merge and apply are unavailable.",
      worktreeCommitted: false,
    });
    expect(gitMocks.gitCommitAll).not.toHaveBeenCalled();
    expect(gitMocks.gitCommitsAhead).not.toHaveBeenCalled();
    expect(gitMocks.gitMergeNoCheckout).not.toHaveBeenCalled();

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
