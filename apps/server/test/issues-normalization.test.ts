import { describe, expect, it } from "vitest";
import { normalizeGitHubIssueList, type RawGitHubIssueListRow } from "../src/githubIssues.ts";

function rows(count: number): RawGitHubIssueListRow[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `Issue ${index + 1}`,
    state: "OPEN",
    url: `https://example.test/issues/${index + 1}`,
  }));
}

describe("GitHub issue list normalization", () => {
  it("does not mark 49 rows incomplete", () => {
    const result = normalizeGitHubIssueList(rows(49));
    expect(result.issues).toHaveLength(49);
    expect(result.incompleteResults).toBe(false);
  });

  it("does not mark exactly 50 rows incomplete", () => {
    const result = normalizeGitHubIssueList(rows(50));
    expect(result.issues).toHaveLength(50);
    expect(result.incompleteResults).toBe(false);
  });

  it("caps 51 rows at the first 50 and marks the result incomplete", () => {
    const result = normalizeGitHubIssueList(rows(51));
    expect(result.issues).toHaveLength(50);
    expect(result.issues.at(-1)?.number).toBe(50);
    expect(result.incompleteResults).toBe(true);
  });
});
