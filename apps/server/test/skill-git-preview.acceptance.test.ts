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

/** A bare remote with two skills (frontmatter name/description + a reference file on the
 *  first; bare SKILL.md on the second). Custom `names` avoid catalog collisions across tests
 *  sharing the one resource home. */
function makeRemote(tag: string, names: [string, string] = ["alpha", "beta"]): string {
  const remote = path.join(root, `remote-${tag}.git`);
  const work = path.join(root, `upstream-${tag}`);
  git(root, ["init", "--bare", "--initial-branch=main", remote]);
  mkdirSync(work);
  git(work, ["init", "--initial-branch=main"]);
  git(work, ["config", "user.name", "Agent Deck acceptance"]);
  git(work, ["config", "user.email", "acceptance@example.invalid"]);
  git(work, ["config", "core.autocrlf", "false"]);
  writeFileSync(path.join(work, ".gitattributes"), "* -text\n");
  const alpha = path.join(work, "skills", names[0]);
  mkdirSync(alpha, { recursive: true });
  writeFileSync(
    path.join(alpha, "SKILL.md"),
    "---\nname: Alpha Helper\ndescription: Helps with alpha things\n---\nAlpha body\n",
  );
  writeFileSync(path.join(alpha, "reference.md"), "extra material\n");
  const beta = path.join(work, "skills", names[1]);
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

// SKL-13 capability probe (0.1.8): a current engine ANSWERS an inspect on an imported
// collection (alreadyImported); 0.1.6/0.1.7 throw RESOURCE_ALREADY_EXISTS. The addon has
// no version API, so probe by doing the real thing in a throwaway home.
const canAdditive = await (async () => {
  if (!hasPreview) return false;
  const probeHome = path.join(root, "probe-home");
  mkdirSync(probeHome, { recursive: true });
  const url = pathToFileURL(makeRemote("probe", ["probe-alpha", "probe-beta"])).href;
  engine.importGitRepo(probeHome, undefined, "global", url, undefined, undefined, undefined);
  try {
    engine.inspectGitRepo(probeHome, url, undefined, undefined);
    return true;
  } catch (error) {
    // ONLY the old-engine refusal classifies the capability as absent; anything else is a
    // real failure the run must surface, not silently skip around.
    if (error instanceof Error && error.message.startsWith("RESOURCE_ALREADY_EXISTS")) {
      return false;
    }
    throw error;
  }
})();

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
    agentMemoryEnabled: () => false,
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

    // SKL-13 (0.1.8): an imported collection ANSWERS a new preview with its selection
    // state; older engines refuse with 409.
    const again = await api("POST", "/resources/skills/inspect-git", { url });
    if (canAdditive) {
      expect(again.statusCode).toBe(200);
      const answered = (await again.json()) as {
        skills: { name: string }[];
        alreadyImported: string[];
      };
      expect(answered.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
      expect(answered.alreadyImported).toEqual(["alpha"]);
    } else {
      expect(again.statusCode).toBe(409);
    }
    // an imported collection still refuses discard (forget/delete owns imported collections)
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

// The pinned pre-0.1.8 addon refuses inspect-of-imported; skip (never fake) until the pin
// reaches 0.1.8.
describe.skipIf(!canAdditive)("engine 0.1.8 additive widening (SKL-13)", () => {
  it("answers for an imported repo, widens additively, and skips what is already there", async () => {
    const remote = makeRemote("additive", ["add-alpha", "add-beta"]);
    const url = pathToFileURL(remote).href;

    const first = await api("POST", "/resources/skills/import-git", {
      scope: "global",
      url,
      selected: ["add-alpha"],
    });
    expect(first.statusCode).toBe(200);

    // inspect the SAME url: answered from the collection's own clone, selection state included
    const inspect = await api("POST", "/resources/skills/inspect-git", { url });
    expect(inspect.statusCode).toBe(200);
    const preview = (await inspect.json()) as {
      skills: { name: string }[];
      alreadyImported: string[];
    };
    expect(preview.skills.map((s) => s.name)).toEqual(["add-alpha", "add-beta"]);
    expect(preview.alreadyImported).toEqual(["add-alpha"]);

    // widening with the full selection imports only what is missing and reports the rest skipped
    const widen = await api("POST", "/resources/skills/import-git", {
      scope: "global",
      url,
      selected: ["add-alpha", "add-beta"],
    });
    expect(widen.statusCode).toBe(200);
    const outcome = (await widen.json()) as { imported: string[]; skipped: string[] };
    expect(outcome.imported).toEqual(["add-beta"]);
    expect(outcome.skipped).toEqual(["add-alpha"]);

    const repos = await api("GET", "/resources/skill-repos");
    const listed = (await repos.json()) as { repos: { remoteUrl: string; skillNames: string[] }[] };
    const mine = listed.repos.find((r) => r.remoteUrl.includes("remote-additive"))!;
    expect(mine.skillNames).toEqual(["add-alpha", "add-beta"]);

    // an UNSELECTED re-import of an imported collection still refuses — additive widening
    // requires an explicit selection
    const blind = await api("POST", "/resources/skills/import-git", { scope: "global", url });
    expect(blind.statusCode).toBe(409);
  }, 120_000);
});
