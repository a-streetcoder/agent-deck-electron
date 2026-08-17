import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseMemory, serializeMemory } from "./frontmatter.ts";
import { truncateGraphemes } from "./graphemes.ts";
import { isSafeMemoryId, memoryFilePath, projectMemoryDir } from "./paths.ts";
import { scanForSecrets } from "./secrets.ts";
import { centeredCosineScores, type Embedder } from "./semantic.ts";
import {
  fuzzyMatchedTerms,
  informativeTerms,
  memoryTerms,
  overlapCoefficient,
  semanticInformativeTerms,
  semanticMemoryTerms,
  sharedTerms,
} from "./text.ts";
import type {
  MemoryRecord,
  MemorySearchHit,
  MemoryStatus,
  MemoryType,
  MemoryWriteInput,
  MemoryWriteResult,
} from "./types.ts";

/**
 * The project-scoped Markdown memory store. Files are the source of truth; the
 * list is derived by scanning the project's memory directory (bounded by the
 * number of memories, which is small). All timestamps are absolute ISO strings.
 */

/** Overlap coefficient at/above which a new write is held as a near-duplicate. */
const DUPLICATE_OVERLAP = 0.6;
/** A memory must share at least this many EXACT informative terms to be a hit. */
const MIN_SHARED_TERMS = 1;
/**
 * With no exact overlap, a memory needs at least this many one-edit near-misses
 * to be a hit. A LONE near-miss is too weak — one coincidental edit-distance-1
 * pair (e.g. "stale"/"scale") would otherwise surface an unrelated memory — so a
 * fuzzy-only recall requires corroboration.
 */
const MIN_FUZZY_ONLY = 2;
/** A one-edit (typo/near-miss) term match counts for less than an exact one. */
const FUZZY_WEIGHT = 0.5;
const DEFAULT_SEARCH_LIMIT = 8;
/** Native-calibrated semantic qualification and relative-keep thresholds. */
const STRONG_SEMANTIC_SCORE = 0.5;
const STRONG_MIN_OVERLAP = 1;
const MIN_QUERY_OVERLAP = 2;
const MIN_BEST_SCORE = 0.1;
const KEEP_SCORE_RATIO = 0.6;
const OVERLAP_BONUS = 0.12;
const OVERLAP_BONUS_CAP = 4;
const DISCRIMINATIVE_MIN_DOC_COUNT = 5;
const DISCRIMINATIVE_MAX_DOC_FRACTION = 0.2;
const SEMANTIC_SCORE_BUCKET = 0.02;
/** Cap on the injected project memory index (memory.md: 40 for parents). */
const DEFAULT_INDEX_CAP = 40;

export interface MemoryStore {
  /** App-owned base dir (e.g. <server data dir>/memory). */
  baseDir: string;
  /** The project whose memory this is; determines the storage subdir. */
  projectPath: string;
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug || "memory";
}

function hasProject(store: MemoryStore): boolean {
  return store.projectPath.trim().length > 0;
}

/** A collision-free id: regenerate the random suffix if a file already exists. */
function uniqueId(store: MemoryStore, type: MemoryType, title: string): string {
  const stamp = new Date()
    .toISOString()
    .replace(/[-:T.Z]/g, "")
    .slice(0, 14);
  const base = `mem_${stamp}_${type}_${slugify(title)}`;
  for (;;) {
    const id = `${base}_${randomUUID().slice(0, 8)}`;
    if (!existsSync(memoryFilePath(store.baseDir, store.projectPath, id))) return id;
  }
}

function writeRecord(store: MemoryStore, record: MemoryRecord): void {
  mkdirSync(projectMemoryDir(store.baseDir, store.projectPath), { recursive: true });
  writeFileSync(
    memoryFilePath(store.baseDir, store.projectPath, record.id),
    serializeMemory(record),
  );
}

/** Every memory for the project, most-recently-updated first. */
export function listMemories(store: MemoryStore): MemoryRecord[] {
  if (!hasProject(store)) return [];
  const dir = projectMemoryDir(store.baseDir, store.projectPath);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const records: MemoryRecord[] = [];
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    try {
      const record = parseMemory(readFileSync(path.join(dir, name), "utf8"));
      if (record) records.push(record);
    } catch {
      // Unreadable file — skip.
    }
  }
  return records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function getMemory(store: MemoryStore, id: string): MemoryRecord | null {
  // Reject traversal ids before they reach a path join — this is what keeps a
  // caller-supplied id (write-by-id, mark-stale) inside its own project's dir.
  if (!hasProject(store) || !isSafeMemoryId(id)) return null;
  try {
    return parseMemory(readFileSync(memoryFilePath(store.baseDir, store.projectPath, id), "utf8"));
  } catch {
    return null;
  }
}

