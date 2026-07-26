import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOOP_PARALLEL_WRITE_TARGET_CODE, type LoopStructure } from "@agent-deck/domain";
import {
  deleteLoopFile,
  loopsDir,
  scanLoops,
  writeLoopFile as persistLoopFile,
} from "@agent-deck/resources";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";

vi.mock("../src/git.ts", () => ({
  createLoopWorktree: vi.fn(),
  gitWorktreeRegistrations: vi.fn(),
  gitWorktreePrune: vi.fn(),
  gitDeleteOwnedWorktreeBranch: vi.fn(),
}));

import {
  createLoopWorktree,
  gitDeleteOwnedWorktreeBranch,
  gitWorktreeRegistrations,
  gitWorktreePrune,
} from "../src/git.ts";
import { LoopEngine } from "../src/loopEngine.ts";
import { canonicalCheckoutLockKey, registerLoopRoutes } from "../src/routes/loops.ts";
import { SessionCreationError } from "../src/SessionManager.ts";

const servers: ReturnType<typeof Fastify>[] = [];

function writeLoopFile(
  roots: Parameters<typeof persistLoopFile>[0],
  edit: Parameters<typeof persistLoopFile>[1],
): ReturnType<typeof persistLoopFile> {
  return persistLoopFile(roots, {
    ...(edit.structure === undefined || edit.structure === "singleAgent"
      ? { agentName: edit.agentName ?? "Agent A" }
      : {}),
    ...edit,
  });
}

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
  const removeLoopSessionSnapshot = vi.fn();
  const startEngine = vi.fn();
  const recordFailedStart = vi.fn((_loop, _cwd, reason, summary) => ({
    id: "failed-start",
    status: "failed",
    stopReason: reason,
    iterations: [{ output: summary }],
  }));
  const stopEngine = vi.fn();
  const settledEngine = vi.fn();
  const rollbackEngine = vi.fn();
  const recoveryCheckoutLocks = vi.fn(() => recovery.locks ?? new Map<string, string>());
  const pendingResourceReconciliations = vi.fn(() => recovery.runs ?? []);
  const markSessionReconciled = vi.fn();
  const acknowledgeCheckoutRecovery = vi.fn();
  const resolveHumanApproval = vi.fn();
  const getEngine = vi.fn();
  const broadcast = vi.fn();
  const resolveNamedAgent = vi.fn<ServerContext["resolveNamedAgent"]>((name: string) =>
    name.startsWith("Missing")
      ? { status: "not_found" as const }
      : {
          status: "ok" as const,
          agent: { body: "", systemPromptMode: "replace", skillDirs: [], extensions: [] },
        },
  );
  const findProject = vi.fn((_predicate?: (project: { id: string; path: string }) => boolean) => ({
    id: "project",
    path: home,
  }));
  const indexRows = new Map<
    string,
    { id: string; cwd: string; createdAt: string; projectId?: string; title?: string }
  >();
  const bridgeTokens = new Map<string, string>();
  announceCreated.mockImplementation((session) => {
    indexRows.set(session.meta.id, session.meta);
  });
  const canonicalCheckoutEffect = vi.fn(canonicalCheckoutLockKey);
  const createWorktreeEffect = vi.fn((...args: Parameters<typeof createLoopWorktree>) =>
    createLoopWorktree(...args),
  );
  registerLoopRoutes(
    {
      fastify,
      sessions: {
        create: createSession,
        destroy: destroySession,
        runSubagent,
        announceCreated,
        removeLoopSessionSnapshot,
      },
      index: {
        upsert: (meta: Parameters<ServerContext["index"]["upsert"]>[0]) =>
          indexRows.set(meta.id, meta),
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
        recordFailedStart,
        stop: stopEngine,
        settled: settledEngine,
        rollbackStart: rollbackEngine,
        recoveryCheckoutLocks,
        pendingResourceReconciliations,
        markSessionReconciled,
        acknowledgeCheckoutRecovery,
        resolveHumanApproval,
        list: () => [],
        get: getEngine,
      },
      bridgeTokens,
      broadcast,
      rootsFor,
      resolveNamedAgent,
      enabledExtensionPaths: () => [],
      worktreesRoot: path.join(home, "managed-worktrees"),
    } as unknown as ServerContext,
    {
      canonicalCheckoutLockKey: canonicalCheckoutEffect,
      createLoopWorktree: createWorktreeEffect,
      gitWorktreeRegistrations,
    },
  );
  return {
    fastify,
    createSession,
    destroySession,
    runSubagent,
    announceCreated,
    removeLoopSessionSnapshot,
    startEngine,
    recordFailedStart,
    stopEngine,
    settledEngine,
    rollbackEngine,
    recoveryCheckoutLocks,
    pendingResourceReconciliations,
    markSessionReconciled,
    acknowledgeCheckoutRecovery,
    resolveHumanApproval,
    getEngine,
    findProject,
    broadcast,
    resolveNamedAgent,
    indexRows,
    bridgeTokens,
    canonicalCheckoutEffect,
    createWorktreeEffect,
  };
}

