import { describe, expect, it } from "vitest";
import {
  normalizeGitHubIssueDetail,
  normalizeIssueReference,
  normalizeRestIssueList,
} from "../src/githubIssues.ts";

/**
 * ISS-03: the detail normalizer carries the FULL structured context the native
 * PiIssuePromptBuilder consumes — timestamps, state reason, and per-comment
 * id/url/updatedAt — not just the display fields.
 */

describe("normalizeGitHubIssueDetail (ISS-03)", () => {
  it("maps every context field and tolerates absent optionals", () => {
    const issue = normalizeGitHubIssueDetail({
      number: 7,
      title: "Flux capacitor",
      body: "# Steps",
      state: "CLOSED",
      stateReason: "COMPLETED",
      url: "https://github.com/acme/widgets/issues/7",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      closedAt: "2026-01-03T00:00:00Z",
      labels: [{ name: "bug" }],
      assignees: [{ login: "marty" }],
      author: { login: "doc" },
      comments: [
        {
          id: "IC_1",
          url: "https://github.com/acme/widgets/issues/7#issuecomment-1",
          author: { login: "marty" },
          body: "I can repro.",
          createdAt: "2026-01-15T10:00:00Z",
          updatedAt: "2026-01-16T10:00:00Z",
        },
      ],
    });
    expect(issue).toEqual({
      number: 7,
      title: "Flux capacitor",
      body: "# Steps",
      state: "CLOSED",
      stateReason: "COMPLETED",
      url: "https://github.com/acme/widgets/issues/7",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      closedAt: "2026-01-03T00:00:00Z",
      labels: ["bug"],
      assignees: ["marty"],
      author: "doc",
      comments: [
        {
          id: "IC_1",
          url: "https://github.com/acme/widgets/issues/7#issuecomment-1",
          author: "marty",
          body: "I can repro.",
          createdAt: "2026-01-15T10:00:00Z",
          updatedAt: "2026-01-16T10:00:00Z",
        },
      ],
    });

    const bare = normalizeGitHubIssueDetail({
      number: 8,
      title: "Bare",
      state: "OPEN",
      url: "https://x/8",
    });
    expect(bare.body).toBe("");
    expect(bare.stateReason).toBeNull();
    expect(bare.createdAt).toBeNull();
    expect(bare.closedAt).toBeNull();
    expect(bare.comments).toEqual([]);
  });
});

describe("normalizeIssueReference (ISS-04)", () => {
  it("maps a REST relationship payload to the native reference shape", () => {
    expect(
      normalizeIssueReference({
        number: 12,
        title: "Child task",
        state: "open",
        html_url: "https://github.com/acme/widgets/issues/12",
        type: { name: "Task" },
      }),
    ).toEqual({
      number: 12,
      title: "Child task",
      state: "open",
      url: "https://github.com/acme/widgets/issues/12",
      repository: "acme/widgets",
      type: "Task",
    });
    // absent optionals and a non-derivable repository stay null
    expect(
      normalizeIssueReference({ number: 3, title: "X", state: "closed", html_url: "https://x/3" }),
    ).toEqual({
      number: 3,
      title: "X",
      state: "closed",
      url: "https://x/3",
      repository: null,
      type: null,
    });
  });
});

describe("normalizeRestIssueList (ISS-08)", () => {
  it("maps raw REST issues (type + state_reason included), excludes PRs, caps at 50", () => {
    const rows = [
      {
        number: 5,
        title: "Bug five",
        state: "open",
        state_reason: null,
        html_url: "https://github.com/acme/one/issues/5",
        labels: [{ name: "bug" }],
        assignees: [{ login: "marty" }],
        user: { login: "doc" },
        updated_at: "2026-02-01T09:30:00Z",
        type: { name: "Bug" },
      },
      {
        number: 6,
        title: "A PR, not an issue",
        state: "open",
        html_url: "https://github.com/acme/one/pull/6",
        pull_request: { url: "https://api.github.com/..." },
        labels: [],
        assignees: [],
        user: { login: "doc" },
        updated_at: "2026-02-01T09:31:00Z",
      },
    ];
    const out = normalizeRestIssueList(rows);
    expect(out.incompleteResults).toBe(false);
    expect(out.issues).toHaveLength(1);
    expect(out.issues[0]).toEqual({
      number: 5,
      title: "Bug five",
      state: "open",
      stateReason: null,
      url: "https://github.com/acme/one/issues/5",
      repository: "acme/one",
      labels: ["bug"],
      assignees: ["marty"],
      author: "doc",
      updatedAt: "2026-02-01T09:30:00Z",
      type: "Bug",
    });
  });
});
