import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { registerResourceRoutes } from "../src/routes/resources.ts";
import { EngineSkillStore } from "../src/skills/engineSkillStore.ts";
import { loadSkillEngineNative } from "../src/skills/skillEngineNative.ts";

/**
 * Real-addon acceptance coverage for the engine 0.1.5 collection seam. This deliberately goes
 * through HTTP -> resource route -> EngineSkillStore -> the pinned NAPI addon, with a local bare
 * remote. It guards the per-file flow that replaced the old whole-skill conflict implementation.
 */
const root = mkdtempSync(path.join(tmpdir(), "skill-git-conflict-"));
const resourceHome = path.join(root, "home");
const remote = path.join(root, "remote.git");
const upstream = path.join(root, "upstream");
let fastify: FastifyInstance;

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function api(method: "GET" | "POST", url: string, body?: Record<string, unknown>) {
  return await fastify.inject({ method, url, payload: body });
}

beforeAll(async () => {
  mkdirSync(resourceHome);
  git(root, ["init", "--bare", "--initial-branch=main", remote]);
  mkdirSync(upstream);
  git(upstream, ["init", "--initial-branch=main"]);
  git(upstream, ["config", "user.name", "Agent Deck acceptance"]);
  git(upstream, ["config", "user.email", "acceptance@example.invalid"]);
  git(upstream, ["config", "core.autocrlf", "false"]);

  const skillDir = path.join(upstream, "skills", "mixed-choice");
  mkdirSync(skillDir, { recursive: true });
  // Disable checkout conversion in every clone so the byte assertions mean the same thing on
  // Windows, macOS, and Linux.
  writeFileSync(path.join(upstream, ".gitattributes"), "* -text\n");
  writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: mixed-choice\ndescription: Per-file acceptance fixture\n---\nBase body\n",
  );
  writeFileSync(path.join(skillDir, "keep.txt"), "base keep\n");
  writeFileSync(path.join(skillDir, "take.txt"), "base take\n");
  writeFileSync(path.join(skillDir, "automatic.txt"), "base automatic\n");
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "-m", "base"]);
  git(upstream, ["remote", "add", "origin", remote]);
  git(upstream, ["push", "--set-upstream", "origin", "main"]);

  const skillStore = new EngineSkillStore({
    engine: await loadSkillEngineNative(),
    scanSkillsFor: () => [],
    home: resourceHome,
    projectRootFor: () => undefined,
  });
  fastify = Fastify();
  // Register the production route module with the real production store. Unused context members
  // are inert test doubles; the collection request path itself is not replaced or mocked.
  registerResourceRoutes({
    fastify,
    skillStore,
    projects: { list: () => [] },
    settings: { get: () => ({ disabledSkills: [] }) },
    bridge: { specs: () => [] },
    resourceHome: () => resourceHome,
    rootsFor: () => ({ home: resourceHome }),
    extensionBridgeConflictAt: () => null,
    agentMemoryEnabled: () => false,
    broadcast: () => undefined,
  } as unknown as ServerContext);
  await fastify.ready();
}, 30_000);

afterAll(async () => {
  await fastify?.close();
  rmSync(root, { recursive: true, force: true });
});

