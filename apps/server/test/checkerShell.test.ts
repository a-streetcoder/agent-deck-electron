import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { CHECKER_SHELL_TOOL, writeCheckerShellExtension } from "../src/checkerShell.ts";

type Execute = (
  id: string,
  params: { command: string },
) => Promise<{ content: { text: string }[] }>;

const repo = mkdtempSync(path.join(tmpdir(), "checker-shell-"));
const extDir = mkdtempSync(path.join(tmpdir(), "checker-shell-ext-"));
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(extDir, { recursive: true, force: true });
});

async function loadTool(validationCommand?: string): Promise<Execute> {
  const file = writeCheckerShellExtension(mkdtempSync(path.join(extDir, "x-")), {
    cwd: repo,
    validationCommand,
  });
  const tools: Array<{ name: string; execute: Execute }> = [];
  const mod = (await import(pathToFileURL(file).href)) as {
    default: (pi: { registerTool: (tool: never) => void }) => void;
  };
  mod.default({ registerTool: (tool) => tools.push(tool) });
  expect(tools.map((tool) => tool.name)).toEqual([CHECKER_SHELL_TOOL]);
  return tools[0]!.execute;
}

describe("checker_shell extension", () => {
  execFileSync("git", ["init", "-q"], { cwd: repo });
  writeFileSync(path.join(repo, "a.txt"), "x\n");

  it("runs the exact validation command and read-only git in the loop cwd", async () => {
    const run = await loadTool(`node -e "process.stdout.write('validated')"`);
    const validation = await run("1", { command: ` node -e "process.stdout.write('validated')" ` });
    expect(validation.content[0]!.text).toBe("exit 0\n\nstdout:\nvalidated");
    const status = await run("2", { command: "git status --porcelain" });
    expect(status.content[0]!.text).toContain("?? a.txt");
  });

  it.each([
    "rm -rf a.txt",
    "node -e \"require('fs').unlinkSync('a.txt')\"",
    "git checkout -- a.txt",
    "git -c core.pager=rm status",
    "git diff --output=a.txt",
    "git log --ext-diff",
    "git status; rm a.txt",
    "git status && rm a.txt",
  ])("refuses %s before anything executes", async (command) => {
    const run = await loadTool("exit 0");
    await expect(run("3", { command })).rejects.toThrow(/checker_shell/);
    expect(existsSync(path.join(repo, "a.txt"))).toBe(true);
  });

  it("refuses a validation run when the loop configured none", async () => {
    const run = await loadTool("");
    await expect(run("4", { command: "" })).rejects.toThrow(/none is configured/);
  });
});
