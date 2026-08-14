import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";
import { piAgentHome, type ResourceRoots } from "./paths.ts";

/**
 * Package-provided skills (SKL-08): Pi's `settings.json → packages` names installed packages
 * whose `package.json → pi.skills` (or conventional `skills/`) directories contribute skills.
 * Native's `PiScanner.scanPackageSkills`, ported. Read-only source: nothing here is written.
 *
 * Reference resolution mirrors native: an absolute path is used as-is, `./`-style refs resolve
 * against the PROJECT root, and a bare npm name is tried against the platform's global
 * `node_modules` roots (Windows adds `%APPDATA%\npm\node_modules`, which native's macOS list
 * lacks; the unix roots are kept for cross-platform parity and simply don't exist elsewhere).
 */
export interface PackageSkillLocation {
  /** The catalog directory containing skill roots. */
  dir: string;
  /** The package reference that declared it, for provenance. */
  packageRef: string;
}

export interface PackageSkillScanResult {
  locations: PackageSkillLocation[];
  /** Human-readable notes: unresolvable refs, declared-but-missing skill paths, bad JSON. */
  warnings: string[];
}

function globalNodeModulesRoots(home: string): string[] {
  const roots: string[] = [];
  if (process.platform === "win32" && process.env.APPDATA) {
    roots.push(path.join(process.env.APPDATA, "npm", "node_modules"));
  }
  roots.push(
    path.join(home, ".npm-global", "lib", "node_modules"),
    path.join(home, "node_modules"),
    "/opt/homebrew/lib/node_modules",
    "/usr/local/lib/node_modules",
  );
  return roots;
}

/** Refs per settings file are BOUNDED: the scan runs on every skills refresh, and a
 * project-controlled list of thousands of refs would block the event loop (review, Codex). */
const MAX_PACKAGE_REFS = 50;

function readPackagesList(settingsFile: string, warnings: string[]): string[] {
  if (!existsSync(settingsFile)) return [];
  try {
    const parsed = JSON.parse(readFileSync(settingsFile, "utf8")) as { packages?: unknown };
    if (!Array.isArray(parsed.packages)) return [];
    const refs = parsed.packages.filter(
      (p): p is string => typeof p === "string" && p.trim() !== "",
    );
    if (refs.length > MAX_PACKAGE_REFS) {
      warnings.push(
        `${settingsFile} lists ${refs.length} packages; only the first ${MAX_PACKAGE_REFS} are scanned.`,
      );
      return refs.slice(0, MAX_PACKAGE_REFS);
    }
    return refs;
  } catch {
    warnings.push(`Couldn't read packages from ${settingsFile} (invalid JSON).`);
    return [];
  }
}

/** REAL-path containment: `child` must live inside `parent` after resolving symlinks and
 * junctions on BOTH sides — a lexical prefix check accepts `pkg-evil` for `pkg`, and a
 * symlinked skills dir would escape the package entirely (review, Codex). Fail closed on
 * unresolvable paths. Exported for per-FILE checks at package prompt read time. */
export function isRealpathContained(parent: string, child: string): boolean {
  return isContained(parent, child);
}

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

function resolvePackageRoot(
  ref: string,
  roots: ResourceRoots,
  warnings: string[],
): string | undefined {
  if (path.isAbsolute(ref)) return existsSync(ref) ? ref : undefined;
  if (ref.startsWith("./") || ref.startsWith("../")) {
    if (!roots.projectPath) {
      warnings.push(`Package ${ref} is project-relative, but no project is selected.`);
      return undefined;
    }
    const resolved = path.resolve(roots.projectPath, ref);
    return existsSync(resolved) ? resolved : undefined;
  }
  for (const nodeModules of globalNodeModulesRoots(roots.home)) {
    const candidate = path.join(nodeModules, ref);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** Skill catalog locations declared by a resolved package: `package.json → pi.skills`
 * (string or array of package-relative paths), else the conventional `skills/`. A DECLARED
 * path that is missing warns — the user configured it and should know it isn't working. */
function packageSkillDirs(pkgRoot: string, ref: string, warnings: string[]): string[] {
  let declared: string[] | undefined;
  const manifest = path.join(pkgRoot, "package.json");
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        pi?: { skills?: unknown };
      };
      const value = parsed.pi?.skills;
      if (typeof value === "string") declared = [value];
      else if (Array.isArray(value)) {
        declared = value.filter((v): v is string => typeof v === "string");
      }
    } catch {
      warnings.push(`Couldn't read ${manifest} (invalid JSON).`);
    }
  }
  const dirs: string[] = [];
  if (declared) {
    for (const rel of declared) {
      const dir = path.resolve(pkgRoot, rel);
      if (!existsSync(dir)) {
        warnings.push(`Package ${ref} declares skills at ${rel}, but that path was not found.`);
        continue;
      }
      // REAL-path containment: a declared path (or a symlink/junction inside it) must stay
      // inside its package after resolution — fail closed (review, Codex)
      if (!isContained(pkgRoot, dir)) {
        warnings.push(`Package ${ref} declares skills outside itself (${rel}) — ignored.`);
        continue;
      }
      dirs.push(dir);
    }
  } else {
    const conventional = path.join(pkgRoot, "skills");
    if (existsSync(conventional) && isContained(pkgRoot, conventional)) dirs.push(conventional);
  }
  return dirs;
}

