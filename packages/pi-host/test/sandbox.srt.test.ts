import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sandboxPolicy } from "@agent-deck/domain";
import { describe, expect, it } from "vitest";
import { createSrtProvider } from "../src/sandbox.ts";

// Real srt with real folders. Linux with bubblewrap only; SBX-04 runs it on
// the VM inside the server image.
const bwrap = process.platform === "linux" && spawnSync("bwrap", ["--version"]).status === 0;

describe.skipIf(!bwrap)("srt provider (real srt, Linux with bubblewrap)", () => {
  it("a sandboxed child writes inside the project and fails outside, leaving no placeholders", async () => {
    const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "sbx-data-")));
    const project = path.join(dataDir, "projects", "app");
    const outside = path.join(dataDir, "outside");
    const agentDir = path.join(dataDir, "home", ".pi", "agent");
    mkdirSync(path.join(project, ".git"), { recursive: true });
    writeFileSync(path.join(project, ".git", "config"), "[core]\n");
    mkdirSync(outside, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    const otherSessions = path.join(agentDir, "sessions", "--other--");
    mkdirSync(otherSessions, { recursive: true });
    writeFileSync(path.join(otherSessions, "t.jsonl"), "theirs\n");
    const policy = sandboxPolicy({ id: "s1", location: { kind: "server" } }, "server", {
      dataDir,
      projectPath: project,
      piAgentDir: agentDir,
      agentDir,
      sessionDir: path.join(agentDir, "sessions", "--app--"),
    });
    const provider = createSrtProvider();
    try {
      const wrapped = await provider.wrap(
        {
          command: "/bin/sh",
          args: [
            "-c",
            'echo in > "$1/in.txt"; echo git >> "$1/.git/config"; echo out > "$2/out.txt"; echo mine > "$3/t.jsonl"',
            "sh",
            project,
            outside,
            otherSessions,
          ],
          env: { PATH: process.env.PATH },
          cwd: project,
        },
        policy,
      );
      const run = spawnSync(wrapped.command, wrapped.args, {
        cwd: wrapped.cwd,
        env: wrapped.env,
        encoding: "utf8",
      });
      wrapped.release?.();
      expect(existsSync(path.join(project, "in.txt"))).toBe(true);
      expect(existsSync(path.join(outside, "out.txt"))).toBe(false);
      expect(run.status).not.toBe(0);
      expect(run.stderr).toMatch(/Read-only file system|Permission denied/);
      // .git is read-only without a worktree.
      expect(spawnSync("cat", [path.join(project, ".git", "config")]).stdout.toString()).toBe(
        "[core]\n",
      );
      // Another session's transcript: the read-denied tree is a tmpfs inside.
      expect(spawnSync("cat", [path.join(otherSessions, "t.jsonl")]).stdout.toString()).toBe(
        "theirs\n",
      );
      // An absent deny path under a writable root is created as its kind;
      // one outside every writable root is neither created nor passed.
      expect(statSync(path.join(agentDir, "extensions")).isDirectory()).toBe(true);
      expect(readFileSync(path.join(agentDir, "trust.json"), "utf8")).toBe("{}");
      expect(existsSync(path.join(dataDir, "home", ".gitconfig"))).toBe(false);
    } finally {
      await provider.dispose?.();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("a worktree session commits, but cannot touch the repository's config, hooks or pointers", async () => {
    const dataDir = realpathSync(mkdtempSync(path.join(tmpdir(), "sbx-data-")));
    const repo = path.join(dataDir, "projects", "app");
    const worktree = path.join(dataDir, "session-worktrees", "s2");
    const agentDir = path.join(dataDir, "home", ".pi", "agent");
    mkdirSync(agentDir, { recursive: true });
    const env = {
      PATH: process.env.PATH,
      HOME: path.join(dataDir, "home"),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "T",
      GIT_AUTHOR_EMAIL: "t@example.com",
      GIT_COMMITTER_NAME: "T",
      GIT_COMMITTER_EMAIL: "t@example.com",
    };
    const git = (cwd: string, ...args: string[]) =>
      spawnSync("git", args, { cwd, env, encoding: "utf8" });
    mkdirSync(repo, { recursive: true });
    git(repo, "init", "-q", "-b", "main");
    writeFileSync(path.join(repo, "a.txt"), "a\n");
    git(repo, "add", "a.txt");
    git(repo, "commit", "-qm", "init");
    git(repo, "worktree", "add", "-q", "-b", "s2", worktree);
    const baseCommit = git(repo, "rev-parse", "HEAD").stdout.trim();
    const gitDir = path.join(repo, ".git");
    const policy = sandboxPolicy(
      { id: "s2", location: { kind: "server" }, workspace: { path: worktree, baseCommit } },
      "server",
      {
        dataDir,
        projectPath: repo,
        piAgentDir: agentDir,
        agentDir,
        sessionDir: path.join(agentDir, "sessions", "--s2--"),
      },
    );
    const provider = createSrtProvider();
    try {
      const protectedPaths = [
        path.join(gitDir, "config"),
        path.join(gitDir, "hooks", "pre-commit"),
        path.join(gitDir, "worktrees", "s2", "commondir"),
        path.join(gitDir, "worktrees", "s2", "gitdir"),
      ];
      const wrapped = await provider.wrap(
        {
          command: "/bin/sh",
          args: [
            "-c",
            'echo b > b.txt && git add b.txt && git commit -qm second || exit 9; shift; for f; do echo x >> "$f" && echo "WROTE $f"; done; exit 0',
            "sh",
            "--",
            ...protectedPaths,
          ],
          env,
          cwd: worktree,
        },
        policy,
      );
      const run = spawnSync(wrapped.command, wrapped.args, {
        cwd: wrapped.cwd,
        env: wrapped.env,
        encoding: "utf8",
      });
      wrapped.release?.();
      expect(run.status, run.stderr).toBe(0);
      expect(git(worktree, "log", "--format=%s", "-1").stdout.trim()).toBe("second");
      expect(run.stdout).not.toContain("WROTE");
      expect(existsSync(path.join(gitDir, "hooks", "pre-commit"))).toBe(false);
    } finally {
      await provider.dispose?.();
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 60_000);
});
