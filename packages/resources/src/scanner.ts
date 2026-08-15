import { readdirSync, readFileSync, realpathSync, statSync, type Dirent } from "node:fs";
import path from "node:path";
import {
  applyShadowing,
  type AgentInfo,
  normalizeAgentDefaultReads,
  normalizeAgentExtensions,
  normalizeAgentOutput,
  SUBAGENT_EXPECTED_OUTCOMES,
  type PromptInfo,
  type ResourceScope,
  type SkillInfo,
  type SubagentExpectedOutcome,
} from "@agent-deck/domain";
import { loadSkillsFromDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { applyAgentOverride, readAgentOverrides } from "./overrides.ts";
import {
  isRealpathContained,
  loadPackageSkillEntries,
  scanPackageExtensionCandidates,
  scanPackagePromptLocations,
} from "./packageSkills.ts";
import {
  agentCatalogDirs,
  extensionCatalogDirs,
  piAgentHome,
  promptCatalogDirs,
  skillCatalogDirs,
  type ResourceRoots,
} from "./paths.ts";

/**
 * Filesystem scanners for agents and skills. Agent frontmatter follows
 * https://github.com/a-streetcoder/agent-deck/blob/main/agent-deck-documentation/reference/agent-frontmatter.md; skill discovery
 * reuses pi's own loader so the rules match pi exactly.
 */

/** Frontmatter list fields arrive as YAML arrays OR comma-separated strings. */
function asList(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    return items.length > 0 ? items : undefined;
  }
  return undefined;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Native accepts canonical raw values plus its human-readable picker labels. */
function asExpectedOutcome(value: unknown): SubagentExpectedOutcome | undefined {
  const normalized = asString(value)?.toLowerCase().replaceAll(" ", "");
  if (!normalized) return undefined;
  return SUBAGENT_EXPECTED_OUTCOMES.find((outcome) => {
    const display =
      outcome === "reportOnly"
        ? "reportonly"
        : outcome === "editFilesInWorktree"
          ? "editfilesinworktree"
          : outcome === "writeProjectFile"
            ? "write/updateprojectfile"
            : "directprojectwrites";
    return outcome.toLowerCase() === normalized || display === normalized;
  });
}

/** Native-compatible split for the shared `tools:` frontmatter field. Direct
 * adapter names are metadata only: they must never enter Pi's `--tools` list. */
function splitAgentTools(value: unknown): { tools?: string[]; mcpDirectTools?: string[] } {
  const tools: string[] = [];
  const mcpDirectTools: string[] = [];
  for (const item of asList(value) ?? []) {
    if (item.startsWith("mcp:")) {
      const name = item.slice(4).trim();
      if (name) mcpDirectTools.push(name);
    } else {
      tools.push(item);
    }
  }
  return {
    tools: tools.length > 0 ? tools : undefined,
    mcpDirectTools: mcpDirectTools.length > 0 ? mcpDirectTools : undefined,
  };
}

export function parseAgentFile(
  filePath: string,
  content: string,
  scope: ResourceScope,
): Omit<AgentInfo, "shadowed" | "replacesBuiltin"> {
  const { frontmatter, body } = parseFrontmatter(content);
  const mode = asString(frontmatter.systemPromptMode);
  const toolsExplicit = Object.prototype.hasOwnProperty.call(frontmatter, "tools");
  const parsedTools = splitAgentTools(frontmatter.tools);
  return {
    name: asString(frontmatter.name) ?? path.basename(filePath, ".md"),
    description: asString(frontmatter.description),
    whenToUse: asString(frontmatter.whenToUse),
    model: asString(frontmatter.model),
    fallbackModels: asList(frontmatter.fallbackModels),
    thinking: asString(frontmatter.thinking),
    systemPromptMode: mode === "append" ? "append" : "replace",
    tools: toolsExplicit ? (parsedTools.tools ?? []) : undefined,
    toolsExplicit,
    mcpDirectTools: parsedTools.mcpDirectTools,
    skills: asList(frontmatter.skills),
    extensions: normalizeAgentExtensions(asList(frontmatter.extensions)),
    mcpServers: asList(frontmatter.mcpServers),
    defaultReads: normalizeAgentDefaultReads(asList(frontmatter.defaultReads)),
    defaultExpectedOutcome: asExpectedOutcome(frontmatter.defaultExpectedOutcome),
    defaultProgress:
      typeof frontmatter.defaultProgress === "boolean" ? frontmatter.defaultProgress : undefined,
    interactive: typeof frontmatter.interactive === "boolean" ? frontmatter.interactive : undefined,
    maxSubagentDepth: (() => {
      const raw = frontmatter.maxSubagentDepth;
      if ((typeof raw !== "number" && typeof raw !== "string") || String(raw).trim() === "") {
        return undefined;
      }
      const parsed = Number(raw);
      return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
    })(),
    output: normalizeAgentOutput(frontmatter.output),
    scope,
    filePath,
    body: body.trim(),
    disabled: frontmatter.disabled === true,
  };
}

function agentMarkdownFiles(dir: string): string[] {
  const files: string[] = [];
  const walk = (current: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Native excludes every markdown file under a `skills` path component.
      if (entry.isDirectory()) {
        if (entry.name !== "skills") walk(path.join(current, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md") && entry.name !== "SKILL.md") {
        files.push(path.join(current, entry.name));
      }
    }
  };
  walk(dir);
  return files;
}

export function scanAgents(roots: ResourceRoots): AgentInfo[] {
  const overrides = readAgentOverrides(roots);
  const raw: Omit<AgentInfo, "shadowed" | "replacesBuiltin">[] = [];
  for (const { dir, scope } of agentCatalogDirs(roots)) {
    for (const filePath of agentMarkdownFiles(dir)) {
      try {
        let agent = parseAgentFile(filePath, readFileSync(filePath, "utf8"), scope);
        // Builtin edits live as diff-shaped overrides — the file is pristine.
        const override = scope === "builtin" ? overrides[agent.name] : undefined;
        if (override) agent = applyAgentOverride(agent, override);
        raw.push(agent);
      } catch {
        // Unreadable/malformed file — skip; a diagnostics channel comes later.
      }
    }
  }
  return applyShadowing(raw);
}

/**
 * Prompt templates: single .md files, `/prompt:<name>` in pi. Returns EVERY
 * scope's entry (no dedup) so a management UI can edit/delete both a global
 * prompt and a same-name project one — pi resolves precedence itself at load.
 */
/** Native references md/markdown/mdown/txt (NSOpenPanel's allowed types, PRM-07). */
export const EXTERNAL_PROMPT_EXTENSIONS = [".md", ".markdown", ".mdown", ".txt"] as const;

export function isExternalPromptFileName(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return EXTERNAL_PROMPT_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function scanPrompts(
  roots: ResourceRoots,
  onWarning?: (warning: string) => void,
  externalPaths: readonly string[] = [],
): PromptInfo[] {
  const prompts: PromptInfo[] = [];
  const readPromptFile = (
    filePath: string,
    scope: ResourceScope,
    external?: boolean,
    fromSettings?: boolean,
  ): void => {
    try {
      const { frontmatter, body } = parseFrontmatter(readFileSync(filePath, "utf8"));
      // A prompt's identity IS its file basename: pi registers the command
      // under the basename (expandPromptTemplate matches `/<basename>`) and
      // IGNORES any frontmatter `name`. So `name` (which edit/rename/delete and
      // the writer key off, as `${name}.md`) must be the basename too — trusting
      // a divergent frontmatter `name` would target the wrong file. External
      // refs may carry native's other extensions; strip whichever matched.
      const basename = external ? path.parse(filePath).name : path.basename(filePath, ".md");
      prompts.push({
        name: basename,
        description: asString(frontmatter.description),
        scope,
        filePath,
        body: body.trim(),
        invocation: `/${basename}`,
        argumentHint: asString(frontmatter["argument-hint"]),
        ...(external ? { external: true } : {}),
        ...(fromSettings ? { source: "settings" as const } : {}),
      });
    } catch {
      // Unreadable/malformed — skip.
    }
  };
  const readPromptDir = (dir: string, scope: ResourceScope): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.endsWith(".md")) readPromptFile(path.join(dir, entry), scope);
    }
  };
  for (const { dir, scope } of promptCatalogDirs(roots)) readPromptDir(dir, scope);
  // Settings-declared prompt candidates (PRM-04, native discoveryKind settings):
  // settings.json `prompts` (a string or string[]) resolves against the settings
  // FILE's directory; a directory contributes its .md files, a .md file itself,
  // and a missing path warns (native's missing-prompt-path diagnostic). Catalog
  // files win the dedupe so their entries keep catalog provenance.
  const promptIdentity = (p: string): string => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const seenPromptFiles = new Set(prompts.map((p) => promptIdentity(p.filePath)));
  const addSettingsPrompt = (filePath: string, scope: ResourceScope): void => {
    const id = promptIdentity(filePath);
    if (seenPromptFiles.has(id)) return;
    seenPromptFiles.add(id);
    readPromptFile(filePath, scope, false, true);
  };
  const promptSettingsFiles: Array<{ file: string; scope: ResourceScope }> = [
    { file: path.join(piAgentHome(roots), "settings.json"), scope: "global" },
    ...(roots.projectPath
      ? [
          {
            file: path.join(roots.projectPath, ".pi", "settings.json"),
            scope: "project" as ResourceScope,
          },
        ]
      : []),
  ];
  for (const { file, scope } of promptSettingsFiles) {
    let declared: unknown;
    try {
      declared = (JSON.parse(readFileSync(file, "utf8")) as { prompts?: unknown }).prompts;
    } catch {
      continue; // missing or malformed settings — nothing to add
    }
    const entries =
      typeof declared === "string" ? [declared] : Array.isArray(declared) ? declared : [];
    for (const entry of entries) {
      if (typeof entry !== "string" || entry.trim() === "") continue;
      const resolved = path.resolve(path.dirname(file), entry);
      let isDir: boolean;
      try {
        isDir = statSync(resolved).isDirectory();
      } catch {
        onWarning?.(`Prompt path ${entry} from ${file} does not exist.`);
        continue;
      }
      if (isDir) {
        let names: string[];
        try {
          names = readdirSync(resolved);
        } catch {
          continue;
        }
        for (const name of names) {
          if (name.endsWith(".md")) addSettingsPrompt(path.join(resolved, name), scope);
        }
      } else if (resolved.endsWith(".md")) {
        addSettingsPrompt(resolved, scope);
      }
    }
  }
  // Package-provided prompts (PRM-03): read-only provenance-bearing entries, same
  // posture as package skills; resolution problems surface through onWarning.
  const packageScan = scanPackagePromptLocations(roots);
  for (const warning of packageScan.warnings) onWarning?.(warning);
  for (const location of packageScan.locations) {
    if (location.kind === "dir") {
      // per-FILE realpath containment: the dir itself is contained, but a symlinked
      // .md inside it could still point outside the package (review, Codex)
      let entries: string[];
      try {
        entries = readdirSync(location.target);
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.endsWith(".md")) continue;
        const filePath = path.join(location.target, entry);
        if (!isRealpathContained(location.target, filePath)) {
          onWarning?.(
            `Package prompt ${entry} in ${location.packageRef} resolves outside its package — ignored.`,
          );
          continue;
        }
        // a settings entry may already list this exact file — one record wins
        if (seenPromptFiles.has(promptIdentity(filePath))) continue;
        seenPromptFiles.add(promptIdentity(filePath));
        readPromptFile(filePath, "package");
      }
    } else {
      if (!seenPromptFiles.has(promptIdentity(location.target))) {
        seenPromptFiles.add(promptIdentity(location.target));
        readPromptFile(location.target, "package");
      }
    }
  }
  // External prompt references (PRM-05, native discoveryKind externalReference):
  // each registered path is a single `.md` file that stays where the user keeps
  // it — never copied into the library. Missing files warn, not vanish. A ref
  // pointing INTO a catalog must not duplicate the catalog's own record.
  const pathIdentity = (p: string): string => {
    const resolved = path.resolve(p);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const seenExternal = new Set<string>(prompts.map((p) => pathIdentity(p.filePath)));
  for (const raw of externalPaths) {
    const resolved = path.resolve(raw);
    const identity = pathIdentity(resolved);
    if (seenExternal.has(identity)) continue;
    seenExternal.add(identity);
    let isFile: boolean;
    try {
      isFile = statSync(resolved).isFile();
    } catch {
      onWarning?.(`External prompt reference ${raw} does not exist.`);
      continue;
    }
    if (!isFile || !isExternalPromptFileName(resolved)) continue; // native's reference types only
    readPromptFile(resolved, "library", true);
  }
  // Rank within a name for first-wins consumers (launch resolution's promptsByName):
  // the user's catalogs keep their existing order (global-first is this repo's
  // documented prompt rule), a package variant ranks below them, and the bundled
  // builtin is always last so a customized copy wins (PRM-02/03).
  const rank: Record<string, number> = {
    global: 0,
    library: 1,
    project: 2,
    package: 3,
    builtin: 4,
  };
  return prompts.sort(
    (a, b) => a.name.localeCompare(b.name) || (rank[a.scope] ?? 9) - (rank[b.scope] ?? 9),
  );
}

