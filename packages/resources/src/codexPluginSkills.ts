import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

/**
 * Codex plugin skills (SKL-09): skills shipped inside installed Codex plugins, discovered from
 * the plugin cache and referenced IN PLACE — never copied — so they follow Codex's active
 * plugin version automatically (native `CodexPluginSkillDiscovery`). Read-only source.
 *
 * Cache layout: `<codexHome>/plugins/cache/<marketplace>/<plugin>/<version>/`. A plugin is
 * ACTIVE when `config.toml` declares `[plugins."<plugin>@<marketplace>"]` or the plugin dir
 * carries a valid `.codex-remote-plugin-install.json` marker. Version selection mirrors
 * Codex's own store: `local` wins, else the highest semver; a malformed NEWEST version makes
 * the plugin unavailable — never a silent fallback to older cache data.
 */
export interface CodexPluginSkillItem {
  marketplace: string;
  plugin: string;
  version: string;
  /** Skill directory name (the display/dedup identity). */
  name: string;
  /** Frontmatter description, for preview display. */
  description?: string;
  /** Path of the skill root relative to the plugin's skills root — the persisted reference. */
  relPath: string;
}

export interface CodexPluginScanResult {
  items: CodexPluginSkillItem[];
  warnings: string[];
}

/** A persisted plugin-skill reference: resolved fresh on every scan so it version-follows. */
export interface CodexPluginSkillRef {
  marketplace: string;
  plugin: string;
  relPath: string;
}

export function codexHome(home: string): string {
  const env = process.env.CODEX_HOME?.trim();
  return env && env !== "" ? env : path.join(home, ".codex");
}

/** Native excludes Computer Use from plugin skill import by product rule. */
function isExcludedSkill(name: string): boolean {
  return /^computer[-_ ]?use$/i.test(name);
}

