import path from "node:path";
import {
  clampMaxIterations,
  isRunnableLoopStructure,
  loopDefinitionValidationError,
  normalizeLoopCheckpointPrompt,
  normalizeLoopClassificationPrompt,
  normalizeLoopLaunchContext,
  normalizeLoopProjectPaths,
  normalizeParallelBranches,
  LOOP_STRUCTURES,
  LOOP_STRUCTURE_UNSUPPORTED_CODE,
  LOOP_WRITE_TARGETS,
  type LoopDefinition,
  type LoopDefinitionAvailability,
  type LoopLaunchContextScope,
  type LoopStructure,
  type LoopWriteTarget,
} from "@agent-deck/domain";
import {
  createLoopCatalogFile,
  deleteLoopCatalogFile,
  LoopCatalogCapabilityError,
  replaceLoopCatalogFile,
  scanLoopCatalog,
} from "@agent-deck/loop-catalog-native";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import YAML from "yaml";
import { piAgentHome, type ResourceRoots } from "./paths.ts";

/**
 * Loop-definition persistence (native LoopDefinitionStore): one file per loop
 * under ~/.pi/agent/loops as `<slug>.loop.md` — frontmatter for the config, the
 * markdown body for the goal — mirroring the agent catalog. This is the Bank
 * CRUD; runtime records live under server app data. Unknown frontmatter round-trips so a
 * native `.loop.md` (which carries more fields) survives an edit here.
 */

const LOOP_SUFFIX = ".loop.md";