function toSkillInfo(
  skill: ReturnType<typeof loadSkillsFromDir>["skills"][number],
  scope: ResourceScope,
): SkillInfo {
  let body = "";
  try {
    body = parseFrontmatter(readFileSync(skill.filePath, "utf8")).body.trim();
  } catch {
    // Unreadable — leave the body empty.
  }
  return {
    name: skill.name,
    description: skill.description,
    scope,
    filePath: skill.filePath,
    baseDir: skill.baseDir,
    disableModelInvocation: skill.disableModelInvocation,
    body,
  };
}

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

function isPrivateResourceSkill(catalog: string, baseDir: string): boolean {
  const relative = path.relative(path.resolve(catalog), path.resolve(baseDir));
  const parts = relative.split(path.sep);
  return relative !== "" && parts.length >= 1 && isRecoveryWrapperName(parts[0]!);
}

/** Effective Pi-shaped candidates after ordinary catalog precedence. For each
 * bare name, only candidates from the highest-priority standard catalog are
 * retained. Collection roots participate only when no standard catalog wins;
 * multiple collection roots with the same name remain a true same-priority tie.
 * Storage remains owned by EngineSkillStore. */
export function scanSkillCandidates(
  roots: ResourceRoots,
  collectionRoots: readonly string[] = [],
  onWarning?: (warning: string) => void,
): SkillInfo[] {
  const standardByName = new Map<string, { priority: number; skills: SkillInfo[] }>();
  for (const [priority, { dir, scope }] of skillCatalogDirs(roots).entries()) {
    const result = loadSkillsFromDir({ dir, source: scope });
    for (const skill of result.skills) {
      if (isPrivateResourceSkill(dir, skill.baseDir)) continue;
      const candidate = toSkillInfo(skill, scope);
      const winner = standardByName.get(candidate.name);
      if (!winner) standardByName.set(candidate.name, { priority, skills: [candidate] });
      else if (winner.priority === priority) winner.skills.push(candidate);
    }
  }

  const skills = [...standardByName.values()].flatMap((winner) => winner.skills);
  for (const root of collectionRoots) {
    const resolvedRoot = path.resolve(root);
    const result = loadSkillsFromDir({ dir: path.dirname(resolvedRoot), source: "library" });
    const skill = result.skills.find(
      (candidate) => path.resolve(candidate.baseDir) === resolvedRoot,
    );
    if (skill && !standardByName.has(skill.name)) skills.push(toSkillInfo(skill, "library"));
  }
  // Package-provided skills (SKL-08): read-only provenance-bearing entries; a standard-catalog
  // name always wins, mirroring the library rule above.
  const packageScan = loadPackageSkillEntries(roots);
  for (const warning of packageScan.warnings) onWarning?.(warning);
  for (const entry of packageScan.entries) {
    if (!standardByName.has(entry.name)) skills.push(toSkillInfo(entry, "package"));
  }
  return skills;
}

