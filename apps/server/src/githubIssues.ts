export interface RawGitHubIssueDetail {
  number: number;
  title: string;
  body?: string;
  state: string;
  stateReason?: string | null;
  url: string;
  createdAt?: string | null;
  updatedAt?: string | null;
  closedAt?: string | null;
  labels?: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  author?: { login: string } | null;
  comments?: Array<{
    id?: string;
    url?: string;
    author?: { login: string } | null;
    body?: string;
    createdAt?: string | null;
    updatedAt?: string | null;
  }>;
}

/** ISS-03: the FULL structured context the native PiIssuePromptBuilder consumes —
 *  timestamps, state reason, per-comment id/url/updatedAt — normalized once here
 *  so the route and any future consumer share one mapping. */
export function normalizeGitHubIssueDetail(raw: RawGitHubIssueDetail) {
  return {
    number: raw.number,
    title: raw.title,
    body: raw.body ?? "",
    state: raw.state,
    stateReason: raw.stateReason ?? null,
    url: raw.url,
    createdAt: raw.createdAt ?? null,
    updatedAt: raw.updatedAt ?? null,
    closedAt: raw.closedAt ?? null,
    labels: (raw.labels ?? []).map((label) => label.name),
    assignees: (raw.assignees ?? []).map((assignee) => assignee.login),
    author: raw.author?.login ?? null,
    comments: (raw.comments ?? []).map((comment) => ({
      id: comment.id ?? null,
      url: comment.url ?? null,
      author: comment.author?.login ?? null,
      body: comment.body ?? "",
      createdAt: comment.createdAt ?? null,
      updatedAt: comment.updatedAt ?? null,
    })),
  };
}

export interface RawIssueRelationship {
  number: number;
  title: string;
  state: string;
  html_url?: string;
  type?: { name?: string } | null;
}

/** ISS-04: one REST relationship payload (parent/sub_issues/dependencies) to the
 *  native GitHubIssueReference shape; repository derives from the html_url. */
export function normalizeIssueReference(raw: RawIssueRelationship) {
  const url = raw.html_url ?? "";
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//i.exec(url);
  return {
    number: raw.number,
    title: raw.title,
    state: raw.state,
    url,
    repository: match ? `${match[1]}/${match[2]}` : null,
    type: raw.type?.name ?? null,
  };
}

export type IssueReference = ReturnType<typeof normalizeIssueReference>;

export interface IssueRelationships {
  parent: IssueReference | null;
  subIssues: IssueReference[];
  blockedBy: IssueReference[];
  blocking: IssueReference[];
}

export interface RawRestIssueRow {
  number: number;
  title: string;
  state: string;
  state_reason?: string | null;
  html_url?: string;
  labels?: Array<{ name?: string }>;
  assignees?: Array<{ login?: string }>;
  user?: { login?: string } | null;
  updated_at?: string | null;
  type?: { name?: string } | null;
  /** Present on pull requests — the REST issues list mixes them in. */
  pull_request?: unknown;
}

/** ISS-08: raw REST issue rows (repos/O/R/issues or search/issues items) to the
 *  board shape — TYPE and state_reason ride along (gh's --json wrappers omit
 *  type), PRs are excluded, repository derives from html_url, and one row past
 *  50 discloses truncation like the gh-backed list did. */
export function normalizeRestIssueList(raw: RawRestIssueRow[]) {
  const issues = raw.filter((row) => row.pull_request === undefined);
  return {
    issues: issues.slice(0, 50).map((row) => {
      const url = row.html_url ?? "";
      const repo = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\//i.exec(url);
      return {
        number: row.number,
        title: row.title,
        state: row.state,
        stateReason: row.state_reason ?? null,
        url,
        repository: repo ? `${repo[1]}/${repo[2]}` : null,
        labels: (row.labels ?? []).flatMap((label) => (label.name ? [label.name] : [])),
        assignees: (row.assignees ?? []).flatMap((a) => (a.login ? [a.login] : [])),
        author: row.user?.login ?? null,
        updatedAt: row.updated_at ?? null,
        type: row.type?.name ?? null,
      };
    }),
    incompleteResults: issues.length > 50,
  };
}
