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
import { LOOP_PARALLEL_WRITE_TARGET_CODE, type LoopStructure } from "@agent-deck/domain";
import { loopsDir, scanLoops, writeLoopFile } from "@agent-deck/resources";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";

vi.mock("../src/git.ts", () => ({
  createLoopWorktree: vi.fn(),
  gitWorktreeRemove: vi.fn(),
  gitDeleteOwnedWorktreeBranch: vi.fn(),
}));

import { createLoopWorktree, gitDeleteOwnedWorktreeBranch, gitWorktreeRemove } from "../src/git.ts";
import { LoopEngine } from "../src/loopEngine.ts";
import { canonicalCheckoutLockKey, registerLoopRoutes } from "../src/routes/loops.ts";
import { SessionCreationError } from "../src/SessionManager.ts";

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
  const acknowledgeCheckoutRecovery = vi.fn();
  const resolveHumanApproval = vi.fn();
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
        acknowledgeCheckoutRecovery,
        resolveHumanApproval,
        list: () => [],
        get: getEngine,
      },
      bridgeTokens,
      broadcast,
      rootsFor,
      enabledExtensionPaths: () => [],
      worktreesRoot: path.join(home, "managed-worktrees"),
    } as unknown as ServerContext,
    {
      canonicalCheckoutLockKey: canonicalCheckoutEffect,
      createLoopWorktree: createWorktreeEffect,
    },
  );
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
    acknowledgeCheckoutRecovery,
    resolveHumanApproval,
    getEngine,
    findProject,
    broadcast,
    indexRows,
    bridgeTokens,
    canonicalCheckoutEffect,
    createWorktreeEffect,
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
      url: "/loops/Release%20Approval/duplicate",
    });
    expect(duplicate.statusCode).toBe(200);

    const run = await fastify.inject({
      method: "POST",
      url: "/loops/Release%20Approval/run",
      payload: { projectId: "project" },
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
    expect(startEngine.mock.calls[0]?.[2]).toEqual({
      projectId: "project",
      retryOf: undefined,
    });
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
    const { fastify, createSession, startEngine, broadcast, bridgeTokens, indexRows } =
      makeRoutes(home);
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
    expect(order).toEqual(["pi"]);
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
    expect(gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();
    const generatedTarget = vi.mocked(createLoopWorktree).mock.calls[0]![1];
    expect(response.json().error).toContain(generatedTarget);
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
    expect(response.json().error).toContain(vi.mocked(createLoopWorktree).mock.calls[0]![1]);
    expect(order).toEqual(["stop", "settled", "rollback", "destroy"]);
    expect(stopEngine).toHaveBeenCalledOnce();
    expect(settledEngine).toHaveBeenCalledOnce();
    expect(rollbackEngine).toHaveBeenCalledWith("run-in-flight");
    expect(destroySession).toHaveBeenCalledOnce();
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
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
    const { fastify, createSession, destroySession, startEngine, settledEngine } = makeRoutes(home);
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
      id: "retained-run",
      status: "completed",
      launch: options.launch,
    }));

    const response = await fastify.inject({
      method: "POST",
      url: "/loops/Retained%20Review%20Loop/run",
      payload: { projectId: "project" },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json().run.launch.worktree).toMatchObject({
      path: worktree.path,
      branch: worktree.branch,
      branchOwned: true,
    });

    settle();
    await vi.waitFor(() => expect(destroySession).toHaveBeenCalledOnce());
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
    expect(gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();
  });

  it("rejects invalid Discovery/Triage configuration before runtime allocation", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-triage-invalid-"));
    const filePath = writeExternalLoop(home, "Invalid Triage", "discoveryTriage");
    const original = readFileSync(filePath, "utf8");
    const { fastify, createSession, startEngine } = makeRoutes(home);

    const run = await fastify.inject({
      method: "POST",
      url: "/loops/Invalid%20Triage/run",
      payload: { projectId: "project" },
    });
    expect(run.statusCode).toBe(422);
    expect(run.json()).toMatchObject({ code: "loop_definition_invalid" });
    expect(createSession).not.toHaveBeenCalled();
    expect(startEngine).not.toHaveBeenCalled();
    expect(createLoopWorktree).not.toHaveBeenCalled();

    const duplicate = await fastify.inject({
      method: "POST",
      url: "/loops/Invalid%20Triage/duplicate",
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
      url: "/loops/Invalid%20Triage/run",
      payload: { projectId: "project" },
    });
    expect(unavailable.statusCode).toBe(422);
    expect(unavailable.json()).toMatchObject({
      code: "loop_definition_invalid",
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

    for (const name of ["Artifact Triage", "Checkout Triage", "Worktree Triage"]) {
      const response = await fastify.inject({
        method: "POST",
        url: `/loops/${encodeURIComponent(name)}/run`,
        payload: { projectId: "project" },
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
      url: "/loops/Unsafe%20Parallel/run",
      payload: { projectId: "project" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json()).toMatchObject({ code: LOOP_PARALLEL_WRITE_TARGET_CODE });
    expect(findProject).not.toHaveBeenCalled();
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
      url: "/loops/Safe%20Parallel/run",
      payload: { projectId: "project" },
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
    expect(indexRows.has("stale-parent")).toBe(false);
    expect(bridgeTokens.has("stale-parent")).toBe(false);
    expect(markSessionReconciled).toHaveBeenCalledOnce();
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
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
    expect(gitWorktreeRemove).not.toHaveBeenCalled();
    expect(gitDeleteOwnedWorktreeBranch).not.toHaveBeenCalled();
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