export function loopsDir(roots: ResourceRoots): string {
  return path.join(piAgentHome(roots), "loops");
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
function asPipelineStages(value: unknown): string[] | undefined {
  if (typeof value === "string") return value.split("|").map((stage) => stage.trim());
  // Read the short-lived Electron array encoding without rewriting until edit.
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? [...value]
    : undefined;
}
function asParallelBranches(value: unknown): string[] | undefined {
  if (typeof value === "string") return normalizeParallelBranches(value.split("|"));
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? normalizeParallelBranches(value)
    : undefined;
}
function decodeJSONStringLine(content: string, key: string): string | undefined {
  const raw = nativeLineFrontmatterValue(content, key);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}
function decodeJSONStringArrayLine(content: string, key: string): string[] | undefined {
  const raw = nativeLineFrontmatterValue(content, key);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((item) => typeof item === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}
function asLaunchContextScope(value: unknown): LoopLaunchContextScope {
  return value === "everyIteration" ? "everyIteration" : "firstIterationOnly";
}
function asAvailability(value: unknown): LoopDefinitionAvailability {
  return value === "projectPaths" ? "projectPaths" : "allProjects";
}
function asProjectPaths(value: unknown): string[] | undefined {
  if (typeof value === "string") return normalizeLoopProjectPaths(value.split("|"));
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? normalizeLoopProjectPaths(value)
    : undefined;
}
function nativeLineDocument(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  if (!normalized.startsWith("---\n")) return { frontmatter: {}, body: normalized.trim() };
  const closingWithBody = normalized.indexOf("\n---\n", 4);
  const closingAtEnd = normalized.endsWith("\n---") ? normalized.length - 4 : -1;
  const closing = closingWithBody >= 0 ? closingWithBody : closingAtEnd;
  if (closing < 0) return { frontmatter: {}, body: normalized.trim() };
  const frontmatter: Record<string, unknown> = {};
  for (const line of normalized.slice(4, closing).split("\n")) {
    const separator = line.indexOf(":");
    if (separator < 0) continue;
    frontmatter[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  const bodyStart = closingWithBody >= 0 ? closing + 5 : normalized.length;
  return { frontmatter, body: normalized.slice(bodyStart).trim() };
}

function parseLoopDocument(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  try {
    return parseFrontmatter(content) as {
      frontmatter: Record<string, unknown>;
      body: string;
    };
  } catch {
    return nativeLineDocument(content);
  }
}

function nativeLineFrontmatterValue(content: string, wantedKey: string): string | undefined {
  return asString(nativeLineDocument(content).frontmatter[wantedKey]);
}

function asStructure(value: unknown): LoopStructure {
  return LOOP_STRUCTURES.includes(value as LoopStructure)
    ? (value as LoopStructure)
    : "singleAgent";
}
function asWriteTarget(value: unknown): LoopWriteTarget {
  return LOOP_WRITE_TARGETS.includes(value as LoopWriteTarget)
    ? (value as LoopWriteTarget)
    : "artifactMarkdown";
}

/** A filesystem-safe slug for the loop's filename. */
export function loopSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "loop";
}

export function loopCatalogIdentity(basename: string): string {
  return Buffer.from(basename, "utf8").toString("base64url");
}

export function parseLoopFile(filePath: string, content: string): LoopDefinition {
  const { frontmatter, body } = parseLoopDocument(content);
  const basename = path.basename(filePath);
  const base = basename.replace(/\.loop\.md$/i, "");
  const launchContext =
    decodeJSONStringLine(content, "launchContextJSON") ?? asString(frontmatter.launchContext);
  const projectPaths =
    decodeJSONStringArrayLine(content, "projectPathsJSON") ??
    asProjectPaths(frontmatter.projectPaths) ??
    [];
  return {
    id: loopCatalogIdentity(basename),
    name: asString(frontmatter.name) ?? base,
    description: asString(frontmatter.description) ?? "",
    goal: body.trim(),
    structure: asStructure(frontmatter.structure),
    agentName: asString(frontmatter.agentName) || asString(frontmatter.makerName) || undefined,
    makerName: asString(frontmatter.makerName) || asString(frontmatter.agentName) || undefined,
    checkerName: asString(frontmatter.checkerName) || undefined,
    checkerRubric: asString(frontmatter.checkerRubric) || undefined,
    pipelineStages: asPipelineStages(frontmatter.pipelineStages),
    parallelBranches: asParallelBranches(frontmatter.parallelBranches),
    triageAgent: asString(frontmatter.triageAgent) || undefined,
    classificationPrompt:
      asStructure(frontmatter.structure) === "discoveryTriage"
        ? normalizeLoopClassificationPrompt(
            nativeLineFrontmatterValue(content, "classificationPrompt"),
          )
        : asString(frontmatter.classificationPrompt) || undefined,
    checkpointPrompt:
      asStructure(frontmatter.structure) === "humanApproval"
        ? normalizeLoopCheckpointPrompt(nativeLineFrontmatterValue(content, "checkpointPrompt"))
        : asString(frontmatter.checkpointPrompt) || undefined,
    launchContext: normalizeLoopLaunchContext(launchContext),
    launchContextScope: asLaunchContextScope(frontmatter.launchContextScope),
    maxIterations: clampMaxIterations(
      frontmatter.maxIterations === undefined ? Number.NaN : Number(frontmatter.maxIterations),
    ),
    validationCommand: asString(frontmatter.validationCommand) ?? "",
    writeTarget: asWriteTarget(frontmatter.writeTarget),
    source: "user",
    availability: asAvailability(frontmatter.availability),
    projectPaths: normalizeLoopProjectPaths(projectPaths),
    filePath,
  };
}

interface LoopCatalogRecord {
  basename: string;
  content: string;
  loop: LoopDefinition;
}

function scanLoopRecords(roots: ResourceRoots): LoopCatalogRecord[] {
  const directory = loopsDir(roots);
  const records: LoopCatalogRecord[] = [];
  for (const entry of scanLoopCatalog(roots.home)) {
    try {
      records.push({
        basename: entry.basename,
        content: entry.content,
        // Compatibility metadata only. Native operations never consume this path.
        loop: parseLoopFile(path.join(directory, entry.basename), entry.content),
      });
    } catch {
      // A syntactically malformed definition is invisible, matching native scan.
    }
  }
  return records.sort((left, right) => left.loop.name.localeCompare(right.loop.name));
}

export function scanLoops(roots: ResourceRoots): LoopDefinition[] {
  return scanLoopRecords(roots).map((record) => record.loop);
}

export interface LoopEdit {
  /** Required when editing; omitted only for creation. */
  id?: string;
  name: string;
  /** Internal duplication seed so native-only metadata survives the copy. */
  preservedFrontmatter?: Record<string, unknown>;
  description?: string;
  goal?: string;
  structure?: LoopStructure;
  agentName?: string;
  makerName?: string;
  checkerName?: string;
  checkerRubric?: string;
  pipelineStages?: string[];
  parallelBranches?: string[];
  triageAgent?: string;
  classificationPrompt?: string;
  checkpointPrompt?: string;
  launchContext?: string;
  launchContextScope?: LoopLaunchContextScope;
  maxIterations?: number;
  validationCommand?: string;
  writeTarget?: LoopWriteTarget;
  availability?: LoopDefinitionAvailability;
  projectPaths?: string[];
}

// Match LoopDefinitionStore.encode: common fields first, followed by the
// fields owned by the selected structure. `agentName` remains a supported
// Electron compatibility field and is serialized with the structure fields.
const LOOP_FIELD_ORDER = [
  "name",
  "description",
  "source",
  "structure",
  "writeTarget",
  "maxIterations",
  "validationCommand",
  "agentName",
  "makerName",
  "checkerName",
  "checkerRubric",
  "pipelineStages",
  "parallelBranches",
  "triageAgent",
  "classificationPrompt",
  "checkpointPrompt",
  "launchContextScope",
  "launchContextJSON",
  "availability",
  "projectPathsJSON",
] as const;
const LOOP_FIELD_KEYS = new Set<string>(LOOP_FIELD_ORDER);

function serializeFrontmatter(record: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const key of LOOP_FIELD_ORDER) {
    if (record[key] !== undefined) ordered[key] = record[key];
  }
  // Native-only metadata must survive Electron edits and copies. Sort it so
  // output does not depend on parser/object insertion order.
  for (const key of Object.keys(record)
    .filter((key) => !LOOP_FIELD_KEYS.has(key))
    .sort()) {
    if (record[key] !== undefined) ordered[key] = record[key];
  }
  return Object.entries(ordered)
    .map(([key, value]) =>
      key === "classificationPrompt"
        ? `classificationPrompt: ${normalizeLoopClassificationPrompt(asString(value))}`
        : key === "checkpointPrompt"
          ? `checkpointPrompt: ${normalizeLoopCheckpointPrompt(asString(value))}`
          : key === "launchContextJSON" || key === "projectPathsJSON"
            ? `${key}: ${JSON.stringify(value)}`
            : YAML.stringify({ [key]: value }).trimEnd(),
    )
    .join("\n");
}

function loopBasename(name: string): string {
  return `${loopSlug(name)}${LOOP_SUFFIX}`;
}

function compatibilityFilePath(roots: ResourceRoots, basename: string): string {
  return path.join(loopsDir(roots), basename);
}

/**
 * Create or update a loop by name. An UPDATE targets the loop's actual file
 * (found by name, so a native `.loop.md` whose filename doesn't match its slug
 * is edited in place, never orphaned). A CREATE writes `<slug>.loop.md` and
 * throws "loop_slug_conflict" if that slug is already taken by a different loop.
 * Unknown frontmatter round-trips.
 */
export function writeLoopFile(roots: ResourceRoots, edit: LoopEdit): string {
  const records = scanLoopRecords(roots);
  const existing = edit.id ? records.find((record) => record.loop.id === edit.id) : undefined;
  if (edit.id && !existing) throw new Error("loop_not_found");
  const basename = existing?.basename ?? loopBasename(edit.name);
  const filePath = compatibilityFilePath(roots, basename);
  let frontmatter: Record<string, unknown> = { ...(edit.preservedFrontmatter ?? {}) };
  let persistedClassificationPrompt: string | undefined;
  let persistedCheckpointPrompt: string | undefined;
  let body = "";
  if (existing) {
    const document = parseLoopDocument(existing.content);
    frontmatter = { ...document.frontmatter };
    persistedClassificationPrompt = nativeLineFrontmatterValue(
      existing.content,
      "classificationPrompt",
    );
    persistedCheckpointPrompt = nativeLineFrontmatterValue(existing.content, "checkpointPrompt");
    body = document.body.trim();
  }

  // Public writes are an authoritative capability boundary too. Existing
  // native/external definitions remain readable and deletable, but an update
  // that omits structure inherits the persisted value and must fail closed.
  // Only an explicit edit to a valid runnable structure converts an unsupported definition.
  const resultingStructure = edit.structure ?? asStructure(frontmatter.structure);
  if (!isRunnableLoopStructure(resultingStructure)) {
    throw new LoopStructureNotRunnableError(resultingStructure);
  }
  const validationError = loopDefinitionValidationError({
    name: edit.name,
    goal: edit.goal ?? body,
    structure: resultingStructure,
    agentName: edit.agentName ?? asString(frontmatter.agentName),
    makerName: edit.makerName ?? asString(frontmatter.makerName) ?? asString(frontmatter.agentName),
    checkerName: edit.checkerName ?? asString(frontmatter.checkerName),
    checkerRubric: edit.checkerRubric ?? asString(frontmatter.checkerRubric),
    pipelineStages: edit.pipelineStages ?? asPipelineStages(frontmatter.pipelineStages),
    parallelBranches: edit.parallelBranches ?? asParallelBranches(frontmatter.parallelBranches),
    triageAgent: edit.triageAgent ?? asString(frontmatter.triageAgent),
    classificationPrompt: normalizeLoopClassificationPrompt(
      edit.classificationPrompt ??
        persistedClassificationPrompt ??
        asString(frontmatter.classificationPrompt),
    ),
    checkpointPrompt: normalizeLoopCheckpointPrompt(
      edit.checkpointPrompt ?? persistedCheckpointPrompt ?? asString(frontmatter.checkpointPrompt),
    ),
    writeTarget: edit.writeTarget ?? asWriteTarget(frontmatter.writeTarget),
  });
  if (validationError) throw new LoopDefinitionInvalidError(validationError);

  if (!existing && records.some((record) => record.basename === basename)) {
    throw new Error("loop_slug_conflict");
  }

  frontmatter.name = edit.name;
  if (edit.description !== undefined) frontmatter.description = edit.description;
  if (edit.structure !== undefined) frontmatter.structure = edit.structure;
  if (edit.agentName !== undefined) {
    if (edit.agentName) frontmatter.agentName = edit.agentName;
    else delete frontmatter.agentName;
  }
  for (const key of ["makerName", "checkerName", "checkerRubric"] as const) {
    if (edit[key] !== undefined) {
      if (edit[key]) frontmatter[key] = edit[key];
      else delete frontmatter[key];
    }
  }
  if (edit.pipelineStages !== undefined) {
    frontmatter.pipelineStages = edit.pipelineStages.join(" | ");
  }
  if (edit.parallelBranches !== undefined) {
    frontmatter.parallelBranches = normalizeParallelBranches(edit.parallelBranches).join(" | ");
  }
  if (edit.triageAgent !== undefined) {
    if (edit.triageAgent) frontmatter.triageAgent = edit.triageAgent;
    else delete frontmatter.triageAgent;
  }
  if (resultingStructure === "discoveryTriage") {
    frontmatter.classificationPrompt = normalizeLoopClassificationPrompt(
      edit.classificationPrompt ??
        persistedClassificationPrompt ??
        asString(frontmatter.classificationPrompt),
    );
  } else if (edit.classificationPrompt !== undefined) {
    if (edit.classificationPrompt) frontmatter.classificationPrompt = edit.classificationPrompt;
    else delete frontmatter.classificationPrompt;
  }
  if (resultingStructure === "humanApproval") {
    frontmatter.checkpointPrompt = normalizeLoopCheckpointPrompt(
      edit.checkpointPrompt ?? persistedCheckpointPrompt ?? asString(frontmatter.checkpointPrompt),
    );
  } else if (edit.checkpointPrompt !== undefined) {
    if (edit.checkpointPrompt) frontmatter.checkpointPrompt = edit.checkpointPrompt;
    else delete frontmatter.checkpointPrompt;
  }
  if (edit.launchContext !== undefined) {
    const launchContext = normalizeLoopLaunchContext(edit.launchContext);
    delete frontmatter.launchContext;
    if (launchContext) {
      frontmatter.launchContextScope = edit.launchContextScope ?? "firstIterationOnly";
      frontmatter.launchContextJSON = launchContext;
    } else {
      delete frontmatter.launchContextScope;
      delete frontmatter.launchContextJSON;
    }
  } else if (edit.launchContextScope !== undefined && frontmatter.launchContextJSON !== undefined) {
    frontmatter.launchContextScope = edit.launchContextScope;
  }
  if (edit.maxIterations !== undefined) {
    frontmatter.maxIterations = clampMaxIterations(edit.maxIterations);
  }
  if (edit.validationCommand !== undefined) {
    if (edit.validationCommand) frontmatter.validationCommand = edit.validationCommand;
    else delete frontmatter.validationCommand;
  }
  if (edit.writeTarget !== undefined) frontmatter.writeTarget = edit.writeTarget;
  if (edit.availability !== undefined) frontmatter.availability = edit.availability;
  if (edit.projectPaths !== undefined || edit.availability !== undefined) {
    delete frontmatter.projectPaths;
    const projectPaths =
      (edit.availability ?? asAvailability(frontmatter.availability)) === "projectPaths"
        ? normalizeLoopProjectPaths(edit.projectPaths ?? [])
        : [];
    if (projectPaths.length) frontmatter.projectPathsJSON = projectPaths;
    else delete frontmatter.projectPathsJSON;
  }
  if (edit.goal !== undefined) body = edit.goal.trim();

  const content = `---\n${serializeFrontmatter(frontmatter)}\n---\n\n${body}\n`;
  try {
    if (existing) replaceLoopCatalogFile(roots.home, basename, content);
    else createLoopCatalogFile(roots.home, basename, content);
  } catch (error) {
    if (
      error instanceof LoopCatalogCapabilityError &&
      error.code === "LOOP_CATALOG_ALREADY_EXISTS"
    ) {
      throw new Error("loop_slug_conflict");
    }
    throw error;
  }
  return filePath;
}

/** Delete by opaque catalog identity. Display file paths are never used as authority. */
export function deleteLoopFile(roots: ResourceRoots, id: string): void {
  const existing = scanLoopRecords(roots).find((record) => record.loop.id === id);
  if (!existing) return;
  deleteLoopCatalogFile(roots.home, existing.basename);
}

export class LoopDefinitionInvalidError extends Error {
  readonly code = "loop_definition_invalid";

  constructor(message: string) {
    super(message);
    this.name = "LoopDefinitionInvalidError";
  }
}

export class LoopStructureNotRunnableError extends Error {
  readonly code = LOOP_STRUCTURE_UNSUPPORTED_CODE;

  constructor(readonly structure: LoopStructure) {
    super(LOOP_STRUCTURE_UNSUPPORTED_CODE);
    this.name = "LoopStructureNotRunnableError";
  }
}

/**
 * Duplicate a loop as a new "Copy of <name>" (native duplicateUserDefinition),
 * de-duplicating the name if a copy already exists. Returns the new loop's name.
 * Throws "loop_not_found" if the source doesn't exist, or
 * LoopStructureNotRunnableError when no engine exists for its structure.
 */
export function duplicateLoop(roots: ResourceRoots, id: string): string {
  const records = scanLoopRecords(roots);
  const sourceRecord = records.find((record) => record.loop.id === id);
  if (!sourceRecord) throw new Error("loop_not_found");
  const source = sourceRecord.loop;
  const loops = records.map((record) => record.loop);
  // This resource boundary is authoritative too: direct callers and a source
  // changed between a route's check and this scan must never copy an
  // unsupported structure. Check before deriving a destination name or writing.
  if (!isRunnableLoopStructure(source.structure)) {
    throw new LoopStructureNotRunnableError(source.structure);
  }
  // De-dup by SLUG (the filename key), not name — otherwise a name-unique copy
  // could still collide on disk with a differently-named loop and throw.
  const existingSlugs = new Set(loops.map((loop) => loopSlug(loop.name)));
  let copyName = `Copy of ${source.name}`;
  for (let n = 2; existingSlugs.has(loopSlug(copyName)); n += 1)
    copyName = `Copy of ${source.name} (${n})`;
  const sourceDocument = parseLoopDocument(sourceRecord.content);
  writeLoopFile(roots, {
    name: copyName,
    preservedFrontmatter: { ...sourceDocument.frontmatter },
    description: source.description,
    goal: source.goal,
    structure: source.structure,
    agentName: source.agentName,
    makerName: source.makerName,
    checkerName: source.checkerName,
    checkerRubric: source.checkerRubric,
    pipelineStages: source.pipelineStages ? [...source.pipelineStages] : undefined,
    parallelBranches: source.parallelBranches ? [...source.parallelBranches] : undefined,
    triageAgent: source.triageAgent,
    classificationPrompt: source.classificationPrompt,
    checkpointPrompt: source.checkpointPrompt,
    launchContext: source.launchContext,
    launchContextScope: source.launchContextScope,
    maxIterations: source.maxIterations,
    validationCommand: source.validationCommand,
    writeTarget: source.writeTarget,
    availability: source.availability,
    projectPaths: source.projectPaths,
  });
  return copyName;
}
