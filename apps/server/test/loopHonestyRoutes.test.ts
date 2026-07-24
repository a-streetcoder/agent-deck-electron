import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOOP_STRUCTURE_UNSUPPORTED_CODE, type LoopStructure } from "@agent-deck/domain";
import { loopsDir, scanLoops, writeLoopFile } from "@agent-deck/resources";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";

vi.mock("../src/git.ts", () => ({
  createLoopWorktree: vi.fn(),
  gitWorktreeRemove: vi.fn(),
  strictRemoveOwnedLoopWorktree: vi.fn(),
  gitDeleteOwnedWorktreeBranch: vi.fn(),
}));

import {
  createLoopWorktree,
  gitDeleteOwnedWorktreeBranch,
  strictRemoveOwnedLoopWorktree,
} from "../src/git.ts";
import { canonicalCheckoutLockKey, registerLoopRoutes } from "../src/routes/loops.ts";
import { SessionCreationError } from "../src/SessionManager.ts";

const unsupportedStructures: LoopStructure[] = [
  "parallelAgents",
  "discoveryTriage",
  "humanApproval",
];

const servers: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.clearAllMocks();
});

function makeRoutes(
  home: string,
  rootsFor: () => { home: string } = () => ({ home }),
  recovery: { locks?: Map<string, string>; runs?: unknown[] } = {},
) {
  const fastify = Fastify();
  servers.push(fastify);
  const createSession = vi.fn();
  const destroySession = vi.fn();
  const runSubagent = vi.fn();
  const announceCreated = vi.fn();
  const startEngine = vi.fn();
  const stopEngine = vi.fn();
  const settledEngine = vi.fn();
  const rollbackEngine = vi.fn();
  const recoveryCheckoutLocks = vi.fn(() => recovery.locks ?? new Map<string, string>());
  const pendingResourceReconciliations = vi.fn(() => recovery.runs ?? []);
  const markSessionReconciled = vi.fn();
  const markWorktreeReconciled = vi.fn();
  const acknowledgeCheckoutRecovery = vi.fn();
  const getEngine = vi.fn();
  const broadcast = vi.fn();
  const findProject = vi.fn((_predicate?: (project: { id: string; path: string }) => boolean) => ({
    id: "project",
    path: home,
  }));
  const indexRows = new Map<
    string,
    { id: string; cwd: string; createdAt: string; projectId?: string }
  >();
  const bridgeTokens = new Map<string, string>();
  registerLoopRoutes({
    fastify,
    sessions: {
      create: createSession,
      destroy: destroySession,
      runSubagent,
      announceCreated,
    },
    index: {
      find: (
        predicate: (meta: {
          id: string;
          cwd: string;
          createdAt: string;
          projectId?: string;
        }) => boolean,
      ) => [...indexRows.values()].find(predicate),
      remove: (id: string) => indexRows.delete(id),
    },
    projects: { find: findProject },
    loopEngine: {
      start: startEngine,
      stop: stopEngine,
      settled: settledEngine,
      rollbackStart: rollbackEngine,
      recoveryCheckoutLocks,
      pendingResourceReconciliations,
      markSessionReconciled,
      markWorktreeReconciled,
      acknowledgeCheckoutRecovery,
      list: () => [],
      get: getEngine,
    },
    bridgeTokens,
    broadcast,
    rootsFor,
    enabledExtensionPaths: () => [],
    worktreesRoot: path.join(home, "managed-worktrees"),
  } as unknown as ServerContext);
  return {
    fastify,
    createSession,
    destroySession,
    runSubagent,
    announceCreated,
    startEngine,
    stopEngine,
    settledEngine,
    rollbackEngine,
    recoveryCheckoutLocks,
    pendingResourceReconciliations,
    markSessionReconciled,
    markWorktreeReconciled,
    acknowledgeCheckoutRecovery,
    getEngine,
    findProject,
    broadcast,
    indexRows,
    bridgeTokens,
  };
}

function writeExternalLoop(
  home: string,
  name: string,
  structure: LoopStructure,
  fileName = "native.loop.md",
): string {
  const dir = loopsDir({ home });
  const filePath = path.join(dir, fileName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    filePath,
    `---\nname: ${name}\nstructure: ${structure}\ndescription: original\nwriteTarget: newWorktree\nexternalMetadata: preserve\n---\n\nKeep this native definition intact.\n`,
  );
  return filePath;
}

