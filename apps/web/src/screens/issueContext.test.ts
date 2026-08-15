import { describe, expect, it } from "vitest";
import { buildIssueContext } from "./issueContext.ts";

/**
 * ISS-03: the Open-in-Pi seed carries native PiIssuePromptBuilder's structured
 * context block — metadata, body, and every comment — not a thin three-liner.
 */

describe("buildIssueContext (ISS-03)", () => {
  it("renders the full native-shaped block and omits absent optionals", () => {
    const block = buildIssueContext(
      {
        number: 7,
        title: "Flux capacitor",
        body: "# Steps\nreproduce",
        state: "CLOSED",
        stateReason: "COMPLETED",
        url: "https://github.com/acme/widgets/issues/7",
        createdAt: "2026-01-01T00:00:00Z",
        updatedAt: "2026-01-02T00:00:00Z",
        closedAt: "2026-01-03T00:00:00Z",
        labels: ["bug", "p1"],
        assignees: ["marty"],
        author: "doc",
        comments: [
          {
            id: "IC_1",
            url: "https://github.com/acme/widgets/issues/7#c1",
            author: "marty",
            body: "I can repro.",
            createdAt: "2026-01-15T10:00:00Z",
            updatedAt: "2026-01-16T10:00:00Z",
          },
        ],
      },
      "Widgets",
      "C:/work/widgets",
    );
    expect(block.startsWith("<github-issue-context>")).toBe(true);
    expect(block.endsWith("</github-issue-context>")).toBe(true);
    expect(block).toContain("project: Widgets");
    expect(block).toContain("project-path: C:/work/widgets");
    // repository derives from the issue URL
    expect(block).toContain("repository: acme/widgets");
    expect(block).toContain("issue-number: 7");
    expect(block).toContain("state: CLOSED");
    expect(block).toContain("state-reason: COMPLETED");
    expect(block).toContain("author: doc");
    expect(block).toContain("assignees: marty");
    expect(block).toContain("labels: bug, p1");
    expect(block).toContain("created-at: 2026-01-01T00:00:00Z");
    expect(block).toContain("closed-at: 2026-01-03T00:00:00Z");
    expect(block).toContain("body:\n# Steps\nreproduce");
    expect(block).toContain("[comment #IC_1]");
    expect(block).toContain("updated-at: 2026-01-16T10:00:00Z");
    expect(block).toContain("url: https://github.com/acme/widgets/issues/7#c1");
    expect(block).toContain("body:\nI can repro.");

    const bare = buildIssueContext(
      {
        number: 8,
        title: "Bare",
        body: "",
        state: "OPEN",
        stateReason: null,
        url: "https://x/8",
        createdAt: null,
        updatedAt: null,
        closedAt: null,
        labels: [],
        assignees: [],
        author: null,
        comments: [],
      },
      "P",
      "/p",
    );
    expect(bare).not.toContain("state-reason:");
    expect(bare).not.toContain("assignees:");
    expect(bare).not.toContain("repository:"); // non-GitHub URL — nothing to derive
    expect(bare).toContain("body:\n(empty)");
    expect(bare).toContain("comments:\n(none)");
  });
});
