import { existsSync, lstatSync, readFileSync, readdirSync, statSync, type Dirent } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import {
  copyResourceTree,
  readResourceCatalogFile,
  removeResourceCatalogEntry,
  renameResourceCatalogEntry,
  ResourceCatalogCapabilityError,
  writeResourceCatalogFile,
  type ResourceCatalog,
} from "@agent-deck/loop-catalog-native";
import YAML from "yaml";
import type { AgentEdit } from "./overrides.ts";
import {
  agentCatalogDirs,
  promptCatalogDirs,
  skillCatalogDirs,
  type ResourceRoots,
} from "./paths.ts";

/**
 * File writers for global/library agents and prompts, plus global skills. Existing files keep
 * their unknown frontmatter fields: we parse, merge only the edited keys,
 * and re-serialize. Builtins are handled by overrides.ts, never here.
 */

export type WritableScope = "global" | "library" | "project";

type CatalogLocation = { catalog: ResourceCatalog; components: string[]; path: string };

function catalogLocation(roots: ResourceRoots, filePath: string): CatalogLocation {
  const candidates: Array<[ResourceCatalog, string]> = [
    ["legacy-agents", path.join(roots.home, ".agents")],
    ["global-agents", path.join(roots.home, ".pi", "agent", "agents")],
    ["library-agents", path.join(roots.home, ".pi", "agent", "agent-library", "agents")],
    ["global-prompts", path.join(roots.home, ".pi", "agent", "prompts")],
    ["library-prompts", path.join(roots.home, ".pi", "agent", "prompt-library")],
    ["global-skills", path.join(roots.home, ".pi", "agent", "skills")],
  ];
  const resolved = path.resolve(filePath);
  for (const [catalog, root] of candidates) {
    const relative = path.relative(path.resolve(root), resolved);
    if (
      relative &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative)
    ) {
      return { catalog, components: relative.split(path.sep), path: resolved };
    }
  }
  throw new ResourceCatalogCapabilityError(
    "RESOURCE_INVALID_PATH",
    "Resource target is not in a writable catalog.",
  );
}

function secureRead(roots: ResourceRoots, filePath: string): string {
  const location = catalogLocation(roots, filePath);
  return readResourceCatalogFile(roots.home, location.catalog, location.components);
}

function secureReadIfPresent(roots: ResourceRoots, filePath: string): string | undefined {
  try {
    return secureRead(roots, filePath);
  } catch (error) {
    if (error instanceof ResourceCatalogCapabilityError && error.code === "RESOURCE_NOT_FOUND") {
      return undefined;
    }
    throw error;
  }
}

function secureWrite(
  roots: ResourceRoots,
  filePath: string,
  content: string,
  createOnly = false,
): void {
  const location = catalogLocation(roots, filePath);
  writeResourceCatalogFile(roots.home, location.catalog, location.components, content, createOnly);
}

function secureRemove(roots: ResourceRoots, filePath: string, force = false): void {
  const location = catalogLocation(roots, filePath);
  try {
    removeResourceCatalogEntry(roots.home, location.catalog, location.components);
  } catch (error) {
    if (
      force &&
      error instanceof ResourceCatalogCapabilityError &&
      error.code === "RESOURCE_NOT_FOUND"
    ) {
      return;
    }
    throw error;
  }
}

function secureRename(
  roots: ResourceRoots,
  from: string,
  to: string,
  replacementContent?: string,
): void {
  const source = catalogLocation(roots, from);
  const target = catalogLocation(roots, to);
  if (source.catalog !== target.catalog) {
    throw new ResourceCatalogCapabilityError(
      "RESOURCE_INVALID_PATH",
      "Resource rename must stay in one catalog.",
    );
  }
  renameResourceCatalogEntry(
    roots.home,
    source.catalog,
    source.components,
    target.components,
    replacementContent,
  );
}

function agentDirFor(roots: ResourceRoots, scope: WritableScope): string {
  const catalogs = agentCatalogDirs(roots).filter((d) => d.scope === scope);
  if (scope === "global") {
    const legacy = catalogs.find((d) => d.legacy)?.dir;
    if (legacy) {
      try {
        if (statSync(legacy).isDirectory()) return legacy;
      } catch {
        // A missing legacy catalog must not be created just to hold a new agent.
      }
    }
    const modern = catalogs.find((d) => !d.legacy)?.dir;
    if (modern) return modern;
  } else {
    const dir = catalogs[0]?.dir;
    if (dir) return dir;
  }
  throw new Error(`no ${scope} agent directory`);
}