function catalogActionUrl(home: string, name: string, action: "run" | "duplicate"): string {
  const loop = scanLoops({ home }).find((candidate) => candidate.name === name);
  if (!loop) throw new Error(`missing fixture Loop: ${name}`);
  return `/loops/${encodeURIComponent(loop.id)}/${action}`;
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

describe("loop route honesty gate", () => {
  it.runIf(process.platform !== "win32")(
    "sanitizes native Loop catalog capability refusals",
    async () => {
      const home = mkdtempSync(path.join(tmpdir(), "loop-route-capability-"));
      const victim = path.join(home, "victim");
      mkdirSync(victim);
      writeFileSync(path.join(victim, "sentinel"), "safe");
      symlinkSync(victim, path.join(home, ".pi"));
      const { fastify } = makeRoutes(home);

      const response = await fastify.inject({ method: "GET", url: "/loops" });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        code: "loop_catalog_capability_error",
        error: "The native Loop catalog safety boundary refused this filesystem operation.",
      });
      expect(response.body).not.toContain(home);
      expect(readFileSync(path.join(victim, "sentinel"), "utf8")).toBe("safe");
    },
  );

  it("authors and launches Human Approval without executable resource allocation", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-human-route-"));
    const {
      fastify,
      createSession,
      runSubagent,
      startEngine,
      resolveHumanApproval,
      getEngine,
      broadcast,
      indexRows,
      canonicalCheckoutEffect,
      createWorktreeEffect,
    } = makeRoutes(home);
    const providerEffect = vi.fn(async () => "must not run");
    const validationEffect = vi.fn(async () => true);
    const realEngine = new LoopEngine({
      executeRole: providerEffect,
      runValidation: validationEffect,
    });
    startEngine.mockImplementation((loop, cwd, options) => realEngine.start(loop, cwd, options));

    const create = await fastify.inject({
      method: "PUT",
      url: "/loops",
      payload: {
        name: "Release Approval",
        structure: "humanApproval",
        checkpointPrompt: "Review the release proposal.",
        writeTarget: "currentCheckout",
      },
    });
    expect(create.statusCode).toBe(200);
    expect(broadcast).toHaveBeenCalled();

    const duplicate = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Release Approval", "duplicate"),
    });
    expect(duplicate.statusCode).toBe(200);

    broadcast.mockClear();
    const run = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Release Approval", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(run.statusCode).toBe(201);
    const checkpoint = run.json().run;
    expect(run.json()).toEqual({
      run: expect.objectContaining({
        id: expect.any(String),
        structure: "humanApproval",
        status: "stopped",
        stopReason: "humanInputRequired",
        checkpointPrompt: "Review the release proposal.",
      }),
      worktree: null,
    });
    expect(startEngine).toHaveBeenCalledWith(
      expect.objectContaining({ structure: "humanApproval" }),
      home,
      { projectId: "project", retryOf: undefined },
    );
    expect(checkpoint.sessionId).toBeUndefined();
    expect(indexRows.size).toBe(0);
    expect(broadcast).not.toHaveBeenCalledWith(expect.objectContaining({ type: "session_meta" }));
    expect(createSession).not.toHaveBeenCalled();
    expect(runSubagent).not.toHaveBeenCalled();
    expect(canonicalCheckoutEffect).not.toHaveBeenCalled();
    expect(createWorktreeEffect).not.toHaveBeenCalled();
    expect(createLoopWorktree).not.toHaveBeenCalled();
    expect(providerEffect).not.toHaveBeenCalled();
    expect(validationEffect).not.toHaveBeenCalled();

    getEngine.mockReturnValue(checkpoint);
    const invalidResolution = await fastify.inject({
      method: "POST",
      url: `/loops/runs/${checkpoint.id}/resolve`,
      payload: { decision: "approve" },
    });
    expect(invalidResolution.statusCode).toBe(400);
    resolveHumanApproval.mockReturnValue({ ...checkpoint, stopReason: "humanApproved" });
    const resolution = await fastify.inject({
      method: "POST",
      url: `/loops/runs/${checkpoint.id}/resolve`,
      payload: { decision: "approve", expectedUpdatedAt: checkpoint.updatedAt },
    });
    expect(resolution.statusCode).toBe(200);
    expect(resolveHumanApproval).toHaveBeenCalledWith(
      checkpoint.id,
      "approve",
      checkpoint.updatedAt,
    );

    getEngine.mockReturnValue({ ...checkpoint, stopReason: "humanRejected" });
    const rejectedRetry = await fastify.inject({
      method: "POST",
      url: `/loops/runs/${checkpoint.id}/retry`,
    });
    expect(rejectedRetry.statusCode).toBe(409);
    expect(rejectedRetry.json()).toMatchObject({
      code: "loop_retry_unavailable",
      error: expect.stringContaining("rejected"),
    });
    expect(startEngine).toHaveBeenCalledTimes(1);
  });

  it("retains a registered worktree and branch when parent creation fails", async () => {
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
    const {
      fastify,
      createSession,
      startEngine,
      recordFailedStart,
      removeLoopSessionSnapshot,
      broadcast,
      bridgeTokens,
      indexRows,
    } = makeRoutes(home);
    const order: string[] = [];
    vi.mocked(createLoopWorktree).mockImplementation(async (_project, target, branch) => ({
      path: target,
      branch,
      sourceBranch: "main",
      branchOwned: true,
    }));
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
      url: catalogActionUrl(home, "Rollback Loop", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual(
      expect.objectContaining({
        code: "loop_start_failed",
        error: expect.stringContaining("Pi startup failed"),
      }),
    );
    expect(order).toEqual(["pi"]);
    expect(gitWorktreePrune).not.toHaveBeenCalled();
    expect(gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();
    const generatedTarget = vi.mocked(createLoopWorktree).mock.calls[0]![1];
    expect(response.json().error).toContain(generatedTarget);
    expect(canonicalCheckoutLockKey(path.dirname(generatedTarget))).toBe(
      canonicalCheckoutLockKey(path.join(home, "managed-worktrees", "loop")),
    );
    expect(path.basename(generatedTarget)).toMatch(
      /^loop-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(startEngine).not.toHaveBeenCalled();
    expect(recordFailedStart).toHaveBeenCalledOnce();
    expect(recordFailedStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Rollback Loop" }),
      expect.any(String),
      "toolFailed",
      expect.stringContaining("Pi startup failed"),
      "project",
      expect.objectContaining({
        sessionId: "failed-parent",
        sessionReconciledAt: expect.any(String),
      }),
    );
    expect(response.json()).toMatchObject({ run: { status: "failed", stopReason: "toolFailed" } });
    expect(bridgeTokens.size).toBe(0);
    expect(indexRows.size).toBe(0);
    expect(removeLoopSessionSnapshot).toHaveBeenCalledWith("failed-parent");
    expect(broadcast).not.toHaveBeenCalled();
  });

  it("makes a goal-only API override the effective default success condition", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-goal-default-"));
    writeLoopFile(
      { home },
      {
        name: "Goal Default",
        structure: "singleAgent",
        goal: "Saved goal.",
        agentName: "Agent A",
        writeTarget: "artifactMarkdown",
      },
    );
    const { fastify, createSession, startEngine, settledEngine } = makeRoutes(home);
    createSession.mockReturnValue({
      meta: {
        id: "goal-parent",
        cwd: home,
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
    });
    startEngine.mockReturnValue({ id: "goal-run", status: "running" });
    settledEngine.mockResolvedValue(undefined);

    const response = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Goal Default", "run"),
      payload: { projectId: "project", goal: "Effective goal." },
    });

    expect(response.statusCode).toBe(201);
    expect(startEngine.mock.calls[0]?.[0]).toMatchObject({
      goal: "Effective goal.",
      successCondition: "Effective goal.",
      successConditionSource: "goal",
    });
  });

  it("validates an evaluator model against the allocated parent before engine work and audits failure", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-evaluator-model-"));
    writeLoopFile(
      { home },
      {
        name: "Unavailable Evaluator",
        structure: "singleAgent",
        goal: "Run safely.",
        agentName: "Agent A",
        evaluatorProvider: "missing-provider",
        evaluatorModel: "missing-model",
        writeTarget: "artifactMarkdown",
      },
    );
    const { fastify, createSession, destroySession, startEngine, runSubagent, recordFailedStart } =
      makeRoutes(home);
    destroySession.mockResolvedValue(undefined);
    const getAvailableModels = vi.fn(async () => [
      { provider: "mock-provider", id: "available-model", name: "Available" },
    ]);
    createSession.mockReturnValue({
      meta: {
        id: "model-parent",
        cwd: home,
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
      getAvailableModels,
    });

    const response = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Unavailable Evaluator", "run"),
      payload: {
        projectId: "project",
        provider: "mock-provider",
        currentCheckoutConfirmed: true,
      },
    });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "loop_start_failed",
      run: { status: "failed", stopReason: "toolFailed" },
    });
    expect(response.json().error).toContain(
      'Evaluator model "missing-provider/missing-model" is unavailable',
    );
    expect(getAvailableModels).toHaveBeenCalledOnce();
    expect(startEngine).not.toHaveBeenCalled();
    expect(runSubagent).not.toHaveBeenCalled();
    expect(destroySession).toHaveBeenCalledWith("model-parent");
    expect(recordFailedStart).toHaveBeenCalledOnce();
  });

  it("validates and launches a collision-safe cross-provider evaluator pair", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-evaluator-provider-"));
    writeLoopFile(
      { home },
      {
        name: "Cross-provider Evaluator",
        structure: "singleAgent",
        goal: "Run safely.",
        agentName: "Agent A",
        evaluatorProvider: "provider-b",
        evaluatorModel: "shared-model",
        writeTarget: "artifactMarkdown",
      },
    );
    const { fastify, createSession, startEngine, settledEngine, runSubagent } = makeRoutes(home);
    createSession.mockReturnValue({
      meta: {
        id: "provider-parent",
        cwd: home,
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
      getAvailableModels: vi.fn(async () => [
        { provider: "provider-a", id: "shared-model", name: "Shared A" },
        { provider: "provider-b", id: "shared-model", name: "Shared B" },
      ]),
    });
    startEngine.mockReturnValue({ id: "provider-run", status: "running" });
    settledEngine.mockReturnValue(new Promise<void>(() => {}));
    runSubagent.mockResolvedValue("SUCCESS");

    const response = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Cross-provider Evaluator", "run"),
      payload: { projectId: "project", provider: "provider-a" },
    });

    expect(response.statusCode).toBe(201);
    expect(startEngine.mock.calls[0]?.[0]).toMatchObject({
      evaluatorProvider: "provider-b",
      evaluatorModel: "shared-model",
    });
    const options = startEngine.mock.calls[0]?.[2];
    await options.executeRole({
      prompt: "evaluate",
      phase: "evaluator",
      provider: "provider-b",
      model: "shared-model",
    });
    expect(runSubagent).toHaveBeenCalledWith("provider-parent", "evaluate", undefined, "none", {
      provider: "provider-b",
      model: "shared-model",
      thinking: undefined,
    });
  });

  it("keeps legacy model-only evaluators on the launch provider", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-evaluator-legacy-provider-"));
    writeLoopFile(
      { home },
      {
        name: "Legacy model-only Evaluator",
        goal: "Run safely.",
        evaluatorModel: "shared-model",
        writeTarget: "artifactMarkdown",
      },
    );
    const { fastify, createSession, startEngine, settledEngine } = makeRoutes(home);
    createSession.mockReturnValue({
      meta: {
        id: "legacy-provider-parent",
        cwd: home,
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
      getAvailableModels: vi.fn(async () => [
        { provider: "launch-provider", id: "shared-model", name: "Shared" },
      ]),
    });
    startEngine.mockReturnValue({ id: "legacy-provider-run", status: "running" });
    settledEngine.mockReturnValue(new Promise<void>(() => {}));

    const response = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Legacy model-only Evaluator", "run"),
      payload: { projectId: "project", provider: "launch-provider" },
    });

    expect(response.statusCode).toBe(201);
    expect(startEngine.mock.calls[0]?.[0]).toMatchObject({ evaluatorModel: "shared-model" });
    expect(startEngine.mock.calls[0]?.[0].evaluatorProvider).toBeUndefined();
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
      recordFailedStart,
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

    const responsePromise = fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Announce Rollback Loop", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    await vi.waitFor(() => expect(order).toEqual(["stop"]));
    expect(destroySession).not.toHaveBeenCalled();
    resolveSettled();
    const response = await responsePromise;

    expect(response.statusCode).toBe(500);
    expect(response.json().error).toContain(vi.mocked(createLoopWorktree).mock.calls[0]![1]);
    expect(order).toEqual(["stop", "settled", "rollback", "destroy"]);
    expect(stopEngine).toHaveBeenCalledOnce();
    expect(settledEngine).toHaveBeenCalledOnce();
    expect(rollbackEngine).toHaveBeenCalledWith("run-in-flight");
    expect(destroySession).toHaveBeenCalledOnce();
    expect(recordFailedStart).toHaveBeenCalledOnce();
    expect(response.json()).toMatchObject({ run: { status: "failed", stopReason: "toolFailed" } });
    expect(gitWorktreePrune).not.toHaveBeenCalled();
    expect(gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();
  });

  it("retains registered worktree evidence after normal terminal settlement", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-terminal-retain-"));
    writeLoopFile(
      { home },
      {
        name: "Retained Review Loop",
        structure: "singleAgent",
        goal: "Produce review evidence.",
        writeTarget: "newWorktree",
      },
    );
    const { fastify, createSession, destroySession, startEngine, settledEngine, indexRows } =
      makeRoutes(home);
    let worktree!: Awaited<ReturnType<typeof createLoopWorktree>>;
    vi.mocked(createLoopWorktree).mockImplementation(async (_project, target, branch) => {
      worktree = { path: target, branch, sourceBranch: "main", branchOwned: true };
      return worktree;
    });
    createSession.mockReturnValue({
      meta: {
        id: "retained-parent",
        cwd: home,
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
    });
    let settle!: () => void;
    settledEngine.mockReturnValue(new Promise<void>((resolve) => (settle = resolve)));
    startEngine.mockImplementation((_loop, _cwd, options) => ({
      id: options.runId,
      status: "completed",
      launch: options.launch,
    }));

    const response = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Retained Review Loop", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().run.launch.worktree).toMatchObject({
      path: worktree.path,
      branch: worktree.branch,
      branchOwned: true,
    });
    expect(response.json().run.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ loopReviewRunId: response.json().run.id }),
    );
    expect(indexRows.get("retained-parent")?.title).toBe(
      `Loop: Retained Review Loop · ${response.json().run.id.slice(0, 8)}`,
    );

    settle();
    await vi.waitFor(() => expect(destroySession).toHaveBeenCalledOnce());
    expect(indexRows.has("retained-parent")).toBe(true);
    expect(gitWorktreePrune).not.toHaveBeenCalled();
    expect(gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();
  });

  it("reveals only terminal worktrees with complete current ownership proof", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-review-proof-"));
    const { fastify, getEngine } = makeRoutes(home);
    const ownershipId = "12345678-1234-4123-8123-123456789abc";
    const projectRoot = canonicalCheckoutLockKey(home);
    const worktreeRoot = path.join(projectRoot, "managed-worktrees", "loop");
    const worktreePath = path.join(worktreeRoot, `loop-${ownershipId}`);
    mkdirSync(worktreePath);
    const sentinel = path.join(worktreePath, "review.txt");
    writeFileSync(sentinel, "retained evidence");
    const branch = "agent-deck/loop-Review-Proof-12345678";
    const run = {
      id: "87654321-4321-4321-8321-cba987654321",
      loopName: "Review Proof",
      projectId: "project",
      status: "completed",
      launch: {
        sessionId: "review-session",
        writeTarget: "newWorktree",
        worktree: {
          ownershipVersion: 1,
          ownershipId,
          projectRoot,
          path: worktreePath,
          branch,
          sourceBranch: "main",
          branchOwned: true,
        },
      },
    };
    getEngine.mockReturnValue(run);
    vi.mocked(gitWorktreeRegistrations).mockResolvedValue([{ path: worktreePath, branch }]);

    const accepted = await fastify.inject({
      method: "GET",
      url: `/loops/runs/${run.id}/worktree-directory`,
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({ directory: canonicalCheckoutLockKey(worktreePath) });

    vi.mocked(gitWorktreeRegistrations).mockResolvedValue([]);
    const stale = await fastify.inject({
      method: "GET",
      url: `/loops/runs/${run.id}/worktree-directory`,
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.body).not.toContain(home);

    vi.mocked(gitWorktreeRegistrations).mockResolvedValue([{ path: worktreePath, branch }]);
    for (const worktree of [
      { ...run.launch.worktree, projectRoot: path.join(home, "other-project") },
      { ...run.launch.worktree, path: path.join(worktreeRoot, "loop-other") },
      { ...run.launch.worktree, ownershipVersion: 2 },
      { ...run.launch.worktree, branch: "agent-deck/loop-tampered" },
    ]) {
      getEngine.mockReturnValue({ ...run, launch: { ...run.launch, worktree } });
      const tampered = await fastify.inject({
        method: "GET",
        url: `/loops/runs/${run.id}/worktree-directory`,
      });
      expect(tampered.statusCode).toBe(409);
      expect(tampered.body).not.toContain(home);
    }

    getEngine.mockReturnValue({ ...run, status: "running" });
    expect(
      (
        await fastify.inject({
          method: "GET",
          url: `/loops/runs/${run.id}/worktree-directory`,
        })
      ).statusCode,
    ).toBe(409);

    getEngine.mockReturnValue(run);
    if (process.platform !== "win32") {
      const retainedTarget = `${worktreePath}-retained`;
      renameSync(worktreePath, retainedTarget);
      symlinkSync(retainedTarget, worktreePath, "dir");
      expect(
        (
          await fastify.inject({
            method: "GET",
            url: `/loops/runs/${run.id}/worktree-directory`,
          })
        ).statusCode,
      ).toBe(409);
    }

    getEngine.mockReturnValue({
      ...run,
      launch: {
        ...run.launch,
        worktree: { ...run.launch.worktree, branch: "agent-deck/loop-tampered" },
      },
    });
    const refused = await fastify.inject({
      method: "GET",
      url: `/loops/runs/${run.id}/worktree-directory`,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({
      code: "loop_worktree_unavailable",
      error: "The retained Loop worktree is unavailable for review.",
    });
    expect(refused.body).not.toContain(home);
    expect(readFileSync(sentinel, "utf8")).toBe("retained evidence");
    expect(gitWorktreePrune).not.toHaveBeenCalled();
    expect(gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();
  });

  it("rejects invalid Discovery/Triage configuration before runtime allocation", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-triage-invalid-"));
    const filePath = writeExternalLoop(home, "Invalid Triage", "discoveryTriage");
    const original = readFileSync(filePath, "utf8");
    const { fastify, createSession, startEngine } = makeRoutes(home);

    const run = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Invalid Triage", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(run.statusCode).toBe(422);
    expect(run.json()).toMatchObject({ code: "loop_agent_preflight_failed" });
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();
    expect(createLoopWorktree).not.toHaveBeenCalled();

    const duplicate = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Invalid Triage", "duplicate"),
    });
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json()).toMatchObject({ code: "loop_definition_invalid" });
    expect(readFileSync(filePath, "utf8")).toBe(original);

    writeFileSync(
      filePath,
      original.replace(
        "externalMetadata: preserve",
        "triageAgent: Missing Explorer\nclassificationPrompt: Classify severity and owner.\nexternalMetadata: preserve",
      ),
    );
    const unavailable = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Invalid Triage", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(unavailable.statusCode).toBe(422);
    expect(unavailable.json()).toMatchObject({
      code: "loop_agent_preflight_failed",
      error: expect.stringContaining("Missing Explorer"),
    });
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();
    expect(createLoopWorktree).not.toHaveBeenCalled();
  });

  it("applies Discovery/Triage tool policy for every target and preserves configured identity", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-triage-policy-"));
    const agentsDir = path.join(home, ".pi", "agent", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, "Configured Explorer.md"),
      "---\nname: Configured Explorer\n---\nClassify discovery evidence.\n",
    );
    for (const [name, writeTarget] of [
      ["Artifact Triage", "artifactMarkdown"],
      ["Checkout Triage", "currentCheckout"],
      ["Worktree Triage", "newWorktree"],
    ] as const) {
      writeLoopFile(
        { home },
        {
          name,
          structure: "discoveryTriage",
          goal: "Discover risks without implicit implementation.",
          triageAgent: "Configured Explorer",
          classificationPrompt: "Classify severity, owner, evidence, and next action.",
          writeTarget,
        },
      );
    }
    vi.mocked(createLoopWorktree).mockImplementation(async (_project, target, branch) => ({
      path: target,
      branch,
      sourceBranch: "main",
      branchOwned: true as const,
    }));
    const { fastify, createSession, startEngine, settledEngine, runSubagent } = makeRoutes(home);
    let parentNumber = 0;
    createSession.mockImplementation(({ cwd: parentCwd }) => ({
      meta: {
        id: `triage-parent-${++parentNumber}`,
        cwd: parentCwd,
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
    }));
    settledEngine.mockReturnValue(new Promise<void>(() => {}));
    startEngine.mockImplementation((loop, runCwd, options) => ({
      id: `triage-run-${parentNumber}`,
      loopName: loop.name,
      projectId: "project",
      status: "running",
      currentIteration: 0,
      maxIterations: 1,
      iterations: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      loop,
      runCwd,
      options,
    }));
    runSubagent.mockResolvedValue("classification");

    for (const [name, writeTarget] of [
      ["Artifact Triage", "artifactMarkdown"],
      ["Checkout Triage", "currentCheckout"],
      ["Worktree Triage", "newWorktree"],
    ] as const) {
      const response = await fastify.inject({
        method: "POST",
        url: catalogActionUrl(home, name, "run"),
        payload: {
          projectId: "project",
          ...(writeTarget === "currentCheckout" ? { currentCheckoutConfirmed: true } : {}),
        },
      });
      expect(response.statusCode).toBe(201);
      const call = startEngine.mock.calls.at(-1)!;
      expect(call[0]).toMatchObject({
        triageAgent: "Configured Explorer",
        classificationPrompt: "Classify severity, owner, evidence, and next action.",
      });
      const options = call[2];
      await options.executeRole({
        prompt: `triage-${name}`,
        agentName: "Configured Explorer",
        phase: "triage",
      });
      await options.executeRole({ prompt: `evaluate-${name}`, phase: "evaluator" });
    }
    expect(runSubagent).toHaveBeenNthCalledWith(
      1,
      "triage-parent-1",
      "triage-Artifact Triage",
      "Configured Explorer",
      "readOnly",
    );
    expect(runSubagent).toHaveBeenNthCalledWith(
      3,
      "triage-parent-2",
      "triage-Checkout Triage",
      "Configured Explorer",
      "configured",
    );
    expect(runSubagent).toHaveBeenNthCalledWith(
      5,
      "triage-parent-3",
      "triage-Worktree Triage",
      "Configured Explorer",
      "configured",
    );
    expect(runSubagent.mock.calls.filter((call) => call[3] === "none")).toHaveLength(3);
    expect(createLoopWorktree).toHaveBeenCalledOnce();
  });

  it("rejects invalid native Pipeline configuration before runtime allocation", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-pipeline-invalid-"));
    const filePath = writeExternalLoop(home, "Invalid Pipeline", "agentPipeline");
    const original = readFileSync(filePath, "utf8");
    const { fastify, createSession, startEngine } = makeRoutes(home);

    const run = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Invalid Pipeline", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(run.statusCode).toBe(422);
    expect(run.json()).toMatchObject({ code: "loop_definition_invalid" });
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();

    const duplicate = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Invalid Pipeline", "duplicate"),
    });
    expect(duplicate.statusCode).toBe(422);
    expect(duplicate.json()).toMatchObject({ code: "loop_definition_invalid" });
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });

  it("rejects unsafe persisted Parallel targets before project/session/Pi/worktree allocation", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-parallel-unsafe-"));
    const filePath = writeExternalLoop(home, "Unsafe Parallel", "parallelAgents");
    writeFileSync(
      filePath,
      readFileSync(filePath, "utf8").replace(
        "externalMetadata: preserve",
        "parallelBranches: A | B\nexternalMetadata: preserve",
      ),
    );
    const original = readFileSync(filePath, "utf8");
    const { fastify, findProject, createSession, startEngine } = makeRoutes(home);

    const response = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Unsafe Parallel", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: LOOP_PARALLEL_WRITE_TARGET_CODE });
    expect(findProject).toHaveBeenCalledTimes(1);
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();
    expect(createLoopWorktree).not.toHaveBeenCalled();
    expect(readFileSync(filePath, "utf8")).toBe(original);
  });

  it("launches safe Parallel branches report-only without a checkout lock or worktree", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-parallel-policy-"));
    writeLoopFile(
      { home },
      {
        name: "Safe Parallel",
        structure: "parallelAgents",
        goal: "Investigate independently.",
        parallelBranches: ["A", "B"],
        writeTarget: "artifactMarkdown",
      },
    );
    const { fastify, createSession, startEngine, settledEngine, runSubagent } = makeRoutes(home);
    createSession.mockReturnValue({
      meta: {
        id: "parallel-parent",
        cwd: home,
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
    });
    settledEngine.mockReturnValue(new Promise<void>(() => {}));
    startEngine.mockImplementation((_loop, _cwd, options) => ({
      id: "parallel-run",
      loopName: "Safe Parallel",
      projectId: "project",
      status: "running",
      currentIteration: 0,
      maxIterations: 1,
      iterations: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      launch: options.launch,
      options,
    }));
    runSubagent.mockResolvedValue("report");

    const response = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Safe Parallel", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(response.statusCode).toBe(201);
    const options = startEngine.mock.calls[0]![2];
    expect(options.launch).toEqual({
      sessionId: "parallel-parent",
      writeTarget: "artifactMarkdown",
      checkoutLockKey: undefined,
    });
    await options.executeRole({ prompt: "branch", agentName: "A", phase: "branch" });
    await options.executeRole({ prompt: "evaluate", phase: "evaluator" });
    expect(runSubagent).toHaveBeenNthCalledWith(1, "parallel-parent", "branch", "A", "readOnly");
    expect(runSubagent).toHaveBeenNthCalledWith(
      2,
      "parallel-parent",
      "evaluate",
      undefined,
      "none",
    );
    expect(createLoopWorktree).not.toHaveBeenCalled();
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
      url: catalogActionUrl(home, "Artifact Pipeline", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
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
      url: catalogActionUrl(home, "Checkout Pipeline", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
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
      url: catalogActionUrl(home, "Checkout Loop", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(first.statusCode).toBe(201);
    const second = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Checkout Loop", "run"),
      payload: { projectId: "project-alias", currentCheckoutConfirmed: true },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json()).toMatchObject({ code: "loop_checkout_busy" });
    // POSIX symlink and Windows directory-junction aliases canonicalize to the
    // same native checkout identity before any second session/Pi allocation.
    expect(createSession).toHaveBeenCalledOnce();
    expect(startEngine).toHaveBeenCalledOnce();

    settle();
    await vi.waitFor(() => expect(destroySession).toHaveBeenCalledOnce());
    expect(indexRows.has(parent.meta.id)).toBe(true);
    expect(broadcast).not.toHaveBeenCalledWith({
      type: "session_removed",
      sessionId: parent.meta.id,
    });
    const afterCleanup = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Checkout Loop", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
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
    const { fastify, createSession, startEngine, recordFailedStart, findProject } =
      makeRoutes(home);
    findProject.mockReturnValue({ id: "project", path: path.join(home, "does-not-exist") });

    const response = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Missing Checkout", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({
      code: "loop_checkout_canonicalization_failed",
      run: { status: "failed", stopReason: "unsafeWriteTarget" },
    });
    expect(recordFailedStart).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Missing Checkout" }),
      path.join(home, "does-not-exist"),
      "unsafeWriteTarget",
      expect.stringContaining("No agent resources were allocated"),
      "project",
    );
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();
  });

  it("reconciles only parent sessions, retains worktrees, and keeps checkout retries locked", async () => {
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
    expect(retry.json()).toMatchObject({ code: "loop_retry_unavailable" });
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();
    expect(destroySession).toHaveBeenCalledTimes(2);
    expect(destroySession).toHaveBeenCalledWith("stale-parent");
    expect(destroySession).toHaveBeenCalledWith("unsettled-parent");
    expect(indexRows.has("stale-parent")).toBe(true);
    expect(bridgeTokens.has("stale-parent")).toBe(false);
    expect(markSessionReconciled).toHaveBeenCalledOnce();
    expect(gitWorktreePrune).not.toHaveBeenCalled();
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

    // Fastify onReady recovery is not repeated for later requests, and retained
    // worktree evidence is never touched by recovery.
    expect(destroySession).toHaveBeenCalledTimes(2);
    expect(gitWorktreePrune).not.toHaveBeenCalled();
    expect(gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();
  });

  it("never confuses an opaque id with another Loop's display name", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-id-collision-route-"));
    writeLoopFile(
      { home },
      {
        name: "Alpha",
        structure: "humanApproval",
        checkpointPrompt: "Alpha checkpoint",
      },
    );
    const alpha = scanLoops({ home }).find((loop) => loop.name === "Alpha")!;
    writeLoopFile(
      { home },
      {
        name: alpha.id,
        structure: "humanApproval",
        checkpointPrompt: "Collision checkpoint",
      },
    );
    const collision = scanLoops({ home }).find((loop) => loop.name === alpha.id)!;
    const { fastify, startEngine } = makeRoutes(home);
    startEngine.mockImplementation((loop) => ({ id: `run-${loop.id}`, loopName: loop.name }));

    const updated = await fastify.inject({
      method: "PUT",
      url: "/loops",
      payload: { id: alpha.id, name: "Alpha", description: "updated alpha" },
    });
    expect(updated.statusCode).toBe(200);
    expect(scanLoops({ home }).find((loop) => loop.id === alpha.id)?.description).toBe(
      "updated alpha",
    );
    expect(scanLoops({ home }).find((loop) => loop.id === collision.id)?.description).toBe("");

    const run = await fastify.inject({
      method: "POST",
      url: `/loops/${encodeURIComponent(alpha.id)}/run`,
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(run.statusCode).toBe(201);
    expect(startEngine.mock.calls[0]![0]).toMatchObject({ id: alpha.id, name: "Alpha" });

    const duplicate = await fastify.inject({
      method: "POST",
      url: `/loops/${encodeURIComponent(alpha.id)}/duplicate`,
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toEqual({ name: "Copy of Alpha" });
    expect(scanLoops({ home }).some((loop) => loop.name === `Copy of ${alpha.id}`)).toBe(false);

    const deleted = await fastify.inject({
      method: "DELETE",
      url: "/loops",
      payload: { id: alpha.id },
    });
    expect(deleted.statusCode).toBe(200);
    expect(scanLoops({ home }).some((loop) => loop.id === alpha.id)).toBe(false);
    expect(scanLoops({ home }).find((loop) => loop.id === collision.id)?.name).toBe(alpha.id);
  });

  it("enforces exact project availability before any executable allocation", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-availability-route-"));
    writeLoopFile(
      { home },
      {
        name: "Assigned",
        goal: "Wait for approval",
        structure: "humanApproval",
        checkpointPrompt: "Review",
        availability: "projectPaths",
        projectPaths: ["/metadata/only", "/metadata/only"],
      },
    );
    const assigned = scanLoops({ home })[0]!;
    const { fastify, createSession, runSubagent, startEngine, canonicalCheckoutEffect } =
      makeRoutes(home);

    const rejected = await fastify.inject({
      method: "POST",
      url: `/loops/${encodeURIComponent(assigned.id)}/run`,
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).toMatchObject({ code: "loop_unavailable_for_project" });
    expect(startEngine).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(runSubagent).not.toHaveBeenCalled();
    expect(canonicalCheckoutEffect).not.toHaveBeenCalled();

    writeLoopFile(
      { home },
      {
        id: assigned.id,
        name: assigned.name,
        availability: "projectPaths",
        projectPaths: [home, home],
      },
    );
    startEngine.mockReturnValue({ id: "assigned-run" });
    const selected = await fastify.inject({
      method: "POST",
      url: `/loops/${encodeURIComponent(assigned.id)}/run`,
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(selected.statusCode).toBe(201);
    expect(startEngine).toHaveBeenCalledTimes(1);

    writeLoopFile(
      { home },
      {
        id: assigned.id,
        name: assigned.name,
        availability: "allProjects",
        projectPaths: ["/ignored/not/authority"],
      },
    );
    const allProjects = await fastify.inject({
      method: "POST",
      url: `/loops/${encodeURIComponent(assigned.id)}/run`,
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });
    expect(allProjects.statusCode).toBe(201);
    expect(startEngine).toHaveBeenCalledTimes(2);
  });

  it("retries the durable effective snapshot after the catalog definition is edited and deleted", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-retry-snapshot-route-"));
    writeLoopFile(
      { home },
      {
        name: "Snapshot approval",
        goal: "original goal",
        structure: "humanApproval",
        checkpointPrompt: "Original checkpoint",
        launchContext: "original context",
        launchContextScope: "everyIteration",
      },
    );
    const definition = scanLoops({ home })[0]!;
    const routes = makeRoutes(home);
    const engine = new LoopEngine();
    routes.startEngine.mockImplementation((loop, cwd, options) => engine.start(loop, cwd, options));
    routes.getEngine.mockImplementation((id) => engine.get(id));

    const first = await routes.fastify.inject({
      method: "POST",
      url: `/loops/${encodeURIComponent(definition.id)}/run`,
      payload: {
        projectId: "project",
        goal: "run-only goal",
        launchContext: "run-only context",
        evaluatorProvider: "provider-b",
        evaluatorModel: "shared-model",
      },
    });
    expect(first.statusCode).toBe(201);
    const firstRun = first.json().run;
    expect(firstRun.definitionSnapshot).toMatchObject({
      goal: "run-only goal",
      launchContext: "run-only context",
      launchContextScope: "everyIteration",
      evaluatorProvider: "provider-b",
      evaluatorModel: "shared-model",
    });

    writeLoopFile(
      { home },
      {
        id: definition.id,
        name: definition.name,
        goal: "edited goal",
        launchContext: "edited context",
      },
    );
    deleteLoopFile({ home }, definition.id);
    const retry = await routes.fastify.inject({
      method: "POST",
      url: `/loops/runs/${firstRun.id}/retry`,
    });
    expect(retry.statusCode).toBe(201);
    expect(retry.json().run).toMatchObject({
      retryOf: firstRun.id,
      definitionSnapshot: {
        goal: "run-only goal",
        launchContext: "run-only context",
        launchContextScope: "everyIteration",
        evaluatorProvider: "provider-b",
        evaluatorModel: "shared-model",
      },
    });
  });

  it("preflights both valid Maker+Checker roles and preserves their selected names", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-maker-preflight-"));
    writeLoopFile(
      { home },
      {
        name: "Maker Preflight",
        structure: "makerChecker",
        goal: "Build and review.",
        makerName: "Maker",
        checkerName: "Checker",
        checkerRubric: "Require evidence.",
        writeTarget: "artifactMarkdown",
      },
    );
    const { fastify, resolveNamedAgent, createSession, startEngine, settledEngine } =
      makeRoutes(home);
    createSession.mockReturnValue({
      meta: {
        id: "maker-parent",
        cwd: home,
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
    });
    settledEngine.mockReturnValue(new Promise<void>(() => {}));
    startEngine.mockReturnValue({
      id: "maker-run",
      loopName: "Maker Preflight",
      status: "running",
      currentIteration: 0,
      maxIterations: 1,
      iterations: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const response = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Maker Preflight", "run"),
      payload: { projectId: "project" },
    });
    expect(response.statusCode).toBe(201);
    expect(resolveNamedAgent.mock.calls.map(([name]) => name)).toEqual(["Maker", "Checker"]);
    expect(startEngine.mock.calls[0]![0]).toMatchObject({
      makerName: "Maker",
      checkerName: "Checker",
    });
  });

  it("reports every unavailable ordered role before checkout or executable allocation", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-agent-preflight-"));
    writeLoopFile(
      { home },
      {
        name: "Preflight Pipeline",
        structure: "agentPipeline",
        goal: "Run every role.",
        pipelineStages: [
          "Good",
          "Missing Agent",
          "Missing Agent",
          "Disabled Agent",
          "Shadowed Agent",
        ],
        writeTarget: "currentCheckout",
      },
    );
    const {
      fastify,
      resolveNamedAgent,
      canonicalCheckoutEffect,
      createWorktreeEffect,
      createSession,
      startEngine,
    } = makeRoutes(home);
    resolveNamedAgent.mockImplementation((name: string) =>
      name === "Disabled Agent"
        ? ({ status: "disabled" } as const)
        : name === "Good"
          ? ({
              status: "ok",
              agent: { body: "", systemPromptMode: "replace", skillDirs: [], extensions: [] },
            } as const)
          : ({ status: "not_found" } as const),
    );

    const response = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Preflight Pipeline", "run"),
      payload: { projectId: "project", currentCheckoutConfirmed: true },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({
      code: "loop_agent_preflight_failed",
      issues: [
        { role: "stage", position: 2, agentName: "Missing Agent", reason: "missing" },
        { role: "stage", position: 3, agentName: "Missing Agent", reason: "missing" },
        { role: "stage", position: 4, agentName: "Disabled Agent", reason: "disabled" },
        { role: "stage", position: 5, agentName: "Shadowed Agent", reason: "missing" },
      ],
    });
    expect(resolveNamedAgent.mock.calls.map(([name]) => name)).toEqual([
      "Good",
      "Missing Agent",
      "Missing Agent",
      "Disabled Agent",
      "Shadowed Agent",
    ]);
    expect(canonicalCheckoutEffect).not.toHaveBeenCalled();
    expect(createWorktreeEffect).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();
  });

  it("requires typed current-checkout confirmation before canonicalization, including retry", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-checkout-confirmation-"));
    writeLoopFile(
      { home },
      {
        name: "Confirmed Checkout",
        goal: "Run safely.",
        agentName: "Agent A",
        writeTarget: "currentCheckout",
      },
    );
    const definition = scanLoops({ home }).find((loop) => loop.name === "Confirmed Checkout")!;
    const {
      fastify,
      getEngine,
      canonicalCheckoutEffect,
      createSession,
      startEngine,
      settledEngine,
    } = makeRoutes(home);

    const launch = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Confirmed Checkout", "run"),
      payload: { projectId: "project" },
    });
    expect(launch.statusCode).toBe(422);
    expect(launch.json()).toMatchObject({
      code: "loop_current_checkout_confirmation_required",
    });
    expect(canonicalCheckoutEffect).not.toHaveBeenCalled();

    getEngine.mockReturnValue({
      id: "00000000-0000-4000-8000-000000000001",
      catalogId: definition.id,
      loopName: definition.name,
      structure: definition.structure,
      definitionSnapshot: {
        name: definition.name,
        description: definition.description,
        goal: definition.goal,
        structure: definition.structure,
        agentName: definition.agentName,
        launchContextScope: definition.launchContextScope,
        maxIterations: definition.maxIterations,
        validationCommand: definition.validationCommand,
        writeTarget: definition.writeTarget,
      },
      projectId: "project",
      status: "failed",
      stopReason: "agentFailed",
      currentIteration: 1,
      maxIterations: 1,
      iterations: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      endedAt: new Date().toISOString(),
    });
    const retry = await fastify.inject({
      method: "POST",
      url: "/loops/runs/00000000-0000-4000-8000-000000000001/retry",
      payload: {},
    });
    expect(retry.statusCode).toBe(422);
    expect(retry.json()).toMatchObject({
      code: "loop_current_checkout_confirmation_required",
    });
    expect(canonicalCheckoutEffect).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();

    createSession.mockReturnValue({
      meta: {
        id: "retry-parent",
        cwd: home,
        createdAt: new Date().toISOString(),
        projectId: "project",
      },
    });
    settledEngine.mockReturnValue(new Promise<void>(() => {}));
    startEngine.mockReturnValue({
      id: "retry-run",
      loopName: definition.name,
      status: "running",
      currentIteration: 0,
      maxIterations: 1,
      iterations: [],
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const confirmedRetry = await fastify.inject({
      method: "POST",
      url: "/loops/runs/00000000-0000-4000-8000-000000000001/retry",
      payload: { currentCheckoutConfirmed: true },
    });
    expect(confirmedRetry.statusCode).toBe(201);
    expect(canonicalCheckoutEffect).toHaveBeenCalledOnce();
    expect(createSession).toHaveBeenCalledOnce();
    expect(startEngine).toHaveBeenCalledOnce();
  });

  it("keeps supported single-agent creation and duplication working", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-honesty-supported-"));
    const { fastify } = makeRoutes(home);
    const create = await fastify.inject({
      method: "PUT",
      url: "/loops",
      payload: {
        name: "Supported",
        structure: "singleAgent",
        goal: "Run safely.",
        agentName: "Agent A",
      },
    });
    expect(create.statusCode).toBe(200);

    const duplicate = await fastify.inject({
      method: "POST",
      url: catalogActionUrl(home, "Supported", "duplicate"),
    });
    expect(duplicate.statusCode).toBe(200);
    expect(scanLoops({ home }).map((loop) => loop.name)).toEqual([
      "Copy of Supported",
      "Supported",
    ]);
  });
});
