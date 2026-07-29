import { lstatSync, mkdirSync, realpathSync } from "node:fs";
import path from "node:path";

/**
 * Resolve agent-deck's application data directory to ONE authoritative physical path — the trust
 * anchor every app-data service is rooted on (sessions, session images, memory, worktrees,
 * settings, loops). Creates it if missing, REJECTS a symlinked / reparse-point data root (so a
 * linked dataDir can't silently redirect all app data outside the intended location), and
 * realpath-resolves ancestor links.
 *
 * Extracted from the retired `ManagedSkillRepositories` (ADR-0002 P4). This was always a HOST
 * concern — the skill engine works off `home` (`~/.agents/skills`), never agent-deck's dataDir —
 * so it stays here rather than moving into the shared engine.
 */
export function resolveTrustedDataDir(dataDir: string): string {
  if (!path.isAbsolute(dataDir)) {
    throw new Error("The trusted data directory must be an absolute path.");
  }
  const lexical = path.resolve(dataDir);
  mkdirSync(lexical, { recursive: true });
  const stat = lstatSync(lexical);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error("The trusted data directory is not a directory.");
  }
  return realpathSync(lexical);
}