function skillDirFor(roots: ResourceRoots, scope: WritableScope): string {
  const dir = skillCatalogDirs(roots).find((d) => d.scope === scope)?.dir;
  if (!dir) throw new Error(`no ${scope} skill directory (is a project selected?)`);
  return dir;
}

function safeAgentPath(dir: string, name: string): string {
  const filePath = path.join(dir, `${name}.md`);
  if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep)) {
    throw new Error("refusing to write outside the agent catalog");
  }
  return filePath;
}

function existingAgentSources(dir: string, name: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "skills") walk(full);
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
        try {
          const parsed = parseFrontmatter(readFileSync(full, "utf8"));
          const parsedName =
            typeof parsed.frontmatter.name === "string" && parsed.frontmatter.name.trim()
              ? parsed.frontmatter.name.trim()
              : path.basename(entry.name, ".md");
          if (parsedName === name) found.push(full);
        } catch {
          // A malformed file is not a managed agent source.
        }
      }
    }
  };
  walk(dir);
  return found;
}

/** Resolve an existing source before applying the catalog's new-file destination. */
function agentFilePath(roots: ResourceRoots, scope: WritableScope, name: string): string {
  if (scope === "project") return safeAgentPath(agentDirFor(roots, scope), name);
  const existing = agentCatalogDirs(roots)
    .filter((catalog) => catalog.scope === scope)
    .flatMap((catalog) => existingAgentSources(catalog.dir, name));
  if (existing.length > 1) throw new Error("agent_ambiguous");
  return existing[0] ?? safeAgentPath(agentDirFor(roots, scope), name);
}

function promptDirFor(roots: ResourceRoots, scope: WritableScope): string {
  const dir = promptCatalogDirs(roots).find((d) => d.scope === scope)?.dir;
  if (!dir) throw new Error(`no ${scope} prompt directory (is a project selected?)`);
  return dir;
}

/** Defense-in-depth: the resolved .md must stay inside the prompt catalog. */
function promptFilePath(roots: ResourceRoots, scope: WritableScope, name: string): string {
  const dir = promptDirFor(roots, scope);
  const filePath = path.join(dir, `${name}.md`);
  if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep)) {
    throw new Error("refusing to write outside the prompt catalog");
  }
  return filePath;
}

/** Create or update a prompt-template .md file, preserving unknown frontmatter. */
export function writePromptFile(
  roots: ResourceRoots,
  scope: WritableScope,
  name: string,
  edit: { description?: string; body?: string },
): string {
  const filePath = promptFilePath(roots, scope, name);

  let frontmatter: Record<string, unknown> = {};
  let body = "";
  const existingContent = secureReadIfPresent(roots, filePath);
  if (existingContent !== undefined) {
    const existing = parseFrontmatter(existingContent);
    frontmatter = { ...existing.frontmatter };
    body = existing.body.trim();
  }

  frontmatter.name = name;
  if (edit.description !== undefined) frontmatter.description = edit.description;
  if (edit.body !== undefined) body = edit.body.trim();

  secureWrite(roots, filePath, `---\n${serializeFrontmatter(frontmatter)}\n---\n\n${body}\n`);
  return filePath;
}

/** Delete a global/library prompt-template .md file. */
export function deletePromptFile(roots: ResourceRoots, scope: WritableScope, name: string): void {
  secureRemove(roots, promptFilePath(roots, scope, name), true);
}

/** True when two paths refer to the same on-disk file (same device + inode). */
function isSameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

/**
 * Rename a prompt-template .md file within the same scope, preserving its body,
 * description, and any unknown frontmatter, and updating the `name` field to
 * match the new filename (pi exposes prompts as /prompt:<filename>). Throws
 * "prompt_not_found" if the source is missing and "prompt_exists" if the target
 * name is already taken — the caller maps these to 404 / 409.
 */
/**
 * Move a resource .md file within its scope dir, preserving the body and any
 * unknown frontmatter and setting `name` to the new filename. Handles a
 * case-only rename on case-insensitive filesystems (renameSync changes the
 * stored case, which a plain write wouldn't) and otherwise claims the target
 * with an exclusive create — which both rejects a real name clash AND closes
 * the check-then-write TOCTOU (a file appearing in the gap fails the write
 * instead of being clobbered). Throws `${kind}_not_found` / `${kind}_exists`.
 */
