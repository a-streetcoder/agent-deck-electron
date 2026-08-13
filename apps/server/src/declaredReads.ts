import path from "node:path";

export const MAX_MANAGED_SUBAGENT_TASK_BYTES = 50_000;
export const MAX_DECLARED_READS = 32;
export const MAX_DECLARED_READ_BYTES = 512;
export const SUBAGENT_ARTIFACT_INPUT_MAX_BYTES = 50 * 1024;
const DECLARED_READS_ARTIFACT_PREFIX =
  "\n\nRead first (project-relative hints; contents are not preloaded):\n";
/**
 * Leaves room at the maximum task size for the fixed artifact wrapper and the
 * worst-case 31 list separators. This is intentionally a UTF-8 byte budget.
 */
export const MAX_DECLARED_READS_TOTAL_BYTES =
  SUBAGENT_ARTIFACT_INPUT_MAX_BYTES -
  MAX_MANAGED_SUBAGENT_TASK_BYTES -
  Buffer.byteLength(DECLARED_READS_ARTIFACT_PREFIX, "utf8") -
  (MAX_DECLARED_READS - 1);

const hasControlContent = (value: string): boolean =>
  [...value].some((character) => {
    const point = character.codePointAt(0)!;
    return (
      point <= 0x1f || (point >= 0x7f && point <= 0x9f) || point === 0x2028 || point === 0x2029
    );
  });

/** Validate model-authored path hints once at the managed_subagent boundary. */
export function normalizeDeclaredReads(reads: readonly string[] | undefined): string[] | undefined {
  if (reads === undefined) return undefined;
  const normalized: string[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const raw of reads) {
    if (hasControlContent(raw)) {
      throw new Error("declared reads cannot contain multiline or control content");
    }
    const value = raw.trim();
    if (!value) throw new Error("declared read paths cannot be empty");
    const valueBytes = Buffer.byteLength(value, "utf8");
    if (valueBytes > MAX_DECLARED_READ_BYTES) {
      throw new Error(`declared read paths cannot exceed ${MAX_DECLARED_READ_BYTES} UTF-8 bytes`);
    }
    if (
      path.posix.isAbsolute(value) ||
      path.win32.isAbsolute(value) ||
      /^[A-Za-z]:/u.test(value) ||
      value.split(/[\\/]/u).includes("..")
    ) {
      throw new Error(
        "declared reads must be single-line project-relative paths without traversal",
      );
    }
    if (seen.has(value)) continue;
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

export function renderSubagentArtifactInput(
  task: string,
  declaredReads: readonly string[] | undefined,
): string {
  return declaredReads && declaredReads.length > 0
    ? `${task}${DECLARED_READS_ARTIFACT_PREFIX}${declaredReads.join("\n")}`
    : task;
}
