import { writeFileSync } from "node:fs";
import path from "node:path";

/** Tool name the Loop checker calls; listed in the child's `--tools`. */
export const CHECKER_SHELL_TOOL = "checker_shell";

/**
 * Write the Pi extension that gives a Loop checker a read-only shell: it runs
 * the loop's configured validation command (exact text, through the platform
 * shell, as the engine does) or `git status|diff|log|show` with plain
 * arguments (no shell, external diff, textconv, output files or fsmonitor).
 * Every other command is refused before anything executes. Plain runtime JS
 * so Pi's jiti loader runs it directly; returns the file to pass as
 * `--extension`.
 */
export function writeCheckerShellExtension(
  directory: string,
  options: { cwd: string; validationCommand?: string },
): string {
  const file = path.join(directory, "checker-shell.ts");
  const cwd = JSON.stringify(options.cwd);
  const validationCommand = JSON.stringify(options.validationCommand?.trim() ?? "");
  writeFileSync(
    file,
    `import { exec, execFile } from "node:child_process";

export default function (pi) {
  const cwd = ${cwd};
  const validationCommand = ${validationCommand};
  const GIT_SUBCOMMANDS = new Set(["status", "diff", "log", "show"]);
  const SAFE_ARG = /^[A-Za-z0-9_.\\/:@^~=,+-]+$/;
  const UNSAFE_OPTION = /^--?(output|ext-diff|textconv|exec|upload-pack|receive-pack|open-files-in-pager)/;
  const LIMIT = 16 * 1024;
  const bound = (text) => (text.length > LIMIT ? "…" + text.slice(-LIMIT) : text);
  const plan = (command) => {
    const text = String(command ?? "").trim();
    if (validationCommand && text === validationCommand) return { kind: "validation" };
    const words = text.split(/\\s+/);
    if (words[0] !== "git" || !GIT_SUBCOMMANDS.has(words[1] ?? "")) {
      return { refused: "checker_shell runs only the loop's validation command" + (validationCommand ? " (" + validationCommand + ")" : " (none is configured)") + " or git status, diff, log or show." };
    }
    const args = words.slice(2);
    const bad = args.find((arg) => !SAFE_ARG.test(arg) || UNSAFE_OPTION.test(arg));
    if (bad) return { refused: "checker_shell refused the git argument " + JSON.stringify(bad) + ": only plain read-only arguments are allowed." };
    const sub = words[1];
    const extra = sub === "status" ? [] : ["--no-ext-diff", "--no-textconv"];
    return { kind: "git", args: ["--no-pager", "-c", "core.fsmonitor=false", sub, ...extra, ...args] };
  };
  const report = (error, stdout, stderr) => {
    const code = error ? (typeof error.code === "number" ? error.code : "unavailable (" + (error.killed ? "timed out" : String(error.message)) + ")") : 0;
    return ["exit " + code, stdout.trim() ? "stdout:\\n" + bound(stdout.trim()) : "", stderr.trim() ? "stderr:\\n" + bound(stderr.trim()) : ""].filter(Boolean).join("\\n\\n");
  };
  pi.registerTool({
    name: ${JSON.stringify(CHECKER_SHELL_TOOL)},
    label: "Checker shell",
    description: "Read-only shell for the loop checker. Runs exactly the loop's validation command" + (validationCommand ? " (" + validationCommand + ")" : " (none is configured)") + ", or git status, git diff, git log or git show with plain arguments, in the loop's working directory. Every other command is refused.",
    promptSnippet: "checker_shell: run the loop's validation command or read-only git (status, diff, log, show)",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "The validation command, or a git status/diff/log/show command." } },
      required: ["command"],
    },
    execute: async (_toolCallId, params, signal) => {
      const step = plan(params && params.command);
      if (step.refused) throw new Error(step.refused);
      const options = { cwd, timeout: step.kind === "validation" ? 120000 : 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal };
      // ponytail: on Windows a timeout kills the shell, not its process tree;
      // the engine's own validation run (runValidationCommand) uses taskkill /t.
      const text = await new Promise((resolve) => {
        const done = (error, stdout, stderr) => resolve(report(error, String(stdout ?? ""), String(stderr ?? "")));
        if (step.kind === "validation") exec(validationCommand, options, done);
        else execFile("git", step.args, options, done);
      });
      return { content: [{ type: "text", text }], details: {} };
    },
  });
}
`,
  );
  return file;
}