function renameMarkdownFile(
  roots: ResourceRoots,
  from: string,
  to: string,
  kind: "prompt" | "agent",
  newName: string,
): string {
  if (from === to) return to; // no-op: nothing to rename
  let parsed: { frontmatter: Record<string, unknown>; body: string };
  try {
    parsed = parseFrontmatter(secureRead(roots, from));
  } catch (error) {
    if (error instanceof ResourceCatalogCapabilityError && error.code === "RESOURCE_NOT_FOUND") {
      throw new Error(`${kind}_not_found`);
    }
    throw error;
  }
  const content = `---\n${serializeFrontmatter({ ...parsed.frontmatter, name: newName })}\n---\n\n${parsed.body.trim()}\n`;

  try {
    secureRename(roots, from, to, content);
  } catch (error) {
    if (
      error instanceof ResourceCatalogCapabilityError &&
      error.code === "RESOURCE_ALREADY_EXISTS"
    ) {
      throw new Error(`${kind}_exists`);
    }
    if (error instanceof ResourceCatalogCapabilityError && error.code === "RESOURCE_NOT_FOUND") {
      throw new Error(`${kind}_not_found`);
    }
    throw error;
  }
  return to;
}

export function renamePromptFile(
  roots: ResourceRoots,
  scope: WritableScope,
  name: string,
  newName: string,
): string {
  return renameMarkdownFile(
    roots,
    promptFilePath(roots, scope, name),
    promptFilePath(roots, scope, newName),
    "prompt",
    newName,
  );
}

const AGENT_FIELD_ORDER = [
  "name",
  "description",
  "whenToUse",
  "model",
  "fallbackModels",
  "thinking",
  "systemPromptMode",
  "tools",
  "skills",
  "mcpServers",
] as const;

function serializeFrontmatter(record: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of AGENT_FIELD_ORDER) {
    if (record[key] !== undefined) ordered[key] = record[key];
  }
  for (const [key, value] of Object.entries(record)) {
    if (!(key in ordered) && value !== undefined) ordered[key] = value;
  }
  return YAML.stringify(ordered).trimEnd();
}

/** Create or update an agent markdown file, preserving unknown frontmatter. */
export function writeAgentFile(
  roots: ResourceRoots,
  scope: WritableScope,
  name: string,
  edit: AgentEdit,
): string {
  const filePath = agentFilePath(roots, scope, name);
  let frontmatter: Record<string, unknown> = {};
  let body = "";
  const existingContent = secureReadIfPresent(roots, filePath);
  if (existingContent !== undefined) {
    const existing = parseFrontmatter(existingContent);
    frontmatter = { ...existing.frontmatter };
    body = existing.body.trim();
  }

  frontmatter.name = name;
  const setOrDelete = (key: string, value: string | undefined) => {
    if (value === undefined) return;
    if (value === "") delete frontmatter[key];
    else frontmatter[key] = value;
  };
  setOrDelete("description", edit.description);
  setOrDelete("whenToUse", edit.whenToUse);
  setOrDelete("model", edit.model);
  setOrDelete("thinking", edit.thinking);
  if (edit.systemPromptMode !== undefined) frontmatter.systemPromptMode = edit.systemPromptMode;
  if (edit.fallbackModels !== undefined) {
    if (edit.fallbackModels.length > 0) frontmatter.fallbackModels = edit.fallbackModels.join(", ");
    else delete frontmatter.fallbackModels;
  }
  if (edit.tools !== undefined) {
    if (edit.tools.length > 0) frontmatter.tools = edit.tools.join(", ");
    else delete frontmatter.tools;
  }
  if (edit.skills !== undefined) {
    if (edit.skills.length > 0) frontmatter.skills = edit.skills.join(", ");
    else delete frontmatter.skills;
  }
  if (edit.mcpServers !== undefined) {
    if (edit.mcpServers.length > 0) frontmatter.mcpServers = edit.mcpServers.join(", ");
    else delete frontmatter.mcpServers;
  }
  if (edit.body !== undefined) body = edit.body.trim();

  secureWrite(roots, filePath, `---\n${serializeFrontmatter(frontmatter)}\n---\n\n${body}\n`);
  return filePath;
}

