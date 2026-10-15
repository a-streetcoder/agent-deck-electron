import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";

/**
 * Folders the CLI entry creates when missing. The server image puts HOME inside
 * the data volume (/data/home), and an existing volume or bind mount gets no
 * first-mount copy of it; AGENT_DECK_PROJECT_ROOT (/data/projects in the
 * Compose setup) must exist for the folder browser and repository clones.
 * Failures are warnings: the server still starts, and the routes report it.
 */
export function ensureStartupDirs(
  home: string,
  env: NodeJS.ProcessEnv,
  warn: (message: string, error: unknown) => void = console.warn,
): void {
  const projectRoot = env.AGENT_DECK_PROJECT_ROOT?.trim();
  const dirs: Array<[string, string, number | undefined]> = [["home", home, 0o700]];
  if (projectRoot) dirs.push(["project root", path.resolve(projectRoot), undefined]);
  for (const [label, dir, mode] of dirs) {
    if (existsSync(dir)) continue;
    try {
      mkdirSync(dir, { recursive: true, mode });
    } catch (error) {
      warn(`Could not create the ${label} directory ${dir}:`, error);
    }
  }
}
