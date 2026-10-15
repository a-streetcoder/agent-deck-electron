// D8: the boot after a store quarantine finds the store file missing, not corrupt.
// A marker next to the renamed file keeps the startup reconcile from reading that
// absence as "every logged run was removed" until the store is written cleanly again.
import { existsSync, rmSync, writeFileSync } from "node:fs";

const markerPath = (storePath: string): string =>
  storePath.replace(/\.json$/, "") + ".quarantined.json";

/** Record that storePath was renamed aside to quarantinedTo. */
export function writeQuarantineMarker(storePath: string, quarantinedTo: string): void {
  writeFileSync(
    markerPath(storePath),
    `${JSON.stringify({ quarantinedAt: new Date().toISOString(), quarantinedTo })}\n`,
  );
}

/** True while a quarantine of storePath has not been followed by a clean write. */
export function hasQuarantineMarker(storePath: string): boolean {
  return existsSync(markerPath(storePath));
}

/** Called after every clean write of the store (cheap no-op when absent). */
export function clearQuarantineMarker(storePath: string): void {
  rmSync(markerPath(storePath), { force: true });
}