/** Create or update a skill's SKILL.md, preserving unknown frontmatter. */
export function writeSkillFile(
  roots: ResourceRoots,
  scope: WritableScope,
  name: string,
  edit: { description?: string; body?: string },
): string {
  const dir = path.join(skillDirFor(roots, scope), name);
  const filePath = path.join(dir, "SKILL.md");

  let frontmatter: Record<string, unknown> = {};
  let body = "";
  const existingContent = secureReadIfPresent(roots, filePath);
  if (existingContent !== undefined) {
    const existing = parseFrontmatter(existingContent);
    frontmatter = { ...existing.frontmatter };
    body = existing.body.trim();
  }

  frontmatter.name = name;
  if (edit.description !== undefined) frontmatter.description = edit.description;
  if (edit.body !== undefined) body = edit.body.trim();

  secureWrite(roots, filePath, `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n\n${body}\n`);
  return filePath;
}

/** Delete a global/library agent's .md file. Builtins are never touched here. */
export function deleteAgentFile(roots: ResourceRoots, scope: WritableScope, name: string): void {
  secureRemove(roots, agentFilePath(roots, scope, name), true);
}

/**
 * Rename a global/library agent's .md file, preserving its body + frontmatter
 * and syncing the `name` field. Builtins can't be renamed (their name is the
 * override key). Throws "agent_not_found" / "agent_exists" (→ 404 / 409); the
 * caller is responsible for re-pointing any project defaults at the new name.
 */
export function renameAgentFile(
  roots: ResourceRoots,
  scope: WritableScope,
  name: string,
  newName: string,
): string {
  const from = agentFilePath(roots, scope, name);
  const dir = path.dirname(from);
  const to = safeAgentPath(dir, newName);
  if (scope === "global" || scope === "library") {
    const conflict = agentCatalogDirs(roots)
      .filter((catalog) => catalog.scope === scope)
      .flatMap((catalog) => existingAgentSources(catalog.dir, newName))
      .find((candidate) => candidate !== from);
    if (conflict && !isSameFile(conflict, from)) throw new Error("agent_exists");
  }
  return renameMarkdownFile(roots, from, to, "agent", newName);
}

/** Set the `disabled` frontmatter flag on a global/library agent file. */
export function setAgentDisabledFile(
  roots: ResourceRoots,
  scope: WritableScope,
  name: string,
  disabled: boolean,
): void {
  const filePath = agentFilePath(roots, scope, name);
  const existing = parseFrontmatter(secureRead(roots, filePath));
  const frontmatter: Record<string, unknown> = { ...existing.frontmatter };
  if (disabled) frontmatter.disabled = true;
  else delete frontmatter.disabled;
  // A metadata-only toggle preserves the body verbatim (no re-trim).
  secureWrite(roots, filePath, `---\n${serializeFrontmatter(frontmatter)}\n---\n${existing.body}`);
}

/** Delete a global/project skill directory (its SKILL.md + contents). */
export function deleteSkillDir(roots: ResourceRoots, scope: WritableScope, name: string): void {
  secureRemove(roots, skillDirPath(roots, scope, name), true);
}

/** Defense-in-depth: the resolved skill dir must stay inside the catalog. */
function skillDirPath(roots: ResourceRoots, scope: WritableScope, name: string): string {
  const catalog = skillDirFor(roots, scope);
  const dir = path.join(catalog, name);
  if (!path.resolve(dir).startsWith(path.resolve(catalog) + path.sep)) {
    throw new Error("refusing to touch outside the skill catalog");
  }
  return dir;
}

/**
 * Rename a global/project skill DIRECTORY (a skill is a folder holding SKILL.md
 * plus any assets), preserving every file and syncing SKILL.md's `name` to the
 * new directory name. Throws "skill_not_found" / "skill_exists" (→ 404 / 409);
 * the caller re-points any project assignments.
 */
export function renameSkillDir(
  roots: ResourceRoots,
  scope: WritableScope,
  name: string,
  newName: string,
): string {
  const from = skillDirPath(roots, scope, name);
  const to = skillDirPath(roots, scope, newName);
  if (from === to) return to; // no-op: nothing to rename
  try {
    secureRename(roots, from, to);
  } catch (error) {
    if (error instanceof ResourceCatalogCapabilityError) {
      if (error.code === "RESOURCE_NOT_FOUND") throw new Error("skill_not_found");
      if (error.code === "RESOURCE_ALREADY_EXISTS") throw new Error("skill_exists");
    }
    throw error;
  }

  // Keep SKILL.md's name field in step with the directory name.
  const skillFile = path.join(to, "SKILL.md");
  try {
    const parsed = parseFrontmatter(secureRead(roots, skillFile));
    const frontmatter = { ...parsed.frontmatter, name: newName };
    secureWrite(
      roots,
      skillFile,
      `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n\n${parsed.body.trim()}\n`,
    );
  } catch (error) {
    if (error instanceof ResourceCatalogCapabilityError && error.code === "RESOURCE_NOT_FOUND") {
      // A directory without SKILL.md can still be renamed.
      return to;
    }

    // The manifest update happens after the directory move. Restore the source
    // location before exposing the failure so a retry starts from the original,
    // internally consistent state. Both moves remain inside the typed native
    // catalog boundary.
    try {
      secureRename(roots, to, from);
    } catch (rollbackError) {
      const incomplete = new ResourceCatalogCapabilityError(
        "RESOURCE_RECONCILE_INCOMPLETE",
        "The skill directory was renamed, its SKILL.md update failed, and the directory rollback also failed. Retry the rename to reconcile it safely.",
      );
      incomplete.cause = new AggregateError(
        [error, rollbackError],
        "Skill rename reconciliation failed",
      );
      throw incomplete;
    }
    throw error;
  }
  return to;
}

