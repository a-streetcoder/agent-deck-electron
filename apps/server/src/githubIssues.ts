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
