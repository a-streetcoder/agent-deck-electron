import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  loadPackageSkillEntries,
  scanPackagePromptLocations,
  scanPackageSkillLocations,
} from "../src/packageSkills.ts";

/** SKL-08: package-provided skills from Pi's `settings.json → packages`. */
const root = mkdtempSync(path.join(tmpdir(), "pkg-skills-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function makeHome(tag: string): { home: string; piAgent: string } {
  const home = path.join(root, `home-${tag}`);
  const piAgent = path.join(home, ".pi", "agent");
  mkdirSync(piAgent, { recursive: true });
  return { home, piAgent };
}

function writeSkill(dir: string, name: string): void {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(
    path.join(dir, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: from a package\n---\nbody`,
  );
}

describe("scanPackageSkillLocations", () => {
  it("resolves absolute refs, honors pi.skills, and warns on declared-but-missing paths", () => {
    const { home, piAgent } = makeHome("abs");
    const pkg = path.join(root, "pkg-abs");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "pkg-abs", pi: { skills: ["skill-dir", "missing-dir"] } }),
    );
    writeSkill(path.join(pkg, "skill-dir"), "packaged");
    writeFileSync(
      path.join(piAgent, "settings.json"),
      JSON.stringify({ packages: [pkg], unrelated: true }),
    );

    const out = scanPackageSkillLocations({ home });
    expect(out.locations.map((l) => l.dir)).toEqual([path.resolve(pkg, "skill-dir")]);
    expect(out.warnings.some((w) => w.includes("missing-dir"))).toBe(true);

    const { entries } = loadPackageSkillEntries({ home });
    expect(entries.map((e) => e.name)).toEqual(["packaged"]);
  });

  it("falls back to the conventional skills/ dir and reads project-relative refs", () => {
    const { home } = makeHome("proj");
    const project = path.join(root, "project");
    const pkg = path.join(project, "vendor", "helper-pack");
    writeFileSync(
      path.join(mkdirSync(pkg, { recursive: true }) ?? pkg, "package.json"),
      JSON.stringify({ name: "helper-pack" }),
    );
    writeSkill(path.join(pkg, "skills"), "conventional");
    mkdirSync(path.join(project, ".pi"), { recursive: true });
    writeFileSync(
      path.join(project, ".pi", "settings.json"),
      JSON.stringify({ packages: ["./vendor/helper-pack"] }),
    );

    const out = scanPackageSkillLocations({ home, projectPath: project });
    expect(out.locations.map((l) => l.dir)).toEqual([path.resolve(pkg, "skills")]);
    // the same ./ ref without a project warns instead of resolving against anything else
    const homeSettings = path.join(home, ".pi", "agent", "settings.json");
    writeFileSync(homeSettings, JSON.stringify({ packages: ["./vendor/helper-pack"] }));
    const noProject = scanPackageSkillLocations({ home });
    expect(noProject.locations).toEqual([]);
    expect(noProject.warnings.some((w) => w.includes("no project is selected"))).toBe(true);
  });

  it("refuses a sibling-prefix escape (pkg vs pkg-evil)", () => {
    // path.relative-based containment: ../pkg-evil/skills shares the lexical prefix with pkg
    // but must refuse (review, Codex)
    const { home, piAgent } = makeHome("sibling");
    const pkg = path.join(root, "sib", "pkg");
    const evil = path.join(root, "sib", "pkg-evil");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "pkg", pi: { skills: ["../pkg-evil/skills"] } }),
    );
    writeSkill(path.join(evil, "skills"), "smuggled");
    writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ packages: [pkg] }));

    const out = scanPackageSkillLocations({ home });
    expect(out.locations).toEqual([]);
    expect(out.warnings.some((w) => w.includes("outside itself"))).toBe(true);
  });

  it("refuses a junctioned skills dir escaping the package (Windows)", () => {
    if (process.platform !== "win32") return;
    const { home, piAgent } = makeHome("junction");
    const pkg = path.join(root, "jx", "pkg");
    const outside = path.join(root, "jx", "outside-catalog");
    mkdirSync(pkg, { recursive: true });
    writeSkill(outside, "escaped");
    writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "pkg" }));
    const link = spawnSync("cmd", ["/c", "mklink", "/J", path.join(pkg, "skills"), outside]);
    expect(link.status).toBe(0);
    writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ packages: [pkg] }));

    const out = scanPackageSkillLocations({ home });
    expect(out.locations).toEqual([]);
  });

  it("dedupes the same catalog reached through an alias (Windows junction)", () => {
    if (process.platform !== "win32") return;
    const { home, piAgent } = makeHome("alias");
    const pkg = path.join(root, "al", "pkg");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "pkg", pi: { skills: ["skills", "alias"] } }),
    );
    writeSkill(path.join(pkg, "skills"), "once");
    const link = spawnSync("cmd", [
      "/c",
      "mklink",
      "/J",
      path.join(pkg, "alias"),
      path.join(pkg, "skills"),
    ]);
    expect(link.status).toBe(0);
    writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ packages: [pkg] }));

    const out = scanPackageSkillLocations({ home });
    expect(out.locations).toHaveLength(1);
  });

  it("resolves package PROMPTS: declared dirs, single .md files, conventional fallback (PRM-03)", () => {
    const { home, piAgent } = makeHome("prompts");
    const pkg = path.join(root, "pkg-prompts");
    mkdirSync(path.join(pkg, "tpl"), { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "pkg-prompts", pi: { prompts: ["tpl", "one-off.md", "gone.md"] } }),
    );
    writeFileSync(path.join(pkg, "tpl", "packaged.md"), "---\ndescription: dir prompt\n---\nbody");
    writeFileSync(path.join(pkg, "one-off.md"), "---\ndescription: file prompt\n---\nbody");
    writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ packages: [pkg] }));

    const out = scanPackagePromptLocations({ home });
    expect(out.locations.map((l) => `${l.kind}:${path.basename(l.target)}`).sort()).toEqual([
      "dir:tpl",
      "file:one-off.md",
    ]);
    // a DECLARED path that is missing warns — the user configured it (native parity)
    expect(out.warnings.some((w) => w.includes("gone.md"))).toBe(true);

    // conventional prompts/ dir when nothing is declared
    const pkg2 = path.join(root, "pkg-conventional");
    mkdirSync(path.join(pkg2, "prompts"), { recursive: true });
    writeFileSync(path.join(pkg2, "package.json"), JSON.stringify({ name: "pkg-conventional" }));
    writeFileSync(path.join(pkg2, "prompts", "conv.md"), "body");
    writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ packages: [pkg2] }));
    const conv = scanPackagePromptLocations({ home });
    expect(conv.locations.map((l) => l.kind)).toEqual(["dir"]);
  });

  it("refuses a declared prompt path escaping its package (PRM-03)", () => {
    const { home, piAgent } = makeHome("prompt-escape");
    const pkg = path.join(root, "pkg-prompt-escape");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "pkg-prompt-escape", pi: { prompts: ["../outside-prompts"] } }),
    );
    mkdirSync(path.join(root, "outside-prompts"), { recursive: true });
    writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ packages: [pkg] }));

    const out = scanPackagePromptLocations({ home });
    expect(out.locations).toEqual([]);
    expect(out.warnings.some((w) => w.includes("outside itself"))).toBe(true);
  });

  it("refuses a declared path escaping its package and tolerates malformed JSON", () => {
    const { home, piAgent } = makeHome("escape");
    const pkg = path.join(root, "pkg-escape");
    mkdirSync(pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "package.json"),
      JSON.stringify({ name: "pkg-escape", pi: { skills: ["../outside"] } }),
    );
    mkdirSync(path.join(root, "outside"), { recursive: true });
    writeFileSync(path.join(piAgent, "settings.json"), JSON.stringify({ packages: [pkg] }));

    const out = scanPackageSkillLocations({ home });
    expect(out.locations).toEqual([]);
    expect(out.warnings.some((w) => w.includes("outside itself"))).toBe(true);

    // malformed settings.json warns and contributes nothing
    writeFileSync(path.join(piAgent, "settings.json"), "{not json");
    const bad = scanPackageSkillLocations({ home });
    expect(bad.locations).toEqual([]);
    expect(bad.warnings.some((w) => w.includes("invalid JSON"))).toBe(true);
  });
});