/**
 * Import a local .md file as a new global/project skill (native SkillImportSheet
 * Local tab): the skill name comes from the file's frontmatter `name` (else its
 * filename), and its SKILL.md is written into the catalog with the name synced.
 * Returns the imported name. Throws "not_a_markdown_file" (bad source),
 * "invalid_skill_name" (can't derive a valid name), or "skill_exists".
 */
/** The content after a leading `---\n…\n---\n` frontmatter block, VERBATIM
 *  (parseFrontmatter trims its body, losing e.g. a leading indented code block). */
function rawBodyAfterFrontmatter(content: string): string {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/.exec(content);
  return match ? content.slice(match[0].length) : content;
}

/** Recursively find top-level skill roots (nested SKILL.md files belong to
 * their containing skill), skipping symlinks and dependency metadata. */
function findSkillDirs(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes("SKILL.md")) {
      found.push(dir);
      return;
    }
    for (const entry of entries) {
      if (entry === ".git" || entry === "node_modules") continue;
      const full = path.join(dir, entry);
      try {
        if (lstatSync(full).isDirectory()) walk(full);
      } catch {
        // Unreadable entry — skip.
      }
    }
  };
  walk(root);
  return found;
}

export interface DiscoveredSkillRoot {
  name: string;
  relativePath: string;
  rootPath: string;
}

/** Import-all discovery for an in-place cloned collection. */
export function discoverSkillRoots(
  cloneDir: string,
  acceptRoot: (rootPath: string) => boolean = () => true,
): DiscoveredSkillRoot[] {
  return findSkillDirs(cloneDir)
    .filter(acceptRoot)
    .map((rootPath) => {
      const relativePath = path.relative(cloneDir, rootPath);
      let name = path.basename(rootPath);
      try {
        const frontmatter = parseFrontmatter(
          readFileSync(path.join(rootPath, "SKILL.md"), "utf8"),
        ).frontmatter;
        if (typeof frontmatter.name === "string" && frontmatter.name.trim()) {
          name = frontmatter.name.trim();
        }
      } catch {
        // Directory basename fallback.
      }
      return { name, relativePath: relativePath === "" ? "" : relativePath, rootPath };
    });
}

export interface SkillImportResult {
  imported: string[];
  skipped: string[];
  /** sha-256 of each imported skill's SKILL.md (the as-written fingerprint). */
  hashes: Record<string, string>;
}

export interface SkillImportFilter {
  only?: Set<string>;
  exclude?: Set<string>;
  /** Called after each catalog copy completes, allowing durable update progress. */
  onImported?: (name: string, hash: string | undefined) => void;
}

/** sha-256 of a SKILL.md file, or null if it can't be read. */
function hashSkillMd(skillDir: string): string | null {
  try {
    return createHash("sha256")
      .update(readFileSync(path.join(skillDir, "SKILL.md")))
      .digest("hex");
  } catch {
    return null;
  }
}

/** The catalog copy's current SKILL.md hash, for detecting a local edit. */
export function skillMdHash(
  roots: ResourceRoots,
  scope: WritableScope,
  name: string,
): string | null {
  try {
    return createHash("sha256")
      .update(secureRead(roots, path.join(skillDirFor(roots, scope), name, "SKILL.md")))
      .digest("hex");
  } catch (error) {
    if (error instanceof ResourceCatalogCapabilityError && error.code === "RESOURCE_NOT_FOUND") {
      return null;
    }
    throw error;
  }
}

