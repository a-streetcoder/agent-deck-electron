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
});
