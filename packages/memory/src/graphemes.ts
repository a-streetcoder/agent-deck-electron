const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Swift-Character-like user-perceived character count. */
export function graphemeCount(value: string): number {
  let count = 0;
  for (const _segment of segmenter.segment(value)) count += 1;
  return count;
}

/** Truncate without splitting an extended grapheme cluster. */
export function truncateGraphemes(value: string, budget: number): string {
  if (budget === Number.POSITIVE_INFINITY) return value;
  if (!Number.isFinite(budget) || budget <= 0) return "";
  const limit = Math.floor(budget);
  let count = 0;
  let end = 0;
  for (const segment of segmenter.segment(value)) {
    if (count >= limit) break;
    end = segment.index + segment.segment.length;
    count += 1;
  }
  return end === value.length ? value : value.slice(0, end);
}