describe("engine 0.1.5 per-file git conflict routes", () => {
  it("rejects a stale review, reloads detail, and applies mixed choices with an automatic merge", async () => {
    const importResponse = await api("POST", "/resources/skills/import-git", {
      scope: "global",
      // The engine intentionally allows explicit file:// git transport for hermetic local remotes.
      url: pathToFileURL(remote).href,
    });
    expect(importResponse.statusCode).toBe(200);
    const imported = (await importResponse.json()) as { imported: string[]; repoId: string };
    expect(imported.imported).toEqual(["mixed-choice"]);

    const reposResponse = await api("GET", "/resources/skill-repos");
    expect(reposResponse.statusCode).toBe(200);
    expect(await reposResponse.json()).toMatchObject({
      repos: [{ id: imported.repoId, skillNames: ["mixed-choice"], storageMode: "collection-v1" }],
    });

    const materialized = path.join(resourceHome, ".agents", "skills", "mixed-choice");
    writeFileSync(path.join(materialized, "keep.txt"), "local bytes to keep\n");
    writeFileSync(path.join(materialized, "take.txt"), "local bytes to discard\n");

    const upstreamSkill = path.join(upstream, "skills", "mixed-choice");
    writeFileSync(path.join(upstreamSkill, "keep.txt"), "remote bytes not selected\n");
    writeFileSync(path.join(upstreamSkill, "take.txt"), "remote bytes selected\n");
    writeFileSync(path.join(upstreamSkill, "automatic.txt"), "remote non-overlap\n");
    git(upstream, ["add", "."]);
    git(upstream, ["commit", "-m", "overlap and non-overlap"]);
    git(upstream, ["push", "origin", "main"]);

    const checkResponse = await api(
      "POST",
      `/resources/skill-repos/${encodeURIComponent(imported.repoId)}/check`,
    );
    expect(checkResponse.statusCode).toBe(200);
    expect(await checkResponse.json()).toMatchObject({
      updateAvailable: true,
      deltas: [{ name: "mixed-choice", kind: "changed" }],
    });

    const updateResponse = await api(
      "POST",
      `/resources/skill-repos/${encodeURIComponent(imported.repoId)}/update`,
    );
    expect(updateResponse.statusCode).toBe(200);
    const update = (await updateResponse.json()) as {
      conflicts: string[];
      mergeConflicts: Array<{
        name: string;
        mergeId: string;
        wholeSkill: boolean;
        paths: Array<{ path: string; local: string; remote: string }>;
      }>;
    };
    expect(update.conflicts).toEqual(["mixed-choice"]);
    expect(update.mergeConflicts).toHaveLength(1);
    const detail = update.mergeConflicts[0]!;
    expect(detail).toMatchObject({ name: "mixed-choice", wholeSkill: false });
    expect(detail.mergeId).not.toBe("");
    expect(detail.paths).toEqual([
      { path: "keep.txt", local: "file", remote: "file" },
      { path: "take.txt", local: "file", remote: "file" },
    ]);
    expect(detail.paths.map((item) => item.path)).not.toContain("automatic.txt");

    // Move conflict-relevant local state after presenting the detail. The merge id above was
    // valid when issued, but changing an overlapping path must invalidate that exact review.
    writeFileSync(path.join(materialized, "keep.txt"), "local bytes changed after review\n");
    const staleResponse = await api(
      "POST",
      `/resources/skill-repos/${encodeURIComponent(imported.repoId)}/resolve`,
      {
        name: "mixed-choice",
        mergeId: detail.mergeId,
        choices: [
          { path: "keep.txt", resolution: "mine" },
          { path: "take.txt", resolution: "remote" },
        ],
      },
    );
    expect(staleResponse.statusCode).toBe(409);
    expect(await staleResponse.json()).toMatchObject({ code: "LEGACY_MERGE_STALE" });

    const refreshResponse = await api(
      "POST",
      `/resources/skill-repos/${encodeURIComponent(imported.repoId)}/refresh-merge`,
      { name: "mixed-choice" },
    );
    expect(refreshResponse.statusCode).toBe(200);
    const refreshed = (await refreshResponse.json()) as { mergeConflict: typeof detail };
    expect(refreshed.mergeConflict.mergeId).not.toBe(detail.mergeId);
    expect(refreshed.mergeConflict).toMatchObject({
      name: detail.name,
      wholeSkill: false,
      paths: detail.paths,
    });

    const resolveResponse = await api(
      "POST",
      `/resources/skill-repos/${encodeURIComponent(imported.repoId)}/resolve`,
      {
        name: "mixed-choice",
        mergeId: refreshed.mergeConflict.mergeId,
        choices: [
          { path: "keep.txt", resolution: "mine" },
          { path: "take.txt", resolution: "remote" },
        ],
      },
    );
    expect(resolveResponse.statusCode).toBe(200);
    expect(await resolveResponse.json()).toMatchObject({ ok: true });

    expect(readFileSync(path.join(materialized, "keep.txt"))).toEqual(
      Buffer.from("local bytes changed after review\n"),
    );
    expect(readFileSync(path.join(materialized, "take.txt"))).toEqual(
      Buffer.from("remote bytes selected\n"),
    );
    expect(readFileSync(path.join(materialized, "automatic.txt"))).toEqual(
      Buffer.from("remote non-overlap\n"),
    );
  }, 30_000);
});