function isActivePlugin(codexRoot: string, marketplace: string, plugin: string): boolean {
  const config = path.join(codexRoot, "config.toml");
  if (existsSync(config)) {
    try {
      const text = readFileSync(config, "utf8");
      // targeted check for the exact table header — presence is all Codex's own store needs;
      // a full TOML dependency would be a heavyweight answer to a one-line question. TOML
      // allows spaces/tabs (never newlines) around the dotted-key separator; trailing
      // garbage after the bracket is invalid TOML and must NOT activate (review, Codex).
      const header = new RegExp(
        `^[ \\t]*\\[[ \\t]*plugins[ \\t]*\\.[ \\t]*["']${escapeRegExp(`${plugin}@${marketplace}`)}["'][ \\t]*\\][ \\t]*(?:#.*)?$`,
        "m",
      );
      if (header.test(text)) return true;
    } catch {
      // unreadable config: fall through to the marker check
    }
  }
  const marker = path.join(
    codexRoot,
    "plugins",
    "cache",
    marketplace,
    plugin,
    ".codex-remote-plugin-install.json",
  );
  if (!existsSync(marker)) return false;
  try {
    const parsed: unknown = JSON.parse(readFileSync(marker, "utf8"));
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A single plain directory name: no separators, no dot-navigation, non-empty. */
export function isPlainDirName(s: string): boolean {
  return s.length > 0 && s !== "." && s !== ".." && !/[\\/]/.test(s);
}

/**
 * `local` wins; else the highest `x.y.z` or `x.y.z-<suffix>` (a real cache uses hash-suffixed
 * release dirs, e.g. `0.1.8-2841cf9749ae`; anything else is ignored — parseInt alone would let
 * a junk dir like `2oops.0.0` win, review/Codex). On an equal numeric triple a bare version
 * beats a suffixed one (semver prerelease rule); two suffixes order lexically, descending.
 */
export function pickVersion(versions: string[]): string | undefined {
  if (versions.includes("local")) return "local";
  const semver = versions
    .map((v) => ({ v, m: /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v) }))
    .filter((x): x is { v: string; m: RegExpExecArray } => x.m !== null)
    .map(({ v, m }) => ({
      v,
      parts: [m[1]!, m[2]!, m[3]!].map((p) => Number.parseInt(p, 10)),
      suffix: m[4],
    }));
  semver.sort((a, b) => {
    for (let i = 0; i < 3; i++) {
      // boolean compare, not subtraction: overflowed components (Infinity) subtract to NaN
      if (a.parts[i]! !== b.parts[i]!) return b.parts[i]! > a.parts[i]! ? 1 : -1;
    }
    if ((a.suffix === undefined) !== (b.suffix === undefined))
      return a.suffix === undefined ? -1 : 1;
    return (b.suffix ?? "") < (a.suffix ?? "") ? -1 : (b.suffix ?? "") > (a.suffix ?? "") ? 1 : 0;
  });
  return semver[0]?.v;
}

/** REAL-path containment (same posture as packageSkills): fail closed on unresolvable paths. */
function isContained(parent: string, child: string): boolean {
  let realParent: string;
  let realChild: string;
  try {
    realParent = realpathSync(parent);
    realChild = realpathSync(child);
  } catch {
    return false;
  }
  const rel = path.relative(realParent, realChild);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function listDirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

/** The ACTIVE version's skills root for one plugin, or a warning why it is unavailable. */
function resolveSkillsRoot(
  codexRoot: string,
  marketplace: string,
  plugin: string,
): { skillsRoot: string; version: string } | { warning: string } {
  const pluginDir = path.join(codexRoot, "plugins", "cache", marketplace, plugin);
  const version = pickVersion(listDirs(pluginDir));
  if (!version) return { warning: `Codex plugin ${plugin}@${marketplace} has no usable version.` };
  const versionDir = path.join(pluginDir, version);
  // anchor containment at the CACHE root: a junctioned identity ancestor makes every
  // descendant-relative check vacuous because both sides resolve outside (review, Codex)
  if (!isContained(path.join(codexRoot, "plugins", "cache"), versionDir)) {
    return {
      warning: `Codex plugin ${plugin}@${marketplace} ${version} resolves outside the plugin cache.`,
    };
  }
  const manifest = path.join(versionDir, ".codex-plugin", "plugin.json");
  let skillsRel: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { skills?: unknown };
    if (typeof parsed.skills === "string" && parsed.skills.trim() !== "") {
      skillsRel = parsed.skills;
    }
  } catch {
    // fallthrough to the unavailable warning — a malformed NEWEST version never falls back
  }
  if (!skillsRel) {
    return {
      warning: `Codex plugin ${plugin}@${marketplace} ${version} has no valid plugin.json skills entry.`,
    };
  }
  const skillsRoot = path.resolve(versionDir, skillsRel);
  if (!existsSync(skillsRoot) || !isContained(versionDir, skillsRoot)) {
    return {
      warning: `Codex plugin ${plugin}@${marketplace} ${version} declares skills outside its version dir.`,
    };
  }
  return { skillsRoot, version };
}

/** Every ACTIVE plugin's skills, enumerated for the known-sources scan. */
export function enumerateCodexPluginSkills(home: string): CodexPluginScanResult {
  const warnings: string[] = [];
  const items: CodexPluginSkillItem[] = [];
  const codexRoot = codexHome(home);
  const cache = path.join(codexRoot, "plugins", "cache");
  for (const marketplace of listDirs(cache)) {
    for (const plugin of listDirs(path.join(cache, marketplace))) {
      if (!isActivePlugin(codexRoot, marketplace, plugin)) continue;
      const resolved = resolveSkillsRoot(codexRoot, marketplace, plugin);
      if ("warning" in resolved) {
        warnings.push(resolved.warning);
        continue;
      }
      const found = loadSkillsFromDir({ dir: resolved.skillsRoot, source: "library" });
      for (const skill of found.skills) {
        const name = path.basename(skill.baseDir);
        if (isExcludedSkill(name)) continue; // product rule (native excludes Computer Use)
        const relPath = path.relative(resolved.skillsRoot, skill.baseDir);
        if (relPath.startsWith("..") || path.isAbsolute(relPath)) continue; // fail closed
        items.push({
          marketplace,
          plugin,
          version: resolved.version,
          name,
          description: skill.description,
          relPath,
        });
      }
    }
  }
  return { items, warnings: [...new Set(warnings)] };
}

/** Resolve persisted references against the CURRENT active versions — the reference is what
 * makes plugin skills version-follow instead of going stale as copies. A reference whose
 * skill vanished in the active version warns rather than silently disappearing. */
export function resolveCodexPluginSkillRefs(
  home: string,
  refs: readonly CodexPluginSkillRef[],
): { roots: string[]; warnings: string[] } {
  const warnings: string[] = [];
  const roots: string[] = [];
  const codexRoot = codexHome(home);
  for (const ref of refs) {
    // marketplace/plugin are path components under the cache: a stored ref must never be
    // able to steer the resolver outside it (re-assert at USE time, fail closed)
    if (!isPlainDirName(ref.marketplace) || !isPlainDirName(ref.plugin)) {
      warnings.push(
        `Codex plugin reference ${ref.plugin}@${ref.marketplace} has an invalid identity — ignored.`,
      );
      continue;
    }
    if (!isActivePlugin(codexRoot, ref.marketplace, ref.plugin)) {
      warnings.push(
        `Codex plugin ${ref.plugin}@${ref.marketplace} is no longer active; its referenced skills are hidden.`,
      );
      continue;
    }
    const resolved = resolveSkillsRoot(codexRoot, ref.marketplace, ref.plugin);
    if ("warning" in resolved) {
      warnings.push(resolved.warning);
      continue;
    }
    const dir = path.resolve(resolved.skillsRoot, ref.relPath);
    // LEXICAL guard first (works for nonexistent paths), then existence, then REALPATH
    // containment for symlink escapes of existing dirs — ordering matters: realpath throws
    // on a vanished dir and would misreport it as an escape
    const lexical = path.relative(resolved.skillsRoot, dir);
    if (lexical.startsWith("..") || path.isAbsolute(lexical)) {
      warnings.push(
        `Codex plugin reference ${ref.plugin}@${ref.marketplace}/${ref.relPath} escapes its skills root — ignored.`,
      );
      continue;
    }
    if (!existsSync(path.join(dir, "SKILL.md"))) {
      warnings.push(
        `Codex plugin ${ref.plugin}@${ref.marketplace} (${resolved.version}) no longer contains ${ref.relPath}.`,
      );
      continue;
    }
    if (!isContained(resolved.skillsRoot, dir)) {
      warnings.push(
        `Codex plugin reference ${ref.plugin}@${ref.marketplace}/${ref.relPath} escapes its skills root — ignored.`,
      );
      continue;
    }
    roots.push(dir);
  }
  return { roots, warnings: [...new Set(warnings)] };
}