/** Every configured package ref resolved to its on-disk root (global ∪ project),
 * with unresolvable refs warned about — shared by the skill and prompt scans. */
function resolvedPackageRoots(
  roots: ResourceRoots,
  warnings: string[],
): { ref: string; pkgRoot: string }[] {
  const refs = [
    ...readPackagesList(path.join(piAgentHome(roots), "settings.json"), warnings),
    ...(roots.projectPath
      ? readPackagesList(path.join(roots.projectPath, ".pi", "settings.json"), warnings)
      : []),
  ];
  const resolved: { ref: string; pkgRoot: string }[] = [];
  for (const ref of refs) {
    const pkgRoot = resolvePackageRoot(ref, roots, warnings);
    if (!pkgRoot) {
      if (!path.isAbsolute(ref) && !ref.startsWith("./") && !ref.startsWith("../")) {
        warnings.push(`Package ${ref} was not found in any global node_modules root.`);
      } else if (path.isAbsolute(ref)) {
        warnings.push(`Package path ${ref} was not found.`);
      }
      continue;
    }
    resolved.push({ ref, pkgRoot });
  }
  return resolved;
}

/** Dedupe by FILESYSTEM identity (realpath, case-folded on Windows) — the same catalog
 * through an alias would mint duplicate candidates (review, Codex). Unresolvable → skip. */
function fsIdentity(target: string): string | undefined {
  let identity: string;
  try {
    identity = realpathSync(target);
  } catch {
    return undefined;
  }
  return process.platform === "win32" ? identity.toLowerCase() : identity;
}

/** Resolve every configured package to its skill catalog locations (global ∪ project). */
export function scanPackageSkillLocations(roots: ResourceRoots): PackageSkillScanResult {
  const warnings: string[] = [];
  const locations: PackageSkillLocation[] = [];
  const seenDirs = new Set<string>();
  for (const { ref, pkgRoot } of resolvedPackageRoots(roots, warnings)) {
    for (const dir of packageSkillDirs(pkgRoot, ref, warnings)) {
      const identity = fsIdentity(dir);
      if (!identity || seenDirs.has(identity)) continue;
      seenDirs.add(identity);
      locations.push({ dir: path.resolve(dir), packageRef: ref });
    }
  }
  return { locations, warnings: [...new Set(warnings)] };
}

/**
 * Package-provided prompt templates (PRM-03), mirroring the skills shape:
 * `package.json → pi.prompts` (string or array; each entry a directory OR a single
 * `.md` file), else the conventional `prompts/` dir. Same containment + warning
 * posture as skills; native `resolvePackagePromptLocations`.
 */
export interface PackagePromptLocation {
  /** A prompt directory (`kind: "dir"`) or one `.md` template (`kind: "file"`). */
  target: string;
  kind: "dir" | "file";
  packageRef: string;
}

export interface PackagePromptScanResult {
  locations: PackagePromptLocation[];
  warnings: string[];
}

function packagePromptTargets(
  pkgRoot: string,
  ref: string,
  warnings: string[],
): { target: string; kind: "dir" | "file" }[] {
  let declared: string[] | undefined;
  const manifest = path.join(pkgRoot, "package.json");
  if (existsSync(manifest)) {
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
        pi?: { prompts?: unknown };
      };
      const value = parsed.pi?.prompts;
      if (typeof value === "string") declared = [value];
      else if (Array.isArray(value)) {
        declared = value.filter((v): v is string => typeof v === "string");
      }
    } catch {
      warnings.push(`Couldn't read ${manifest} (invalid JSON).`);
    }
  }
  const targets: { target: string; kind: "dir" | "file" }[] = [];
  if (declared) {
    for (const rel of declared) {
      const target = path.resolve(pkgRoot, rel);
      if (!existsSync(target)) {
        warnings.push(
          `Package ${ref} declares prompt templates at ${rel}, but that path was not found.`,
        );
        continue;
      }
      if (!isContained(pkgRoot, target)) {
        warnings.push(`Package ${ref} declares prompts outside itself (${rel}) — ignored.`);
        continue;
      }
      const kind = statSync(target).isDirectory() ? "dir" : "file";
      if (kind === "file" && !target.endsWith(".md")) continue; // native scans only .md files
      targets.push({ target, kind });
    }
  } else {
    const conventional = path.join(pkgRoot, "prompts");
    if (existsSync(conventional) && isContained(pkgRoot, conventional)) {
      targets.push({ target: conventional, kind: "dir" });
    }
  }
  return targets;
}

