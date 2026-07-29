import { statSync } from "node:fs";
import path from "node:path";
import { watch, type FSWatcher } from "chokidar";
import { watchDirs, type ResourceRoots } from "./paths.ts";

const watcherTargets = new WeakMap<FSWatcher, string[]>();
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
  return targets.some((target) => {
    const relative = path.relative(target, resolved);
    if (
      relative !== "" &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      isRecoveryWrapperName(relative.split(path.sep)[0]!)
    ) {
      return false;
    }
    return (
      resolved === target ||
      target.startsWith(`${resolved}${path.sep}`) ||
      resolved.startsWith(`${target}${path.sep}`)
    );
  });
}

/** Watch ancestors must remain traversable so missing targets can appear later,
 * but an ancestor metadata event is not itself a resource change. Only an exact
 * target or one of its descendants schedules the authoritative rescan. */
function isChangedTarget(candidate: string, targets: string[]): boolean {
  const resolved = path.resolve(candidate);
  return targets.some(
    (target) => resolved === target || resolved.startsWith(`${target}${path.sep}`),
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
  watcherTargets.set(watcher, targets);
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
