import { describe, expect, it } from "vitest";
import { normalizeRestIssueList, type RawRestIssueRow } from "../src/githubIssues.ts";

function rows(count: number): RawRestIssueRow[] {
  return Array.from({ length: count }, (_, index) => ({
    number: index + 1,
    title: `Issue ${index + 1}`,
    state: "open",
    html_url: `https://github.com/acme/one/issues/${index + 1}`,
  }));
}

describe("normalizeRestIssueList truncation boundaries", () => {
  it("does not mark fewer than 50 incomplete", () => {
    const result = normalizeRestIssueList(rows(49));
    expect(result.issues).toHaveLength(49);
    expect(result.incompleteResults).toBe(false);
  });

  it("does not claim incompleteness at exactly 50", () => {
    const result = normalizeRestIssueList(rows(50));
    expect(result.issues).toHaveLength(50);
    expect(result.incompleteResults).toBe(false);
  });

  it("caps at 50 and discloses a 51st ISSUE (PRs never count)", () => {
    const result = normalizeRestIssueList(rows(51));
    expect(result.issues).toHaveLength(50);
    expect(result.issues.at(-1)?.number).toBe(50);
    expect(result.incompleteResults).toBe(true);
    // 50 issues + a PR page-mate is NOT truncation — PRs are excluded first
    const mixed = [...rows(50), { ...rows(1)[0]!, number: 99, pull_request: {} }];
    expect(normalizeRestIssueList(mixed).incompleteResults).toBe(false);
  });
});
