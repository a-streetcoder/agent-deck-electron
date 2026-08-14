import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { registerResourceRoutes } from "../src/routes/resources.ts";
import { EngineSkillStore } from "../src/skills/engineSkillStore.ts";
import { loadSkillEngineNative, type SkillEngineNative } from "../src/skills/skillEngineNative.ts";

/**
 * Real-addon acceptance for LOCAL folder import (SKL-05) + full-fileset local skills (SKL-06):
 * HTTP → routes → EngineSkillStore → the NAPI addon on plain directories. Capability-gated:
 * skips on a 0.1.6 addon (no `inspectLocalFolder`); runs fully against a 0.1.7 build via
 * `AGENT_DECK_SKILL_ENGINE_NATIVE_PATH`, and in CI once the pin reaches 0.1.7.
 */
const root = mkdtempSync(path.join(tmpdir(), "skill-local-"));
const resourceHome = path.join(root, "home");
let fastify: FastifyInstance;
const engine: SkillEngineNative = await loadSkillEngineNative();
const hasLocalFolder = typeof engine.inspectLocalFolder === "function";

/** A folder with skills `alpha` (frontmatter + a sibling + a nested script) and `beta`. */
function makeFolder(tag: string): string {
  const folder = path.join(root, `folder-${tag}`);
  const alpha = path.join(folder, "alpha");
  mkdirSync(path.join(alpha, "scripts"), { recursive: true });
  writeFileSync(
    path.join(alpha, "SKILL.md"),
    "---\nname: Alpha Helper\ndescription: Helps with alpha things\n---\nAlpha body\n",
  );
  writeFileSync(path.join(alpha, "reference.md"), "extra material\n");
  writeFileSync(path.join(alpha, "scripts", "run.txt"), "echo hi\n");
  const beta = path.join(folder, "beta");
  mkdirSync(beta, { recursive: true });
  writeFileSync(path.join(beta, "SKILL.md"), "beta body, no frontmatter\n");
  return folder;
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

const skillFile = (name: string, rel: string): string =>
  path.join(resourceHome, ".agents", "skills", name, rel);

describe.skipIf(!hasLocalFolder)("engine 0.1.7 local folder import routes (SKL-05/06)", () => {
  it("previews a folder, imports only the selection with full filesets", async () => {
    const folder = makeFolder("main");

    const inspect = await api("POST", "/resources/skills/inspect-local", { path: folder });
    expect(inspect.statusCode).toBe(200);
    const preview = (await inspect.json()) as {
      skills: { name: string; displayName: string; description?: string; extraFileCount: number }[];
    };
    expect(preview.skills.map((s) => s.name)).toEqual(["alpha", "beta"]);
    expect(preview.skills[0]!.displayName).toBe("Alpha Helper");
    expect(preview.skills[0]!.extraFileCount).toBe(2);
    // a preview writes nothing
    expect(() => readFileSync(skillFile("alpha", "SKILL.md"))).toThrow();

    const imp = await api("POST", "/resources/skills/import-local-folder", {
      path: folder,
      selected: ["alpha"],
    });
    expect(imp.statusCode).toBe(200);
    expect(((await imp.json()) as { imported: string[] }).imported).toEqual(["alpha"]);
    // SKL-06: the WHOLE tree came along
    expect(readFileSync(skillFile("alpha", "reference.md"), "utf8")).toBe("extra material\n");
    expect(readFileSync(skillFile("alpha", path.join("scripts", "run.txt")), "utf8")).toBe(
      "echo hi\n",
    );
    expect(() => readFileSync(skillFile("beta", "SKILL.md"))).toThrow();

    // a bad selection imports nothing
    const bad = await api("POST", "/resources/skills/import-local-folder", {
      path: folder,
      selected: ["beta", "nope"],
    });
    expect(bad.statusCode).toBe(404);
    expect(() => readFileSync(skillFile("beta", "SKILL.md"))).toThrow();
  }, 60_000);

  it("known sources list existing Claude/Codex folders and feed the same preview flow (SKL-07/10)", async () => {
    // a Claude global skills folder in the test home — the discovery catalog must find it,
    // and the folder previews/imports through the same local pipeline
    const claude = path.join(resourceHome, ".claude", "skills", "claude-tip");
    mkdirSync(claude, { recursive: true });
    writeFileSync(
      path.join(claude, "SKILL.md"),
      "---\nname: claude-tip\ndescription: From Claude\n---\nTip body\n",
    );

    const known = await api("GET", "/resources/skills/known-sources");
    expect(known.statusCode).toBe(200);
    const { sources } = (await known.json()) as {
      sources: { path: string; label: string; provider: string }[];
    };
    const claudeGlobal = sources.find((s) => s.label === "Claude · Global");
    expect(claudeGlobal?.provider).toBe("claude");
    // only folders that exist are offered — no Codex dir was created in this home
    expect(sources.some((s) => s.label === "Codex · Global")).toBe(false);

    // an aliased CODEX_HOME must not mint a duplicate root (dedupe by resolved path)
    const priorCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = path.join(resourceHome, ".claude");
    try {
      const aliased = await api("GET", "/resources/skills/known-sources");
      const aliasedSources = (await aliased.json()) as { sources: { path: string }[] };
      const claudePaths = aliasedSources.sources.filter((s) => s.path === claudeGlobal!.path);
      expect(claudePaths).toHaveLength(1);
    } finally {
      if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = priorCodexHome;
    }

    const inspect = await api("POST", "/resources/skills/inspect-local", {
      path: claudeGlobal!.path,
    });
    expect(inspect.statusCode).toBe(200);
    const preview = (await inspect.json()) as { skills: { name: string }[] };
    expect(preview.skills.map((s) => s.name)).toEqual(["claude-tip"]);

    const imp = await api("POST", "/resources/skills/import-local-folder", {
      path: claudeGlobal!.path,
      selected: ["claude-tip"],
    });
    expect(imp.statusCode).toBe(200);
    expect(readFileSync(skillFile("claude-tip", "SKILL.md"), "utf8")).toContain("From Claude");
  }, 60_000);

  it("single-path import brings siblings when pointed at a SKILL.md (SKL-06)", async () => {
    // a UNIQUE skill name so this test cannot collide with the sibling test's imports and
    // silently skip its success assertions (review, Codex)
    const folder = path.join(root, "folder-single");
    const gamma = path.join(folder, "gamma");
    mkdirSync(path.join(gamma, "assets"), { recursive: true });
    writeFileSync(
      path.join(gamma, "SKILL.md"),
      "---\nname: gamma\ndescription: Sibling fixture\n---\nGamma body\n",
    );
    writeFileSync(path.join(gamma, "assets", "notes.md"), "sibling notes\n");
    const res = await api("POST", "/resources/skills/import", {
      scope: "global",
      // the historical UX: a user pastes the path to the SKILL.md itself
      sourcePath: path.join(gamma, "SKILL.md"),
    });
    expect(res.statusCode).toBe(200);
    // SKL-06: the sibling tree came along, not just the markdown
    expect(readFileSync(skillFile("gamma", path.join("assets", "notes.md")), "utf8")).toBe(
      "sibling notes\n",
    );
  }, 60_000);
});