/** Standard catalogs followed by selected in-place collection roots. The first
 * name wins for ambient/catalog display compatibility. Explicit agent launches
 * use scanSkillCandidates and fail closed on ambiguity. */
export function scanSkills(
  roots: ResourceRoots,
  collectionRoots: readonly string[] = [],
  onWarning?: (warning: string) => void,
): SkillInfo[] {
  const names = new Set<string>();
  return scanSkillCandidates(roots, collectionRoots, onWarning).filter((skill) => {
    if (names.has(skill.name)) return false;
    names.add(skill.name);
    return true;
  });
}

/** A pi extension file discovered in a catalog dir (native PiExtensionCandidate). */
export interface DiscoveredExtension {
  name: string;
  path: string;
  scope: ResourceScope;
  /**
   * How the candidate was found (EXT-01): the standard extension dirs, or a
   * `settings.json` `extensions` entry (native discoveryKind settingsExtension).
   */
  source?: "auto" | "settings" | "package";
  /** For package candidates (EXT-02): the settings.json ref that supplied it. */
  packageRef?: string;
}

/** pi loads extensions written in TS or JS (any module flavor). */
const EXTENSION_FILE_RE = /\.(ts|mts|cts|js|mjs|cjs)$/i;

/**
 * Discover the user's own extension files in the standard pi locations (global
 * ~/.pi/agent/extensions + the project's .pi/extensions), so they appear in the
 * Extensions screen without being added by hand — mirroring how agents/skills
 * are discovered. App-generated bridge extensions are written elsewhere and are
 * never scanned here, so a user can't see or disable them. A project entry wins
 * over a global one at the same path (there is none — paths are absolute), and
 * duplicates are de-duped by absolute path.
 * App-generated bridge extensions written into a scanned dir are EXCLUDED: a
 * `.agent-deck-manifest.json` (a filename→content-hash map that Agent Deck writes
 * alongside the extensions it generates) marks them as app-owned, not user
 * extensions. Re-discovering + injecting them would duplicate/shadow the app's
 * own freshly-generated bridges (and a stale/broken one would crash pi), so they
 * are skipped — the same separation native gets by keeping its bridges apart.
 */

