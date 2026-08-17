import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { MEMORY_STATUSES, MEMORY_TYPES, type MemoryRecord } from "./types.ts";

/**
 * A memory file is YAML frontmatter + a Markdown body (memory.md §Memory File
 * Format). The frontmatter is the durable metadata; the body is the content.
 */

/** Ranking only needs ordering, so a counter this large is already meaningless;
 * clamping keeps arithmetic exact and the YAML small. */
const MAX_USE_COUNT = 1_000_000_000;

export function serializeMemory(record: MemoryRecord): string {
  const frontmatter = stringifyYaml({
    id: record.id,
    type: record.type,
    scope: record.scope,
    status: record.status,
    title: record.title,
    summary: record.summary,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    tags: record.tags,
    writeReason: record.writeReason ?? "",
    sourceAgentName: record.sourceAgentName ?? "",
    useCount: record.useCount,
    lastUsedAt: record.lastUsedAt ?? "",
  }).trimEnd();
  return `---\n${frontmatter}\n---\n\n${record.body.trim()}\n`;
}

// Tolerate CRLF: a memory file may be hand-edited on Windows even though we
// always write LF.
const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" && value.trim()) {
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return [];
}

/** Parse a memory file. Returns null when the frontmatter is missing/invalid. */
export function parseMemory(text: string): MemoryRecord | null {
  const match = FRONTMATTER.exec(text);
  if (!match) return null;
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = parseYaml(match[1]!);
    if (typeof parsed !== "object" || parsed === null) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = String(data.type ?? "");
  const status = String(data.status ?? "active");
  if (!MEMORY_TYPES.includes(type as MemoryRecord["type"])) return null;
  const id = typeof data.id === "string" ? data.id : "";
  const title = typeof data.title === "string" ? data.title : "";
  if (!id || !title) return null;
  return {
    id,
    type: type as MemoryRecord["type"],
    scope: "project",
    status: MEMORY_STATUSES.includes(status as MemoryRecord["status"])
      ? (status as MemoryRecord["status"])
      : "active",
    title,
    summary: typeof data.summary === "string" ? data.summary : "",
    body: (match[2] ?? "").trim(),
    createdAt: typeof data.createdAt === "string" ? data.createdAt : "",
    updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : "",
    tags: asStringArray(data.tags),
    writeReason:
      typeof data.writeReason === "string" && data.writeReason ? data.writeReason : undefined,
    sourceAgentName:
      typeof data.sourceAgentName === "string" && data.sourceAgentName
        ? data.sourceAgentName
        : undefined,
    // Usage metadata (MEM-08/09/10) arrived after users already had memory
    // files, so a manifest without these keys is NORMAL, not corrupt: default
    // to unused rather than NaN. A non-integer or negative value on disk is
    // equally untrusted — clamp it instead of propagating it into ranking.
    // A hand-edited manifest is untrusted: only a SAFE integer inside a sane
    // bound survives. Number.isInteger alone accepts 1e21, where `count + 1`
    // equals `count`, so the counter would silently stop advancing (Codex).
    useCount:
      typeof data.useCount === "number" && Number.isSafeInteger(data.useCount) && data.useCount > 0
        ? Math.min(data.useCount, MAX_USE_COUNT)
        : 0,
    lastUsedAt:
      typeof data.lastUsedAt === "string" && data.lastUsedAt ? data.lastUsedAt : undefined,
  };
}