/** Memories eligible for recall/injection: active or pinned. */
function injectable(records: MemoryRecord[]): MemoryRecord[] {
  return records.filter((r) => r.status === "active" || r.status === "pinned");
}

/**
 * Write a memory. An `id` updates in place (reactivating a stale memory, since
 * the agent is asserting the fact is current); otherwise a new memory is
 * created, subject to secret scanning and the near-duplicate guard.
 */
export function writeMemory(store: MemoryStore, input: MemoryWriteInput): MemoryWriteResult {
  if (!hasProject(store)) {
    return {
      ok: false,
      reason: "no_project",
      message: "Memory needs a project — no project path is set for this session.",
    };
  }
  const secret = scanForSecrets(input.title, input.summary, input.body);
  if (secret.hasSecret) {
    return {
      ok: false,
      reason: "secret",
      message: `Write blocked: the content looks like it contains a secret (${secret.matched.join(", ")}). Remove it and try again.`,
    };
  }

  const now = new Date().toISOString();

  if (input.id) {
    const existing = getMemory(store, input.id);
    if (!existing) {
      return { ok: false, reason: "not_found", message: `No memory with id ${input.id}.` };
    }
    const updated: MemoryRecord = {
      ...existing,
      type: input.type,
      title: input.title,
      summary: input.summary,
      body: input.body,
      tags: input.tags ?? existing.tags,
      // Updating a stale memory reactivates it; otherwise keep pinned/active.
      status: input.status ?? (existing.status === "stale" ? "active" : existing.status),
      writeReason: input.writeReason ?? existing.writeReason,
      // FIRST author wins. Native's updateMemory does not take or touch
      // sourceAgentName at all (AgentMemoryStore.swift:218) — provenance is set
      // once at creation — so agent B updating agent A's memory by id must not
      // relabel it as B's. An input name is adopted only by a record that has
      // none, which backfills a memory written before provenance existed.
      sourceAgentName: existing.sourceAgentName ?? input.sourceAgentName,
      updatedAt: now,
    };
    writeRecord(store, updated);
    return { ok: true, record: updated, created: false };
  }

  if (!input.confirmNew) {
    const candidateTerms = memoryTerms({
      title: input.title,
      summary: input.summary,
      tags: input.tags ?? [],
    });
    for (const existing of injectable(listMemories(store))) {
      if (overlapCoefficient(candidateTerms, memoryTerms(existing)) >= DUPLICATE_OVERLAP) {
        return {
          ok: false,
          reason: "duplicate",
          existing,
          message: `This looks like a near-duplicate of "${existing.title}" (id ${existing.id}). Pass that id to update it in place, or set confirmNew to store it as a distinct memory.`,
        };
      }
    }
  }

  const record: MemoryRecord = {
    id: uniqueId(store, input.type, input.title),
    type: input.type,
    scope: "project",
    status: input.status ?? "active",
    title: input.title,
    summary: input.summary,
    body: input.body,
    createdAt: now,
    updatedAt: now,
    tags: input.tags ?? [],
    writeReason: input.writeReason,
    sourceAgentName: input.sourceAgentName,
    useCount: 0,
  };
  writeRecord(store, record);
  return { ok: true, record, created: true };
}

/** Change a memory's status (pin / stale / archive / re-activate). */
export function setMemoryStatus(
  store: MemoryStore,
  id: string,
  status: MemoryStatus,
): MemoryWriteResult {
  const existing = getMemory(store, id);
  if (!existing) {
    return { ok: false, reason: "not_found", message: `No memory with id ${id}.` };
  }
  const updated: MemoryRecord = { ...existing, status, updatedAt: new Date().toISOString() };
  writeRecord(store, updated);
  return { ok: true, record: updated, created: false };
}

/** Mark a memory stale so it stops being injected (kept for inspection). */
/**
 * Record that recall INJECTED these memories (MEM-10, native
 * `AgentMemoryStore.markUsed`): stamp `lastUsedAt` and bump `useCount`, skipping
 * ids this store does not hold. `updatedAt` is deliberately untouched — a recall
 * is not an edit, and moving it would reorder the memory list and make every
 * recall look like a write.
 */
export function markMemoriesUsed(store: MemoryStore, ids: readonly string[]): void {
  if (!hasProject(store)) return;
  const usedAt = new Date().toISOString();
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    const record = getMemory(store, id);
    if (!record) continue;
    writeRecord(store, { ...record, useCount: record.useCount + 1, lastUsedAt: usedAt });
  }
}

/**
 * Delete `id` ONLY while it is still stale — the guarantee a bulk stale cleanup
 * rests on, kept in ONE place so no caller can re-implement it and forget the
 * check (MEM-14). Returns false when the memory is unknown or no longer stale.
 *
 * The read and the unlink are separate filesystem operations, so a process that
 * reactivates the memory inside that window can still lose it. That is the same
 * non-atomicity every mutation in this store has (writeMemory, setMemoryStatus
 * and markStale are all read-modify-write without locks) and it predates this
 * function; closing it needs store-wide locking, not a special case here.
 */
