import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResourceScope } from "@agent-deck/domain";

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

/**
 * Every location scanned for resources, per
 * https://github.com/a-streetcoder/agent-deck/blob/main/agent-deck-documentation/reference/file-locations.md. `home` is injectable
 * for hermetic tests.
 */

export interface ResourceRoots {
  home: string;
  /** Current project root, when a project is selected. */
  projectPath?: string;
}

export function defaultRoots(projectPath?: string): ResourceRoots {
  return { home: homedir(), projectPath };
}

export function piAgentHome(roots: ResourceRoots): string {
  return path.join(roots.home, ".pi", "agent");
}

/**
 * The active APPEND_SYSTEM.md pi would auto-discover, with pi's precedence:
 * project `<project>/.pi/APPEND_SYSTEM.md`, else global
 * `~/.pi/agent/APPEND_SYSTEM.md` (agent-deck-system-prompt-logic.md). Because
 * any explicit --append-system-prompt suppresses pi's automatic discovery, the
 * launch flow must re-add this path ahead of Agent Deck's own appends so the
 * file is still honored. Not ancestor-walked. Returns undefined if neither
 * file exists.
 */
export function appendSystemPromptPath(roots: ResourceRoots): string | undefined {
  const candidates = [
    roots.projectPath ? path.join(roots.projectPath, ".pi", "APPEND_SYSTEM.md") : undefined,
    path.join(piAgentHome(roots), "APPEND_SYSTEM.md"),
  ];
  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Packaged builds copy immutable built-ins outside app.asar and provide their
 * explicit resource path. Source/test runs retain the package-relative path.
 */
export const BUILTIN_AGENTS_DIR =
  process.env.AGENT_DECK_BUILTIN_AGENTS_DIR?.trim() ||
  fileURLToPath(new URL("../builtin-agents", import.meta.url));

export interface AgentCatalogDir {
  dir: string;
  scope: ResourceScope;
  /** Legacy locations are scanned and watched without ever being auto-created. */
  legacy?: boolean;
}

export function agentCatalogDirs(roots: ResourceRoots): AgentCatalogDir[] {
  return [
    // Native resolves the legacy global catalog before the modern one, so scan
    // it first. Merely describing this path must never create it.
    { dir: path.join(roots.home, ".agents"), scope: "global", legacy: true },
    { dir: path.join(piAgentHome(roots), "agents"), scope: "global" },
    { dir: path.join(piAgentHome(roots), "agent-library", "agents"), scope: "library" },
    { dir: BUILTIN_AGENTS_DIR, scope: "builtin" },
  ];
}

export interface SkillCatalogDir {
  dir: string;
  scope: ResourceScope;
  /** A compatibility catalog that must not be created by discovery/watching. */
  legacy?: boolean;
}

export function skillCatalogDirs(roots: ResourceRoots): SkillCatalogDir[] {
  return [
    { dir: path.join(piAgentHome(roots), "skills"), scope: "global" },
    { dir: path.join(roots.home, ".agents", "skills"), scope: "global", legacy: true },
  ];
}

export interface ExtensionCatalogDir {
  dir: string;
  scope: ResourceScope;
}

/** The standard pi extension locations to DISCOVER user extensions in: the
 *  global ~/.pi/agent/extensions and the project's .pi/extensions. (App-generated
 *  bridge extensions live elsewhere and are never scanned, so a user can't see or
 *  disable them here.) */
export function extensionCatalogDirs(roots: ResourceRoots): ExtensionCatalogDir[] {
  const dirs: ExtensionCatalogDir[] = [
    { dir: path.join(piAgentHome(roots), "extensions"), scope: "global" },
  ];
  if (roots.projectPath) {
    dirs.push({ dir: path.join(roots.projectPath, ".pi", "extensions"), scope: "project" });
  }
  return dirs;
}

export interface PromptCatalogDir {
  dir: string;
  scope: ResourceScope;
}

/** Prompt-template catalog dirs — single .md files, pi's `/prompt:<name>`. */
export function promptCatalogDirs(roots: ResourceRoots): PromptCatalogDir[] {
  return [
    { dir: path.join(piAgentHome(roots), "prompts"), scope: "global" },
    { dir: path.join(piAgentHome(roots), "prompt-library"), scope: "library" },
  ];
}

/**
 * Directories the file watcher observes. Builtins never change; missing targets
 * are passed to chokidar so their later creation is observed without creating them.
 */
export function watchDirs(roots: ResourceRoots): string[] {
  return [
    ...agentCatalogDirs(roots)
      .filter((d) => d.scope !== "builtin")
      .map((d) => d.dir),
    ...skillCatalogDirs(roots).map((d) => d.dir),
    ...promptCatalogDirs(roots).map((d) => d.dir),
  ];
}

/** Native refresh watching has no project resource catalog directories. */
export function projectWatchDirs(_projectPath: string): string[] {
  return [];
}
