import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ImportedSkillRepository } from "./persistence.ts";

export interface SkillRepositoriesRootOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home: string;
}

/** Historical platform path helper retained for compatibility tests. */
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

export class ManagedSkillRepositoryUnavailableError extends Error {
  readonly code = "MANAGED_SKILL_REPOSITORY_UNAVAILABLE";

  constructor(message = "The managed skill repository path is unsafe or no longer available.") {
    super(message);
    this.name = "ManagedSkillRepositoryUnavailableError";
  }
}

type RootIdentity = { realpath: string; dev: bigint | number; ino: bigint | number };

/**
 * Process-lifetime trust gate for collection-v1 storage. The server dataDir is
 * the trust anchor; its relocation is trusted, but a configured collection root
 * may only name its direct SkillRepositories child.
 */
export class ManagedSkillRepositories {
  readonly dataDir: string;
  readonly root: string;
  private readonly identity: RootIdentity;

  nativeIdentity(): { realpath: string; dev: string; ino: string } {
    return {
      realpath: this.identity.realpath,
      dev: this.identity.dev.toString(),
      ino: this.identity.ino.toString(),
    };
  }

  constructor(dataDir: string, configuredRoot = path.join(dataDir, "SkillRepositories")) {
    if (!path.isAbsolute(dataDir) || !path.isAbsolute(configuredRoot)) {
      throw new ManagedSkillRepositoryUnavailableError(
        "Managed repository paths must be absolute.",
      );
    }
    const lexicalDataDir = path.resolve(dataDir);
    mkdirSync(lexicalDataDir, { recursive: true });
    const dataStat = lstatSync(lexicalDataDir, { bigint: true });
    if (!dataStat.isDirectory() || dataStat.isSymbolicLink()) {
      throw new ManagedSkillRepositoryUnavailableError(
        "The trusted data directory is not a directory.",
      );
    }
    this.dataDir = realpathSync(lexicalDataDir);
    const required = path.resolve(configuredRoot);
    const configuredParent = path.dirname(required);
    const sameName =
      process.platform === "win32"
        ? path.basename(configuredRoot).toLowerCase() === "skillrepositories"
        : path.basename(configuredRoot) === "SkillRepositories";
    if (!sameName || !samePath(configuredParent, lexicalDataDir)) {
      throw new ManagedSkillRepositoryUnavailableError(
        "The managed repository root must be the direct SkillRepositories child of dataDir.",
      );
    }
    if (!existsSync(required)) mkdirSync(required);
    const rootLstat = lstatSync(required, { bigint: true });
    if (!rootLstat.isDirectory() || rootLstat.isSymbolicLink()) {
      throw new ManagedSkillRepositoryUnavailableError(
        "SkillRepositories must be a real directory.",
      );
    }
    this.root = required;
    const canonical = realpathSync(required);
    if (!samePath(path.dirname(canonical), this.dataDir)) {
      throw new ManagedSkillRepositoryUnavailableError(
        "SkillRepositories escaped the trusted data directory.",
      );
    }
    const rootStat = statSync(required, { bigint: true });
    this.identity = { realpath: canonical, dev: rootStat.dev, ino: rootStat.ino };
  }

  validateRoot(): void {
    let current;
    try {
      const lexical = lstatSync(this.root, { bigint: true });
      if (!lexical.isDirectory() || lexical.isSymbolicLink()) throw new Error("unsafe root");
      current = statSync(this.root, { bigint: true });
      if (
        !samePath(realpathSync(this.root), this.identity.realpath) ||
        current.dev !== this.identity.dev ||
        current.ino !== this.identity.ino
      ) {
        throw new Error("root identity changed");
      }
    } catch {
      throw new ManagedSkillRepositoryUnavailableError(
        "SkillRepositories changed after server startup. Restart after restoring the directory.",
      );
    }
  }

