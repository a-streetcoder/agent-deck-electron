import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLoopWorktree,
  createSessionWorktree,
  createSessionWorktreeWithBranchRetries,
  gitApplyPatch,
  gitApplyPatchCheck,
  gitBlobAtCommit,
  gitCommitsAhead,
  gitCreateAndPushReleaseTag,
  gitDeleteOwnedWorktreeBranchCas,
  gitLocalBranchRef,
  gitLocalTagExists,
  gitLoopWorktreePatch,
  gitOperationInProgress,
  gitOwnedWorktreeBranchOid,
  gitRepositoryIdentity,
  gitReleaseSynchronization,
  gitRemoteTagExists,
  gitRepoRelativePosixPath,
  gitWorktreePrune,
  gitWorktreeRegistrationMatches,
  gitWorkingTreeClean,
  gitWorktreeRegistrations,
  parseStatus,
  SessionWorktreeBranchCollisionError,
} from "../src/git.ts";

function makeRepo(): string {
  const repo = mkdtempSync(path.join(tmpdir(), "agent-deck-git-test-"));
  execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
  writeFileSync(path.join(repo, "README.md"), "test\n");
  execFileSync("git", ["add", "README.md"], { cwd: repo });
  execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
  return repo;
}

function git(repo: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" });
}

interface RemoteFixture {
  bare: string;
  work: string;
  peer: string;
  remote: string;
}

function makeRemoteFixture(remote = "publishing"): RemoteFixture {
  const root = mkdtempSync(path.join(tmpdir(), "agent-deck-release-sync-"));
  const bare = path.join(root, "remote.git");
  const work = path.join(root, "work");
  const peer = path.join(root, "peer");
  execFileSync("git", ["init", "--bare", bare]);
  execFileSync("git", ["init", "-b", "main", work]);
  git(work, ["config", "user.email", "test@example.com"]);
  git(work, ["config", "user.name", "Test"]);
  writeFileSync(path.join(work, "README.md"), "initial\n");
  git(work, ["add", "README.md"]);
  git(work, ["commit", "-m", "initial"]);
  git(work, ["remote", "add", remote, bare]);
  git(work, ["push", "-u", remote, "main"]);
  execFileSync("git", ["clone", "--branch", "main", bare, peer]);
  git(peer, ["config", "user.email", "peer@example.com"]);
  git(peer, ["config", "user.name", "Peer"]);
  return { bare, work, peer, remote };
}

function commitFile(repo: string, name: string, contents = name): void {
  writeFileSync(path.join(repo, name), `${contents}\n`);
  git(repo, ["add", name]);
  git(repo, ["commit", "-m", `add ${name}`]);
}

function branches(repo: string): string[] {
  return execFileSync("git", ["branch", "--format=%(refname:short)"], { cwd: repo })
    .toString()
    .trim()
    .split("\n")
    .filter(Boolean);
}

describe("git commit blobs", () => {
  it("reads exact committed bytes instead of checkout-filtered bytes", async () => {
    const repo = makeRepo();
    const commit = git(repo, ["rev-parse", "HEAD"]).trim();
    writeFileSync(path.join(repo, "README.md"), "test\r\n");

    const relative = gitRepoRelativePosixPath(repo, path.join(repo, "README.md"));
    expect(relative).toBe("README.md");
    expect(await gitBlobAtCommit(repo, commit, relative)).toEqual(Buffer.from("test\n"));
  });

  it("rejects malformed, ambiguous, and out-of-root blob paths", async () => {
    const repo = makeRepo();
    const commit = git(repo, ["rev-parse", "HEAD"]).trim();
    expect(() => gitRepoRelativePosixPath(repo, path.join(repo, "..", "outside"))).toThrow(
      "git_blob_path_outside_repository",
    );
    for (const candidate of ["../README.md", "/README.md", "a\\README.md", "HEAD:README.md"]) {
      await expect(gitBlobAtCommit(repo, commit, candidate)).rejects.toThrow(
        "invalid_git_blob_path",
      );
    }
    await expect(gitBlobAtCommit(repo, "HEAD", "README.md")).rejects.toThrow("invalid_git_commit");
  });
});