/**
 * Import every skill found in a cloned repo dir into the scope's skill catalog
 * (native SkillRepositorySync). Rule (native): a SKILL.md at the repo root means
 * the whole repo is ONE skill; otherwise every SKILL.md's parent dir is a skill.
 * Each skill's directory is copied whole (assets included) with the .git dir
 * excluded. Names come from SKILL.md frontmatter `name`, else the dir basename
 * (or `repoName` for the root case). Existing + invalid names are skipped.
 */
export function importSkillsFromClone(
  roots: ResourceRoots,
  scope: WritableScope,
  cloneDir: string,
  repoName: string,
  /** Re-sync: replace an existing catalog skill instead of skipping it. */
  overwrite = false,
  /** Restrict which skills are touched: `only` = just these names; `exclude` =
   *  every name but these (used to HOLD locally-edited conflicts on a re-sync). */
  filter?: SkillImportFilter,
): SkillImportResult {
  const skillDirs = existsSync(path.join(cloneDir, "SKILL.md"))
    ? [cloneDir] // root SKILL.md → the whole repo is a single skill
    : findSkillDirs(cloneDir);
  const catalog = skillDirFor(roots, scope);
  const imported: string[] = [];
  const skipped: string[] = [];
  const hashes: Record<string, string> = {};
  for (const srcDir of skillDirs) {
    let name: string;
    try {
      const fm = parseFrontmatter(readFileSync(path.join(srcDir, "SKILL.md"), "utf8")).frontmatter;
      name =
        typeof fm.name === "string" && fm.name.trim()
          ? fm.name.trim()
          : srcDir === cloneDir
            ? repoName
            : path.basename(srcDir);
    } catch {
      name = srcDir === cloneDir ? repoName : path.basename(srcDir);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
      skipped.push(name);
      continue;
    }
    if (filter?.only && !filter.only.has(name)) continue; // not in the include set
    if (filter?.exclude?.has(name)) {
      skipped.push(name); // held back (a conflict to resolve)
      continue;
    }
    const dest = catalogLocation(roots, path.join(catalog, name));
    try {
      copyResourceTree(roots.home, dest.catalog, dest.components, srcDir, overwrite);
    } catch (error) {
      if (
        !overwrite &&
        error instanceof ResourceCatalogCapabilityError &&
        error.code === "RESOURCE_ALREADY_EXISTS"
      ) {
        skipped.push(name);
        continue;
      }
      throw error;
    }
    imported.push(name);
    const hash = hashSkillMd(srcDir);
    if (hash) hashes[name] = hash;
    filter?.onImported?.(name, hash ?? undefined);
  }
  return { imported, skipped, hashes };
}

export function importSkillFile(
  roots: ResourceRoots,
  scope: WritableScope,
  sourcePath: string,
): string {
  if (!sourcePath.endsWith(".md") || !existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
    throw new Error("not_a_markdown_file");
  }
  const content = readFileSync(sourcePath, "utf8");
  const parsed = parseFrontmatter(content);
  const fromFrontmatter =
    typeof parsed.frontmatter.name === "string" ? parsed.frontmatter.name.trim() : "";
  const name = fromFrontmatter || path.basename(sourcePath, ".md");
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Error("invalid_skill_name");
  const dir = skillDirPath(roots, scope, name);
  try {
    const existing = lstatSync(dir);
    if (!existing.isSymbolicLink()) throw new Error("skill_exists");
    // Let the native parent walk return the authoritative unsafe-component error.
  } catch (error) {
    if (error instanceof Error && error.message === "skill_exists") throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Skills need a description to be discoverable — default one if the file lacks it.
  const description =
    typeof parsed.frontmatter.description === "string" && parsed.frontmatter.description.trim()
      ? parsed.frontmatter.description
      : "Imported skill";
  // Write directly (not via writeSkillFile) so the body is preserved VERBATIM —
  // its .trim() would strip a leading indented code block — and any other
  // frontmatter the source carried is kept. Only name/description are synced.
  const frontmatter = { ...parsed.frontmatter, name, description };
  const rawBody = rawBodyAfterFrontmatter(content);
  const body = rawBody.endsWith("\n") ? rawBody : `${rawBody}\n`;
  try {
    secureWrite(
      roots,
      path.join(dir, "SKILL.md"),
      `---\n${serializeFrontmatter(frontmatter)}\n---\n\n${body}`,
      true,
    );
  } catch (error) {
    if (
      error instanceof ResourceCatalogCapabilityError &&
      error.code === "RESOURCE_ALREADY_EXISTS"
    ) {
      throw new Error("skill_exists");
    }
    throw error;
  }
  return name;
}
