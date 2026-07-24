import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  clampMaxIterations,
  isRunnableLoopStructure,
  loopDefinitionValidationError,
  normalizeParallelBranches,
  LOOP_STRUCTURES,
  LOOP_STRUCTURE_UNSUPPORTED_CODE,
  LOOP_WRITE_TARGETS,
  type LoopDefinition,
  type LoopStructure,
  type LoopWriteTarget,
} from "@agent-deck/domain";
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

export function parseLoopFile(filePath: string, content: string): LoopDefinition {
  const { frontmatter, body } = parseFrontmatter(content);
  const base = path.basename(filePath).replace(/\.loop\.md$/i, "");
  return {
    id: filePath,
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
    maxIterations: clampMaxIterations(Number(frontmatter.maxIterations)),
    validationCommand: asString(frontmatter.validationCommand) ?? "",
    writeTarget: asWriteTarget(frontmatter.writeTarget),
    source: "user",
    filePath,
  };
}

export function scanLoops(roots: ResourceRoots): LoopDefinition[] {
  const dir = loopsDir(roots);
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return []; // no loops dir yet
  }
  const loops: LoopDefinition[] = [];
  for (const entry of entries) {
    if (!entry.toLowerCase().endsWith(LOOP_SUFFIX)) continue;
    const filePath = path.join(dir, entry);
    try {
      loops.push(parseLoopFile(filePath, readFileSync(filePath, "utf8")));
    } catch {
      // Skip a malformed file.
    }
  }
  return loops.sort((a, b) => a.name.localeCompare(b.name));
}

export interface LoopEdit {
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
  maxIterations?: number;
  validationCommand?: string;
  writeTarget?: LoopWriteTarget;
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
  return YAML.stringify(ordered).trimEnd();
}

function loopFilePath(roots: ResourceRoots, name: string): string {
  const dir = loopsDir(roots);
  const filePath = path.join(dir, `${loopSlug(name)}${LOOP_SUFFIX}`);
  // Defense-in-depth: the resolved file must stay inside the loops dir.
  if (!path.resolve(filePath).startsWith(path.resolve(dir) + path.sep)) {
    throw new Error("refusing to write outside the loops catalog");
  }
  return filePath;
}

/** The on-disk file of the loop whose name matches, regardless of its filename. */
function loopPathByName(roots: ResourceRoots, name: string): string | undefined {
  return scanLoops(roots).find((loop) => loop.name === name)?.filePath;
}

/**
 * Create or update a loop by name. An UPDATE targets the loop's actual file
 * (found by name, so a native `.loop.md` whose filename doesn't match its slug
 * is edited in place, never orphaned). A CREATE writes `<slug>.loop.md` and
 * throws "loop_slug_conflict" if that slug is already taken by a different loop.
 * Unknown frontmatter round-trips.
 */
export function writeLoopFile(roots: ResourceRoots, edit: LoopEdit): string {
  const dir = loopsDir(roots);
  const existingPath = loopPathByName(roots, edit.name);
  const filePath = existingPath ?? loopFilePath(roots, edit.name);
  let frontmatter: Record<string, unknown> = { ...(edit.preservedFrontmatter ?? {}) };
  let body = "";
  if (existingPath) {
    const existing = parseFrontmatter(readFileSync(filePath, "utf8"));
    frontmatter = { ...existing.frontmatter };
    body = existing.body.trim();
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
    writeTarget: edit.writeTarget ?? asWriteTarget(frontmatter.writeTarget),
  });
  if (validationError) throw new LoopDefinitionInvalidError(validationError);

  if (!existingPath && existsSync(filePath)) {
    // The slug is occupied by a loop with a different name — refuse to clobber.
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
  if (edit.maxIterations !== undefined) {
    frontmatter.maxIterations = clampMaxIterations(edit.maxIterations);
  }
  if (edit.validationCommand !== undefined) {
    if (edit.validationCommand) frontmatter.validationCommand = edit.validationCommand;
    else delete frontmatter.validationCommand;
  }
  if (edit.writeTarget !== undefined) frontmatter.writeTarget = edit.writeTarget;
  if (edit.goal !== undefined) body = edit.goal.trim();

  mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, `---\n${serializeFrontmatter(frontmatter)}\n---\n\n${body}\n`);
  return filePath;
}

/** Delete a loop by name (its actual file, not the re-derived slug). No-op if absent. */
export function deleteLoopFile(roots: ResourceRoots, name: string): void {
  const filePath = loopPathByName(roots, name) ?? loopFilePath(roots, name);
  rmSync(filePath, { force: true });
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
export function duplicateLoop(roots: ResourceRoots, name: string): string {
  const loops = scanLoops(roots);
  const source = loops.find((loop) => loop.name === name);
  if (!source) throw new Error("loop_not_found");
  // This resource boundary is authoritative too: direct callers and a source
  // changed between a route's check and this scan must never copy an
  // unsupported structure. Check before deriving a destination name or writing.
  if (!isRunnableLoopStructure(source.structure)) {
    throw new LoopStructureNotRunnableError(source.structure);
  }
  // De-dup by SLUG (the filename key), not name — otherwise a name-unique copy
  // could still collide on disk with a differently-named loop and throw.
  const existingSlugs = new Set(loops.map((loop) => loopSlug(loop.name)));
  let copyName = `Copy of ${name}`;
  for (let n = 2; existingSlugs.has(loopSlug(copyName)); n += 1)
    copyName = `Copy of ${name} (${n})`;
  const sourceDocument = parseFrontmatter(readFileSync(source.filePath, "utf8"));
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
    maxIterations: source.maxIterations,
    validationCommand: source.validationCommand,
    writeTarget: source.writeTarget,
  });
  return copyName;
}