/** Resolve every configured package to its prompt template locations (global ∪ project). */
export function scanPackagePromptLocations(roots: ResourceRoots): PackagePromptScanResult {
  const warnings: string[] = [];
  const locations: PackagePromptLocation[] = [];
  const seen = new Set<string>();
  for (const { ref, pkgRoot } of resolvedPackageRoots(roots, warnings)) {
    for (const { target, kind } of packagePromptTargets(pkgRoot, ref, warnings)) {
      const identity = fsIdentity(target);
      if (!identity || seen.has(identity)) continue;
      seen.add(identity);
      locations.push({ target: path.resolve(target), kind, packageRef: ref });
    }
  }
  return { locations, warnings: [...new Set(warnings)] };
}

/** The raw pi-shaped skills found at package locations (name/description/filePath via the
 * pinned Pi loader — the same parser every other catalog uses). */
export function loadPackageSkillEntries(roots: ResourceRoots): {
  entries: ReturnType<typeof loadSkillsFromDir>["skills"];
  warnings: string[];
} {
  const { locations, warnings } = scanPackageSkillLocations(roots);
  const entries: ReturnType<typeof loadSkillsFromDir>["skills"] = [];
  for (const location of locations) {
    const result = loadSkillsFromDir({ dir: location.dir, source: "package" });
    entries.push(...result.skills);
  }
  return { entries, warnings };
}

/**
 * Package-provided EXTENSIONS (EXT-02), native discoverPackageExtensions:
 * `package.json → pi.extensions` (string list; each entry a `.ts` file or a
 * directory), else the conventional `extensions/` dir. A directory contributes
 * its own `index.ts` when present, else ONE child level (`.ts` files and
 * subdirectories holding an `index.ts`). Same containment + warning posture as
 * package skills/prompts.
 */
export interface PackageExtensionCandidate {
  /** The concrete launch source (`.ts` file). */
  path: string;
  packageRef: string;
}

export function scanPackageExtensionCandidates(roots: ResourceRoots): {
  candidates: PackageExtensionCandidate[];
  warnings: string[];
} {
  const warnings: string[] = [];
  const candidates: PackageExtensionCandidate[] = [];
  const seen = new Set<string>();
  const push = (target: string, ref: string): void => {
    const identity = fsIdentity(target);
    if (!identity || seen.has(identity)) return;
    seen.add(identity);
    candidates.push({ path: path.resolve(target), packageRef: ref });
  };
  const concreteSources = (location: string): string[] => {
    let stat;
    try {
      stat = statSync(location);
    } catch {
      return [];
    }
    if (stat.isFile()) return location.toLowerCase().endsWith(".ts") ? [location] : [];
    const isFile = (p: string): boolean => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    };
    const index = path.join(location, "index.ts");
    if (isFile(index)) return [index]; // a DIRECTORY named index.ts never counts (review, Codex)
    let children: string[];
    try {
      children = readdirSync(location);
    } catch {
      return [];
    }
    const sources: string[] = [];
    for (const child of children) {
      const childPath = path.join(location, child);
      try {
        const childStat = statSync(childPath);
        if (childStat.isDirectory()) {
          const childIndex = path.join(childPath, "index.ts");
          if (isFile(childIndex)) sources.push(childIndex);
        } else if (child.toLowerCase().endsWith(".ts")) {
          sources.push(childPath);
        }
      } catch {
        // unreadable child — skip
      }
    }
    return sources;
  };

  for (const { ref, pkgRoot } of resolvedPackageRoots(roots, warnings)) {
    let declared: string[] | undefined;
    const manifest = path.join(pkgRoot, "package.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          pi?: { extensions?: unknown };
        };
        const value = parsed.pi?.extensions;
        if (typeof value === "string") declared = [value];
        else if (Array.isArray(value)) {
          declared = value.filter((v): v is string => typeof v === "string");
        }
      } catch {
        warnings.push(`Couldn't read ${manifest} (invalid JSON).`);
      }
    }
    const locations: string[] = [];
    if (declared) {
      for (const rel of declared) {
        const target = path.resolve(pkgRoot, rel);
        if (!existsSync(target)) {
          warnings.push(
            `Package ${ref} declares extensions at ${rel}, but that path was not found.`,
          );
          continue;
        }
        if (!isContained(pkgRoot, target)) {
          warnings.push(`Package ${ref} declares extensions outside itself (${rel}) — ignored.`);
          continue;
        }
        locations.push(target);
      }
    } else {
      const conventional = path.join(pkgRoot, "extensions");
      if (existsSync(conventional) && isContained(pkgRoot, conventional)) {
        locations.push(conventional);
      }
    }
    for (const location of locations) {
      for (const source of concreteSources(location)) {
        // per-FILE containment: a symlinked child could still escape the package
        if (!isContained(pkgRoot, source)) {
          warnings.push(`Package ${ref} extension ${source} resolves outside itself — ignored.`);
          continue;
        }
        push(source, ref);
      }
    }
  }
  return { candidates, warnings: [...new Set(warnings)] };
}
