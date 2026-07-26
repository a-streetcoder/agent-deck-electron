import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

/** Directories that are never useful in composer file suggestions. */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".turbo",
  "target",
  ".venv",
  "venv",
  "__pycache__",
  ".DS_Store",
  "coverage",
  ".pnpm",
]);

const DEFAULT_LIMIT = 500;

export interface ListProjectFilesOptions {
  limit?: number;
  signal?: AbortSignal;
}

interface RankedPath {
  path: string;
  category: number;
  position: number;
}

function compareRanked(left: RankedPath, right: RankedPath): number {
  if (left.category !== right.category) return left.category - right.category;
  if (left.position !== right.position) return left.position - right.position;
  if (left.path.length !== right.path.length) return left.path.length - right.path.length;
  return left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
}

function rankPath(relativePath: string, needle: string): RankedPath | null {
  const normalizedPath = relativePath.toLowerCase();
  const basename = path.posix.basename(normalizedPath);

  if (needle === "") return { path: relativePath, category: 3, position: 0 };
  if (basename === needle) return { path: relativePath, category: 0, position: 0 };
  if (basename.startsWith(needle)) return { path: relativePath, category: 1, position: 0 };

  const basenamePosition = basename.indexOf(needle);
  if (basenamePosition >= 0) {
    return { path: relativePath, category: 2, position: basenamePosition };
  }

  const pathPosition = normalizedPath.indexOf(needle);
  if (pathPosition >= 0) {
    return { path: relativePath, category: 3, position: pathPosition };
  }
  return null;
}

function retainBest(results: RankedPath[], candidate: RankedPath, limit: number): void {
  let low = 0;
  let high = results.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (compareRanked(results[middle]!, candidate) <= 0) low = middle + 1;
    else high = middle;
  }
  if (low >= limit) return;
  results.splice(low, 0, candidate);
  if (results.length > limit) results.pop();
}

function isWithinRoot(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/**
 * Return the best project-relative file paths under `root` after exhaustively
 * walking the eligible tree. The sequential depth-first walk retains traversal
 * depth rather than every visited directory, never follows symlink entries, and
 * keeps only the bounded top-K matches.
 */
export async function listProjectFiles(
  root: string,
  query = "",
  { limit = DEFAULT_LIMIT, signal }: ListProjectFilesOptions = {},
): Promise<string[]> {
  signal?.throwIfAborted();
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_LIMIT;
  if (boundedLimit === 0) return [];

  let canonicalRoot: string;
  try {
    canonicalRoot = await realpath(path.resolve(root));
  } catch {
    if (signal?.aborted) signal.throwIfAborted();
    return [];
  }
  signal?.throwIfAborted();

  const needle = query.trim().toLowerCase();
  const results: RankedPath[] = [];

  const walk = async (directory: string): Promise<void> => {
    signal?.throwIfAborted();
    let canonicalDirectory: string;
    try {
      // Re-resolve immediately before traversal. This closes ordinary root-link
      // and directory-swap escapes, though Node cannot provide an openat-style
      // kernel guarantee against a swap after this check.
      canonicalDirectory = await realpath(directory);
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      return;
    }
    signal?.throwIfAborted();
    if (!isWithinRoot(canonicalRoot, canonicalDirectory)) return;

    let entries;
    try {
      entries = await readdir(canonicalDirectory, { withFileTypes: true });
    } catch {
      if (signal?.aborted) signal.throwIfAborted();
      // Unreadable or raced directories do not invalidate the rest of a search.
      return;
    }
    signal?.throwIfAborted();

    for (const entry of entries) {
      signal?.throwIfAborted();
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name) || entry.isSymbolicLink())
        continue;

      const fullPath = path.resolve(canonicalDirectory, entry.name);
      if (!isWithinRoot(canonicalRoot, fullPath)) continue;

      if (entry.isDirectory()) {
        // Awaiting each child makes this depth-first without a retaining BFS queue.
        await walk(fullPath);
      } else if (entry.isFile()) {
        const relativeNative = path.relative(canonicalRoot, fullPath);
        if (!isWithinRoot(canonicalRoot, fullPath) || relativeNative === "") continue;
        const relativePath = relativeNative.split(path.sep).join("/");
        const ranked = rankPath(relativePath, needle);
        if (ranked) retainBest(results, ranked, boundedLimit);
      }
    }
  };

  await walk(canonicalRoot);
  signal?.throwIfAborted();
  return results.map((result) => result.path);
}