/** The bridge filenames Agent Deck generates — a conservative fallback for when a
 *  manifest EXISTS in a dir (so it holds app bridges) but can't be parsed. */
const KNOWN_APP_BRIDGE_NAMES = new Set([
  "agent-deck-bridge.ts",
  "agent-deck-ask-user-bridge.ts",
  "agent-deck-mcp-bridge.ts",
  "agent-deck-memory-bridge.ts",
  "agent-deck-openai-fast.ts",
  "agent-deck-web-access.ts",
  "agent-deck-web-fetch.ts",
  "contact-supervisor-bridge.ts",
  "create-agent-deck-command.ts",
  "managed-subagent-bridge.ts",
  "optimize-agents-md.ts",
  "system-prompt-audit-bridge.ts",
]);

/** Filenames Agent Deck generated in `dir` (from its manifest); empty if none. */
function appGeneratedExtensionNames(dir: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(path.join(dir, ".agent-deck-manifest.json"), "utf8");
  } catch {
    return new Set(); // no manifest → this dir has no app-generated extensions
  }
  try {
    const manifest: unknown = JSON.parse(raw);
    if (manifest && typeof manifest === "object" && !Array.isArray(manifest)) {
      return new Set(Object.keys(manifest));
    }
  } catch {
    // Manifest present but unparseable (mid-write/corrupt) — fall through.
  }
  // A manifest EXISTS, so this dir DOES hold app-generated bridges; we just can't
  // read the exact list. Exclude the known app-bridge names rather than risk
  // re-injecting a stale/broken bridge (which crashes pi).
  return KNOWN_APP_BRIDGE_NAMES;
}

