import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSessionWorktree, parseStatus } from "../src/git.ts";

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
