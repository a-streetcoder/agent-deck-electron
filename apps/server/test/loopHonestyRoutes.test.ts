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
}));

import { createSessionWorktree } from "../src/git.ts";
import { registerLoopRoutes } from "../src/routes/loops.ts";

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
  const startEngine = vi.fn();
  const broadcast = vi.fn();
  registerLoopRoutes({
    fastify,
    sessions: { create: createSession },
    index: {},
    projects: { find: () => ({ id: "project", path: home }) },
    loopEngine: { start: startEngine },
    bridgeTokens: new Map(),
    broadcast,
    rootsFor,
    enabledExtensionPaths: () => [],
  } as unknown as ServerContext);
  return { fastify, createSession, startEngine, broadcast };
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
