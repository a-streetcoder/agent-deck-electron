import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * SBX-09: the `packages` a Pi agent dir's settings.json declares. Pi 1.2
 * resolves them at every launch and installs a missing one into
 * `<agentDir>/npm`, which a sandboxed session cannot write (EROFS kills the
 * launch before Pi responds). Names only; an unreadable file declares nothing.
 */
export function declaredPiPackages(agentDir: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(path.join(agentDir, "settings.json"), "utf8")) as {
      packages?: unknown;
    };
    return Array.isArray(parsed.packages)
      ? parsed.packages
          .map((entry) =>
            typeof entry === "string"
              ? entry
              : String((entry as { source?: unknown })?.source ?? ""),
          )
          .filter((name) => name.length > 0)
      : [];
  } catch {
    return [];
  }
}
