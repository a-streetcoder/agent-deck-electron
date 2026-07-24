import { statSync } from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { watchDirs, type ResourceRoots } from "./paths.ts";

const watcherTargets = new WeakMap<FSWatcher, string[]>();

/** Compatibility helper retained for callers. Catalog setup never creates paths. */
export function ensureDirs(dirs: string[]): string[] {
  return dirs;
}

function isDirectory(dir: string): boolean {
  try {
    return statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

/** Chokidar does not reliably retain a watch for a missing deep leaf. Start at
 * the nearest existing directory instead; the ignored predicate below limits a
 * broad ancestor (normally HOME) to only catalog ancestors and descendants. */
function nearestExistingParent(target: string): string {
  let candidate = path.resolve(target);
  while (!isDirectory(candidate)) {
    const parent = path.dirname(candidate);
    if (parent === candidate) return candidate;
    candidate = parent;
  }
  return candidate;
}

function minimalRoots(targets: string[]): string[] {
  const candidates = [...new Set(targets.map(nearestExistingParent))].sort(
    (a, b) => a.length - b.length,
  );
  return candidates.filter(
    (candidate, index) =>
      !candidates.some(
        (other, otherIndex) =>
          otherIndex < index &&
          (candidate === other || candidate.startsWith(`${other}${path.sep}`)),
      ),
  );
}

function isRelevant(candidate: string, targets: string[]): boolean {
  const resolved = path.resolve(candidate);
  return targets.some(
    (target) =>
      resolved === target ||
      target.startsWith(`${resolved}${path.sep}`) ||
      resolved.startsWith(`${target}${path.sep}`),
  );
}

/**
 * Debounced resource watching. Coarse-grained by design: any change under a
 * resource directory triggers one callback; consumers re-scan.
 */
export function watchResources(
  roots: ResourceRoots,
  onChange: () => void,
  debounceMs = 250,
): FSWatcher {
  let timer: NodeJS.Timeout | null = null;
  const targets = watchDirs(roots).map((target) => path.resolve(target));
  const watcher = watch(minimalRoots(targets), {
    ignored: (candidate) => !isRelevant(candidate, targets),
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  watcherTargets.set(watcher, targets);
  watcher.on("all", () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  });
  return watcher;
}

/** Add exact persisted collection roots without creating them. */
export function addResourceWatchPaths(watcher: FSWatcher, paths: readonly string[]): void {
  const targets = watcherTargets.get(watcher);
  if (!targets) throw new Error("unknown resource watcher");
  const additions = paths
    .map((item) => path.resolve(item))
    .filter((item) => !targets.includes(item));
  if (additions.length === 0) return;
  targets.push(...additions);
  watcher.add(minimalRoots(additions));
}

export async function removeResourceWatchPaths(
  watcher: FSWatcher,
  paths: readonly string[],
): Promise<void> {
  const targets = watcherTargets.get(watcher);
  if (!targets) throw new Error("unknown resource watcher");
  const removals = new Set(paths.map((item) => path.resolve(item)));
  for (let index = targets.length - 1; index >= 0; index -= 1) {
    if (removals.has(targets[index]!)) targets.splice(index, 1);
  }
  await watcher.unwatch([...removals]);
}
