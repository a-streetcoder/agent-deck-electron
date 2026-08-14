import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { registerResourceRoutes } from "../src/routes/resources.ts";
import { EngineSkillStore } from "../src/skills/engineSkillStore.ts";
import { loadSkillEngineNative, type SkillEngineNative } from "../src/skills/skillEngineNative.ts";

/**
 * Real-addon acceptance coverage for the engine 0.1.6 preview seam (SKL-03/04): HTTP →
 * resource routes → EngineSkillStore → the NAPI addon, with local bare remotes. Inspect must
 * materialize nothing, import must honor the selection, and cancel must be idempotent.
 *
 * Capability-gated: with a 0.1.5 addon (no `inspectGitRepo`) the suite SKIPS — it runs fully
 * once the `@a-streetcoder/skill-engine-native` pin reaches 0.1.6, and locally today via
 * `AGENT_DECK_SKILL_ENGINE_NATIVE_PATH` pointing at a 0.1.6 build.
 */
const root = mkdtempSync(path.join(tmpdir(), "skill-git-preview-"));
const resourceHome = path.join(root, "home");
let fastify: FastifyInstance;
// Loaded at module scope so the capability gate is a real boolean at collection time
// (`skipIf` does not evaluate functions lazily).
const engine: SkillEngineNative = await loadSkillEngineNative();
const hasPreview = typeof engine.inspectGitRepo === "function";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

/** A bare remote with skills `alpha` (frontmatter name/description + a reference file) and `beta`. */
function makeRemote(tag: string): string {
  const remote = path.join(root, `remote-${tag}.git`);
  const work = path.join(root, `upstream-${tag}`);
  git(root, ["init", "--bare", "--initial-branch=main", remote]);
  mkdirSync(work);
  git(work, ["init", "--initial-branch=main"]);
  git(work, ["config", "user.name", "Agent Deck acceptance"]);
  git(work, ["config", "user.email", "acceptance@example.invalid"]);
  git(work, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(work, ".gitattributes"), "* -text\n");
  const alpha = path.join(work, "skills", "alpha");
  mkdirSync(alpha, { recursive: true });
  writeFileSync(
    path.join(alpha, "SKILL.md"),
    "---\nname: Alpha Helper\ndescription: Helps with alpha things\n---\nAlpha body\n",
  );
  writeFileSync(path.join(alpha, "reference.md"), "extra material\n");
  const beta = path.join(work, "skills", "beta");
  mkdirSync(beta, { recursive: true });
  writeFileSync(path.join(beta, "SKILL.md"), "no frontmatter here\n");
  git(work, ["add", "."]);
  git(work, ["commit", "-m", "base"]);
  git(work, ["remote", "add", "origin", remote]);
  git(work, ["push", "--set-upstream", "origin", "main"]);
  return remote;
}

async function api(method: "GET" | "POST", url: string, body?: Record<string, unknown>) {
  return await fastify.inject({ method, url, payload: body });
}

beforeAll(async () => {
  mkdirSync(resourceHome);
  const skillStore = new EngineSkillStore({
    engine,
    scanSkillsFor: () => [],
    home: resourceHome,
    projectRootFor: () => undefined,
  });
  fastify = Fastify();
  registerResourceRoutes({
    fastify,
    skillStore,
    projects: { list: () => [] },
    settings: { get: () => ({ disabledSkills: [] }) },
    bridge: { specs: () => [] },
    resourceHome: () => resourceHome,
    rootsFor: () => ({ home: resourceHome }),
    extensionBridgeConflictAt: () => null,
    broadcast: () => undefined,
  } as unknown as ServerContext);
  await fastify.ready();
}, 30_000);

afterAll(async () => {
  await fastify?.close();
  rmSync(root, { recursive: true, force: true });
});

// The 0.1.5 addon has no preview surface; skip (never fake) until the pin reaches 0.1.6.
describe.skipIf(!hasPreview)("engine 0.1.6 preview + selected import routes (SKL-03/04)", () => {
  it("inspects without materializing, imports only the selection, then refuses re-preview", async () => {
    const remote = makeRemote("main");
    const url = pathToFileURL(remote).href;

    const inspect = await api("POST", "/resources/skills/inspect-git", { url });
    expect(inspect.statusCode).toBe(200);
    const preview = (await inspect.json()) as {
      repoId: string;
      skills: {
        name: string;
        displayName: string;
        description?: string;
        extraFileCount: number;
      }[];
    };
    expect(preview.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    const alpha = preview.skills[0]!;
    // display fields derive from SKILL.md frontmatter via the pinned Pi parser
    expect(alpha.displayName).toBe("Alpha Helper");
    expect(alpha.description).toBe("Helps with alpha things");
    expect(alpha.extraFileCount).toBe(1);
    // no frontmatter → folder-name fallback, no description
    expect(preview.skills[1]!.displayName).toBe("beta");
    expect(preview.skills[1]!.description).toBeUndefined();

    // nothing materialized, nothing listed — a preview is not resource state
    const repos = await api("GET", "/resources/skill-repos");
    expect(((await repos.json()) as { repos: unknown[] }).repos).toEqual([]);

    // import ONLY alpha
    const imp = await api("POST", "/resources/skills/import-git", {
      scope: "global",
      url,
      selected: ["alpha"],
    });
    expect(imp.statusCode).toBe(200);
    expect(((await imp.json()) as { imported: string[] }).imported).toEqual(["alpha"]);

    const after = await api("GET", "/resources/skill-repos");
    const listed = (await after.json()) as { repos: { skillNames: string[] }[] };
    expect(listed.repos).toHaveLength(1);
    expect(listed.repos[0]!.skillNames).toEqual(["alpha"]);

    // an imported collection refuses a new preview (additive re-import is SKL-13's scope)…
    const again = await api("POST", "/resources/skills/inspect-git", { url });
    expect(again.statusCode).toBe(409);
    // …and refuses discard (forget/delete owns imported collections)
    const discard = await api("POST", "/resources/skills/discard-git-preview", {
      repoId: preview.repoId,
    });
    expect(discard.statusCode).toBe(409);
  }, 120_000);

  it("cancelling a preview is idempotent and a bad selection imports nothing", async () => {
    const remote = makeRemote("cancel");
    const url = pathToFileURL(remote).href;

    const inspect = await api("POST", "/resources/skills/inspect-git", { url });
    expect(inspect.statusCode).toBe(200);
    const { repoId } = (await inspect.json()) as { repoId: string };

    const discard = await api("POST", "/resources/skills/discard-git-preview", { repoId });
    expect(discard.statusCode).toBe(200);
    const discardAgain = await api("POST", "/resources/skills/discard-git-preview", { repoId });
    expect(discardAgain.statusCode).toBe(200);

    // a selection naming a skill the repo doesn't have imports NOTHING (fail closed)
    const bad = await api("POST", "/resources/skills/import-git", {
      scope: "global",
      url,
      selected: ["alpha", "nope"],
    });
    expect(bad.statusCode).toBe(404);
    // THIS remote never became a collection (the sibling test's import may legitimately exist)
    const repos = await api("GET", "/resources/skill-repos");
    const listed = (await repos.json()) as { repos: { remoteUrl: string }[] };
    expect(listed.repos.filter((r) => r.remoteUrl.includes("remote-cancel"))).toEqual([]);
  }, 120_000);
});