  validatePath(
    candidate: string,
    options: {
      allowMissing?: boolean;
      allowRoot?: boolean;
      directChild?: boolean;
      kind?: "directory" | "file";
    } = {},
  ): string {
    this.validateRoot();
    if (
      !path.isAbsolute(candidate) ||
      !isPathInside(this.root, candidate) ||
      (!options.allowRoot && samePath(this.root, candidate))
    ) {
      throw new ManagedSkillRepositoryUnavailableError();
    }
    if (samePath(this.root, candidate)) return this.root;
    const relative = path.relative(this.root, path.resolve(candidate));
    const components = relative.split(path.sep);
    if (options.directChild && components.length !== 1) {
      throw new ManagedSkillRepositoryUnavailableError("Managed clones must be direct children.");
    }
    let cursor = this.root;
    for (let index = 0; index < components.length; index += 1) {
      const component = components[index]!;
      if (!portableComponent(component)) throw new ManagedSkillRepositoryUnavailableError();
      cursor = path.join(cursor, component);
      try {
        const metadata = lstatSync(cursor);
        if (metadata.isSymbolicLink()) throw new Error("link");
        const final = index === components.length - 1;
        if (!final && !metadata.isDirectory()) throw new Error("non-directory component");
        if (final && options.kind === "directory" && !metadata.isDirectory())
          throw new Error("not directory");
        if (final && options.kind === "file" && !metadata.isFile()) throw new Error("not file");
        if (final && !options.kind && !metadata.isDirectory() && !metadata.isFile())
          throw new Error("special");
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" && options.allowMissing) break;
        throw new ManagedSkillRepositoryUnavailableError();
      }
    }
    const physical = canonicalPath(candidate);
    if (!isPathInside(this.identity.realpath, physical))
      throw new ManagedSkillRepositoryUnavailableError();
    this.validateRoot();
    return path.resolve(candidate);
  }

  validateRepository(candidate: string): string {
    const clone = this.validatePath(candidate, { directChild: true, kind: "directory" });
    this.validatePath(path.join(clone, ".git"), { kind: "directory" });
    this.validateTree(clone);
    this.validateRoot();
    return clone;
  }

  deriveSkillRoots(record: ImportedSkillRepository): string[] {
    const clone = this.validateRepository(record.clonePath);
    const relativeRoots =
      record.syncedSkillRelativePaths ?? record.selectedSkillRelativePaths ?? [];
    return relativeRoots.map((relative) => {
      if (path.isAbsolute(relative) || relative.split(/[\\/]/).includes("..")) {
        throw new ManagedSkillRepositoryUnavailableError(
          "A persisted selected skill path is unsafe.",
        );
      }
      const root = samePath(path.resolve(clone, relative), clone)
        ? clone
        : this.validatePath(path.resolve(clone, relative), { kind: "directory" });
      if (!isPathInside(clone, root)) throw new ManagedSkillRepositoryUnavailableError();
      this.validatePath(path.join(root, "SKILL.md"), { kind: "file" });
      return root;
    });
  }

  private validateTree(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const child = path.join(directory, entry.name);
      const metadata = lstatSync(child);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new ManagedSkillRepositoryUnavailableError(
          "Managed repositories cannot contain links or special entries.",
        );
      }
      if (metadata.isDirectory()) this.validateTree(child);
    }
  }
}

function samePath(left: string, right: string): boolean {
  return process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);
}

function portableComponent(component: string): boolean {
  if (!component || component === "." || component === ".." || component.includes("\0"))
    return false;
  if (
    process.platform === "win32" &&
    (component.includes(":") || component.endsWith(".") || component.endsWith(" "))
  )
    return false;
  return true;
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
  if (process.platform === "win32") {
    const foldedBase = base.toLowerCase();
    const foldedCandidate = candidate.toLowerCase();
    return foldedCandidate === foldedBase || foldedCandidate.startsWith(`${foldedBase}${path.sep}`);
  }
  return candidate === base || candidate.startsWith(`${base}${path.sep}`);
}

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

/** Legacy helpers retained for copy-based records and focused compatibility tests. */
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

export function resolveManagedSkillRoot(fixedRoot: string, candidate: string): string | undefined {
  const root = resolveManagedPath(fixedRoot, candidate);
  if (!root) return undefined;
  const manifest = resolveManagedPath(fixedRoot, path.join(root, "SKILL.md"));
  return manifest && isPathInside(root, manifest) ? root : undefined;
}
