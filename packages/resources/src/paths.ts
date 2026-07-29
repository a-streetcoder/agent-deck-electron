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
  const dirs: AgentCatalogDir[] = [];
  // A selected project's agents (`<project>/.pi/agents`) come first so a project
  // agent shadows a same-named global one — native parity, restored.
  if (roots.projectPath) {
    dirs.push({ dir: path.join(roots.projectPath, ".pi", "agents"), scope: "project" });
  }
  // Native resolves the legacy global catalog before the modern one, so scan it
  // first. Merely describing these paths must never create them.
  dirs.push({ dir: path.join(roots.home, ".agents"), scope: "global", legacy: true });
  dirs.push({ dir: path.join(piAgentHome(roots), "agents"), scope: "global" });
  dirs.push({ dir: path.join(piAgentHome(roots), "agent-library", "agents"), scope: "library" });
  dirs.push({ dir: BUILTIN_AGENTS_DIR, scope: "builtin" });
  return dirs;
}

export interface SkillCatalogDir {
  dir: string;
  scope: ResourceScope;
  /** A compatibility catalog that must not be created by discovery/watching. */
  legacy?: boolean;
}

export function skillCatalogDirs(roots: ResourceRoots): SkillCatalogDir[] {
  const dirs: SkillCatalogDir[] = [];
  // A selected project's skills come FIRST so a project skill shadows a same-named global
  // one — native parity (agent-deck's `.project` scope). Within project scope, canonical
  // `<project>/.agents/skills` — where the shared engine MATERIALIZES project skills —
  // ranks above the legacy `<project>/.pi/skills`, matching the engine's `default_catalogs`
  // (Syncr `skill-engine/src/store.rs`) and pi's own ancestor discovery. agent-deck MUST
  // read `.agents/skills` here: a project skill it just authored through the engine lands
  // there, and project fan-out does NOT bridge it to `.pi/skills` (that tool path is
  // global-only), so without this entry a freshly-created project skill is invisible.
  // (Global stays `.pi/agent/skills` first — there fan-out DOES bridge and both readers
  // already agree; ranking `.agents` above `.pi` globally is a separate lockstep change.)
  if (roots.projectPath) {
    dirs.push({ dir: path.join(roots.projectPath, ".agents", "skills"), scope: "project" });
    dirs.push({ dir: path.join(roots.projectPath, ".pi", "skills"), scope: "project" });
  }
  dirs.push({ dir: path.join(piAgentHome(roots), "skills"), scope: "global" });
  dirs.push({ dir: path.join(roots.home, ".agents", "skills"), scope: "global", legacy: true });
  return dirs;
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
  const dirs: PromptCatalogDir[] = [];
  // A selected project's prompts (`<project>/.pi/prompts`) come first — native
  // parity, restored.
  if (roots.projectPath) {
    dirs.push({ dir: path.join(roots.projectPath, ".pi", "prompts"), scope: "project" });
  }
  dirs.push({ dir: path.join(piAgentHome(roots), "prompts"), scope: "global" });
  dirs.push({ dir: path.join(piAgentHome(roots), "prompt-library"), scope: "library" });
  return dirs;
}

/**
 * Paths the file watcher observes. Builtins never change; missing directories
 * and exact settings files are passed to chokidar so their later creation is
 * observed without creating them.
 */
export function watchDirs(roots: ResourceRoots): string[] {
  return [
    ...agentCatalogDirs(roots)
      .filter((d) => d.scope !== "builtin")
      .map((d) => d.dir),
    ...skillCatalogDirs(roots).map((d) => d.dir),
    ...promptCatalogDirs(roots).map((d) => d.dir),
    // Native watches this exact file even before it exists. It can change
    // builtin-agent overrides and other Pi-discovered resource configuration.
    path.join(piAgentHome(roots), "settings.json"),
  ];
}

/** A selected project's resource catalog dirs and exact settings file observed
 * for live-update (native parity: `AppRefreshService` watches these per project).
 * Missing targets are fine — chokidar observes their later creation without
 * creating them. */
export function projectWatchDirs(projectPath: string): string[] {
  const pi = path.join(projectPath, ".pi");
  return [
    // Canonical, where the engine materializes project skills (see skillCatalogDirs).
    path.join(projectPath, ".agents", "skills"),
    path.join(pi, "skills"),
    path.join(pi, "agents"),
    path.join(pi, "prompts"),
    path.join(pi, "settings.json"),
  ];
}
