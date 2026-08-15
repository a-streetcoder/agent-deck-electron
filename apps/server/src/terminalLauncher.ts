import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { PiNotFoundError, resolvePiBinary } from "@agent-deck/pi-host";
import { escapeWindowsShellArg, resolveCommandPath } from "./editorLauncher.ts";

/**
 * External terminal resume (TER-01), mirroring the native
 * `openSelectedPiAgentSessionInTerminal` flow: continue THIS session's pi
 * conversation in the user's own terminal, in the session's cwd, via
 * `pi --session <session-file>` — the same reference the server's own resume
 * path uses (`meta.piSessionFile`, native's `resumablePiSessionReference`).
 *
 * editorLauncher.ts is the template: an injectable spawn seam, PATH-probe
 * command resolution, detached/unref'd launches, and NO shell interpolation of
 * data — argv where the target parses argv, and a one-shot SCRIPT where a
 * shell would otherwise re-parse quoting (batch/zsh, values quoted by rule and
 * control characters rejected outright).
 *
 * Platform matrix (the planner is pure and pinned by unit tests):
 *   - win32: Windows Terminal (`wt -d cwd pi --session ref`, plain argv) when
 *     installed, else a one-shot `resume.cmd` opened via `start "" "<script>"`
 *     — the only start form that parsed correctly under empirical test.
 *   - darwin: native parity — a one-shot `.command` zsh script (cd + resume,
 *     POSIX-quoted) handed to `open`; Terminal.app (or the user's default
 *     handler for .command) owns the window. Relying on the LaunchServices
 *     association is accepted — native's default path does the same.
 *   - linux: first of x-terminal-emulator / gnome-terminal / konsole.
 * Anything else fails typed — never a guessed shell string.
 */

export interface ExternalTerminalInput {
  /** The session's cwd (server-side meta — worktree-aware, never the wire). */
  readonly cwd: string;
  /** The session's pi session file from server-side meta (may be absent when
   * pi has not persisted one yet — that fails closed with a clear message). */
  readonly piSessionFile: string | undefined;
}

export interface ExternalTerminalLauncher {
  readonly open: (input: ExternalTerminalInput) => Promise<void>;
}

interface PlanInput {
  readonly cwd: string;
  readonly piBinary: string;
  readonly sessionRef: string;
}

export type ExternalTerminalPlan =
  | {
      readonly kind: "spawn";
      readonly command: string;
      readonly args: string[];
      readonly cwd?: string;
      readonly shell: boolean;
    }
  | { readonly kind: "macScript"; readonly open: string; readonly script: string }
  | { readonly kind: "winScript"; readonly script: string };