export function scanExtensions(
  roots: ResourceRoots,
  onWarning?: (warning: string) => void,
): DiscoveredExtension[] {
  const found: DiscoveredExtension[] = [];
  // dedupe by FILESYSTEM identity — Windows paths are case-insensitive, so two
  // casings of one file must never mint two candidates (review, Codex)
  const seen = new Set<string>();
  // FILESYSTEM identity where possible: an aliased path (junction/symlink) to an
  // already-discovered file must not mint a second candidate that pi would load
  // twice (review, Codex). Nonexistent candidates fall back to the lexical path.
  const pathKey = (p: string): string => {
    let identity: string;
    try {
      identity = realpathSync(p);
    } catch {
      identity = path.resolve(p);
    }
    return process.platform === "win32" ? identity.toLowerCase() : identity;
  };
  for (const { dir, scope } of extensionCatalogDirs(roots)) {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // the dir doesn't exist — nothing to discover there
    }
    const appGenerated = appGeneratedExtensionNames(dir);
    for (const entry of entries) {
      if (!entry.isFile() || !EXTENSION_FILE_RE.test(entry.name)) continue;
      if (appGenerated.has(entry.name)) continue; // app's own bridge, not a user extension
      const full = path.join(dir, entry.name);
      if (seen.has(pathKey(full))) continue;
      seen.add(pathKey(full));
      found.push({ name: entry.name, path: full, scope, source: "auto" });
    }
  }
  // settings.json `extensions` entries are candidates too (EXT-01, native
  // discoveryKind settingsExtension): each path resolves against the settings
  // FILE's directory. Auto-discovered files win the dedupe so their entry keeps
  // the richer auto provenance.
  const settingsFiles: Array<{ file: string; scope: ResourceScope }> = [
    { file: path.join(piAgentHome(roots), "settings.json"), scope: "global" },
    ...(roots.projectPath
      ? [
          {
            file: path.join(roots.projectPath, ".pi", "settings.json"),
            scope: "project" as ResourceScope,
          },
        ]
      : []),
  ];
  for (const { file, scope } of settingsFiles) {
    let listed: unknown;
    try {
      listed = (JSON.parse(readFileSync(file, "utf8")) as { extensions?: unknown }).extensions;
    } catch {
      continue; // missing or malformed settings — nothing to add
    }
    if (!Array.isArray(listed)) continue;
    for (const entry of listed) {
      if (typeof entry !== "string" || entry.trim() === "") continue;
      const resolved = path.resolve(path.dirname(file), entry);
      if (seen.has(pathKey(resolved))) continue;
      seen.add(pathKey(resolved));
      found.push({ name: path.basename(resolved), path: resolved, scope, source: "settings" });
    }
  }
  // Package-provided extensions (EXT-02): candidates from settings.packages,
  // same provenance/warning posture as package skills and prompts.
  const packageScan = scanPackageExtensionCandidates(roots);
  for (const warning of packageScan.warnings) onWarning?.(warning);
  for (const candidate of packageScan.candidates) {
    if (seen.has(pathKey(candidate.path))) continue;
    seen.add(pathKey(candidate.path));
    found.push({
      name: path.basename(candidate.path),
      path: candidate.path,
      scope: "package",
      source: "package",
      packageRef: candidate.packageRef,
    });
  }
  return found;
}
