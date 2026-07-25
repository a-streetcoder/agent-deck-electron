import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSessionWorktree,
  gitCreateAndPushReleaseTag,
  gitLocalTagExists,
  gitReleaseSynchronization,
  gitRemoteTagExists,
  parseStatus,
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
  });

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

describe("session worktree branch ownership", () => {
  it("removes the branch it created when worktree add fails", async () => {
    const repo = makeRepo();
    const target = path.join(repo, "occupied-target");
    writeFileSync(target, "occupied\n");

    await expect(
      createSessionWorktree(repo, target, "agent-deck/session-failed-add"),
    ).rejects.toThrow();

    expect(branches(repo)).toEqual(["main"]);
    expect(existsSync(target)).toBe(false);
  });

  it("never deletes a pre-existing same-named branch", async () => {
    const repo = makeRepo();
    const branch = "agent-deck/session-existing";
    execFileSync("git", ["branch", branch, "main"], { cwd: repo });
    const target = path.join(repo, "target");

    await expect(createSessionWorktree(repo, target, branch)).rejects.toThrow();

    expect(branches(repo)).toEqual([branch, "main"]);
    expect(existsSync(target)).toBe(false);
  });
});
