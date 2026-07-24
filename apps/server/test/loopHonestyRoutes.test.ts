import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { LOOP_STRUCTURE_UNSUPPORTED_CODE, type LoopStructure } from "@agent-deck/domain";
import { loopsDir, scanLoops, writeLoopFile } from "@agent-deck/resources";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";

vi.mock("../src/git.ts", () => ({
  createSessionWorktree: vi.fn(),
  gitWorktreeRemove: vi.fn(),
  gitDeleteOwnedWorktreeBranch: vi.fn(),
}));

import {
  createSessionWorktree,
  gitDeleteOwnedWorktreeBranch,
  gitWorktreeRemove,
} from "../src/git.ts";
import { registerLoopRoutes } from "../src/routes/loops.ts";
import { SessionCreationError } from "../src/SessionManager.ts";

const unsupportedStructures: LoopStructure[] = [
  "makerChecker",
  "agentPipeline",
  "parallelAgents",
  "discoveryTriage",
  "humanApproval",
];

const servers: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  vi.clearAllMocks();
});

function makeRoutes(home: string, rootsFor: () => { home: string } = () => ({ home })) {
  const fastify = Fastify();
  servers.push(fastify);
  const createSession = vi.fn();
  const destroySession = vi.fn();
  const announceCreated = vi.fn();
  const startEngine = vi.fn();
  const stopEngine = vi.fn();
  const settledEngine = vi.fn();
  const broadcast = vi.fn();
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
    projects: { find: () => ({ id: "project", path: home }) },
    loopEngine: { start: startEngine, stop: stopEngine, settled: settledEngine },
    bridgeTokens,
    broadcast,
    rootsFor,
    enabledExtensionPaths: () => [],
  } as unknown as ServerContext);
  return {
    fastify,
    createSession,
    destroySession,
    announceCreated,
    startEngine,
    stopEngine,
    settledEngine,
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
      expect(createSessionWorktree).not.toHaveBeenCalled();
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
    vi.mocked(createSessionWorktree).mockResolvedValue({
      path: path.join(home, "worktree"),
      branch: "agent-deck/loop-Rollback-abc123",
      sourceBranch: "main",
      branchOwned: true,
    });
    vi.mocked(gitWorktreeRemove).mockImplementation(async () => {
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
    vi.mocked(createSessionWorktree).mockResolvedValue({
      path: parent.meta.cwd,
      branch: "agent-deck/loop-Announce-Rollback-abc123",
      sourceBranch: "main",
      branchOwned: true,
    });
    createSession.mockReturnValue(parent);
    startEngine.mockReturnValue({ id: "run-in-flight" });
    announceCreated.mockImplementation(() => {
      throw new Error("announcement failed");
    });
    stopEngine.mockImplementation(() => {
      order.push("stop");
    });
    settledEngine.mockReturnValue(settled);
    destroySession.mockImplementation(async () => {
      order.push("destroy");
    });
    vi.mocked(gitWorktreeRemove).mockImplementation(async () => {
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
    expect(order).toEqual(["stop", "settled", "destroy", "worktree", "branch"]);
    expect(stopEngine).toHaveBeenCalledOnce();
    expect(settledEngine).toHaveBeenCalledOnce();
    expect(destroySession).toHaveBeenCalledOnce();
    expect(gitWorktreeRemove).toHaveBeenCalledOnce();
    expect(gitDeleteOwnedWorktreeBranch).toHaveBeenCalledOnce();
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
