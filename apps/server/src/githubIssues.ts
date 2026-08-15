export interface RawGitHubIssueListRow {
  number: number;
  title: string;
  state: string;
  url: string;
  labels?: Array<{ name: string }>;
  assignees?: Array<{ login: string }>;
  author?: { login: string } | null;
  updatedAt?: string;
}

export function normalizeGitHubIssueList(raw: RawGitHubIssueListRow[]) {
  return {
    issues: raw.slice(0, 50).map((issue) => ({
      number: issue.number,
      title: issue.title,
      state: issue.state,
      url: issue.url,
      labels: (issue.labels ?? []).map((label) => label.name),
      assignees: (issue.assignees ?? []).map((assignee) => assignee.login),
      author: issue.author?.login ?? null,
      updatedAt: issue.updatedAt ?? null,
    })),
    incompleteResults: raw.length > 50,
  };
}

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
