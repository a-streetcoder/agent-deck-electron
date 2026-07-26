import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpath, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

/**
 * Git automation (native GitRepositoryService): commit the agent's work in a
 * project's working tree. This is the status + commit-all core; push/remote is a
 * follow-up. Runs the real `git` in the project cwd via execFile (no shell), the
 * same mechanism the gh Issues integration uses. AGENT_DECK_GIT_BIN overrides
 * the binary for tests, matching AGENT_DECK_GH_BIN.
 */

const execFileAsync = promisify(execFile);

export interface GitFileChange {
  /** The 2-char porcelain status (e.g. " M", "??", "A ", "MM"). */
  status: string;
  path: string;
}
export interface GitStatus {
  /** False when the cwd is not inside a git work tree. */
  repo: boolean;
  branch?: string;
  files: GitFileChange[];
  /** True when the work tree has no changes to commit. */
  clean: boolean;
}

function gitBin(): string {
  return process.env.AGENT_DECK_GIT_BIN || "git";
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(gitBin(), args, {
    cwd,
    timeout: 15_000,
    maxBuffer: 8_000_000,
  });
  return stdout;
}

function validateGitObjectId(commit: string): void {
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(commit)) {
    throw new Error("invalid_git_commit");
  }
}

function validateGitBlobPath(repoRelativePosixPath: string): void {
  if (
    repoRelativePosixPath.length === 0 ||
    repoRelativePosixPath.startsWith("/") ||
    repoRelativePosixPath.includes("\\") ||
    repoRelativePosixPath.includes(":") ||
    repoRelativePosixPath.includes("\0") ||
    path.posix.normalize(repoRelativePosixPath) !== repoRelativePosixPath ||
    repoRelativePosixPath.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error("invalid_git_blob_path");
  }
}

/**
 * Convert an absolute path beneath a checkout to Git's repository-relative,
 * POSIX path spelling. Ambiguous path syntax is rejected rather than passed to
 * Git's `<object>:<path>` revision parser.
 */