describe("git porcelain parsing", () => {
  it("parses the branch and file changes", () => {
    const out = parseStatus(
      "## main...origin/main [ahead 1]\n M src/a.ts\n?? new file.ts\nA  added.ts\n",
    );
    expect(out.branch).toBe("main");
    expect(out.files).toEqual([
      { status: " M", path: "src/a.ts" },
      { status: "??", path: "new file.ts" }, // a path with a space survives verbatim
      { status: "A ", path: "added.ts" },
    ]);
  });

  it("handles a bare branch with no upstream", () => {
    expect(parseStatus("## feature-x\n").branch).toBe("feature-x");
  });

  it("handles a fresh repo with no commits yet", () => {
    expect(parseStatus("## No commits yet on main\n?? README.md\n").branch).toBe("main");
  });

  it("reports no branch for a detached HEAD", () => {
    const out = parseStatus("## HEAD (no branch)\n M src/a.ts\n");
    expect(out.branch).toBeUndefined();
    expect(out.files).toEqual([{ status: " M", path: "src/a.ts" }]);
  });

  it("a clean tree yields no files", () => {
    const out = parseStatus("## main...origin/main\n");
    expect(out.files).toEqual([]);
  });
});

describe("strict release synchronization", () => {
  it("is ready on a synchronized non-origin upstream and captures HEAD", async () => {
    const { work } = makeRemoteFixture();
    const result = await gitReleaseSynchronization(work);
    expect(result).toMatchObject({
      state: "ready",
      branch: "main",
      upstream: "publishing/main",
      remote: "publishing",
      ahead: 0,
      behind: 0,
      blocker: null,
    });
    expect(result.headSha).toBe(git(work, ["rev-parse", "HEAD"]).trim());
  }, 15_000);

  it("classifies dirty, ahead, behind, and diverged histories", async () => {
    const dirty = makeRemoteFixture();
    writeFileSync(path.join(dirty.work, "dirty.txt"), "wip\n");
    expect((await gitReleaseSynchronization(dirty.work)).state).toBe("dirty");

    const ahead = makeRemoteFixture();
    commitFile(ahead.work, "ahead.txt");
    expect(await gitReleaseSynchronization(ahead.work)).toMatchObject({
      state: "ahead",
      ahead: 1,
      behind: 0,
    });

    const behind = makeRemoteFixture();
    commitFile(behind.peer, "behind.txt");
    git(behind.peer, ["push", "origin", "main"]);
    expect(await gitReleaseSynchronization(behind.work)).toMatchObject({
      state: "behind",
      ahead: 0,
      behind: 1,
    });

    const diverged = makeRemoteFixture();
    commitFile(diverged.work, "local.txt");
    commitFile(diverged.peer, "remote.txt");
    git(diverged.peer, ["push", "origin", "main"]);
    expect(await gitReleaseSynchronization(diverged.work)).toMatchObject({
      state: "diverged",
      ahead: 1,
      behind: 1,
    });
  }, 20_000);

  it("classifies detached HEAD, missing upstream, and an unreachable remote", async () => {
    const detached = makeRemoteFixture();
    git(detached.work, ["checkout", "--detach"]);
    expect((await gitReleaseSynchronization(detached.work)).state).toBe("detached");

    const missing = makeRepo();
    expect((await gitReleaseSynchronization(missing)).state).toBe("missing_upstream");

    const unreachable = makeRemoteFixture();
    git(unreachable.work, [
      "remote",
      "set-url",
      unreachable.remote,
      path.join(unreachable.bare, "missing"),
    ]);
    expect((await gitReleaseSynchronization(unreachable.work)).state).toBe("fetch_failed");
  });

  it("distinguishes exact local/remote tags and propagates remote lookup failures", async () => {
    const fixture = makeRemoteFixture();
    git(fixture.work, ["tag", "v1.0.0"]);
    expect(await gitLocalTagExists(fixture.work, "v1.0.0")).toBe(true);
    expect(await gitRemoteTagExists(fixture.work, fixture.remote, "v1.0.0")).toBe(false);
    git(fixture.work, ["push", fixture.remote, "v1.0.0"]);
    expect(await gitRemoteTagExists(fixture.work, fixture.remote, "v1.0.0")).toBe(true);
    git(fixture.work, ["remote", "set-url", fixture.remote, path.join(fixture.bare, "missing")]);
    await expect(gitRemoteTagExists(fixture.work, fixture.remote, "v2.0.0")).rejects.toThrow();
  });

  it("rolls back its local tag when a concurrent remote tag rejects the push", async () => {
    const fixture = makeRemoteFixture();
    const sync = await gitReleaseSynchronization(fixture.work);
    expect(sync.state).toBe("ready");
    expect(await gitRemoteTagExists(fixture.work, fixture.remote, "v2.0.0")).toBe(false);

    git(fixture.peer, ["tag", "v2.0.0"]);
    git(fixture.peer, ["push", "origin", "v2.0.0"]);
    const result = await gitCreateAndPushReleaseTag(
      fixture.work,
      "v2.0.0",
      "notes",
      sync.headSha!,
      fixture.remote,
      sync.remoteRef!,
    );
    expect(result).toMatchObject({
      ok: false,
      failure: { code: "push_failed", localRollback: "deleted", remoteTag: "present" },
    });
    expect(await gitLocalTagExists(fixture.work, "v2.0.0")).toBe(false);
  });

  it("atomically rejects a remote branch advance after synchronization and publishes no tag", async () => {
    const fixture = makeRemoteFixture();
    const sync = await gitReleaseSynchronization(fixture.work);
    expect(sync.state).toBe("ready");

    const result = await gitCreateAndPushReleaseTag(
      fixture.work,
      "v2.1.0",
      "notes",
      sync.headSha!,
      fixture.remote,
      sync.remoteRef!,
      {
        beforePush: () => {
          commitFile(fixture.peer, "remote-race.txt");
          git(fixture.peer, ["push", "origin", "main"]);
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "push_failed", localRollback: "deleted", remoteTag: "absent" },
    });
    expect(await gitRemoteTagExists(fixture.work, fixture.remote, "v2.1.0")).toBe(false);
  });

  it("pushes the owned tag object and cannot roll back another actor's replacement", async () => {
    const fixture = makeRemoteFixture();
    const sync = await gitReleaseSynchronization(fixture.work);
    expect(sync.state).toBe("ready");
    let replacementObject = "";

    const result = await gitCreateAndPushReleaseTag(
      fixture.work,
      "v2.2.0",
      "owned notes",
      sync.headSha!,
      fixture.remote,
      sync.remoteRef!,
      {
        beforePush: (ownedObject) => {
          git(fixture.work, [
            "tag",
            "-a",
            "replacement-object",
            sync.headSha!,
            "-m",
            "replacement",
          ]);
          replacementObject = git(fixture.work, [
            "rev-parse",
            "refs/tags/replacement-object",
          ]).trim();
          git(fixture.work, ["update-ref", "refs/tags/v2.2.0", replacementObject, ownedObject]);
          commitFile(fixture.peer, "remote-replacement-race.txt");
          git(fixture.peer, ["push", "origin", "main"]);
        },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      failure: { code: "push_failed", localRollback: "failed", remoteTag: "absent" },
    });
    expect(git(fixture.work, ["rev-parse", "refs/tags/v2.2.0"]).trim()).toBe(replacementObject);
    expect(await gitRemoteTagExists(fixture.work, fixture.remote, "v2.2.0")).toBe(false);
  });

  it("rejects a stale local worktree immediately before tag-ref creation", async () => {
    const fixture = makeRemoteFixture();
    const sync = await gitReleaseSynchronization(fixture.work);
    const result = await gitCreateAndPushReleaseTag(
      fixture.work,
      "v2.3.0",
      "notes",
      sync.headSha!,
      fixture.remote,
      sync.remoteRef!,
      { beforeLocalRefCreate: () => writeFileSync(path.join(fixture.work, "late.txt"), "late\n") },
    );
    expect(result).toMatchObject({ ok: false, failure: { code: "stale_local" } });
    expect(await gitLocalTagExists(fixture.work, "v2.3.0")).toBe(false);
    expect(await gitRemoteTagExists(fixture.work, fixture.remote, "v2.3.0")).toBe(false);
  });
});