export function deleteMemoryIfStale(store: MemoryStore, id: string): boolean {
  return getMemory(store, id)?.status === "stale" ? deleteMemory(store, id) : false;
}

export function markStale(store: MemoryStore, id: string): MemoryWriteResult {
  return setMemoryStatus(store, id, "stale");
}

/** Permanently delete a memory file. Returns false if it didn't exist. */
export function deleteMemory(store: MemoryStore, id: string): boolean {
  // getMemory enforces the project guard + rejects traversal ids, so an unsafe
  // id can never reach unlink with a path outside the project dir.
  if (!getMemory(store, id)) return false;
  try {
    rmSync(memoryFilePath(store.baseDir, store.projectPath, id), { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Lexical recall over active/pinned memories: rank by the informative terms the
 * query shares with each memory's title/summary/tags, plus a smaller credit for
 * one-edit typo/near-miss matches (so "postgress migation" still recalls a
 * "Postgres migration" memory that exact overlap would miss). Small pinned
 * boost, recency as the tie-breaker. A fuzzy-only hit needs ≥ MIN_FUZZY_ONLY
 * near-misses so one coincidental near-miss can't surface an unrelated memory.
 * Abstains (empty) when the query carries no informative terms or nothing
 * matches. `sharedTerms` on a hit stays the EXACT overlap — fuzzy matches lift
 * the score but aren't reported as shared.
 */
export function searchMemories(
  store: MemoryStore,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): MemorySearchHit[] {
  const queryTerms = informativeTerms(query);
  if (queryTerms.size === 0) return [];
  const hits: MemorySearchHit[] = [];
  for (const record of injectable(listMemories(store))) {
    const memTerms = memoryTerms(record);
    const shared = sharedTerms(queryTerms, memTerms);
    const fuzzy = fuzzyMatchedTerms(queryTerms, memTerms);
    // An exact match alone qualifies; a fuzzy-only hit needs corroboration.
    if (shared.length < MIN_SHARED_TERMS && fuzzy.length < MIN_FUZZY_ONLY) continue;
    hits.push({
      record,
      score: shared.length + FUZZY_WEIGHT * fuzzy.length + (record.status === "pinned" ? 0.5 : 0),
      sharedTerms: shared,
    });
  }
  hits.sort((a, b) => b.score - a.score || b.record.updatedAt.localeCompare(a.record.updatedAt));
  return hits.slice(0, limit);
}

/** Text embedded for a memory's semantic vector — title + summary + bounded body. */
function memoryEmbedText(record: MemoryRecord): string {
  const bodyPrefix = record.body.slice(0, 600).trim();
  return bodyPrefix
    ? `${record.title}\n${record.summary}\n${bodyPrefix}`
    : `${record.title}\n${record.summary}`;
}

function validEmbeddingBatch(vectors: number[][], expectedCount: number): boolean {
  if (vectors.length !== expectedCount) return false;
  const dimension = vectors[0]?.length ?? 0;
  return (
    dimension > 0 &&
    vectors.every(
      (vector) => vector.length === dimension && vector.every((value) => Number.isFinite(value)),
    )
  );
}

function discriminativeOverlaps(
  records: MemoryRecord[],
  queryTerms: Set<string>,
): Array<{ count: number; shared: string[] }> {
  const termsByRecord = records.map(semanticMemoryTerms);
  const documentFrequency = new Map<string, number>();
  for (const terms of termsByRecord) {
    for (const term of terms) {
      documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
    }
  }

  return termsByRecord.map((terms) => {
    const shared = sharedTerms(queryTerms, terms);
    const count = shared.filter((term) => {
      const documentCount = documentFrequency.get(term) ?? 0;
      return !(
        documentCount >= DISCRIMINATIVE_MIN_DOC_COUNT &&
        documentCount / records.length > DISCRIMINATIVE_MAX_DOC_FRACTION
      );
    }).length;
    // Preserve the public hit contract: sharedTerms reports every exact shared
    // term even though only the discriminative subset qualifies and scores.
    return { count, shared };
  });
}

/**
 * Semantic recall with native-calibrated qualification and abstention. Embedding
 * similarity ranks only memories corroborated by discriminative title, summary,
 * or tag vocabulary; incidental body terms never qualify a hit. The injected
 * embedder remains optional at the server boundary, and failures or malformed
 * vectors safely fall back to the existing lexical search.
 *
 * `semanticWeight` remains accepted for source compatibility with earlier
 * callers, but native-calibrated hybrid scoring intentionally does not vary it.
 */
export type SemanticSearchFailure = "embedding_failed" | "invalid_embedding";

export type SemanticSearchOutcome =
  | { hits: MemorySearchHit[]; mode: "semantic" }
  | { hits: MemorySearchHit[]; mode: "lexical_fallback"; reason: SemanticSearchFailure };

/** Outcome-bearing semantic search for owners that must surface fallback truthfully. */
export async function semanticSearchMemoriesWithOutcome(
  store: MemoryStore,
  query: string,
  embedder: Embedder,
  options: { limit?: number; semanticWeight?: number } = {},
): Promise<SemanticSearchOutcome> {
  const limit = Math.max(0, options.limit ?? DEFAULT_SEARCH_LIMIT);
  const records = injectable(listMemories(store));
  if (limit === 0 || records.length === 0 || !query.trim()) return { hits: [], mode: "semantic" };

  let vectors: number[][];
  try {
    vectors = await embedder.embed([query, ...records.map(memoryEmbedText)]);
  } catch {
    return {
      hits: searchMemories(store, query, limit),
      mode: "lexical_fallback",
      reason: "embedding_failed",
    };
  }
  if (!validEmbeddingBatch(vectors, records.length + 1)) {
    return {
      hits: searchMemories(store, query, limit),
      mode: "lexical_fallback",
      reason: "invalid_embedding",
    };
  }
  const [queryVec, ...docVecs] = vectors as [number[], ...number[][]];
  const rawScores = centeredCosineScores(queryVec, docVecs);

  // An exactly-centroid query has no semantic direction and must abstain rather
  // than turning lexical overlap into a result on ambiguous geometry.
  if (rawScores.length !== records.length) return { hits: [], mode: "semantic" };

  const overlaps = discriminativeOverlaps(records, semanticInformativeTerms(query));
  const centered = records.length >= 2;
  const ranked = records.map((record, index) => {
    const raw = rawScores[index]!;
    const overlap = overlaps[index]!;
    return {
      record,
      raw,
      overlap: overlap.count,
      hit: {
        record,
        score: raw + OVERLAP_BONUS * Math.min(overlap.count, OVERLAP_BONUS_CAP),
        sharedTerms: overlap.shared,
      } satisfies MemorySearchHit,
    };
  });
  ranked.sort((a, b) => {
    // Native deliberately quantizes score before metadata ordering: pin, usage
    // and recency may settle a near-tie but never add relevance points. The
    // order matches AgentMemoryStore.swift:314-323 exactly — bucket, pinned,
    // useCount, updatedAt — so a memory that keeps proving useful wins over a
    // same-bucket neighbour and never outranks a better match (MEM-08).
    const scoreBucketDifference =
      Math.floor(b.hit.score / SEMANTIC_SCORE_BUCKET) -
      Math.floor(a.hit.score / SEMANTIC_SCORE_BUCKET);
    return (
      scoreBucketDifference ||
      Number(b.record.status === "pinned") - Number(a.record.status === "pinned") ||
      b.record.useCount - a.record.useCount ||
      b.record.updatedAt.localeCompare(a.record.updatedAt)
    );
  });

  const qualified = ranked.filter(({ raw, overlap }) =>
    centered
      ? (raw >= STRONG_SEMANTIC_SCORE && overlap >= STRONG_MIN_OVERLAP) ||
        overlap >= MIN_QUERY_OVERLAP
      : overlap >= MIN_QUERY_OVERLAP,
  );
  const best = qualified[0]?.hit.score;
  if (best === undefined || best < MIN_BEST_SCORE) return { hits: [], mode: "semantic" };

  const keepCutoff = best * KEEP_SCORE_RATIO;
  return {
    mode: "semantic",
    hits: qualified
      .filter(({ hit }) => hit.score >= keepCutoff)
      .slice(0, limit)
      .map(({ hit }) => hit),
  };
}

/** Backward-compatible hit-only API. Fallback remains intentionally transparent here. */
export async function semanticSearchMemories(
  store: MemoryStore,
  query: string,
  embedder: Embedder,
  options: { limit?: number; semanticWeight?: number } = {},
): Promise<MemorySearchHit[]> {
  return (await semanticSearchMemoriesWithOutcome(store, query, embedder, options)).hits;
}

/**
 * The project memory index injected at launch (memory.md §Memory Policy
 * Injection): one line per injectable memory — id · type · title — summary — so
 * the agent knows what is stored before deciding to write or search. Bodies are
 * never here.
 */
export function injectableIndex(
  store: MemoryStore,
  cap: number = DEFAULT_INDEX_CAP,
): { lines: string[]; overflow: number } {
  const records = injectable(listMemories(store));
  const lines = records.slice(0, cap).map((record) => {
    const summary = truncateGraphemes(record.summary, 110);
    const suffix = summary === record.summary ? "" : "…";
    return `${record.id} · ${record.type} · ${record.title} — ${summary}${suffix}`;
  });
  return { lines, overflow: Math.max(0, records.length - cap) };
}