function expectUnsupported(response: { statusCode: number; json(): unknown }): void {
  expect(response.statusCode).toBe(422);
  expect(response.json()).toEqual(
    expect.objectContaining({
      code: LOOP_STRUCTURE_UNSUPPORTED_CODE,
      error: expect.stringContaining("Convert this loop to Single agent first"),
    }),
  );
}

describe("loop route honesty gate", () => {
  it.each(unsupportedStructures)(
    "rejects %s writes, duplication, and runs without mutation or runtime allocation",
    async (structure) => {
      const home = mkdtempSync(path.join(tmpdir(), "loop-honesty-"));
      const roots = { home };
      const filePath = writeExternalLoop(home, `Native ${structure}`, structure);
      const original = readFileSync(filePath, "utf8");
      const { fastify, createSession, startEngine, broadcast } = makeRoutes(home);

      const list = await fastify.inject({ method: "GET", url: "/loops" });
      expect(list.statusCode).toBe(200);
      expect(list.json()).toEqual({
        loops: [expect.objectContaining({ name: `Native ${structure}`, structure })],
      });

      const create = await fastify.inject({
        method: "PUT",
        url: "/loops",
        payload: { name: `New ${structure}`, structure },
      });
      expectUnsupported(create);
      expect(scanLoops(roots)).toHaveLength(1);

      const update = await fastify.inject({
        method: "PUT",
        url: "/loops",
        payload: { name: `Native ${structure}`, description: "must not change" },
      });
      expectUnsupported(update);
      expect(readFileSync(filePath, "utf8")).toBe(original);

      const duplicate = await fastify.inject({
        method: "POST",
        url: `/loops/${encodeURIComponent(`Native ${structure}`)}/duplicate`,
      });
      expectUnsupported(duplicate);
      expect(scanLoops(roots)).toHaveLength(1);
      expect(readFileSync(filePath, "utf8")).toBe(original);

      const run = await fastify.inject({
        method: "POST",
        url: `/loops/${encodeURIComponent(`Native ${structure}`)}/run`,
        payload: { projectId: "project" },
      });
      expectUnsupported(run);
      expect(createSession).not.toHaveBeenCalled();
      expect(startEngine).not.toHaveBeenCalled();
      expect(createLoopWorktree).not.toHaveBeenCalled();
      expect(broadcast).not.toHaveBeenCalled();
      expect(readFileSync(filePath, "utf8")).toBe(original);

      const remove = await fastify.inject({
        method: "DELETE",
        url: "/loops",
        payload: { name: `Native ${structure}` },
      });
      expect(remove.statusCode).toBe(200);
      expect(scanLoops(roots)).toEqual([]);

      // Simulate the native definition returning, then prove an explicit
      // conversion (and only an explicit conversion) remains allowed.
      writeFileSync(filePath, original);
      const convert = await fastify.inject({
        method: "PUT",
        url: "/loops",
        payload: {
          name: `Native ${structure}`,
          structure: "singleAgent",
          description: "explicitly converted",
        },
      });
      expect(convert.statusCode).toBe(200);
      expect(scanLoops(roots)[0]).toMatchObject({
        structure: "singleAgent",
        description: "explicitly converted",
      });
    },
  );

  it("maps a structure changed between the route scan and resource write to the same 422", async () => {
    const supportedHome = mkdtempSync(path.join(tmpdir(), "loop-route-race-supported-"));
    const unsupportedHome = mkdtempSync(path.join(tmpdir(), "loop-route-race-unsupported-"));
    const supportedPath = writeLoopFile(
      { home: supportedHome },
      { name: "Racing Loop", structure: "singleAgent", description: "supported" },
    );
    const unsupportedPath = writeExternalLoop(unsupportedHome, "Racing Loop", "humanApproval");
    const supportedOriginal = readFileSync(supportedPath, "utf8");
    const unsupportedOriginal = readFileSync(unsupportedPath, "utf8");
    let homeReads = 0;
    const racingRoots = {} as { home: string };
    Object.defineProperty(racingRoots, "home", {
      get: () => (homeReads++ === 0 ? supportedHome : unsupportedHome),
    });
    const { fastify, broadcast } = makeRoutes(supportedHome, () => racingRoots);

    const update = await fastify.inject({
      method: "PUT",
      url: "/loops",
      payload: { name: "Racing Loop", description: "must not change" },
    });

    expectUnsupported(update);
    expect(update.json()).toEqual(
      expect.objectContaining({ error: expect.stringContaining("Human approval") }),
    );
    expect(broadcast).not.toHaveBeenCalled();
    expect(readFileSync(supportedPath, "utf8")).toBe(supportedOriginal);
    expect(readFileSync(unsupportedPath, "utf8")).toBe(unsupportedOriginal);
  });

  it("rolls back a post-allocation parent create failure before deleting the owned Loop branch", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-start-rollback-"));
    writeLoopFile(
      { home },
      {
        name: "Rollback Loop",
        structure: "singleAgent",
        goal: "Run safely.",
        writeTarget: "newWorktree",
      },
    );
    const { fastify, createSession, startEngine, broadcast, bridgeTokens, indexRows } =
      makeRoutes(home);
    const order: string[] = [];
    vi.mocked(createLoopWorktree).mockImplementation(async (_project, target, branch) => ({
      path: target,
      branch,
      sourceBranch: "main",
      branchOwned: true,
    }));
    vi.mocked(strictRemoveOwnedLoopWorktree).mockImplementation(async () => {
      order.push("worktree");
    });
    vi.mocked(gitDeleteOwnedWorktreeBranch).mockImplementation(async () => {
      order.push("branch");
    });
    createSession.mockImplementation(() => {
      bridgeTokens.set("failed-parent", "secret");
      throw new SessionCreationError(
        "failed-parent",
        new Error("Pi startup failed"),
        Promise.resolve().then(() => {
          order.push("pi");
        }),
      );
    });

    const response = await fastify.inject({
      method: "POST",
      url: "/loops/Rollback%20Loop/run",
      payload: { projectId: "project" },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(
      expect.objectContaining({
        code: "loop_start_failed",
        error: expect.stringContaining("Pi startup failed"),
      }),
    );
    expect(order).toEqual(["pi", "worktree", "branch"]);
    const generatedTarget = vi.mocked(createLoopWorktree).mock.calls[0]![1];
    expect(path.dirname(generatedTarget)).toBe(
      path.join(realpathSync(path.join(home, "managed-worktrees")), "loop"),
    );
    expect(path.basename(generatedTarget)).toMatch(
      /^loop-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(startEngine).not.toHaveBeenCalled();
    expect(bridgeTokens.size).toBe(0);
    expect(indexRows.size).toBe(0);
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("stops and settles an accepted run before destroying startup resources when announcement fails", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-announce-rollback-"));
    writeLoopFile(
      { home },
      {
        name: "Announce Rollback Loop",
        structure: "singleAgent",
        goal: "Run safely.",
        writeTarget: "newWorktree",
      },
    );
    const {
      fastify,
      createSession,
      destroySession,
      announceCreated,
      startEngine,
      stopEngine,
      settledEngine,
      rollbackEngine,
    } = makeRoutes(home);
    const order: string[] = [];
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = () => {
        order.push("settled");
        resolve();
      };
    });
    const parent = {
      meta: {
        id: "accepted-parent",
        cwd: path.join(home, "worktree"),
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
    };
    vi.mocked(createLoopWorktree).mockImplementation(async (_project, target, branch) => ({
      path: target,
      branch,
      sourceBranch: "main",
      branchOwned: true,
    }));
    createSession.mockReturnValue(parent);
    startEngine.mockReturnValue({ id: "run-in-flight" });
    announceCreated.mockImplementation(() => {
      throw new Error("announcement failed");
    });
    stopEngine.mockImplementation(() => {
      order.push("stop");
    });
    settledEngine.mockReturnValue(settled);
    rollbackEngine.mockImplementation(() => {
      order.push("rollback");
    });
    destroySession.mockImplementation(async () => {
      order.push("destroy");
    });
    vi.mocked(strictRemoveOwnedLoopWorktree).mockImplementation(async () => {
      order.push("worktree");
    });
    vi.mocked(gitDeleteOwnedWorktreeBranch).mockImplementation(async () => {
      order.push("branch");
    });

    const responsePromise = fastify.inject({
      method: "POST",
      url: "/loops/Announce%20Rollback%20Loop/run",
      payload: { projectId: "project" },
    });
    await vi.waitFor(() => expect(order).toEqual(["stop"]));
    expect(destroySession).not.toHaveBeenCalled();
    resolveSettled();
    const response = await responsePromise;

    expect(response.statusCode).toBe(500);
    expect(order).toEqual(["stop", "settled", "rollback", "destroy", "worktree", "branch"]);
    expect(stopEngine).toHaveBeenCalledOnce();
    expect(settledEngine).toHaveBeenCalledOnce();
    expect(rollbackEngine).toHaveBeenCalledWith("run-in-flight");
    expect(destroySession).toHaveBeenCalledOnce();
    expect(strictRemoveOwnedLoopWorktree).toHaveBeenCalledOnce();
    expect(gitDeleteOwnedWorktreeBranch).toHaveBeenCalledOnce();
  });

  it("rejects invalid native Pipeline configuration before runtime allocation", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-pipeline-invalid-"));
    const filePath = writeExternalLoop(home, "Invalid Pipeline", "agentPipeline");
    const original = readFileSync(filePath, "utf8");
    const { fastify, createSession, startEngine } = makeRoutes(home);

    const run = await fastify.inject({
      method: "POST",
      url: "/loops/Invalid%20Pipeline/run",
      payload: { projectId: "project" },
    });
    expect(run.statusCode).toBe(422);
    expect(run.json()).toMatchObject({ code: "loop_definition_invalid" });
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();

    const duplicate = await fastify.inject({
      method: "POST",
      url: "/loops/Invalid%20Pipeline/duplicate",
    });
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json()).toMatchObject({ code: "loop_definition_invalid" });
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });

  it("applies Pipeline stage tool policy by write target and evaluator no-tools policy", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-pipeline-policy-"));
    writeLoopFile(
      { home },
      {
        name: "Artifact Pipeline",
        structure: "agentPipeline",
        goal: "Run stages.",
        pipelineStages: ["A", "A", "B"],
        writeTarget: "artifactMarkdown",
      },
    );
    writeLoopFile(
      { home },
      {
        name: "Checkout Pipeline",
        structure: "agentPipeline",
        goal: "Run stages.",
        pipelineStages: ["A", "B"],
        writeTarget: "currentCheckout",
      },
    );
    const { fastify, createSession, startEngine, settledEngine, runSubagent } = makeRoutes(home);
    let parentNumber = 0;
    createSession.mockImplementation(() => ({
      meta: {
        id: `pipeline-parent-${++parentNumber}`,
        cwd: home,
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
    }));
    const never = new Promise<void>(() => {});
    settledEngine.mockReturnValue(never);
    startEngine.mockImplementation((_loop, _cwd, options) => ({
      id: `pipeline-run-${parentNumber}`,
      loopName: "Pipeline",
      projectId: "project",
      status: "running",
      currentIteration: 0,
      maxIterations: 1,
      iterations: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      options,
    }));
    runSubagent.mockResolvedValue("report");

    const artifact = await fastify.inject({
      method: "POST",
      url: "/loops/Artifact%20Pipeline/run",
      payload: { projectId: "project" },
    });
    expect(artifact.statusCode).toBe(201);
    const artifactOptions = startEngine.mock.calls[0]![2];
    await artifactOptions.executeRole({ prompt: "stage", agentName: "A", phase: "stage" });
    await artifactOptions.executeRole({ prompt: "evaluate", phase: "evaluator" });
    expect(runSubagent).toHaveBeenNthCalledWith(1, "pipeline-parent-1", "stage", "A", "readOnly");
    expect(runSubagent).toHaveBeenNthCalledWith(
      2,
      "pipeline-parent-1",
      "evaluate",
      undefined,
      "none",
    );

    const checkout = await fastify.inject({
      method: "POST",
      url: "/loops/Checkout%20Pipeline/run",
      payload: { projectId: "project" },
    });
    expect(checkout.statusCode).toBe(201);
    const checkoutOptions = startEngine.mock.calls[1]![2];
    await checkoutOptions.executeRole({ prompt: "stage", agentName: "B", phase: "stage" });
    expect(runSubagent).toHaveBeenNthCalledWith(3, "pipeline-parent-2", "stage", "B", "configured");
  });

  it("rejects concurrent current-checkout runs before a second Pi allocation and releases after cleanup", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-checkout-lock-"));
    writeLoopFile(
      { home },
      {
        name: "Checkout Loop",
        structure: "singleAgent",
        goal: "Run safely.",
        validationCommand: "test",
        writeTarget: "currentCheckout",
      },
    );
    const {
      fastify,
      createSession,
      destroySession,
      announceCreated,
      startEngine,
      settledEngine,
      indexRows,
      findProject,
      broadcast,
    } = makeRoutes(home);
    const aliasRoot = mkdtempSync(path.join(tmpdir(), "loop-checkout-alias-"));
    const alias = path.join(aliasRoot, "project-link");
    symlinkSync(home, alias, process.platform === "win32" ? "junction" : "dir");
    findProject.mockImplementation(
      (predicate?: (project: { id: string; path: string }) => boolean) =>
        [
          { id: "project", path: home },
          { id: "project-alias", path: alias },
        ].find(predicate ?? (() => true))!,
    );
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const parent = {
      meta: {
        id: "loop-parent",
        cwd: home,
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
    };
    createSession.mockReturnValue(parent);
    destroySession.mockResolvedValue(undefined);
    announceCreated.mockImplementation(() => indexRows.set(parent.meta.id, parent.meta));
    startEngine.mockReturnValue({
      id: "run-1",
      loopName: "Checkout Loop",
      status: "running",
      currentIteration: 0,
      maxIterations: 1,
      iterations: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    settledEngine.mockReturnValue(settled);

    const first = await fastify.inject({
      method: "POST",
      url: "/loops/Checkout%20Loop/run",
      payload: { projectId: "project" },
    });
    expect(first.statusCode).toBe(201);
    const second = await fastify.inject({
      method: "POST",
      url: "/loops/Checkout%20Loop/run",
      payload: { projectId: "project-alias" },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "loop_checkout_busy" });
    // POSIX symlink and Windows directory-junction aliases canonicalize to the
    // same native checkout identity before any second session/Pi allocation.
    expect(createSession).toHaveBeenCalledOnce();
    expect(startEngine).toHaveBeenCalledOnce();

    settle();
    await vi.waitFor(() => expect(destroySession).toHaveBeenCalledOnce());
    expect(indexRows.has(parent.meta.id)).toBe(false);
    expect(broadcast).toHaveBeenCalledWith({
      type: "session_removed",
      sessionId: parent.meta.id,
    });
    const afterCleanup = await fastify.inject({
      method: "POST",
      url: "/loops/Checkout%20Loop/run",
      payload: { projectId: "project" },
    });
    expect(afterCleanup.statusCode).toBe(201);
    expect(createSession).toHaveBeenCalledTimes(2);
  });

  it("fails closed when checkout canonicalization cannot be established", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-checkout-missing-"));
    writeLoopFile(
      { home },
      {
        name: "Missing Checkout",
        structure: "singleAgent",
        goal: "Run safely.",
        validationCommand: "test",
        writeTarget: "currentCheckout",
      },
    );
    const { fastify, createSession, startEngine, findProject } = makeRoutes(home);
    findProject.mockReturnValue({ id: "project", path: path.join(home, "does-not-exist") });

    const response = await fastify.inject({
      method: "POST",
      url: "/loops/Missing%20Checkout/run",
      payload: { projectId: "project" },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ code: "loop_checkout_canonicalization_failed" });
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();
  });

  it("reconciles only proven recovery resources once and keeps checkout retries locked", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-recovery-"));
    writeLoopFile(
      { home },
      {
        name: "Recovery Loop",
        structure: "singleAgent",
        goal: "Run safely.",
        validationCommand: "test",
        writeTarget: "currentCheckout",
      },
    );
    const lockKey = canonicalCheckoutLockKey(home);
    const interrupted = {
      id: "11111111-1111-4111-8111-111111111111",
      loopName: "Recovery Loop",
      projectId: "project",
      status: "interrupted",
      launch: {
        sessionId: "stale-parent",
        writeTarget: "currentCheckout",
        checkoutLockKey: lockKey,
      },
    };
    const ownedWorktree = {
      id: "owned-worktree-run",
      projectId: "project",
      status: "interrupted",
      launch: {
        sessionId: "owned-parent",
        writeTarget: "newWorktree",
        sessionReconciledAt: "already-clean",
        worktree: {
          projectRoot: home,
          path: path.join(home, "owned-worktree"),
          branch: "agent-deck/loop-owned",
          sourceBranch: "main",
          branchOwned: true,
        },
      },
    };
    const unsettledWorktree = {
      id: "unsettled-worktree-run",
      status: "interrupted",
      launch: {
        sessionId: "unsettled-parent",
        writeTarget: "newWorktree",
        worktree: {
          projectRoot: home,
          path: path.join(home, "unsettled-worktree"),
          branch: "agent-deck/loop-unsettled",
          sourceBranch: "main",
          branchOwned: true,
        },
      },
    };
    const unownedWorktree = {
      id: "unowned-worktree-run",
      status: "interrupted",
      launch: {
        sessionId: "unowned-parent",
        writeTarget: "newWorktree",
        sessionReconciledAt: "already-clean",
        worktree: {
          projectRoot: home,
          path: path.join(home, "unowned-worktree"),
          branch: "user-branch",
          sourceBranch: "main",
          branchOwned: false,
        },
      },
    };
    const {
      fastify,
      createSession,
      startEngine,
      destroySession,
      getEngine,
      acknowledgeCheckoutRecovery,
      markSessionReconciled,
      markWorktreeReconciled,
      indexRows,
      bridgeTokens,
    } = makeRoutes(home, undefined, {
      locks: new Map([[lockKey, interrupted.id]]),
      runs: [interrupted, ownedWorktree, unsettledWorktree, unownedWorktree],
    });
    indexRows.set("stale-parent", {
      id: "stale-parent",
      cwd: home,
      createdAt: "before-restart",
      projectId: "project",
    });
    bridgeTokens.set("stale-parent", "stale-token");
    destroySession.mockImplementation(async (id: string) => {
      if (id === "unsettled-parent") throw new Error("process has not settled");
    });
    getEngine.mockReturnValue(interrupted);

    const retry = await fastify.inject({
      method: "POST",
      url: "/loops/runs/11111111-1111-4111-8111-111111111111/retry",
    });
    expect(retry.statusCode).toBe(409);
    expect(retry.json()).toMatchObject({
      code: "loop_checkout_recovery_required",
      runId: "11111111-1111-4111-8111-111111111111",
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();
    expect(destroySession).toHaveBeenCalledTimes(2);
    expect(destroySession).toHaveBeenCalledWith("stale-parent");
    expect(destroySession).toHaveBeenCalledWith("unsettled-parent");
    expect(indexRows.has("stale-parent")).toBe(false);
    expect(bridgeTokens.has("stale-parent")).toBe(false);
    expect(markSessionReconciled).toHaveBeenCalledOnce();
    expect(strictRemoveOwnedLoopWorktree).toHaveBeenCalledOnce();
    expect(strictRemoveOwnedLoopWorktree).toHaveBeenCalledWith(
      expect.objectContaining({
        registeredProjectRoot: home,
        worktree: ownedWorktree.launch.worktree,
      }),
    );
    expect(markWorktreeReconciled).toHaveBeenCalledOnce();
    expect(gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();

    const acknowledged = {
      ...interrupted,
      launch: { ...interrupted.launch, checkoutAcknowledgedAt: new Date().toISOString() },
    };
    acknowledgeCheckoutRecovery.mockReturnValue(acknowledged);
    const acknowledge = await fastify.inject({
      method: "POST",
      url: "/loops/runs/11111111-1111-4111-8111-111111111111/acknowledge",
    });
    expect(acknowledge.statusCode).toBe(200);

    // Fastify onReady recovery is not repeated for later requests.
    expect(destroySession).toHaveBeenCalledTimes(2);
    expect(strictRemoveOwnedLoopWorktree).toHaveBeenCalledOnce();
  });

  it("keeps supported single-agent creation and duplication working", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-honesty-supported-"));
    const { fastify } = makeRoutes(home);
    const create = await fastify.inject({
      method: "PUT",
      url: "/loops",
      payload: { name: "Supported", structure: "singleAgent", goal: "Run safely." },
    });
    expect(create.statusCode).toBe(200);

    const duplicate = await fastify.inject({ method: "POST", url: "/loops/Supported/duplicate" });
    expect(duplicate.statusCode).toBe(200);
    expect(scanLoops({ home }).map((loop) => loop.name)).toEqual([
      "Copy of Supported",
      "Supported",
    ]);
  });
});
