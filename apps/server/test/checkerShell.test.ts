import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CHECKER_SHELL_TOOL, writeCheckerShellExtension } from "../src/checkerShell.ts";
import { killProcessTree } from "../src/processTree.ts";

type Execute = (
  id: string,
  params: { command: string },
  signal?: AbortSignal,
) => Promise<{ content: { text: string }[] }>;

const root = mkdtempSync(path.join(tmpdir(), "checker-shell-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function gitRepo(name: string): string {
  const repo = path.join(root, name);
  mkdirSync(repo);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q");
  writeFileSync(path.join(repo, "a.txt"), "x\n");
  git("add", "a.txt");
  git("-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-qm", "init");
  writeFileSync(path.join(repo, "a.txt"), "x\ny\n");
  return repo;
}

let extensions = 0;
async function loadTool(cwd: string): Promise<Execute> {
  const dir = path.join(root, `ext-${++extensions}`);
  mkdirSync(dir);
  const file = writeCheckerShellExtension(dir, { cwd });
  const tools: Array<{ name: string; execute: Execute }> = [];
  const mod = (await import(pathToFileURL(file).href)) as {
    default: (pi: { registerTool: (tool: never) => void }) => void;
  };
  mod.default({ registerTool: (tool) => tools.push(tool) });
  expect(tools.map((tool) => tool.name)).toEqual([CHECKER_SHELL_TOOL]);
  return tools[0]!.execute;
}

const text = async (run: Execute, command: string): Promise<string> =>
  (await run("id", { command })).content[0]!.text;

describe("checker_shell extension", () => {
  const repo = gitRepo("clean");

  it("runs allowlisted read-only git in the loop cwd", async () => {
    const run = await loadTool(repo);
    expect(await text(run, "git status --porcelain")).toContain("M a.txt");
    expect(await text(run, "git diff --stat -- a.txt")).toContain("a.txt | 1 +");
    expect(await text(run, "git diff -U1 --name-status")).toContain("M\ta.txt");
    expect(await text(run, "git log --oneline -n 1")).toContain("init");
    expect(await text(run, "git log --max-count=1 --format=short")).toContain("Author: t");
    expect(await text(run, "git show --stat HEAD")).toContain("a.txt");
    expect(await text(run, "git show HEAD:a.txt")).toBe("exit 0\n\nstdout:\nx");
  });

  it("ignores inherited GIT_* variables", async () => {
    const run = await loadTool(repo);
    process.env.GIT_DIR = path.join(root, "missing-git-dir");
    process.env.GIT_EXTERNAL_DIFF = "node -e \"require('fs').writeFileSync('pwned', '')\"";
    try {
      expect(await text(run, "git diff")).toContain("+y");
    } finally {
      delete process.env.GIT_DIR;
      delete process.env.GIT_EXTERNAL_DIFF;
    }
    expect(existsSync(path.join(repo, "pwned"))).toBe(false);
  });

  it.each([
    "",
    "rm -rf a.txt",
    "node -e \"require('fs').unlinkSync('a.txt')\"",
    "exit 0",
    "git checkout -- a.txt",
    "git -c core.pager=rm status",
    "git status; rm a.txt",
    "git status && rm a.txt",
    // Git accepts unambiguous abbreviations: --ext-dif would override --no-ext-diff.
    "git diff --no-index --ext-dif -- a b",
    "git diff --ext-dif",
    "git log -n 1; rm a.txt",
    "git log -n 0",
    "git show HEAD:../outside.txt",
    "git diff /etc/passwd a.txt",
    "git diff C:/Windows/win.ini a.txt",
    "git diff -- -rf",
  ])("refuses %j before anything executes", async (command) => {
    const run = await loadTool(repo);
    await expect(run("id", { command })).rejects.toThrow(/checker_shell refused/);
    expect(existsSync(path.join(repo, "a.txt"))).toBe(true);
  });

  it("refuses dangerous git options and every abbreviation of them", async () => {
    const run = await loadTool(repo);
    const dangerous = [
      "--ext-diff",
      "--textconv",
      "--output=x",
      "--no-index",
      "--exec=x",
      "--upload-pack=x",
      "--show-signature",
      "--open-files-in-pager",
      "--git-dir=x",
      "--work-tree=x",
      "--pretty=format:%x",
      "--format=%H",
      "--notes",
      "--ignore-submodules=none",
      "--submodule=diff",
      "--color-moved",
      "--patch-with-raw",
    ];
    const allowed: Record<string, string[]> = {
      status: ["--porcelain", "--short", "-s", "--branch"],
      diff: ["--stat", "--numstat", "--name-only", "--name-status", "--cached"],
      log: ["--oneline", "--stat", "--name-only"],
      show: ["--stat", "--name-only"],
    };
    let checked = 0;
    for (const option of dangerous) {
      for (let length = 3; length <= option.length; length += 1) {
        const prefix = option.slice(0, length);
        for (const sub of Object.keys(allowed)) {
          if (allowed[sub]!.includes(prefix)) continue;
          await expect(run("id", { command: `git ${sub} ${prefix}` })).rejects.toThrow(
            /not on the read-only allowlist/,
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(500);
  });

  it("refuses git when the repository plants a content filter", async () => {
    const planted = gitRepo("planted");
    const marker = path.join(planted, "filter-ran");
    writeFileSync(path.join(planted, ".gitattributes"), "*.txt filter=evil\n");
    execFileSync(
      "git",
      ["config", "filter.evil.clean", `node -e "require('fs').writeFileSync('filter-ran', '')"`],
      { cwd: planted },
    );
    const run = await loadTool(planted);
    for (const command of ["git status", "git diff", "git log --stat"]) {
      await expect(run("id", { command })).rejects.toThrow(
        /repository defines content filters or diff drivers/,
      );
    }
    expect(existsSync(marker)).toBe(false);

    // Attributes alone (root or nested) and config alone are each enough.
    for (const folder of ["", "sub"]) {
      const attributesOnly = gitRepo(`attributes-only${folder}`);
      mkdirSync(path.join(attributesOnly, folder), { recursive: true });
      writeFileSync(path.join(attributesOnly, folder, ".gitattributes"), "*.md diff=x\n");
      await expect(
        (await loadTool(attributesOnly))("id", { command: "git status" }),
      ).rejects.toThrow(/content filters or diff drivers/);
    }
    const configOnly = gitRepo("config-only");
    execFileSync("git", ["config", "diff.x.textconv", "cat"], { cwd: configOnly });
    await expect((await loadTool(configOnly))("id", { command: "git diff" })).rejects.toThrow(
      /content filters or diff drivers/,
    );
  });
});

describe("killProcessTree", () => {
  it("kills a shell, its child and grandchild, so close fires promptly", async () => {
    // The grandchild inherits stdout; close fires only once it is gone too.
    const child = spawn(
      `node -e "require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit' }); setTimeout(() => {}, 60000)"`,
      { shell: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] },
    );
    child.stdout.resume();
    child.stderr.resume();
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const started = Date.now();
    killProcessTree(child.pid!, spawn);
    await closed;
    expect(Date.now() - started).toBeLessThan(15_000);
  }, 30_000);
});
