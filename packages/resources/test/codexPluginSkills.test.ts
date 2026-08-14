import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  enumerateCodexPluginSkills,
  pickVersion,
  resolveCodexPluginSkillRefs,
} from "../src/codexPluginSkills.ts";
import { scanSkills, watchDirs } from "../src/index.ts";

/** SKL-09: Codex plugin skills — cache discovery, activity gating, version-follow refs. */
const root = mkdtempSync(path.join(tmpdir(), "codex-plugin-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
afterEach(() => delete process.env.CODEX_HOME);

function makeHome(tag: string): string {
  const home = path.join(root, `home-${tag}`);
  mkdirSync(home, { recursive: true });
  return home;
}

function writePlugin(
  home: string,
  marketplace: string,
  plugin: string,
  version: string,
  skills: Record<string, string>,
): void {
  const versionDir = path.join(home, ".codex", "plugins", "cache", marketplace, plugin, version);
  mkdirSync(path.join(versionDir, ".codex-plugin"), { recursive: true });
  writeFileSync(
    path.join(versionDir, ".codex-plugin", "plugin.json"),
    JSON.stringify({ skills: "skills" }),
  );
  for (const [name, description] of Object.entries(skills)) {
    const dir = path.join(versionDir, "skills", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nbody`,
    );
  }
}

function activate(home: string, marketplace: string, plugin: string): void {
  writeFileSync(
    path.join(home, ".codex", "config.toml"),
    `[plugins."${plugin}@${marketplace}"]\nenabled = true\n`,
  );
}

describe("enumerateCodexPluginSkills", () => {
  it("lists active plugins' skills, ignores inactive ones, excludes Computer Use", () => {
    const home = makeHome("enum");
    writePlugin(home, "mkt", "toolbox", "1.2.0", {
      helper: "a helper",
      "computer-use": "excluded by product rule",
    });
    writePlugin(home, "mkt", "dormant", "1.0.0", { hidden: "inactive plugin" });
    activate(home, "mkt", "toolbox");

    const out = enumerateCodexPluginSkills(home);
    expect(out.items.map((i) => `${i.plugin}/${i.name}@${i.version}`)).toEqual([
      "toolbox/helper@1.2.0",
    ]);
    expect(out.items[0]!.relPath).toBe("helper");
    // frontmatter description rides along so the preview dialog can show it
    expect(out.items[0]!.description).toBe("a helper");
  });

  it("prefers local over semver, picks highest semver, and never falls back past a broken newest", () => {
    const home = makeHome("versions");
    writePlugin(home, "mkt", "versioned", "1.0.0", { old: "old" });
    writePlugin(home, "mkt", "versioned", "1.10.0", { newer: "newer" });
    activate(home, "mkt", "versioned");
    expect(enumerateCodexPluginSkills(home).items.map((i) => i.name)).toEqual(["newer"]);

    // `local` beats any semver
    writePlugin(home, "mkt", "versioned", "local", { dev: "local dev" });
    expect(enumerateCodexPluginSkills(home).items.map((i) => i.name)).toEqual(["dev"]);

    // a broken NEWEST version makes the plugin unavailable — no silent fallback
    const home2 = makeHome("broken");
    writePlugin(home2, "mkt", "fragile", "1.0.0", { fine: "works" });
    writePlugin(home2, "mkt", "fragile", "2.0.0", { unreachable: "broken manifest" });
    writeFileSync(
      path.join(
        home2,
        ".codex",
        "plugins",
        "cache",
        "mkt",
        "fragile",
        "2.0.0",
        ".codex-plugin",
        "plugin.json",
      ),
      "{not json",
    );
    activate(home2, "mkt", "fragile");
    const broken = enumerateCodexPluginSkills(home2);
    expect(broken.items).toEqual([]);
    expect(broken.warnings.some((w) => w.includes("fragile@mkt"))).toBe(true);
  });

  it("honors CODEX_HOME and the remote-install marker as an activity signal", () => {
    const home = makeHome("envhome");
    const altCodex = path.join(root, "alt-codex");
    process.env.CODEX_HOME = altCodex;
    const versionDir = path.join(altCodex, "plugins", "cache", "mkt", "marked", "3.0.0");
    mkdirSync(path.join(versionDir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(versionDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ skills: "skills" }),
    );
    const skillDir = path.join(versionDir, "skills", "marked-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: marked-skill\ndescription: d\n---\nbody",
    );
    // no config.toml — the marker alone activates
    writeFileSync(
      path.join(altCodex, "plugins", "cache", "mkt", "marked", ".codex-remote-plugin-install.json"),
      JSON.stringify({ installedAt: "2026-08-14" }),
    );

    const out = enumerateCodexPluginSkills(home);
    expect(out.items.map((i) => i.name)).toEqual(["marked-skill"]);
  });
});

describe("resolveCodexPluginSkillRefs", () => {
  it("resolves refs against the ACTIVE version and warns when a referenced skill vanished", () => {
    const home = makeHome("refs");
    writePlugin(home, "mkt", "toolbox", "1.0.0", { helper: "v1" });
    activate(home, "mkt", "toolbox");
    const ref = { marketplace: "mkt", plugin: "toolbox", relPath: "helper" };

    const v1 = resolveCodexPluginSkillRefs(home, [ref]);
    expect(v1.roots).toHaveLength(1);
    expect(v1.roots[0]).toContain("1.0.0");

    // version bump: the SAME ref now resolves into the new version (version-follow)
    writePlugin(home, "mkt", "toolbox", "2.0.0", { helper: "v2" });
    const v2 = resolveCodexPluginSkillRefs(home, [ref]);
    expect(v2.roots[0]).toContain("2.0.0");

    // a version that dropped the skill warns instead of silently vanishing
    writePlugin(home, "mkt", "toolbox", "3.0.0", { other: "no helper here" });
    const v3 = resolveCodexPluginSkillRefs(home, [ref]);
    expect(v3.roots).toEqual([]);
    expect(v3.warnings.some((w) => w.includes("no longer contains helper"))).toBe(true);
  });

  it("refuses a ref escaping the skills root and hides refs to inactive plugins", () => {
    const home = makeHome("refguard");
    writePlugin(home, "mkt", "toolbox", "1.0.0", { helper: "v1" });
    activate(home, "mkt", "toolbox");

    const escape = resolveCodexPluginSkillRefs(home, [
      { marketplace: "mkt", plugin: "toolbox", relPath: "../../../secrets" },
    ]);
    expect(escape.roots).toEqual([]);
    expect(escape.warnings.some((w) => w.includes("escapes"))).toBe(true);

    const inactive = resolveCodexPluginSkillRefs(home, [
      { marketplace: "mkt", plugin: "ghost", relPath: "helper" },
    ]);
    expect(inactive.roots).toEqual([]);
    expect(inactive.warnings.some((w) => w.includes("no longer active"))).toBe(true);
  });

  it("refuses a plugin dir that is a junction escaping the cache (Windows)", async () => {
    // Codex review (SKL-09): containment was only checked between versionDir and skillsRoot —
    // a junctioned IDENTITY ancestor made both external and the check vacuous. The resolver
    // must anchor containment at the cache root itself.
    if (process.platform !== "win32") return;
    const { spawnSync } = await import("node:child_process");
    const home = makeHome("junction");
    const outside = path.join(root, "outside-toolbox");
    const versionDir = path.join(outside, "1.0.0");
    mkdirSync(path.join(versionDir, ".codex-plugin"), { recursive: true });
    writeFileSync(
      path.join(versionDir, ".codex-plugin", "plugin.json"),
      JSON.stringify({ skills: "skills" }),
    );
    const skillDir = path.join(versionDir, "skills", "helper");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "---\nname: helper\ndescription: d\n---\nbody");
    const cacheMkt = path.join(home, ".codex", "plugins", "cache", "mkt");
    mkdirSync(cacheMkt, { recursive: true });
    const link = spawnSync("cmd", ["/c", "mklink", "/J", path.join(cacheMkt, "toolbox"), outside]);
    expect(link.status).toBe(0);
    activate(home, "mkt", "toolbox");

    const scan = enumerateCodexPluginSkills(home);
    expect(scan.items).toEqual([]);
    const refs = resolveCodexPluginSkillRefs(home, [
      { marketplace: "mkt", plugin: "toolbox", relPath: "helper" },
    ]);
    expect(refs.roots).toEqual([]);
  });

  it("version selection only accepts strict x.y.z names — '2oops.0.0' never wins", () => {
    const home = makeHome("strictver");
    writePlugin(home, "mkt", "toolbox", "1.10.0", { real: "real" });
    writePlugin(home, "mkt", "toolbox", "2oops.0.0", { fake: "parseInt would pick me" });
    activate(home, "mkt", "toolbox");
    expect(enumerateCodexPluginSkills(home).items.map((i) => i.name)).toEqual(["real"]);
  });

  it("accepts suffixed release versions (the real cache uses them) and picks deterministically", () => {
    // observed on a real machine: plugins/cache/openai-curated-remote/github/0.1.8-2841cf9749ae
    const home = makeHome("suffixver");
    writePlugin(home, "mkt", "gh", "0.1.8-2841cf9749ae", { suffixed: "real layout" });
    activate(home, "mkt", "gh");
    expect(enumerateCodexPluginSkills(home).items.map((i) => i.name)).toEqual(["suffixed"]);

    // a bare version beats a same-triple suffixed one (semver prerelease rule, conservative)
    writePlugin(home, "mkt", "gh", "0.1.8", { bare: "bare wins" });
    expect(enumerateCodexPluginSkills(home).items.map((i) => i.name)).toEqual(["bare"]);

    // a HIGHER suffixed version still beats a lower bare one
    writePlugin(home, "mkt", "gh", "0.2.0-abc", { newest: "suffixed but higher" });
    expect(enumerateCodexPluginSkills(home).items.map((i) => i.name)).toEqual(["newest"]);
  });

  it("astronomically large numeric components stay deterministic (no NaN comparator)", () => {
    // unit-level: a 320-digit dir name exceeds Windows MAX_PATH, so no fs fixture is possible.
    // Both majors overflow to Infinity; comparison must fall through to the patch component.
    const big = `${"9".repeat(320)}.0.0`;
    const bigger = `${"9".repeat(320)}.0.1`;
    expect(pickVersion([big, bigger])).toBe(bigger);
    expect(pickVersion([bigger, big])).toBe(bigger);
  });

  it("a NUL-bearing ref warns instead of throwing (fail closed, never a 500)", () => {
    const home = makeHome("nul");
    writePlugin(home, "mkt", "toolbox", "1.0.0", { helper: "v1" });
    activate(home, "mkt", "toolbox");
    const out = resolveCodexPluginSkillRefs(home, [
      { marketplace: "mkt\u0000", plugin: "toolbox", relPath: "helper" },
      { marketplace: "mkt", plugin: "toolbox", relPath: "hel\u0000per" },
    ]);
    expect(out.roots).toEqual([]);
    expect(out.warnings.length).toBeGreaterThan(0);
  });

  it("activity header matching tolerates TOML whitespace and refuses trailing garbage", () => {
    const home = makeHome("toml");
    writePlugin(home, "mkt", "toolbox", "1.0.0", { helper: "v1" });
    // valid TOML: whitespace around the dotted-key separator still activates
    writeFileSync(
      path.join(home, ".codex", "config.toml"),
      '[ plugins . "toolbox@mkt" ]\nenabled = true\n',
    );
    expect(enumerateCodexPluginSkills(home).items.map((i) => i.name)).toEqual(["helper"]);
    // invalid TOML: junk after the closing bracket must NOT activate
    writeFileSync(path.join(home, ".codex", "config.toml"), '[plugins."toolbox@mkt"]garbage\n');
    expect(enumerateCodexPluginSkills(home).items).toEqual([]);
    // TOML whitespace is spaces/tabs only — a header broken across lines is invalid
    writeFileSync(
      path.join(home, ".codex", "config.toml"),
      '[ plugins\n.\n"toolbox@mkt"\n]\nenabled = true\n',
    );
    expect(enumerateCodexPluginSkills(home).items).toEqual([]);
  });

  it("refuses marketplace/plugin identity components that are not plain dir names", () => {
    // marketplace/plugin are joined into cache paths — a stored ref must never be able to
    // point the resolver outside the plugin cache (re-assert at USE time, fail closed)
    const home = makeHome("unsafe");
    writePlugin(home, "mkt", "toolbox", "1.0.0", { helper: "v1" });
    activate(home, "mkt", "toolbox");
    for (const bad of [
      { marketplace: "..", plugin: "toolbox", relPath: "helper" },
      { marketplace: "mkt", plugin: "../toolbox", relPath: "helper" },
      { marketplace: "mkt\\evil", plugin: "toolbox", relPath: "helper" },
      { marketplace: "", plugin: "toolbox", relPath: "helper" },
    ]) {
      const out = resolveCodexPluginSkillRefs(home, [bad]);
      expect(out.roots).toEqual([]);
      expect(out.warnings.length).toBeGreaterThan(0);
    }
  });
});

describe("scanner integration", () => {
  it("surfaces resolved refs through scanSkills as read-only library entries, standard name wins", () => {
    const home = makeHome("scan");
    writePlugin(home, "mkt", "toolbox", "1.0.0", { helper: "plugin helper", clash: "loses" });
    activate(home, "mkt", "toolbox");
    // a standard-catalog skill with the same name as one plugin skill
    const catalog = path.join(home, ".agents", "skills", "clash");
    mkdirSync(catalog, { recursive: true });
    writeFileSync(path.join(catalog, "SKILL.md"), "---\nname: clash\ndescription: wins\n---\nbody");

    const { roots } = resolveCodexPluginSkillRefs(home, [
      { marketplace: "mkt", plugin: "toolbox", relPath: "helper" },
      { marketplace: "mkt", plugin: "toolbox", relPath: "clash" },
    ]);
    const skills = scanSkills({ home }, roots);
    const helper = skills.find((s) => s.name === "helper");
    expect(helper?.scope).toBe("library");
    expect(skills.find((s) => s.name === "clash")?.description).toBe("wins");
  });

  it("watches the codex config.toml so plugin activity flips refresh the catalog", () => {
    const home = makeHome("watch");
    expect(watchDirs({ home })).toContain(path.join(home, ".codex", "config.toml"));
  });
});
