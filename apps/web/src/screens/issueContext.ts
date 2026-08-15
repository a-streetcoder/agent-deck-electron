/**
 * ISS-03: the structured `<github-issue-context>` block the native
 * PiIssuePromptBuilder appends to an Open-in-Pi message — metadata, body, and
 * every comment, with absent optionals omitted rather than emitted empty.
 * (Native also emits a relationships section; that data arrives with ISS-04.)
 */

export interface IssueContextComment {
  id: string | null;
  url: string | null;
  author: string | null;
  body: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface IssueContextDetail {
  number: number;
  title: string;
  body: string;
  state: string;
  stateReason: string | null;
  url: string;
  createdAt: string | null;
  updatedAt: string | null;
  closedAt: string | null;
  labels: string[];
  assignees: string[];
  author: string | null;
  comments: IssueContextComment[];
}

/** `https://github.com/OWNER/REPO/issues/N` → `OWNER/REPO`, else null. */
function repositoryFromUrl(url: string): string | null {
  const match = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/\d+/i.exec(url);
  return match ? `${match[1]}/${match[2]}` : null;
}

export function buildIssueContext(
  issue: IssueContextDetail,
  projectName: string,
  projectPath: string,
): string {
  const lines: string[] = [
    "<github-issue-context>",
    `project: ${projectName}`,
    `project-path: ${projectPath}`,
  ];
  const repository = repositoryFromUrl(issue.url);
  if (repository) lines.push(`repository: ${repository}`);
  lines.push(`issue-number: ${issue.number}`, `title: ${issue.title}`, `url: ${issue.url}`);
  lines.push(`state: ${issue.state}`);
  if (issue.stateReason?.trim()) lines.push(`state-reason: ${issue.stateReason.trim()}`);
  if (issue.author?.trim()) lines.push(`author: ${issue.author.trim()}`);
  if (issue.assignees.length > 0) lines.push(`assignees: ${issue.assignees.join(", ")}`);
  if (issue.labels.length > 0) lines.push(`labels: ${issue.labels.join(", ")}`);
  if (issue.createdAt) lines.push(`created-at: ${issue.createdAt}`);
  if (issue.updatedAt) lines.push(`updated-at: ${issue.updatedAt}`);
  if (issue.closedAt) lines.push(`closed-at: ${issue.closedAt}`);

  lines.push("", "body:", issue.body.trim() || "(empty)");

  lines.push("", "comments:");
  if (issue.comments.length === 0) {
    lines.push("(none)");
  } else {
    for (const comment of issue.comments) {
      lines.push("", `[comment #${comment.id ?? "?"}]`);
      if (comment.author?.trim()) lines.push(`author: ${comment.author.trim()}`);
      if (comment.createdAt) lines.push(`created-at: ${comment.createdAt}`);
      if (comment.updatedAt && comment.updatedAt !== comment.createdAt) {
        lines.push(`updated-at: ${comment.updatedAt}`);
      }
      if (comment.url) lines.push(`url: ${comment.url}`);
      lines.push("body:", comment.body.trim() || "(empty)");
    }
  }

  lines.push("</github-issue-context>");
  return lines.join("\n");
}
