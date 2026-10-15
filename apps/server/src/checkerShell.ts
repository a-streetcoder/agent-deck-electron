import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { killProcessTree } from "./processTree.ts";

/** Tool name the Loop checker calls; listed in the child's `--tools`. */
export const CHECKER_SHELL_TOOL = "checker_shell";

/**
 * Write the Pi extension that gives a Loop checker read-only git: `git
 * status|diff|log|show` with options from an exact per-subcommand allowlist (no
 * abbreviations) and plain revisions or repository-relative paths. It never runs
 * the validation command: the engine has already run it and the result is in
 * the checker's prompt. Git runs without a shell, with every GIT_*
 * variable removed, no system or global config, empty hooks and attributes,
 * and is refused when the repository defines content filters or diff drivers.
 * Every other command is refused before anything executes; timeouts and
 * cancellation kill the whole process tree (processTree.ts) and wait for it.
 *
 * `directory` must be owned by the launch and removed with it: it also holds
 * the empty config/attributes file and hooks folder. Plain runtime JS so Pi's
 * jiti loader runs it directly; returns the file to pass as `--extension`.
 */
export function writeCheckerShellExtension(
  directory: string,
  options: { cwd: string; timeoutMs?: number },
): string {
  const file = path.join(directory, "checker-shell.ts");
  const emptyFile = path.join(directory, "checker-shell-empty");
  const emptyHooks = path.join(directory, "checker-shell-hooks");
  writeFileSync(emptyFile, "");
  mkdirSync(emptyHooks, { recursive: true });
  writeFileSync(
    file,
    `import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export default function (pi) {
  const cwd = ${JSON.stringify(options.cwd)};
  const gitTimeoutMs = ${JSON.stringify(options.timeoutMs ?? 30_000)};
  const emptyFile = ${JSON.stringify(emptyFile)};
  const emptyHooks = ${JSON.stringify(emptyHooks)};
  const killTree = ${killProcessTree.toString()};
  const NL = String.fromCharCode(10);
  const LIMIT = 16 * 1024;
  const OPTIONS = {
    status: new Set(["--porcelain", "--short", "-s", "--branch"]),
    diff: new Set(["--stat", "--numstat", "--name-only", "--name-status", "--cached", "--"]),
    log: new Set(["--oneline", "--stat", "--name-only", "--"]),
    show: new Set(["--stat", "--name-only"]),
  };
  const FORMATS = new Set(["oneline", "short", "medium"]);
  const COUNT = /^[1-9][0-9]{0,4}$/;
  const POSITIONAL = /^[A-Za-z0-9_./:@^~=,+-]+$/;
  const gitOnly = "git status, diff, log or show";
  const refusal = (reason) => ({ refused: "checker_shell refused: " + reason });

  // A revision or a path inside the repository: no option, absolute path or "..".
  const positionalOk = (word) =>
    POSITIONAL.test(word) &&
    !word.startsWith("-") &&
    !word.startsWith("/") &&
    !/^[A-Za-z]:/.test(word) &&
    !word.split(/[/:]/).includes("..");

  const plan = (command) => {
    const text = String(command ?? "").trim();
    const words = text.split(" ").filter(Boolean);
    const sub = words[1];
    if (words[0] !== "git" || !Object.prototype.hasOwnProperty.call(OPTIONS, sub)) {
      return refusal("it runs only " + gitOnly + "; the loop's validation result is already in your prompt.");
    }
    const args = [];
    let pathsOnly = false;
    for (let index = 2; index < words.length; index += 1) {
      const word = words[index];
      if (!pathsOnly && word.startsWith("-")) {
        if (word === "--") pathsOnly = true;
        if (OPTIONS[sub].has(word)) {
          args.push(word);
          continue;
        }
        if (sub === "diff" && (/^-U[0-9]{1,4}$/.test(word) || /^--unified=[0-9]{1,4}$/.test(word))) {
          args.push(word);
          continue;
        }
        if (sub === "log" && word === "-n" && COUNT.test(words[index + 1] ?? "")) {
          args.push(word, words[index + 1]);
          index += 1;
          continue;
        }
        if (sub === "log" && word.startsWith("--max-count=") && COUNT.test(word.slice(12))) {
          args.push(word);
          continue;
        }
        if ((sub === "log" || sub === "show") && word.startsWith("--format=") && FORMATS.has(word.slice(9))) {
          args.push(word);
          continue;
        }
        return refusal("git " + sub + " option " + JSON.stringify(word) + " is not on the read-only allowlist.");
      }
      if (!positionalOk(word)) {
        return refusal(JSON.stringify(word) + " is not a plain revision or repository path.");
      }
      args.push(word);
    }
    return { kind: "git", sub, args };
  };

  const run = (file, args, env, signal) =>
    new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      let child;
      const finish = (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (signal) signal.removeEventListener("abort", stop);
        resolve({ code, stdout, stderr, timedOut, aborted: Boolean(signal && signal.aborted) });
      };
      const stop = () => {
        if (child && child.pid) killTree(child.pid, spawn);
      };
      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, gitTimeoutMs);
      try {
        child = spawn(file, args, {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          detached: process.platform !== "win32",
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        stderr = String(error && error.message ? error.message : error);
        finish(null);
        return;
      }
      child.stdout.on("data", (chunk) => {
        stdout = (stdout + chunk.toString("utf8")).slice(-LIMIT);
      });
      child.stderr.on("data", (chunk) => {
        stderr = (stderr + chunk.toString("utf8")).slice(-LIMIT);
      });
      child.once("error", (error) => {
        stderr = (stderr + String(error.message)).slice(-LIMIT);
        finish(null);
      });
      // close fires only when every process holding the pipes has exited, so a
      // timeout or cancellation resolves after the whole tree is gone.
      child.once("close", (code) => finish(code));
      if (signal) {
        if (signal.aborted) stop();
        else signal.addEventListener("abort", stop, { once: true });
      }
    });

  const report = (result) => {
    const status = result.timedOut
      ? "timed out; process tree killed"
      : result.aborted
        ? "cancelled; process tree killed"
        : "exit " + (result.code ?? "unavailable");
    return [
      status,
      result.stdout.trim() ? "stdout:" + NL + result.stdout.trim() : "",
      result.stderr.trim() ? "stderr:" + NL + result.stderr.trim() : "",
    ]
      .filter(Boolean)
      .join(NL + NL);
  };

  // Repository helpers never run: no inherited GIT_* (GIT_DIR, GIT_EXTERNAL_DIFF,
  // GIT_CONFIG_*), no system or global config, no optional index writes.
  const gitEnv = () => {
    const env = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (!/^GIT_/i.test(key)) env[key] = value;
    }
    env.GIT_CONFIG_NOSYSTEM = "1";
    env.GIT_CONFIG_GLOBAL = emptyFile;
    env.GIT_OPTIONAL_LOCKS = "0";
    env.GIT_TERMINAL_PROMPT = "0";
    return env;
  };
  const SAFE_CONFIG = [
    "--no-pager",
    "--no-optional-locks",
    "-c", "core.hooksPath=" + emptyHooks,
    "-c", "core.attributesFile=" + emptyFile,
    "-c", "core.fsmonitor=false",
    "-c", "diff.external=",
    "-c", "log.showSignature=false",
    "-c", "status.submoduleSummary=false",
    "-c", "diff.ignoreSubmodules=all",
  ];
  const ATTRIBUTE_HELPER = /(^|[^A-Za-z0-9_-])(filter|diff|merge)=|textconv/;

  // Fail closed unless the repository is known to define no content filter,
  // diff driver or merge driver, in config or in any attributes file.
  const helperRefusal = async (env, signal) => {
    const where = await run("git", ["rev-parse", "--show-toplevel", "--git-common-dir"], env, signal);
    if (where.code !== 0) return refusal("the loop directory is not a git work tree. " + report(where));
    const [top, commonDir] = where.stdout.split(NL).map((line) => line.trim());
    const config = await run("git", ["config", "--get-regexp", "^(filter|diff|merge)[.]"], env, signal);
    if (config.code === 0 && config.stdout.trim()) return refusal("repository defines content filters or diff drivers.");
    if (config.code !== 1) return refusal("could not read the repository config. " + report(config));
    const listed = await run(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "--full-name", "--", ":(top,glob)**/.gitattributes"],
      env,
      signal,
    );
    if (listed.code !== 0 || listed.stdout.length >= LIMIT) return refusal("could not list the repository attributes files.");
    const files = listed.stdout
      .split(NL)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((name) => path.join(top, name));
    files.push(path.join(path.resolve(cwd, commonDir), "info", "attributes"));
    for (const name of files) {
      if (!existsSync(name)) continue;
      let text;
      try {
        text = readFileSync(name, "utf8");
      } catch {
        return refusal("could not read " + name + ".");
      }
      if (text.split(NL).some((line) => !line.trim().startsWith("#") && ATTRIBUTE_HELPER.test(line))) {
        return refusal("repository defines content filters or diff drivers.");
      }
    }
    return undefined;
  };

  pi.registerTool({
    name: ${JSON.stringify(CHECKER_SHELL_TOOL)},
    label: "Checker shell",
    description:
      "Read-only git for the loop checker, in the loop's working directory: " + gitOnly + " with these options only: status --porcelain --short -s --branch; " +
      "diff --stat --numstat --name-only --name-status --cached -U<n> --unified=<n>; " +
      "log --oneline -n <k> --max-count=<k> --stat --name-only --format=oneline|short|medium; " +
      "show --stat --name-only --format=oneline|short|medium; plus revisions and repository paths. " +
      "Every other command or option is refused.",
    promptSnippet: "checker_shell: read-only git (status, diff, log, show) in the loop's working directory",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "A git status, diff, log or show command." },
      },
      required: ["command"],
    },
    execute: async (_toolCallId, params, signal) => {
      const step = plan(params && params.command);
      if (step.refused) throw new Error(step.refused);
      const env = gitEnv();
      const refused = await helperRefusal(env, signal);
      if (refused) throw new Error(refused.refused);
      const extra = step.sub === "status" ? ["--ignore-submodules=all"] : ["--no-ext-diff", "--no-textconv"];
      const result = await run("git", [...SAFE_CONFIG, step.sub, ...extra, ...step.args], env, signal);
      return { content: [{ type: "text", text: report(result) }], details: {} };
    },
  });
}
`,
  );
  return file;
}
