import { existsSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface SkillRepositoriesRootOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home: string;
}

/** Fixed native-compatible storage root. Injectable inputs are test seams only. */
export function skillRepositoriesRoot({
  platform = process.platform,
  env = process.env,
  home,
}: SkillRepositoriesRootOptions): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  let dataRoot: string;
  if (platform === "darwin") {
    dataRoot = pathApi.join(home, "Library", "Application Support");
  } else if (platform === "win32") {
    dataRoot = env.APPDATA?.trim() || pathApi.join(home, "AppData", "Roaming");
  } else {
    dataRoot = env.XDG_DATA_HOME?.trim() || pathApi.join(home, ".local", "share");
  }
  return pathApi.join(dataRoot, "Agent Deck", "SkillRepositories");
}

export function normalizeGitRemote(remote: string, baseDir = process.cwd()): string | undefined {
  const value = remote.trim();
  if (!value) return undefined;
  const stripPath = (input: string): string =>
    input
      .replace(/[\\/]+$/, "")
      .replace(/\.git$/i, "")
      .replace(/[\\/]+$/, "");

  try {
    const parsed = new URL(value);
    if (parsed.protocol === "file:") return stripPath(canonicalPath(fileURLToPath(parsed)));
    const host = parsed.host.toLowerCase();
    const repositoryPath = stripPath(parsed.pathname).replace(/^\/+/, "");
    if (!host || !repositoryPath) return undefined;
    // Repository identity is host + path, independent of common Git transport
    // spellings (HTTPS, ssh://, git://, and SCP syntax).
    return `network:${host}/${repositoryPath}`;
  } catch {
    // Continue with SCP-style or filesystem remotes.
  }

  const scp = /^(?:[^@/]+@)?([^:/\\]+):(.+)$/.exec(value);
  if (scp && !/^[A-Za-z]:[\\/]/.test(value)) {
    return `network:${scp[1]!.toLowerCase()}/${stripPath(scp[2]!).replace(/^\/+/, "")}`;
  }
  return stripPath(canonicalPath(path.resolve(baseDir, value)));
}

export function sanitizedRepositoryFolder(remoteUrl: string): string {
  const withoutSuffix = remoteUrl.replace(/[\\/]+$/, "").replace(/\.git$/i, "");
  const segments = withoutSuffix.split(/[\\/:]+/).filter(Boolean);
  const raw = segments.slice(-2).join("-") || "repository";
  const mapped = raw.replace(/[^A-Za-z0-9._-]/g, "-").replace(/-+/g, "-");
  return mapped.replace(/^[-.]+|[-.]+$/g, "") || "repository";
}

export function isPathInside(parent: string, child: string): boolean {
  const base = path.resolve(parent);
  const candidate = path.resolve(child);
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

/**
 * Canonicalize an existing path, or a missing path through its nearest existing
 * ancestor. The latter catches symlink escapes even when the final child has
 * not been created yet.
 */
export function canonicalPath(candidate: string): string {
  let existing = path.resolve(candidate);
  const missing: string[] = [];
  while (!existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missing.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalParent = existsSync(existing) ? realpathSync(existing) : existing;
  return path.resolve(canonicalParent, ...missing);
}

/** Returns the canonical candidate only when it is a safe child of the fixed root. */
export function resolveManagedPath(
  fixedRoot: string,
  candidate: string,
  options: { allowMissing?: boolean; allowRoot?: boolean } = {},
): string | undefined {
  if (!path.isAbsolute(candidate)) return undefined;
  const canonicalRoot = canonicalPath(fixedRoot);
  const canonicalCandidate = canonicalPath(candidate);
  if (!isPathInside(canonicalRoot, canonicalCandidate)) return undefined;
  if (!options.allowRoot && canonicalCandidate === canonicalRoot) return undefined;
  if (!options.allowMissing && !existsSync(candidate)) return undefined;
  return canonicalCandidate;
}

/** Resolve an existing skill root and reject an escaping SKILL.md symlink. */
export function resolveManagedSkillRoot(fixedRoot: string, candidate: string): string | undefined {
  const root = resolveManagedPath(fixedRoot, candidate);
  if (!root) return undefined;
  const manifest = resolveManagedPath(fixedRoot, path.join(root, "SKILL.md"));
  return manifest && isPathInside(root, manifest) ? root : undefined;
}
