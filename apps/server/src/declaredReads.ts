import {
  AGENT_DEFAULT_READ_MAX_BYTES,
  AGENT_DEFAULT_READ_MAX_ITEMS,
  AGENT_DEFAULT_READ_TOTAL_MAX_BYTES,
  normalizeAgentDefaultReads,
  projectRelativeReadError,
} from "@agent-deck/domain";

export const MAX_MANAGED_SUBAGENT_TASK_BYTES = 50_000;
export const MAX_DECLARED_READS = AGENT_DEFAULT_READ_MAX_ITEMS;
export const MAX_DECLARED_READ_BYTES = AGENT_DEFAULT_READ_MAX_BYTES;
export const SUBAGENT_ARTIFACT_INPUT_MAX_BYTES = 50 * 1024;
const DECLARED_READS_ARTIFACT_PREFIX =
  "\n\nRead first (project-relative hints; contents are not preloaded):\n";
/** Shared path-byte budget; with the fixed wrapper and worst-case separators,
 * this keeps a maximum task inside the native artifact input limit. */
export const MAX_DECLARED_READS_TOTAL_BYTES = AGENT_DEFAULT_READ_TOTAL_MAX_BYTES;

/** Validate model-authored path hints once at the managed_subagent boundary. */
export function normalizeDeclaredReads(reads: readonly string[] | undefined): string[] | undefined {
  if (reads === undefined) return undefined;
  const normalized: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const raw of reads) {
    const safetyError = projectRelativeReadError(raw);
    if (safetyError) throw new Error(`declared read paths ${safetyError}`);
    const value = raw.trim();
    if (seen.has(value)) continue;
    if (normalized.length >= MAX_DECLARED_READS) {
      throw new Error(`declared reads cannot exceed ${MAX_DECLARED_READS} paths`);
    }
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (totalBytes + valueBytes > MAX_DECLARED_READS_TOTAL_BYTES) {
      throw new Error(
        `declared read paths cannot exceed ${MAX_DECLARED_READS_TOTAL_BYTES} UTF-8 bytes in total`,
      );
    }
    totalBytes += valueBytes;
    seen.add(value);
    normalized.push(value);
  }
  return normalized;
}

/** Merge current authored defaults before strict caller hints. Defaults fail soft
 * entry-by-entry; the effective list itself must fit the shared hard budget. */
export function effectiveDeclaredReads(
  defaults: readonly string[] | undefined,
  caller: readonly string[] | undefined,
): string[] {
  return (
    normalizeDeclaredReads([...(normalizeAgentDefaultReads(defaults) ?? []), ...(caller ?? [])]) ??
    []
  );
}

export function renderSubagentArtifactInput(
  task: string,
  declaredReads: readonly string[] | undefined,
): string {
  return declaredReads && declaredReads.length > 0
    ? `${task}${DECLARED_READS_ARTIFACT_PREFIX}${declaredReads.join("\n")}`
    : task;
}