/** POSIX single-quote: safe verbatim inside a shell script (native shellQuoted). */
export function shellQuotePosix(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The one-shot macOS resume script (native's `.command` file, condensed). */
export function buildResumeScript(cwd: string, piBinary: string, sessionRef: string): string {
  return [
    "#!/bin/zsh",
    `cd ${shellQuotePosix(cwd)} || exit 1`,
    `${shellQuotePosix(piBinary)} --session ${shellQuotePosix(sessionRef)} || {`,
    `  echo "Pi could not resume this session."`,
    `  read -k 1 "?Press any key to close."`,
    "}",
    "",
  ].join("\n");
}

/**
 * The one-shot Windows resume script. Batch has no single-quote safety, so the
 * values are double-quoted with `%` doubled (the only expansion active in a
 * default non-delayed cmd), and any control character (CR/LF — a literal
 * batch-line injection) or embedded double quote (invalid in Windows paths
 * anyway) REJECTS instead of being escaped. Fail closed over clever quoting —
 * the empirically verified launch form is `start "" "<script>"` with the
 * script carrying every argument internally (a quoted argument AFTER the
 * program breaks `start`'s parsing — proven by execution, not reasoning).
 */
export function buildWindowsResumeScript(
  cwd: string,
  piBinary: string,
  sessionRef: string,
): string {
  const quoteBatch = (value: string): string => {
    // eslint-disable-next-line no-control-regex -- control chars ARE the hazard rejected here
    if (/[\u0000-\u001f\u007f"]/.test(value)) {
      throw new Error("This session's paths cannot be launched in a Windows terminal.");
    }
    return `"${value.replaceAll("%", "%%")}"`;
  };
  return [
    "@echo off",
    // The file is WRITTEN as UTF-8; cmd re-reads batch files line by line, so
    // switching the code page up front makes the later non-ASCII path lines
    // parse as the bytes we wrote (a legacy ANSI code page would corrupt them).
    "chcp 65001 >nul",
    "title Agent Deck",
    `cd /d ${quoteBatch(cwd)} || exit /b 1`,
    `${quoteBatch(piBinary)} --session ${quoteBatch(sessionRef)} || pause`,
    "",
  ].join("\r\n");
}

/**
 * Compose the platform launch. Pure: `resolveCommand` is the PATH probe seam.
 * Returns null when no supported terminal can be found (fail closed).
 */
export function planExternalTerminalLaunch(
  platform: NodeJS.Platform | string,
  input: PlanInput,
  resolveCommand: (name: string) => string | null,
): ExternalTerminalPlan | null {
  if (platform === "win32") {
    const wt = resolveCommand("wt");
    if (wt !== null) {
      return {
        kind: "spawn",
        command: wt,
        args: ["-d", input.cwd, input.piBinary, "--session", input.sessionRef],
        shell: false,
      };
    }
    // No Windows Terminal: a one-shot batch script mirrors the darwin design.
    // `start "" "<script>"` (title, then ONE quoted target) is the only start
    // form that parsed correctly under test — a quoted argument AFTER the
    // program made start silently run nothing, so the script carries the
    // arguments internally instead.
    return {
      kind: "winScript",
      script: buildWindowsResumeScript(input.cwd, input.piBinary, input.sessionRef),
    };
  }
  if (platform === "darwin") {
    const open = resolveCommand("open");
    if (open === null) return null;
    return {
      kind: "macScript",
      open,
      script: buildResumeScript(input.cwd, input.piBinary, input.sessionRef),
    };
  }
  if (platform === "linux") {
    const xte = resolveCommand("x-terminal-emulator");
    if (xte !== null) {
      return {
        kind: "spawn",
        command: xte,
        args: ["-e", input.piBinary, "--session", input.sessionRef],
        cwd: input.cwd,
        shell: false,
      };
    }
    const gnome = resolveCommand("gnome-terminal");
    if (gnome !== null) {
      return {
        kind: "spawn",
        command: gnome,
        args: [
          `--working-directory=${input.cwd}`,
          "--",
          input.piBinary,
          "--session",
          input.sessionRef,
        ],
        shell: false,
      };
    }
    const konsole = resolveCommand("konsole");
    if (konsole !== null) {
      return {
        kind: "spawn",
        command: konsole,
        args: ["--workdir", input.cwd, "-e", input.piBinary, "--session", input.sessionRef],
        shell: false,
      };
    }
    return null;
  }
  return null;
}

/** The spawn surface (editorLauncher's seam shape, plus the launch handshake). */
export type TerminalSpawnLike = (
  command: string,
  args: readonly string[],
  options: { detached: boolean; stdio: "ignore"; shell: boolean; cwd?: string },
) => {
  on(event: "error", listener: (error: Error) => void): unknown;
  /** Launch handshake events: "spawn" (), "error" (Error), "close" (exit code). */
  once(event: "spawn" | "error" | "close", listener: (...args: never[]) => void): unknown;
  unref(): void;
};

export interface ExternalTerminalLauncherOptions {
  readonly platform?: NodeJS.Platform;
  readonly spawnFn?: TerminalSpawnLike;
  readonly env?: NodeJS.ProcessEnv;
  /** PATH-probe override for tests; defaults to editorLauncher's resolver. */
  readonly resolveCommand?: (name: string) => string | null;
}

export function createExternalTerminalLauncher(
  options: ExternalTerminalLauncherOptions = {},
): ExternalTerminalLauncher {
  const platform = options.platform ?? process.platform;
  const env = (): NodeJS.ProcessEnv => options.env ?? process.env;
  const spawnFn: TerminalSpawnLike =
    options.spawnFn ?? ((command, args, spawnOptions) => spawn(command, [...args], spawnOptions));
  const resolveCommand =
    options.resolveCommand ?? ((name: string) => resolveCommandPath(name, env(), platform));

  // ONE scratch dir per launcher; each launch gets its OWN script file (two
  // rapid launches must not overwrite each other before start/open reads the
  // file), best-effort deleted after a minute — long after the ms-scale read,
  // so accumulation stays bounded without reintroducing the race. The script
  // holds paths, not secrets.
  let scriptDir: string | null = null;
  let launchSeq = 0;
  const scriptPathFor = (extension: string): string => {
    scriptDir ??= mkdtempSync(nodePath.join(tmpdir(), "agent-deck-resume-"));
    launchSeq += 1;
    const scriptPath = nodePath.join(scriptDir, `resume-${launchSeq}${extension}`);
    const timer = setTimeout(() => rmSync(scriptPath, { force: true }), 60_000);
    timer.unref();
    return scriptPath;
  };

  const open = async (input: ExternalTerminalInput): Promise<void> => {
    const sessionRef = input.piSessionFile?.trim();
    if (!sessionRef) {
      throw new Error("This session has no pi session file to resume yet.");
    }
    // Re-asserted at USE time: the stored path may be stale (worktree removed,
    // transcript pruned) — a dead reference must not open a broken terminal.
    if (!existsSync(sessionRef)) {
      throw new Error("The pi session file for this session no longer exists.");
    }
    let piBinary: string;
    try {
      piBinary = resolvePiBinary(env(), platform).path;
    } catch (error) {
      // Stable public message; the detail (env paths) stays in the server log.
      console.error("[terminal] pi resolution failed:", error);
      if (error instanceof PiNotFoundError) {
        throw new Error("Pi could not be found on this machine.");
      }
      throw new Error("Pi could not be resolved for the external terminal.");
    }
    const plan = planExternalTerminalLaunch(
      platform,
      { cwd: input.cwd, piBinary, sessionRef },
      resolveCommand,
    );
    if (plan === null) {
      throw new Error("No supported terminal application was found on this machine.");
    }

    let command: string;
    let args: string[];
    let shell = false;
    let cwd: string | undefined;
    let isScriptPlan = false;
    try {
      if (plan.kind === "macScript") {
        const scriptPath = scriptPathFor(".command");
        writeFileSync(scriptPath, plan.script, "utf8");
        chmodSync(scriptPath, 0o755);
        command = plan.open;
        args = [scriptPath];
        isScriptPlan = true;
      } else if (plan.kind === "winScript") {
        const scriptPath = scriptPathFor(".cmd");
        writeFileSync(scriptPath, plan.script, "utf8");
        // The empirically verified form: title, then ONE quoted target.
        command = "start";
        args = ['""', escapeWindowsShellArg(scriptPath)];
        shell = true;
        isScriptPlan = true;
      } else {
        ({ command, shell } = plan);
        args = plan.args;
        cwd = plan.cwd;
      }
    } catch (error) {
      // Stable public message; the detail (temp paths) stays in the server log.
      console.error("[terminal] launch preparation failed:", error);
      throw new Error("The external terminal launch could not be prepared.");
    }
    let child: ReturnType<TerminalSpawnLike>;
    try {
      child = spawnFn(command, args, {
        detached: true,
        stdio: "ignore",
        shell,
        ...(cwd !== undefined ? { cwd } : {}),
      });
    } catch (error) {
      console.error("[terminal] external launch failed:", error);
      throw new Error("The terminal application could not be started.");
    }
    // Launch handshake. Script plans run through a short-lived wrapper (`cmd`
    // hosting start / `open`) whose EXIT CODE is the real verdict — a start
    // parse failure or a missing .command association surfaces there, after
    // the 'spawn' event already fired. Long-lived argv plans (wt, the linux
    // terminals) settle on 'spawn' — their exit is the terminal's own life.
    await new Promise<void>((resolve, reject) => {
      const fail = (detail: unknown): void => {
        console.error("[terminal] external launch failed:", detail);
        reject(new Error("The terminal application could not be started."));
      };
      child.once("error", fail);
      if (isScriptPlan) {
        child.once("close", (code) => {
          if (code === 0) resolve();
          else fail(`launcher wrapper exited with code ${String(code)}`);
        });
      } else {
        child.once("spawn", () => resolve());
      }
    });
    child.unref();
  };

  return { open };
}
