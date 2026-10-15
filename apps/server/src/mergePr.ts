import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { redactSecrets } from "@agent-deck/domain";
import {
  gitCommitAll,
  gitCommitsAhead,
  gitCommitSubjects,
  gitErrorText,
  gitPushBranch,
} from "./git.ts";
import { withTrailers } from "./gitIdentity.ts";
import { parseGitHubRepo } from "./routes/projects.ts";

const execFileAsync = promisify(execFile);

/** The pull request URL gh prints (on success, and in its "already exists" refusal). */
const PR_URL = /https:\/\/[^\s"'<>]+\/pull\/(\d+)/;

export interface SessionPrResult {
  status: number;
  body: Record<string, unknown>;
  worktreeCommitted: boolean;
  pr?: { url: string; number: number };
}

/**
 * SRV-12c3: a session's merge on the shared server. Shared work lands through
 * GitHub, never as a local merge on the server: commit the worktree as the merge
 * does, push the session branch to origin with the session OWNER's GitHub
 * connection (`githubEnv`, never the server's own login), and open a pull
 * request as the owner with gh. Title and body are argv, never a shell string.
 * The worktree is kept: it is the PR's branch until the PR is merged.
 */
export async function openSessionPullRequest(options: {
  sessionId: string;
  title: string | undefined;
  worktreePath: string;
  branch: string;
  sourceBranch: string;
  /** The project's default branch: the PR's base. */
  base: string;
  /** The project's origin (owner/name for gh --repo). */
  origin: string | undefined;
  /** The owner's git identity (author and committer). */
  identityEnv: Record<string, string> | undefined;
  coAuthors: string[];
  /** The owner's GitHub env: GH_TOKEN and the credential helper. */
  githubEnv: Record<string, string>;
  /** The PR an earlier merge opened: the push updates it while it is open. */
  existing?: { url: string; number: number };
}): Promise<SessionPrResult> {
  const { branch, worktreePath } = options;
  const token = options.githubEnv.GH_TOKEN;
  const redact = (text: string) =>
    redactSecrets(token ? text.split(token).join("<secret>") : text).slice(-1_000);
  let worktreeCommitted = false;
  const fail = (
    status: number,
    code: string,
    error: string,
    extra: Record<string, unknown> = {},
  ) => ({
    status,
    worktreeCommitted,
    body: { code, outcome: "failed", error, worktreeCommitted, ...extra },
  });

  try {
    await gitCommitAll(
      worktreePath,
      withTrailers(`Agent Deck: ${options.title ?? "session"} changes`, options.coAuthors),
      options.identityEnv,
    );
    worktreeCommitted = true;
  } catch (error) {
    if (!(error instanceof Error && error.message === "nothing_to_commit"))
      return fail(
        409,
        "merge_worktree_commit_failed",
        `Couldn't commit the session worktree: ${gitErrorText(error)}`,
      );
  }
  let commits: number;
  try {
    commits = await gitCommitsAhead(worktreePath, branch, options.sourceBranch);
  } catch (error) {
    return fail(
      500,
      "merge_ahead_failed",
      `Couldn't determine commits ahead: ${gitErrorText(error)}`,
    );
  }
  if (commits === 0)
    return {
      status: 400,
      worktreeCommitted,
      body: {
        code: "merge_nothing_to_merge",
        outcome: "nothing_to_merge",
        error: "Nothing to merge — the session made no commits.",
        worktreeCommitted,
      },
    };

  try {
    await gitPushBranch(worktreePath, branch, options.githubEnv);
  } catch (error) {
    return fail(
      502,
      "merge_push_failed",
      `The branch ${branch} could not be pushed: ${redact(gitErrorText(error))}`,
    );
  }

  const subjects = await gitCommitSubjects(
    worktreePath,
    `${options.sourceBranch}..${branch}`,
  ).catch(() => [] as string[]);
  const body = [
    ...subjects.slice(0, 50).map((subject) => `- ${subject}`),
    ...(subjects.length > 50 ? [`- … and ${subjects.length - 50} more`] : []),
    "",
    `Opened from Agent Deck session ${options.sessionId}`,
  ].join("\n");
  const repo = options.origin ? parseGitHubRepo(options.origin) : undefined;
  const gh = (args: string[]) =>
    execFileAsync(process.env.AGENT_DECK_GH_BIN || "gh", args, {
      cwd: worktreePath,
      env: { ...process.env, ...options.githubEnv, GH_PROMPT_DISABLED: "1" },
      timeout: 60_000,
      maxBuffer: 1_000_000,
    });
  const answer = (pr: { url: string; number: number }, updated: boolean): SessionPrResult => ({
    status: 200,
    worktreeCommitted,
    pr,
    body: {
      ok: true,
      code: updated ? "merge_pr_updated" : "merge_pr_opened",
      outcome: "pr",
      pr,
      branch,
      base: options.base,
      commits,
      worktreeCommitted,
    },
  });
  // The push above updated an earlier PR; only a merged or closed one makes a new PR.
  if (options.existing) {
    let state: unknown;
    try {
      const { stdout } = await gh([
        "pr",
        "view",
        String(options.existing.number),
        ...(repo ? [`--repo=${repo.owner}/${repo.name}`] : []),
        "--json=state",
      ]);
      state = (JSON.parse(stdout) as { state?: unknown }).state;
    } catch {
      // Unknown: the PR is still the answer (the branch is pushed either way).
      state = "OPEN";
    }
    if (state !== "MERGED" && state !== "CLOSED") return answer(options.existing, true);
  }
  // --flag=value: a title or body that starts with "-" is still only a value.
  const args = [
    "pr",
    "create",
    ...(repo ? [`--repo=${repo.owner}/${repo.name}`] : []),
    `--head=${branch}`,
    `--base=${options.base}`,
    `--title=${(options.title ?? "Agent Deck session").slice(0, 256)}`,
    `--body=${body}`,
  ];
  let output: string;
  try {
    output = (await gh(args)).stdout;
  } catch (error) {
    // An open PR for this branch already: that is the answer.
    const text = gitErrorText(error);
    const existing = /already exists/i.test(text) ? PR_URL.exec(text) : null;
    if (!existing)
      return fail(
        502,
        "merge_pr_failed",
        `Pushed ${branch} to origin, but the pull request could not be opened: ${redact(text)}`,
        { branch, pushed: true },
      );
    output = existing[0];
  }
  const match = PR_URL.exec(output);
  if (!match)
    return fail(
      502,
      "merge_pr_failed",
      `Pushed ${branch} to origin, but gh did not report the pull request.`,
      { branch, pushed: true },
    );
  return answer({ url: match[0], number: Number(match[1]) }, false);
}