describe("Loop worktree review patch", () => {
  it("captures an immutable pre-add base and committed, staged, unstaged, rename, delete, untracked, and binary changes", async () => {
    const repo = makeRepo();
    writeFileSync(path.join(repo, "rename-me.txt"), "rename\n");
    writeFileSync(path.join(repo, "delete-me.txt"), "delete\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "fixtures"]);
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    const root = mkdtempSync(path.join(tmpdir(), "loop-review-patch-"));
    const target = path.join(root, "loop-owned");
    const worktree = await createLoopWorktree(repo, target, "agent-deck/loop-review-test");
    expect(worktree.baseCommit).toBe(base);

    writeFileSync(path.join(target, "committed.txt"), "committed\n");
    git(target, ["add", "committed.txt"]);
    git(target, ["commit", "-m", "worktree commit"]);
    writeFileSync(path.join(target, "staged.txt"), "staged\n");
    git(target, ["add", "staged.txt"]);
    writeFileSync(path.join(target, "README.md"), "unstaged\n");
    git(target, ["mv", "rename-me.txt", "renamed.txt"]);
    rmSync(path.join(target, "delete-me.txt"));
    writeFileSync(path.join(target, "untracked.txt"), "untracked\n");
    writeFileSync(path.join(target, "binary.bin"), Buffer.from([0, 1, 2, 255]));

    const review = await gitLoopWorktreePatch(target, base);
    expect(review.bytes.toString("utf8")).toContain("GIT binary patch");
    expect(review.changedFiles.map((file) => file.path)).toEqual(
      expect.arrayContaining([
        "README.md",
        "binary.bin",
        "committed.txt",
        "delete-me.txt",
        "renamed.txt",
        "staged.txt",
        "untracked.txt",
      ]),
    );
    expect(review.changedFiles).toContainEqual(
      expect.objectContaining({ path: "renamed.txt", oldPath: "rename-me.txt", status: "renamed" }),
    );
    expect(review.changedFiles).toContainEqual(
      expect.objectContaining({ path: "delete-me.txt", status: "deleted" }),
    );
    expect(review.changedFiles).toContainEqual(
      expect.objectContaining({ path: "binary.bin", status: "binary" }),
    );
    // The real index is unchanged by review generation.
    expect(git(target, ["diff", "--cached", "--name-only"])).toContain("staged.txt");
    expect(git(target, ["status", "--porcelain"])).toContain("?? untracked.txt");
  });

  it("checks and applies exact patch bytes from stdin onto an evolved clean source branch", async () => {
    const repo = makeRepo();
    const base = git(repo, ["rev-parse", "HEAD"]).trim();
    const target = path.join(mkdtempSync(path.join(tmpdir(), "loop-stdin-")), "worktree");
    await createLoopWorktree(repo, target, "agent-deck/loop-stdin-test");
    writeFileSync(path.join(target, "loop.txt"), "from loop\n");
    const patch = await gitLoopWorktreePatch(target, base);

    writeFileSync(path.join(repo, "evolved.txt"), "source evolved\n");
    git(repo, ["add", "evolved.txt"]);
    git(repo, ["commit", "-m", "evolve source"]);

    await gitApplyPatchCheck(repo, patch.bytes);
    await gitApplyPatch(repo, patch.bytes);
    expect(readFileSync(path.join(repo, "loop.txt"), "utf8")).toBe("from loop\n");
    expect(readFileSync(path.join(repo, "evolved.txt"), "utf8")).toBe("source evolved\n");
  });
});

describe("session worktree branch ownership", () => {
  it("allocates base-2 with exact ownership when the generated base branch is occupied", async () => {
    const repo = makeRepo();
    const target = path.join(mkdtempSync(path.join(tmpdir(), "session-retry-")), "target");
    const baseBranch = "agent-deck/session-generated";
    const identityToken = "v1:0000000000000001:0000000000000002";
    execFileSync("git", ["branch", baseBranch, "main"], { cwd: repo });

    const worktree = await createSessionWorktreeWithBranchRetries(
      repo,
      target,
      baseBranch,
      identityToken,
    );

    expect(worktree).toEqual({
      path: target,
      branch: `${baseBranch}-2`,
      sourceBranch: "main",
      identityToken,
      branchOwned: true,
    });
    expect(await gitWorktreeRegistrationMatches(repo, target, `${baseBranch}-2`)).toBe(true);
    expect(await gitOwnedWorktreeBranchOid(repo, baseBranch)).toBe(
      git(repo, ["rev-parse", "main"]).trim(),
    );
    expect(await gitOwnedWorktreeBranchOid(repo, `${baseBranch}-2`)).toBe(
      git(repo, ["rev-parse", "main"]).trim(),
    );
  });

  it("exhausts the base through -50 without creating or registering a target", async () => {
    const repo = makeRepo();
    const target = path.join(mkdtempSync(path.join(tmpdir(), "session-exhausted-")), "target");
    const baseBranch = "agent-deck/session-exhausted";
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const branch = attempt === 0 ? baseBranch : `${baseBranch}-${attempt + 1}`;
      execFileSync("git", ["branch", branch, "main"], { cwd: repo });
    }

    await expect(
      createSessionWorktreeWithBranchRetries(
        repo,
        target,
        baseBranch,
        "v1:0000000000000001:0000000000000002",
      ),
    ).rejects.toMatchObject({ baseBranch, attempts: 50 });

    expect(existsSync(target)).toBe(false);
    expect((await gitWorktreeRegistrations(repo)).some((entry) => entry.path === target)).toBe(
      false,
    );
    // ~100 sequential git spawns (50 branch creates + 50 colliding attempts):
    // far beyond the 5s default on loaded CI runners (every completed CI run
    // since 2026-08-03 timed out here).
  }, 120_000);

  it("classifies only an exact pre-existing branch as a retryable collision", async () => {
    const repo = makeRepo();
    const target = path.join(repo, "unused-target");
    const branch = "agent-deck/session-pre-existing";
    execFileSync("git", ["branch", branch, "main"], { cwd: repo });

    await expect(
      createSessionWorktree(repo, target, branch, "v1:0000000000000001:0000000000000002"),
    ).rejects.toEqual(expect.any(SessionWorktreeBranchCollisionError));

    expect(branches(repo)).toEqual([branch, "main"]);
    expect(existsSync(target)).toBe(false);
  });

  it("does not classify a non-collision branch failure as retryable", async () => {
    const repo = makeRepo();
    const target = path.join(repo, "unused-invalid-target");
    let failure: unknown;

    try {
      await createSessionWorktree(
        repo,
        target,
        "agent-deck/session-invalid..name",
        "v1:0000000000000001:0000000000000002",
      );
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(SessionWorktreeBranchCollisionError);
    expect(branches(repo)).toEqual(["main"]);
    expect(existsSync(target)).toBe(false);
  });

  it("returns ownership proof without deleting an occupied target when worktree add fails", async () => {
    const repo = makeRepo();
    const target = path.join(repo, "occupied-target");
    mkdirSync(target);
    writeFileSync(path.join(target, "sentinel"), "occupied\n");

    await expect(
      createSessionWorktree(
        repo,
        target,
        "agent-deck/session-failed-add",
        "v1:0000000000000001:0000000000000002",
      ),
    ).rejects.toMatchObject({
      worktree: expect.objectContaining({
        branch: "agent-deck/session-failed-add",
        branchOwned: true,
      }),
    });

    expect(branches(repo)).toEqual(["agent-deck/session-failed-add", "main"]);
    expect(readFileSync(path.join(target, "sentinel"), "utf8")).toBe("occupied\n");
  });

  it("keeps a target registered to another branch untouched", async () => {
    const repo = makeRepo();
    const target = path.join(mkdtempSync(path.join(tmpdir(), "other-worktree-")), "target");
    execFileSync("git", ["branch", "other-owner", "main"], { cwd: repo });
    execFileSync("git", ["worktree", "add", target, "other-owner"], { cwd: repo });
    const sentinel = path.join(target, "README.md");

    await expect(
      createSessionWorktree(
        repo,
        target,
        "agent-deck/session-collision",
        "v1:0000000000000001:0000000000000002",
      ),
    ).rejects.toMatchObject({
      worktree: expect.objectContaining({ branch: "agent-deck/session-collision" }),
    });

    expect(await gitWorktreeRegistrationMatches(repo, target, "agent-deck/session-collision")).toBe(
      false,
    );
    expect(readFileSync(sentinel, "utf8").replaceAll("\r\n", "\n")).toBe("test\n");
    expect(existsSync(target)).toBe(true);
  });

  it("expires registration immediately after physical removal so its owned branch can be deleted", async () => {
    const repo = makeRepo();
    const target = path.join(mkdtempSync(path.join(tmpdir(), "prune-worktree-")), "target");
    const branch = "agent-deck/session-prune-now";
    execFileSync("git", ["branch", branch, "main"], { cwd: repo });
    execFileSync("git", ["worktree", "add", target, branch], { cwd: repo });
    rmSync(target, { recursive: true });

    await gitWorktreePrune(repo);

    expect((await gitWorktreeRegistrations(repo)).some((entry) => entry.path === target)).toBe(
      false,
    );
    expect(() => execFileSync("git", ["branch", "-D", "--", branch], { cwd: repo })).not.toThrow();
  });

  it("atomically CAS-deletes only the exact owned branch object and is absent-idempotent", async () => {
    const repo = makeRepo();
    const worktree = {
      path: path.join(repo, "removed-worktree"),
      branch: "agent-deck/session-cas-delete",
      sourceBranch: "main",
      identityToken: "v1:0000000000000001:0000000000000002",
      branchOwned: true as const,
    };
    const expectedOid = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["branch", worktree.branch, expectedOid]);
    expect(await gitOwnedWorktreeBranchOid(repo, worktree.branch)).toBe(expectedOid);

    commitFile(repo, "replacement.txt");
    const replacementOid = git(repo, ["rev-parse", "HEAD"]).trim();
    git(repo, ["update-ref", `refs/heads/${worktree.branch}`, replacementOid, expectedOid]);
    await expect(gitDeleteOwnedWorktreeBranchCas(repo, worktree, expectedOid)).rejects.toThrow();
    expect(await gitOwnedWorktreeBranchOid(repo, worktree.branch)).toBe(replacementOid);

    await gitDeleteOwnedWorktreeBranchCas(repo, worktree, replacementOid);
    expect(await gitOwnedWorktreeBranchOid(repo, worktree.branch)).toBeUndefined();
    await expect(
      gitDeleteOwnedWorktreeBranchCas(repo, worktree, replacementOid),
    ).resolves.toBeUndefined();
  });

  it("never deletes a pre-existing same-named branch", async () => {
    const repo = makeRepo();
    const branch = "agent-deck/session-existing";
    execFileSync("git", ["branch", branch, "main"], { cwd: repo });
    const target = path.join(repo, "target");

    await expect(
      createSessionWorktree(repo, target, branch, "v1:0000000000000001:0000000000000002"),
    ).rejects.toThrow();

    expect(branches(repo)).toEqual([branch, "main"]);
    expect(existsSync(target)).toBe(false);
  });
});

