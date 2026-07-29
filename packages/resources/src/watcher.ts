import { realpathSync, statSync } from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { watchDirs, type ResourceRoots } from "./paths.ts";

interface WatchTarget {
  path: string;
  canonicalBoundary: string;
  watchPath: string;
}

interface WatchState {
  targets: WatchTarget[];
  roots: Set<string>;
  releasedRoots: Set<string>;
}

const watcherStates = new WeakMap<FSWatcher, WatchState>();
const RESOURCE_RECOVERY_PREFIX = ".agent-deck-resource-recovery-v1-";

function isRecoveryWrapperName(name: string): boolean {
  if (!name.startsWith(RESOURCE_RECOVERY_PREFIX)) return false;
  const suffix = name.slice(RESOURCE_RECOVERY_PREFIX.length);
  const separator = suffix.indexOf("-");
  if (separator < 1) return false;
  const length = Number(suffix.slice(0, separator));
  const remainder = suffix.slice(separator + 1);
  const skillName = remainder.slice(0, length);
  return (
    Number.isSafeInteger(length) &&
    length > 0 &&
    remainder[length] === "-" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(skillName) &&
    /^[0-9a-f]{32}$/i.test(remainder.slice(length + 1))
  );
}

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

export function isWatchPathContained(boundary: string, candidate: string, pathApi = path): boolean {
  const relative = pathApi.relative(boundary, candidate);
  return (
    relative === "" ||
    (!pathApi.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${pathApi.sep}`))
  );
}

function makeWatchTarget(target: string, boundary: string): WatchTarget | null {
  const resolvedPath = path.resolve(target);
  const resolvedBoundary = path.resolve(boundary);
  if (!isWatchPathContained(resolvedBoundary, resolvedPath) || !isDirectory(resolvedBoundary)) {
    return null;
  }
  try {
    const canonicalBoundary = realpathSync.native(resolvedBoundary);
    return {
      path: resolvedPath,
      // The configured home/project root itself is trusted and may intentionally
      // be an alias. Descendant links still have to remain inside this physical root.
      canonicalBoundary,
      watchPath: path.resolve(canonicalBoundary, path.relative(resolvedBoundary, resolvedPath)),
    };
  } catch {
    return null;
  }
}

function canonicalNearestExisting(candidate: string, boundary: string): string | null {
  let current = path.resolve(candidate);
  while (isWatchPathContained(boundary, current)) {
    try {
      return realpathSync.native(current);
    } catch {
      if (current === boundary) return null;
      current = path.dirname(current);
    }
  }
  return null;
}

function isPhysicallyContained(candidate: string, target: WatchTarget): boolean {
  const canonical = canonicalNearestExisting(candidate, target.canonicalBoundary);
  return canonical !== null && isWatchPathContained(target.canonicalBoundary, canonical);
}

/** Chokidar does not reliably retain a watch for a missing deep leaf. Start at
 * the nearest physically-contained existing directory instead. If a catalog
 * ancestor links outside its trusted home/project root, climb above the link so
 * Chokidar encounters it as a leaf and never opens the destination. */
function nearestExistingParent(target: WatchTarget): string | null {
  let candidate = target.watchPath;
  while (isWatchPathContained(target.canonicalBoundary, candidate)) {
    if (isDirectory(candidate) && isPhysicallyContained(candidate, target)) return candidate;
    if (candidate === target.canonicalBoundary) return null;
    candidate = path.dirname(candidate);
  }
  return null;
}

function minimalRoots(targets: WatchTarget[]): string[] {
  const candidates = [
    ...new Set(targets.map(nearestExistingParent).filter((item): item is string => item !== null)),
  ].sort((a, b) => a.length - b.length);
  return candidates.filter(
    (candidate, index) =>
      !candidates.some(
        (other, otherIndex) => otherIndex < index && isWatchPathContained(other, candidate),
      ),
  );
}

function isLexicallyRelevant(candidate: string, target: WatchTarget): boolean {
  const resolved = path.resolve(candidate);
  const relative = path.relative(target.watchPath, resolved);
  if (
    relative !== "" &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== ".." &&
    isRecoveryWrapperName(relative.split(path.sep)[0]!)
  ) {
    return false;
  }
  return (
    resolved === target.watchPath ||
    isWatchPathContained(resolved, target.watchPath) ||
    isWatchPathContained(target.watchPath, resolved)
  );
}

function isRelevant(candidate: string, targets: WatchTarget[]): boolean {
  return targets.some(
    (target) => isLexicallyRelevant(candidate, target) && isPhysicallyContained(candidate, target),
  );
}

/** Watch ancestors must remain traversable so missing targets can appear later,
 * but an ancestor metadata event is not itself a resource change. Only an exact
 * target or one of its descendants schedules the authoritative rescan. */
function isChangedTarget(candidate: string, targets: WatchTarget[]): boolean {
  const resolved = path.resolve(candidate);
  return targets.some(
    (target) =>
      isWatchPathContained(target.watchPath, resolved) && isPhysicallyContained(candidate, target),
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
  const homeBoundary = path.resolve(roots.home);
  const projectBoundary = roots.projectPath ? path.resolve(roots.projectPath) : null;
  const targets = watchDirs(roots)
    .map((target) => {
      const resolved = path.resolve(target);
      const boundary =
        projectBoundary && isWatchPathContained(projectBoundary, resolved)
          ? projectBoundary
          : homeBoundary;
      return makeWatchTarget(resolved, boundary);
    })
    .filter((target): target is WatchTarget => target !== null);
  const rootsToWatch = minimalRoots(targets);
  const watcher = watch(rootsToWatch, {
    ignored: (candidate) => !isRelevant(candidate, targets),
    ignoreInitial: true,
    // Chokidar defaults to following links. Resource catalogs are untrusted
    // mutable trees: links are observable leaf entries, never recursive roots.
    followSymlinks: false,
    // On Windows, native fs.watch (ReadDirectoryChangesW) holds an open handle
    // on every watched directory, opened WITHOUT FILE_SHARE_DELETE. That handle
    // blocks the atomic catalog replace — renaming a watched skill directory
    // fails with ACCESS_DENIED. Polling uses stat() and holds no directory
    // handle, so the descriptor-relative rename in the native module succeeds.
    // The resource catalog is small (skills/loops/prompts), so polling cost is
    // negligible. POSIX keeps native watching (inotify/FSEvents don't lock).
    usePolling: process.platform === "win32",
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
  });
  watcherStates.set(watcher, {
    targets,
    roots: new Set(rootsToWatch),
    releasedRoots: new Set(),
  });
  const scheduleRescan = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(onChange, debounceMs);
  };
  watcher.on("all", (_event, candidate) => {
    if (isChangedTarget(candidate, targets)) scheduleRescan();
  });
  // Watch errors—including transient file↔directory races—may mean an event
  // was missed. Always schedule the same debounced authoritative rescan.
  watcher.on("error", scheduleRescan);
  const close = watcher.close.bind(watcher);
  watcher.close = async (): Promise<void> => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    await close();
  };
  return watcher;
}

/** Add paths inside an explicit trusted home/project/collection boundary. */
export function addResourceWatchPaths(
  watcher: FSWatcher,
  paths: readonly string[],
  containmentRoot: string,
): void {
  const state = watcherStates.get(watcher);
  if (!state) throw new Error("unknown resource watcher");
  const boundary = path.resolve(containmentRoot);
  const additions = paths
    .map((item) => makeWatchTarget(item, boundary))
    .filter((item): item is WatchTarget => item !== null)
    .filter((item) => !state.targets.some((target) => target.path === item.path));
  if (additions.length === 0) return;
  const rootsToAdd = [
    ...new Set([
      ...minimalRoots(additions),
      ...[...state.releasedRoots].filter((root) =>
        additions.some(
          (target) =>
            isWatchPathContained(root, target.watchPath) ||
            isWatchPathContained(target.watchPath, root),
        ),
      ),
    ]),
  ];
  state.targets.push(...additions);
  for (const root of rootsToAdd) {
    state.releasedRoots.delete(root);
    state.roots.add(root);
  }
  watcher.add(rootsToAdd);
}

export async function removeResourceWatchPaths(
  watcher: FSWatcher,
  paths: readonly string[],
): Promise<void> {
  const state = watcherStates.get(watcher);
  if (!state) throw new Error("unknown resource watcher");
  const removals = new Set(paths.map((item) => path.resolve(item)));
  for (let index = state.targets.length - 1; index >= 0; index -= 1) {
    const target = state.targets[index]!;
    if (removals.has(target.path)) {
      state.targets.splice(index, 1);
    }
  }
  const rootsToRelease = [...state.roots].filter(
    (root) =>
      !state.targets.some(
        (target) =>
          isWatchPathContained(root, target.watchPath) ||
          isWatchPathContained(target.watchPath, root),
      ),
  );
  for (const root of rootsToRelease) {
    state.roots.delete(root);
    state.releasedRoots.add(root);
  }
  await watcher.unwatch(rootsToRelease);
}