export function gitRepoRelativePosixPath(repoDir: string, absolutePath: string): string {
  const root = path.resolve(repoDir);
  const target = path.resolve(absolutePath);
  const relative = path.relative(root, target);
  if (
    relative === "" ||
    path.isAbsolute(relative) ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`)
  ) {
    throw new Error("git_blob_path_outside_repository");
  }
  const posixPath = relative.split(path.sep).join("/");
  validateGitBlobPath(posixPath);
  return posixPath;
}

/** Read exact blob bytes from a validated commit without consulting checkout filters. */
export async function gitBlobAtCommit(
  repoDir: string,
  commit: string,
  repoRelativePosixPath: string,
): Promise<Buffer> {
  validateGitObjectId(commit);
  validateGitBlobPath(repoRelativePosixPath);
  const { stdout } = await execFileAsync(
    gitBin(),
    ["cat-file", "blob", `${commit}:${repoRelativePosixPath}`],
    {
      cwd: repoDir,
      encoding: "buffer",
      timeout: 15_000,
      maxBuffer: 8_000_000,
    },
  );
  return stdout;
}

/** As {@link runGit}, but with extra environment (checkpoint capture threads a
 * throwaway `GIT_INDEX_FILE` + author/committer identity through here). */
async function runGitEnv(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  const { stdout } = await execFileAsync(gitBin(), args, {
    cwd,
    env,
    timeout: 15_000,
    maxBuffer: 8_000_000,
  });
  return stdout;
}

/** Run Git without a shell while supplying plumbing input on stdin. */
async function runGitInput(cwd: string, args: string[], input: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(gitBin(), args, {
      cwd,
      env: process.env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 15_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else
        reject(Object.assign(new Error(`git exited with code ${String(code)}`), { code, stderr }));
    });
    child.stdin.end(input);
  });
}

/** Parse `git status --porcelain=v1 --branch` output into a structured status. */
export function parseStatus(stdout: string): { branch?: string; files: GitFileChange[] } {
  let branch: string | undefined;
  const files: GitFileChange[] = [];
  // Split on LF; git emits LF even on Windows for porcelain output.
  for (const line of stdout.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("## ")) {
      const rest = line.slice(3);
      const noCommits = "No commits yet on ";
      if (rest.startsWith(noCommits)) {
        branch = rest.slice(noCommits.length).trim();
      } else if (rest.startsWith("HEAD (no branch)")) {
        branch = undefined; // detached HEAD — no branch to show
      } else {
        // "<branch>...<upstream> [ahead N]" or a bare "<branch>".
        branch = (rest.split("...")[0] ?? rest).split(" ")[0];
      }
      continue;
    }
    // "XY <path>" — exactly two status chars, a space, then the path (verbatim,
    // so paths with spaces survive).
    files.push({ status: line.slice(0, 2), path: line.slice(3) });
  }
  return { branch, files };
}

export async function gitStatus(cwd: string): Promise<GitStatus> {
  let stdout: string;
  try {
    stdout = await runGit(cwd, ["status", "--porcelain=v1", "--branch"]);
  } catch {
    // Not a repo (or git unavailable) — surfaced as repo:false, not an error.
    return { repo: false, files: [], clean: true };
  }
  const { branch, files } = parseStatus(stdout);
  return { repo: true, branch, files, clean: files.length === 0 };
}

/**
 * Clone a repo into a PERSISTENT dir kept for later re-sync (native
 * SkillRepositorySyncService.cloneForDiscovery). Uses a blobless partial clone
 * (`--filter=blob:none`) so only reachable trees download up front; if the source
 * rejects the filter (common for a local path), retries a plain clone. `ref`
 * pins the tracked branch. Throws "clone_failed" on failure.
 */
export async function gitClonePersistent(
  source: string,
  destDir: string,
  ref?: string,
): Promise<void> {
  const branchArgs = ref ? ["--branch", ref, "--single-branch"] : [];
  const opts = {
    timeout: 180_000,
    maxBuffer: 8_000_000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  };
  try {
    await execFileAsync(
      gitBin(),
      ["clone", "--filter=blob:none", ...branchArgs, source, destDir],
      opts,
    );
  } catch {
    // Partial-clone filter rejected (e.g. a local source) — retry a plain clone.
    await rm(destDir, { recursive: true, force: true }).catch(() => {});
    try {
      await execFileAsync(gitBin(), ["clone", ...branchArgs, source, destDir], opts);
    } catch {
      throw new Error("clone_failed");
    }
  }
}

/** The HEAD commit sha of a clone (native rev-parse HEAD). */
export async function gitHead(dir: string): Promise<string> {
  return (await runGit(dir, ["rev-parse", "HEAD"])).trim();
}

/** Read origin without fetching or changing the existing checkout. */
export async function gitOriginRemote(dir: string): Promise<string> {
  return (await runGit(dir, ["remote", "get-url", "origin"])).trim();
}

/**
 * Adoption may not checkout/reset an existing native clone, so a requested ref
 * is compatible only when it resolves locally to the clone's current HEAD.
 */
export async function gitHeadMatchesRef(dir: string, ref?: string): Promise<boolean> {
  if (!ref) return true;
  const head = await gitHead(dir);
  for (const candidate of [ref, `refs/heads/${ref}`, `refs/remotes/origin/${ref}`]) {
    try {
      const commit = (await runGit(dir, ["rev-parse", "--verify", `${candidate}^{commit}`])).trim();
      if (commit === head) return true;
    } catch {
      // Try the next unambiguous local spelling without fetching.
    }
  }
  return false;
}

/**
 * The remote tip sha for `ref` (default HEAD) WITHOUT downloading (native
 * checkForUpdate: `git ls-remote`). Returns null on any error / no match, so a
 * transient network failure just reports "no update known".
 */
export async function gitLsRemote(remoteUrl: string, ref = "HEAD"): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(gitBin(), ["ls-remote", remoteUrl, ref], {
      timeout: 30_000,
      maxBuffer: 8_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
    const sha = stdout.trim().split(/\s+/)[0];
    return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the tracked branch and hard-reset the clone to it, returning the new
 * HEAD (native update: fetch + ff). The clone is a read-only mirror (its skills
 * were COPIED into the catalog, never edited in place), so a hard reset can't
 * lose local work. Throws the git error on a fetch/reset failure.
 */
export async function gitPullFfInto(cloneDir: string, ref?: string): Promise<string> {
  // Fetch the SPECIFIC branch (the pinned ref, else the clone's current branch)
  // so FETCH_HEAD is unambiguous — `git fetch origin` with no ref can leave
  // FETCH_HEAD pointing at the wrong branch in a multi-branch clone.
  const branch = ref ?? (await runGit(cloneDir, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
  await runGit(cloneDir, ["fetch", "origin", branch]);
  await runGit(cloneDir, ["reset", "--hard", "FETCH_HEAD"]);
  return (await runGit(cloneDir, ["rev-parse", "HEAD"])).trim();
}

/**
 * Stage everything and commit with `message`. Throws "nothing_to_commit" when
 * the work tree is clean (native noChanges) and "not_a_repo" outside a repo, so
 * the route maps them to a 400 with a clear message.
 */
export async function gitCommitAll(cwd: string, message: string): Promise<{ committed: true }> {
  const status = await gitStatus(cwd);
  if (!status.repo) throw new Error("not_a_repo");
  if (status.clean) throw new Error("nothing_to_commit");
  await runGit(cwd, ["add", "-A"]);
  await runGit(cwd, ["commit", "-m", message]);
  return { committed: true };
}

/**
 * The working-tree status + a diff of all tracked changes vs HEAD, for feeding
 * a commit-message generator (native PiAgentShipService). The diff is capped so
 * a huge change set can't blow the helper model's context. On a fresh repo with
 * no commits (no HEAD), the diff is empty and the status still lists the files.
 */
export async function gitStatusAndDiff(cwd: string): Promise<{ status: string; diff: string }> {
  const status = (await runGit(cwd, ["status", "--porcelain=v1"])).trim();
  let diff = "";
  try {
    diff = (await runGit(cwd, ["diff", "HEAD"])).slice(0, 60_000);
  } catch {
    // No HEAD yet (fresh repo) — the status alone describes the changes.
  }
  return { status, diff };
}

/** The current branch name, or "HEAD" when detached (native readCurrentBranch). */
export async function gitCurrentBranch(cwd: string): Promise<string> {
  return (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

/** True iff `dir` is inside a git working tree (git rev-parse --is-inside-work-tree). */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    return (await runGit(dir, ["rev-parse", "--is-inside-work-tree"])).trim() === "true";
  } catch {
    return false; // not a repo, or git unavailable
  }
}

// ---------------------------------------------------------------------------
// Diff-engine primitives (Slice 9) — pure exec helpers for services/diff.ts,
// shaped from t3code's GitVcsDriverCore.ts (MIT): working-tree-vs-HEAD status
// with rename detection, per-file numstat, bounded patch output, and the
// /dev/null no-index synthesis for untracked files. Policy (caching, set
// merging, truncation semantics) lives in the service; these stay plain git.
// ---------------------------------------------------------------------------

/** The well-known empty-tree ids — the diff base for a repo with no commits. */
const EMPTY_TREE_SHA1 = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const EMPTY_TREE_SHA256 = "6ef19b41225c5369f1c104d45d8d85efa9b057b53b14b4b9b939dd74decc5321";

/**
 * The revision working-tree diffs compare against: HEAD, or — in a fresh repo
 * with no commits yet — the empty tree (sha1 id, falling back to the sha256 id
 * for object-format=sha256 repos), so staged files still diff as additions.
 */
export async function gitDiffBase(cwd: string): Promise<string> {
  for (const rev of ["HEAD", EMPTY_TREE_SHA1, EMPTY_TREE_SHA256]) {
    try {
      await runGit(cwd, ["rev-parse", "--verify", "--quiet", rev]);
      return rev;
    } catch {
      // Try the next candidate.
    }
  }
  return "HEAD"; // unreachable in a repo; callers guard with isGitRepo first
}

export interface GitNameStatusEntry {
  /** One-letter status (A/M/D/R/C/T/U); rename/copy scores are stripped. */
  status: string;
  path: string;
  /** The rename/copy source (R/C entries only). */
  oldPath?: string;
}

/** Parse `git diff --name-status -z` output (NUL-separated; renames carry two paths). */
export function parseNameStatusZ(stdout: string): GitNameStatusEntry[] {
  const parts = stdout.split("\0");
  const entries: GitNameStatusEntry[] = [];
  for (let i = 0; i < parts.length; ) {
    const status = parts[i] ?? "";
    if (status.length === 0) break;
    const letter = status[0] ?? "";
    if (letter === "R" || letter === "C") {
      const oldPath = parts[i + 1];
      const path = parts[i + 2];
      if (oldPath && path) entries.push({ status: letter, path, oldPath });
      i += 3;
    } else {
      const path = parts[i + 1];
      if (path) entries.push({ status: letter, path });
      i += 2;
    }
  }
  return entries;
}

/** Working tree vs `base`, with rename detection (donor: `-M`). */
export async function gitDiffNameStatus(cwd: string, base: string): Promise<GitNameStatusEntry[]> {
  return parseNameStatusZ(await runGit(cwd, ["diff", "--name-status", "-z", "-M", base, "--"]));
}

export interface GitNumstatEntry {
  path: string;
  oldPath?: string;
  /** Null for binary files (numstat prints `-`). */
  insertions: number | null;
  deletions: number | null;
}

/**
 * Parse `git diff --numstat -z` output. Non-renames are `ins\tdel\tpath\0`;
 * renames are `ins\tdel\t\0old\0new\0` (empty third field, then two paths).
 */
export function parseNumstatZ(stdout: string): GitNumstatEntry[] {
  const parts = stdout.split("\0");
  const entries: GitNumstatEntry[] = [];
  const parseCount = (raw: string): number | null => {
    if (raw === "-") return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  };
  for (let i = 0; i < parts.length; ) {
    const record = parts[i] ?? "";
    if (record.length === 0) break;
    const [insRaw = "", delRaw = "", inlinePath = ""] = record.split("\t");
    const insertions = parseCount(insRaw);
    const deletions = parseCount(delRaw);
    if (inlinePath.length > 0) {
      entries.push({ path: inlinePath, insertions, deletions });
      i += 1;
    } else {
      const oldPath = parts[i + 1];
      const path = parts[i + 2];
      if (oldPath && path) entries.push({ path, oldPath, insertions, deletions });
      i += 3;
    }
  }
  return entries;
}

/** Per-file add/del stats of the working tree vs `base` (rename-aware). */
export async function gitDiffNumstat(cwd: string, base: string): Promise<GitNumstatEntry[]> {
  return parseNumstatZ(await runGit(cwd, ["diff", "--numstat", "-z", "-M", base, "--"]));
}

/** Untracked files (donor: `ls-files --others --exclude-standard -z`). */
export async function gitListUntracked(cwd: string): Promise<string[]> {
  const stdout = await runGit(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
  return stdout.split("\0").filter((path) => path.length > 0);
}

export interface GitBoundedOutput {
  text: string;
  /** True when the output exceeded `maxChars` and was cut. */
  truncated: boolean;
}

/**
 * Run git capturing at most `maxChars` of stdout: the child's stdout buffer is
 * bounded, and on overflow the PARTIAL output is returned with
 * `truncated: true` instead of throwing (execFile attaches the partial stdout
 * to its maxBuffer error). `okExitCodes` admits non-zero exits that still
 * produce valid output (`diff --no-index` exits 1 when the files differ).
 */
async function runGitBounded(
  cwd: string,
  args: string[],
  maxChars: number,
  okExitCodes: readonly number[] = [],
): Promise<GitBoundedOutput> {
  try {
    const { stdout } = await execFileAsync(gitBin(), args, {
      cwd,
      timeout: 15_000,
      maxBuffer: maxChars,
    });
    return { text: stdout, truncated: false };
  } catch (error) {
    const err = error as { code?: unknown; stdout?: unknown };
    const partial = typeof err.stdout === "string" ? err.stdout : "";
    if (err.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
      return { text: partial.slice(0, maxChars), truncated: true };
    }
    if (typeof err.code === "number" && okExitCodes.includes(err.code)) {
      return { text: partial, truncated: false };
    }
    throw error;
  }
}

/**
 * One tracked file's unified diff vs `base`, bounded. For a rename both paths
 * ride the pathspec — limiting to the new path alone would exclude the rename
 * source and degrade the entry to an add.
 */
export async function gitDiffFilePatch(
  cwd: string,
  base: string,
  paths: readonly string[],
  maxChars: number,
): Promise<GitBoundedOutput> {
  // --literal-pathspecs: these paths come back FROM git status output, but a
  // name like `app/[id]/page.tsx` would otherwise be glob-expanded as a
  // pathspec and match SIBLING files' diffs (donor: GitVcsDriverCore
  // prepareCommitContext uses the same flag when feeding paths back).
  return runGitBounded(
    cwd,
    ["--literal-pathspecs", "diff", "--no-ext-diff", "--patch", "-M", base, "--", ...paths],
    maxChars,
  );
}

/**
 * Synthesize an untracked file's diff against /dev/null (donor:
 * readUntrackedReviewDiffs). Git special-cases the literal `/dev/null` in
 * --no-index mode on every platform (verified on Windows), and exits 1 when
 * the files differ — the expected outcome, not an error.
 */
export async function gitDiffUntrackedPatch(
  cwd: string,
  path: string,
  maxChars: number,
): Promise<GitBoundedOutput> {
  return runGitBounded(
    cwd,
    ["diff", "--no-index", "--no-ext-diff", "--patch", "--", "/dev/null", path],
    maxChars,
    [1],
  );
}

/**
 * An untracked file's add/del stats via `--no-index --numstat` (exit 1
 * expected). Returns null insertions/deletions for a binary file, and
 * `null` when git produced no stat line (e.g. an empty file reports 0/0 —
 * that DOES produce a line; a vanished file does not).
 */
export async function gitDiffUntrackedNumstat(
  cwd: string,
  path: string,
): Promise<{ insertions: number | null; deletions: number | null } | null> {
  const { text } = await runGitBounded(
    cwd,
    ["diff", "--no-index", "--numstat", "--", "/dev/null", path],
    1_000_000,
    [1],
  );
  const record = text.split("\n")[0]?.trim() ?? "";
  if (record.length === 0) return null;
  const [insRaw = "", delRaw = ""] = record.split("\t");
  const parse = (raw: string): number | null => {
    if (raw === "-") return null;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  };
  return { insertions: parse(insRaw), deletions: parse(delRaw) };
}

export class SessionWorktreeAddError extends Error {
  constructor(
    readonly worktree: GitWorktree,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "SessionWorktreeAddError";
  }
}

export interface GitWorktree {
  /** The isolated checkout directory. */
  path: string;
  /** The new branch the worktree is on. */
  branch: string;
  /** The branch the worktree was forked from. */
  sourceBranch: string;
  /** Native stable identity reserved before the checkout is populated. */
  identityToken?: string;
  /** Proof that createSessionWorktree atomically created this branch. */
  branchOwned: true;
}

/**
 * Add a worktree for an EXISTING branch. Branch creation is a separate atomic
 * command in createSessionWorktree so a failed add can delete only a branch this
 * attempt conclusively created, never a pre-existing same-named branch.
 */
export async function gitWorktreeAdd(
  projectDir: string,
  targetPath: string,
  branch: string,
): Promise<void> {
  await runGit(projectDir, ["worktree", "add", targetPath, branch]);
}

/** Delete a branch only when the caller holds createSessionWorktree's ownership
 * proof and the name is in Agent Deck's private namespace. Throws on failure so
 * transaction callers can log it without masking their primary typed error. */
export async function gitDeleteOwnedWorktreeBranch(
  projectDir: string,
  worktree: GitWorktree,
): Promise<void> {
  if (worktree.branchOwned !== true || !worktree.branch.startsWith("agent-deck/")) {
    throw new Error("refusing to delete an unowned worktree branch");
  }
  await runGit(projectDir, ["branch", "-D", "--", worktree.branch]);
}

/**
 * The shared session/loop worktree dance: fork a NEW branch off the project's
 * CURRENT branch into an isolated worktree at `targetPath`. Throws
 * "detached HEAD — check out a branch first" when there is no branch to fork.
 * The caller owns token-bound rollback of its pre-reserved target, plus the
 * surrounding policy (400 vs silent fallback) and target/branch naming.
 */
export async function createSessionWorktree(
  projectDir: string,
  targetPath: string,
  branch: string,
  identityToken: string,
): Promise<GitWorktree> {
  const sourceBranch = await gitCurrentBranch(projectDir);
  if (sourceBranch === "HEAD") throw new Error("detached HEAD — check out a branch first");
  // `git branch` is atomic: success proves this attempt owns the new ref;
  // failure (including a pre-existing branch or a concurrent creator) means we
  // own nothing and therefore must not delete anything.
  await runGit(projectDir, ["branch", branch, sourceBranch]);
  const worktree: GitWorktree = {
    path: targetPath,
    branch,
    sourceBranch,
    identityToken,
    branchOwned: true,
  };
  try {
    await gitWorktreeAdd(projectDir, targetPath, branch);
  } catch (error) {
    // Preserve proof that this attempt owns the branch. The route must first use
    // its held native root to remove any partial checkout, then prune Git, then
    // (and only then) delete this owned branch without masking the add failure.
    throw new SessionWorktreeAddError(worktree, error);
  }
  return worktree;
}

/**
 * Loop allocation variant: on a failed `git worktree add`, never invoke the
 * permissive target-directory fallback. The atomically-created private branch
 * is deleted only if Git permits it (a partially registered checkout keeps the
 * branch and generated directory for later evidence-based reconciliation).
 */
export async function createLoopWorktree(
  projectDir: string,
  targetPath: string,
  branch: string,
): Promise<GitWorktree> {
  const sourceBranch = await gitCurrentBranch(projectDir);
  if (sourceBranch === "HEAD") throw new Error("detached HEAD — check out a branch first");
  await runGit(projectDir, ["branch", branch, sourceBranch]);
  const worktree: GitWorktree = { path: targetPath, branch, sourceBranch, branchOwned: true };
  try {
    await gitWorktreeAdd(projectDir, targetPath, branch);
    return worktree;
  } catch (error) {
    await gitDeleteOwnedWorktreeBranch(projectDir, worktree).catch(() => {});
    throw error;
  }
}

/** Prune registrations only after native capability-relative physical removal. */
export async function gitWorktreePrune(projectDir: string): Promise<void> {
  // Git's default expiry keeps freshly-stale administrative entries for months.
  // Physical removal is already proven by the caller, so expire immediately.
  await runGit(projectDir, ["worktree", "prune", "--expire", "now"]);
}

export interface OwnedLoopWorktreeProof {
  ownershipVersion: 1;
  ownershipId: string;
  projectRoot: string;
  path: string;
  branch: string;
  sourceBranch: string;
  branchOwned: true;
}

export interface GitWorktreeRegistration {
  path: string;
  branch: string;
}

/**
 * Read Git's registration table without pruning or otherwise mutating it. The
 * porcelain NUL format preserves paths containing whitespace/newlines; callers
 * still own canonical-path and branch-ownership policy.
 */
export async function canonicalWorktreePath(candidate: string): Promise<string> {
  let canonical: string;
  try {
    canonical = await realpath(candidate);
  } catch {
    canonical = path.resolve(candidate);
  }
  if (process.platform === "win32") {
    let normalized = path.win32.normalize(canonical.replaceAll("/", "\\"));
    const upper = normalized.toUpperCase();
    if (upper.startsWith("\\\\?\\UNC\\")) normalized = `\\\\${normalized.slice(8)}`;
    else if (upper.startsWith("\\\\?\\")) normalized = normalized.slice(4);
    return normalized.toLocaleLowerCase("en-US");
  }
  return path.normalize(canonical);
}

export async function gitWorktreeRegistrationAtPath(
  projectDir: string,
  targetPath: string,
): Promise<GitWorktreeRegistration | undefined> {
  const expectedPath = await canonicalWorktreePath(targetPath);
  const registrations = await gitWorktreeRegistrations(projectDir);
  for (const registration of registrations) {
    if ((await canonicalWorktreePath(registration.path)) === expectedPath) return registration;
  }
  return undefined;
}

export async function gitWorktreeRegistrationMatches(
  projectDir: string,
  targetPath: string,
  expectedBranch: string,
): Promise<boolean> {
  return (await gitWorktreeRegistrationAtPath(projectDir, targetPath))?.branch === expectedBranch;
}

export async function gitWorktreeRegistrations(
  projectDir: string,
): Promise<GitWorktreeRegistration[]> {
  const output = await runGit(projectDir, ["worktree", "list", "--porcelain", "-z"]);
  return output
    .split("\0\0")
    .map((record) => record.split("\0"))
    .flatMap((fields) => {
      const worktree = fields.find((field) => field.startsWith("worktree "))?.slice(9);
      const branchRef = fields.find((field) => field.startsWith("branch refs/heads/"));
      if (!worktree || !branchRef) return [];
      return [{ path: worktree, branch: branchRef.slice("branch refs/heads/".length) }];
    });
}

/**
 * Validate a persisted local branch name with Git itself, fully qualify it, and
 * prove it still resolves to a commit. This is used only for server-owned Loop
 * review metadata; no renderer request can select a revision.
 */
export async function gitFullyQualifiedBranchRef(cwd: string, branch: string): Promise<string> {
  if (!branch || branch.startsWith("-")) throw new Error("invalid branch name");
  const checked = (await runGit(cwd, ["check-ref-format", "--branch", branch])).trim();
  if (checked !== branch) throw new Error("invalid branch name");
  const ref = `refs/heads/${branch}`;
  await gitCommitOid(cwd, ref);
  return ref;
}

/** Resolve a validated revision to the immutable commit used by one diff scan. */
export async function gitCommitOid(cwd: string, revision: string): Promise<string> {
  return (await runGit(cwd, ["rev-parse", "--verify", `${revision}^{commit}`])).trim();
}

/** Commits on `branch` not yet reachable from `base` (native commitsAhead). */
export async function gitCommitsAhead(cwd: string, branch: string, base: string): Promise<number> {
  const out = (await runGit(cwd, ["rev-list", "--count", `${base}..${branch}`])).trim();
  const n = Number.parseInt(out, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Merge a session's worktree `branch` back into `sourceBranch` (native Merge
 * toolbar action): check out sourceBranch in the project root, then a `--no-ff`
 * merge with an explicit message (no editor). Throws the git stderr on a dirty
 * tree / checkout failure / merge conflict so the caller can surface it. The
 * worktree + branch are left in place (native default keepWorktreeAfterMerge).
 */
export async function gitMerge(
  projectDir: string,
  branch: string,
  sourceBranch: string,
): Promise<void> {
  await runGit(projectDir, ["checkout", sourceBranch]);
  await runGit(projectDir, ["merge", "--no-ff", branch, "-m", `Merge ${branch}`]);
}

/** Propose the next patch/minor/major version off the latest `vX.Y.Z` tag
 *  (semver; native uses a single-digit-minor scheme, generalized here). */
export function nextReleaseVersions(latestTag: string | null): {
  patch: string;
  minor: string;
  major: string;
} {
  const match = latestTag ? /^v(\d+)\.(\d+)\.(\d+)$/.exec(latestTag) : null;
  if (!match) return { patch: "v0.1.0", minor: "v0.1.0", major: "v1.0.0" }; // first release
  const [maj, min, pat] = [Number(match[1]), Number(match[2]), Number(match[3])];
  return {
    patch: `v${maj}.${min}.${pat + 1}`,
    minor: `v${maj}.${min + 1}.0`,
    major: `v${maj + 1}.0.0`,
  };
}

export type ReleaseSyncCode =
  | "ready"
  | "not_repo"
  | "detached"
  | "missing_upstream"
  | "invalid_upstream"
  | "fetch_failed"
  | "dirty"
  | "ahead"
  | "behind"
  | "diverged";

export interface ReleaseSyncBlocker {
  code: Exclude<ReleaseSyncCode, "ready">;
  message: string;
}

/** A fail-closed snapshot proving which clean, synchronized commit may be released. */
export interface ReleaseSynchronization {
  state: ReleaseSyncCode;
  branch: string | null;
  upstream: string | null;
  remote: string | null;
  remoteRef: string | null;
  ahead: number | null;
  behind: number | null;
  headSha: string | null;
  blocker: ReleaseSyncBlocker | null;
}

function blockedReleaseSync(
  code: Exclude<ReleaseSyncCode, "ready">,
  message: string,
  details: Partial<Omit<ReleaseSynchronization, "state" | "blocker">> = {},
): ReleaseSynchronization {
  return {
    state: code,
    branch: null,
    upstream: null,
    remote: null,
    remoteRef: null,
    ahead: null,
    behind: null,
    headSha: null,
    ...details,
    blocker: { code, message },
  };
}

/**
 * Fetch and compare the checked-out branch with its configured non-local
 * upstream. Classification uses command results and plumbing output only; Git's
 * localized diagnostics are retained solely as actionable fetch details.
 */
export async function gitReleaseSynchronization(cwd: string): Promise<ReleaseSynchronization> {
  try {
    if ((await runGit(cwd, ["rev-parse", "--is-inside-work-tree"])).trim() !== "true") {
      return blockedReleaseSync("not_repo", "This project isn't a git repository.");
    }
  } catch {
    return blockedReleaseSync("not_repo", "This project isn't a git repository.");
  }

  let branch: string;
  try {
    branch = (await runGit(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  } catch {
    return blockedReleaseSync("detached", "Check out a branch before creating a release.");
  }

  const metadata = (
    await runGit(cwd, [
      "for-each-ref",
      "--format=%(upstream:short)%00%(upstream:remotename)%00%(upstream:remoteref)",
      `refs/heads/${branch}`,
    ])
  ).trim();
  const [upstream = "", remote = "", remoteRef = ""] = metadata.split("\0");
  if (!upstream) {
    return blockedReleaseSync(
      "missing_upstream",
      `Branch ${branch} has no upstream. Configure and push its upstream before releasing.`,
      { branch },
    );
  }
  if (!remote || remote === "." || !remoteRef.startsWith("refs/heads/")) {
    return blockedReleaseSync(
      "invalid_upstream",
      `Branch ${branch} must track a branch on a configured remote, not a local branch.`,
      { branch, upstream, remote: remote || null, remoteRef: remoteRef || null },
    );
  }

  try {
    await execFileAsync(gitBin(), ["fetch", "--quiet", "--tags", remote, remoteRef], {
      cwd,
      timeout: 30_000,
      maxBuffer: 8_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    });
  } catch (error) {
    return blockedReleaseSync(
      "fetch_failed",
      `Couldn't fetch ${upstream} and tags from ${remote}: ${gitErrorText(error)}`,
      { branch, upstream, remote, remoteRef },
    );
  }

  const status = await gitStatus(cwd);
  let ahead: number;
  let behind: number;
  try {
    const counts = (
      await runGit(cwd, ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"])
    )
      .trim()
      .split(/\s+/);
    ahead = Number.parseInt(counts[0] ?? "", 10);
    behind = Number.parseInt(counts[1] ?? "", 10);
    if (!Number.isFinite(ahead) || !Number.isFinite(behind)) throw new Error("invalid counts");
  } catch {
    return blockedReleaseSync(
      "invalid_upstream",
      `The configured upstream ${upstream} could not be compared. Repair the branch tracking configuration before releasing.`,
      { branch, upstream, remote, remoteRef },
    );
  }
  const details = { branch, upstream, remote, remoteRef, ahead, behind };
  if (!status.clean) {
    return blockedReleaseSync(
      "dirty",
      "Commit or stash your changes first — a release tags a clean commit.",
      details,
    );
  }
  if (ahead > 0 && behind > 0) {
    return blockedReleaseSync(
      "diverged",
      `Local ${branch} and ${upstream} have diverged (${ahead} ahead, ${behind} behind). Reconcile and push the branch before releasing.`,
      details,
    );
  }
  if (ahead > 0) {
    return blockedReleaseSync(
      "ahead",
      `Local ${branch} is ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${upstream}. Push the branch before releasing.`,
      details,
    );
  }
  if (behind > 0) {
    return blockedReleaseSync(
      "behind",
      `Local ${branch} is ${behind} commit${behind === 1 ? "" : "s"} behind ${upstream}. Pull or fast-forward before releasing.`,
      details,
    );
  }
  const headSha = (await runGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  return { state: "ready", ...details, headSha, blocker: null };
}

/** The newest `vX.Y.Z` version tag (native latestVersionTag), or null if none. */
export async function gitLatestVersionTag(cwd: string): Promise<string | null> {
  try {
    const out = (
      await runGit(cwd, ["tag", "-l", "v[0-9]*.[0-9]*.[0-9]*", "--sort=-v:refname"])
    ).trim();
    // The glob also matches prerelease tags (v1.2.3-rc), which sort ahead of the
    // plain release — scan for the newest STRICT vX.Y.Z, not just the first line.
    const first = out
      .split("\n")
      .map((line) => line.trim())
      .find((line) => /^v\d+\.\d+\.\d+$/.test(line));
    return first ?? null;
  } catch {
    return null;
  }
}

function commandExitCode(error: unknown): number | string | undefined {
  return (error as { code?: number | string }).code;
}

/** Exact local tag lookup. Exit 1 is Git's documented "not found" result. */
export async function gitLocalTagExists(cwd: string, tag: string): Promise<boolean> {
  try {
    await runGit(cwd, ["show-ref", "--verify", "--quiet", `refs/tags/${tag}`]);
    return true;
  } catch (error) {
    if (commandExitCode(error) === 1) return false;
    throw error;
  }
}

/** Exact remote tag lookup. A successful empty response means absent; transport failures throw. */
export async function gitRemoteTagExists(
  cwd: string,
  remote: string,
  tag: string,
): Promise<boolean> {
  const output = await execFileAsync(
    gitBin(),
    ["ls-remote", "--tags", remote, `refs/tags/${tag}`],
    {
      cwd,
      timeout: 30_000,
      maxBuffer: 8_000_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    },
  );
  return output.stdout.trim().length > 0;
}

export interface ReleasePushFailure {
  code: "push_failed";
  message: string;
  localRollback: "deleted" | "failed";
  remoteTag: "absent" | "present" | "unknown";
}

export interface ReleaseStaleLocalFailure {
  code: "stale_local";
  message: string;
}

export interface ReleaseTagTestHooks {
  /** Tests only: runs after the tag object exists but before local ref mutation. */
  beforeLocalRefCreate?: () => Promise<void> | void;
  /** Tests only: runs after owned local ref creation but before the atomic push. */
  beforePush?: (createdTagObject: string) => Promise<void> | void;
}

/**
 * Build and locally own an annotated tag, then atomically publish a no-op branch
 * update plus the explicit tag object under exact branch/tag leases. A server
 * without atomic-push support fails closed without publishing either ref.
 */
export async function gitCreateAndPushReleaseTag(
  cwd: string,
  tag: string,
  message: string,
  headSha: string,
  remote: string,
  remoteRef: string,
  hooks: ReleaseTagTestHooks = {},
): Promise<{ ok: true } | { ok: false; failure: ReleasePushFailure | ReleaseStaleLocalFailure }> {
  const tagger = (await runGit(cwd, ["var", "GIT_COMMITTER_IDENT"])).trim();
  const tagBody = `object ${headSha}\ntype commit\ntag ${tag}\ntagger ${tagger}\n\n${message || tag}\n`;
  // mktag writes the immutable annotated object without publishing a ref.
  const createdTagObject = (await runGitInput(cwd, ["mktag"], tagBody)).trim();

  await hooks.beforeLocalRefCreate?.();
  // This is deliberately adjacent to the guarded ref mutation: no stale UI or
  // earlier synchronization may authorize a moved HEAD or dirty worktree.
  const currentHead = (await runGit(cwd, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
  const dirty = (await runGit(cwd, ["status", "--porcelain=v1"])).trim().length > 0;
  if (currentHead !== headSha || dirty) {
    return {
      ok: false,
      failure: {
        code: "stale_local",
        message:
          currentHead !== headSha
            ? "The local branch changed during release preparation. Run preflight again before releasing."
            : "The working tree changed during release preparation. Commit or stash changes, then run preflight again.",
      },
    };
  }

  const objectFormat = (await runGit(cwd, ["rev-parse", "--show-object-format"])).trim();
  const zeroObject = "0".repeat(objectFormat === "sha256" ? 64 : 40);
  await runGit(cwd, ["update-ref", `refs/tags/${tag}`, createdTagObject, zeroObject]);
  await hooks.beforePush?.(createdTagObject);

  try {
    await runGit(cwd, [
      "push",
      "--atomic",
      `--force-with-lease=${remoteRef}:${headSha}`,
      `--force-with-lease=refs/tags/${tag}:`,
      remote,
      `${headSha}:${remoteRef}`,
      `${createdTagObject}:refs/tags/${tag}`,
    ]);
    return { ok: true };
  } catch (error) {
    const localRollback = await runGit(cwd, [
      "update-ref",
      "-d",
      `refs/tags/${tag}`,
      createdTagObject,
    ])
      .then(() => "deleted" as const)
      .catch(() => "failed" as const);
    const remoteTag = await gitRemoteTagExists(cwd, remote, tag)
      .then((present) => (present ? ("present" as const) : ("absent" as const)))
      .catch(() => "unknown" as const);
    const rollbackMessage =
      localRollback === "deleted"
        ? "The local tag created by this attempt was deleted."
        : "Local tag cleanup failed; the local tag may remain and needs inspection.";
    const outcomeMessage =
      remoteTag === "absent"
        ? "The remote tag is confirmed absent."
        : remoteTag === "present"
          ? "The remote tag is present; inspect it before deciding whether another release action is safe."
          : "The remote tag outcome is unknown; inspect the remote before retrying.";
    return {
      ok: false,
      failure: {
        code: "push_failed",
        localRollback,
        remoteTag,
        message: `Atomic release push of ${tag} to ${remote} failed: ${gitErrorText(error)} ${rollbackMessage} ${outcomeMessage}`,
      },
    };
  }
}

/** Commit subjects in `range` (e.g. "v1.2.0..HEAD"), newest first, no merges —
 *  the input to release-notes generation (native commitSubjects). */
export async function gitCommitSubjects(cwd: string, range: string): Promise<string[]> {
  const out = await runGit(cwd, ["log", "--no-merges", "--pretty=format:%s", range]);
  return out
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The git stderr from a failed execFile, else the error message — for surfacing. */
export function gitErrorText(error: unknown): string {
  const stderr = (error as { stderr?: string }).stderr;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim();
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Hidden-ref checkpoint capture (Slice 18a) — port of t3code's
// GitVcsDriver.captureCheckpoint (MIT). Snapshots the working tree as a
// checkpoint COMMIT stored at a hidden ref (refs/agent-deck/checkpoints/...),
// WITHOUT touching the user's real index or working tree: the tree is written
// through a THROWAWAY `GIT_INDEX_FILE` (seeded from HEAD so unchanged entries
// keep their mode), committed detached (`commit-tree`, no parent), and the ref
// is repointed. The real `.git/index`, the working tree, and HEAD are never
// read for staging nor mutated, so a session's staged state survives capture.
// ---------------------------------------------------------------------------

/** The absolute git common dir (worktree-aware — the shared `.git` of a linked
 * worktree), where the throwaway checkpoint index is written. */
export async function gitCommonDir(cwd: string): Promise<string> {
  const raw = (await runGit(cwd, ["rev-parse", "--git-common-dir"])).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

/** Whether HEAD resolves to a commit (false in a fresh repo with no commits). */
async function gitHasHead(cwd: string): Promise<boolean> {
  try {
    await runGit(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture the working tree of `cwd` as a hidden checkpoint commit at `ref`,
 * returning the commit oid. Uses a throwaway `GIT_INDEX_FILE` so the user's
 * real index / working tree / staged state are UNDISTURBED. `.gitignore` is
 * honored (ignored files — node_modules etc. — stay out of the snapshot); every
 * other tracked-or-untracked file is captured. `commit-tree` gets no parent so
 * the checkpoint commit is a detached snapshot, not history the user sees.
 */
export async function gitCaptureCheckpoint(cwd: string, ref: string): Promise<string> {
  const commonDir = await gitCommonDir(cwd);
  const tempIndex = path.join(commonDir, `agent-deck-checkpoint-index-${randomUUID()}`);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_INDEX_FILE: tempIndex,
    GIT_AUTHOR_NAME: "Agent Deck",
    GIT_AUTHOR_EMAIL: "agent-deck@users.noreply.github.com",
    GIT_COMMITTER_NAME: "Agent Deck",
    GIT_COMMITTER_EMAIL: "agent-deck@users.noreply.github.com",
  };
  try {
    // Seed the THROWAWAY index from HEAD (when there is one) so unchanged
    // entries keep their blob+mode, then stage the whole worktree into it.
    if (await gitHasHead(cwd)) {
      await runGitEnv(cwd, ["read-tree", "HEAD"], env);
    }
    await runGitEnv(cwd, ["add", "-A", "--", "."], env);
    const tree = (await runGitEnv(cwd, ["write-tree"], env)).trim();
    if (tree.length === 0) throw new Error("git write-tree returned an empty tree");
    const commit = (
      await runGitEnv(cwd, ["commit-tree", tree, "-m", `agent-deck checkpoint ${ref}`], env)
    ).trim();
    if (commit.length === 0) throw new Error("git commit-tree returned an empty commit");
    // update-ref needs no temp index (it touches refs, not the index).
    await runGit(cwd, ["update-ref", ref, commit]);
    return commit;
  } finally {
    // Best-effort: the throwaway index is inside the git common dir.
    await rm(tempIndex, { force: true }).catch(() => {});
  }
}

/** The commit oid a checkpoint ref points at, or null when the ref is absent. */
export async function gitRefCommit(cwd: string, ref: string): Promise<string | null> {
  try {
    const out = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/** The tree oid of a commit/ref (for verifying a checkpoint's captured tree),
 * or null when the rev is absent. */
export async function gitTreeOf(cwd: string, rev: string): Promise<string | null> {
  try {
    const out = (await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${rev}^{tree}`])).trim();
    return out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

/**
 * Restore the working tree of `cwd` to a hidden checkpoint `ref` (Slice 18b
 * rollback) — port of t3code's GitVcsDriver.restoreCheckpoint (MIT). Returns
 * `true` when the ref resolved and the worktree was restored, `false` when the
 * ref is absent (nothing to restore).
 *
 * This DOES NOT move the branch pointer: the checkpoint is a PARENTLESS detached
 * snapshot commit, so `git reset --hard <checkpoint>` would rewrite the current
 * branch onto it and destroy history. Instead it rebuilds the worktree the way
 * the donor does, WITHOUT touching HEAD:
 *   1. `git restore --source <commit> --worktree --staged -- .` — overwrite every
 *      path that EXISTS in the checkpoint tree with the captured version (staging
 *      them so the next step can't clean them), covering the "a post-checkpoint
 *      edit is reverted" and "a deleted file is brought back" cases.
 *   2. `git clean -fd -- .` — remove files created AFTER the checkpoint (they are
 *      not in its tree, so step 1 left them; they are untracked, so clean drops
 *      them). Ignored files (node_modules etc.) are NOT removed (no `-x`), matching
 *      the capture, which honored `.gitignore`.
 *   3. `git reset --quiet -- .` (only when HEAD exists) — return the index to HEAD
 *      so the session's staged state reflects reality again, not the checkpoint.
 *
 * The net effect: the worktree is byte-identical to the checkpoint's captured
 * tree, uncommitted post-checkpoint work is DISCARDED (the point of a rollback —
 * the UI confirms it), and committed history is untouched.
 */
export async function gitRestoreCheckpoint(cwd: string, ref: string): Promise<boolean> {
  const commit = await gitRefCommit(cwd, ref);
  if (commit === null) return false;
  await runGit(cwd, ["restore", "--source", commit, "--worktree", "--staged", "--", "."]);
  await runGit(cwd, ["clean", "-fd", "--", "."]);
  if (await gitHasHead(cwd)) {
    await runGit(cwd, ["reset", "--quiet", "--", "."]);
  }
  return true;
}

/** Delete hidden checkpoint refs (best-effort; a missing ref is not an error) —
 * the prune-beyond-cap path and S18b's rollback truncation. */
export async function gitDeleteRefs(cwd: string, refs: readonly string[]): Promise<void> {
  for (const ref of refs) {
    try {
      await runGit(cwd, ["update-ref", "-d", ref]);
    } catch {
      // Already gone / never created — tolerated.
    }
  }
}

/**
 * Push the current branch (native pushCurrentBranch). Try a plain `git push`;
 * if the branch has no upstream (common for a fresh branch), retry with
 * `-u origin <branch>`. Any other failure (no remote, rejected, auth) throws
 * with the git stderr so the caller can surface it.
 */
export async function gitPush(cwd: string): Promise<void> {
  try {
    await runGit(cwd, ["push"]);
    return;
  } catch (firstError) {
    const stderr = String((firstError as { stderr?: string }).stderr ?? "").toLowerCase();
    const missingUpstream =
      stderr.includes("no upstream") ||
      stderr.includes("set-upstream") ||
      stderr.includes("has no upstream");
    if (!missingUpstream) throw new Error(gitErrorText(firstError));
    const branch = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    try {
      await runGit(cwd, ["push", "-u", "origin", branch]);
    } catch (secondError) {
      throw new Error(gitErrorText(secondError));
    }
  }
}