describe("merge preflight plumbing", () => {
  it("distinguishes exact zero ahead and detects every porcelain dirty class", async () => {
    const repo = makeRepo();
    expect(await gitCommitsAhead(repo, "main", "main")).toBe(0);
    expect(await gitWorkingTreeClean(repo)).toBe(true);

    writeFileSync(path.join(repo, "README.md"), "unstaged\n");
    expect(await gitWorkingTreeClean(repo)).toBe(false);
    git(repo, ["add", "README.md"]);
    expect(await gitWorkingTreeClean(repo)).toBe(false);
    git(repo, ["reset", "--hard", "HEAD"]);
    writeFileSync(path.join(repo, "untracked.txt"), "new\n");
    expect(await gitWorkingTreeClean(repo)).toBe(false);
  });

  it("validates local refs, repository identity, and operation markers", async () => {
    const repo = makeRepo();
    expect(await gitLocalBranchRef(repo, "main")).toBe("refs/heads/main");
    await expect(gitLocalBranchRef(repo, "-invalid")).rejects.toThrow();
    expect(await gitRepositoryIdentity(repo)).toBeTruthy();
    expect(await gitOperationInProgress(repo)).toBe(false);
    writeFileSync(path.join(repo, ".git", "MERGE_HEAD"), "deadbeef\n");
    expect(await gitOperationInProgress(repo)).toBe(true);
  });
});
