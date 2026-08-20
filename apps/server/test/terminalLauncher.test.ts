import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { escapeWindowsShellArg } from "../src/editorLauncher.ts";
import {
  buildResumeScript,
  buildWindowsResumeScript,
  createExternalTerminalLauncher,
  planExternalTerminalLaunch,
  shellQuotePosix,
} from "../src/terminalLauncher.ts";

/**
 * TER-01 — external terminal resume. The planner is pure (platform matrix
 * pinned exactly); the facade validates the session reference FAIL-CLOSED and
 * launches detached through an injected spawn seam (editorLauncher pattern).
 */

const input = {
  cwd: "C:\\work\\my app",
  piBinary: "C:\\tools\\pi.cmd",
  sessionRef: "C:\\sessions\\s1.jsonl",
};
const posixInput = {
  cwd: "/work/my app",
  piBinary: "/usr/local/bin/pi",
  sessionRef: "/sessions/it's.jsonl",
};

describe("shellQuotePosix / buildResumeScript", () => {
  it("single-quotes POSIX args, escaping embedded quotes", () => {
    expect(shellQuotePosix("plain")).toBe("'plain'");
    expect(shellQuotePosix("it's")).toBe("'it'\\''s'");
    expect(shellQuotePosix("")).toBe("''");
  });

  it("builds the macOS resume script: cd into the session cwd, exec pi --session", () => {
    const script = buildResumeScript(posixInput.cwd, posixInput.piBinary, posixInput.sessionRef);
    expect(script.startsWith("#!/bin/zsh\n")).toBe(true);
    expect(script).toContain(`cd '/work/my app' || exit 1`);
    expect(script).toContain(`'/usr/local/bin/pi' --session '/sessions/it'\\''s.jsonl'`);
  });
});

describe("planExternalTerminalLaunch", () => {
  it("win32 prefers Windows Terminal with plain argv (no shell)", () => {
    const resolve = (name: string) => (name === "wt" ? "C:\\wt\\wt.exe" : null);
    expect(planExternalTerminalLaunch("win32", input, resolve)).toEqual({
      kind: "spawn",
      command: "C:\\wt\\wt.exe",
      args: ["-d", input.cwd, input.piBinary, "--session", input.sessionRef],
      shell: false,
    });
  });

  it("win32 without wt falls back to a one-shot batch script (empirically the only working start form)", () => {
    const plan = planExternalTerminalLaunch("win32", input, () => null);
    expect(plan).toEqual({
      kind: "winScript",
      script: buildWindowsResumeScript(input.cwd, input.piBinary, input.sessionRef),
    });
  });

  it("the batch script quotes values, doubles %, and REJECTS control chars and quotes", () => {
    const script = buildWindowsResumeScript(
      String.raw`C:\dir 100%`,
      String.raw`C:\pi.cmd`,
      String.raw`C:\s.jsonl`,
    );
    expect(script).toContain(String.raw`cd /d "C:\dir 100%%" || exit /b 1`);
    expect(script).toContain(String.raw`"C:\pi.cmd" --session "C:\s.jsonl" || pause`);
    const nl = String.fromCharCode(10);
    const quote = String.fromCharCode(34);
    expect(() => buildWindowsResumeScript("C:" + nl + "del x", "p", "s")).toThrow(/path/i);
    expect(() => buildWindowsResumeScript("C:", "p", "s" + quote + "t")).toThrow(/path/i);
  });

  it("darwin plans a one-shot .command script opened with open(1)", () => {
    const resolve = (name: string) => (name === "open" ? "/usr/bin/open" : null);
    const plan = planExternalTerminalLaunch("darwin", posixInput, resolve);
    expect(plan).toEqual({
      kind: "macScript",
      open: "/usr/bin/open",
      script: buildResumeScript(posixInput.cwd, posixInput.piBinary, posixInput.sessionRef),
    });
  });

  it("prepends packaged cli.js and ELECTRON_RUN_AS_NODE when leading args are set", () => {
    const resolve = (name: string) => (name === "open" ? "/usr/bin/open" : null);
    const leadingArgs = ["/app/Resources/pi-runtime/cli.js"];
    const plan = planExternalTerminalLaunch(
      "darwin",
      { ...posixInput, piLeadingArgs: leadingArgs },
      resolve,
    );
    expect(plan).toEqual({
      kind: "macScript",
      open: "/usr/bin/open",
      script: buildResumeScript(
        posixInput.cwd,
        posixInput.piBinary,
        posixInput.sessionRef,
        leadingArgs,
      ),
    });
    expect(plan && "script" in plan ? plan.script : "").toContain("ELECTRON_RUN_AS_NODE=1");
    expect(plan && "script" in plan ? plan.script : "").toContain(leadingArgs[0]);
  });

  it("linux tries x-terminal-emulator, then gnome-terminal, then konsole", () => {
    const only = (available: string) => (name: string) =>
      name === available ? `/usr/bin/${available}` : null;
    expect(planExternalTerminalLaunch("linux", posixInput, only("x-terminal-emulator"))).toEqual({
      kind: "spawn",
      command: "/usr/bin/x-terminal-emulator",
      args: ["-e", posixInput.piBinary, "--session", posixInput.sessionRef],
      cwd: posixInput.cwd,
      shell: false,
    });
    expect(planExternalTerminalLaunch("linux", posixInput, only("gnome-terminal"))).toEqual({
      kind: "spawn",
      command: "/usr/bin/gnome-terminal",
      args: [
        `--working-directory=${posixInput.cwd}`,
        "--",
        posixInput.piBinary,
        "--session",
        posixInput.sessionRef,
      ],
      shell: false,
    });
    expect(planExternalTerminalLaunch("linux", posixInput, only("konsole"))).toEqual({
      kind: "spawn",
      command: "/usr/bin/konsole",
      args: [
        "--workdir",
        posixInput.cwd,
        "-e",
        posixInput.piBinary,
        "--session",
        posixInput.sessionRef,
      ],
      shell: false,
    });
    expect(planExternalTerminalLaunch("linux", posixInput, () => null)).toBeNull();
  });

  it("an unsupported platform yields no plan (fail closed)", () => {
    expect(planExternalTerminalLaunch("sunos", input, () => "/bin/anything")).toBeNull();
  });
});

describe("createExternalTerminalLauncher", () => {
  const makeSessionFile = (): { dir: string; file: string } => {
    const dir = mkdtempSync(join(tmpdir(), "agent-deck-ter01-"));
    const file = join(dir, "session.jsonl");
    writeFileSync(file, "{}");
    return { dir, file };
  };

  it("fails closed when the session has no pi session file yet", async () => {
    const spawnFn = vi.fn();
    const launcher = createExternalTerminalLauncher({
      platform: "win32",
      spawnFn,
      env: { AGENT_DECK_PI_PATH: "C:\\tools\\pi.cmd" },
    });
    await expect(launcher.open({ cwd: "C:\\work", piSessionFile: undefined })).rejects.toThrow(
      /session/i,
    );
    await expect(launcher.open({ cwd: "C:\\work", piSessionFile: "  " })).rejects.toThrow(
      /session/i,
    );
    await expect(
      launcher.open({ cwd: "C:\\work", piSessionFile: "C:\\gone\\nope.jsonl" }),
    ).rejects.toThrow(/session/i);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it("launches the planned terminal detached via the spawn seam (win32 wt)", async () => {
    const { dir, file } = makeSessionFile();
    try {
      const child = {
        on: vi.fn(),
        once: vi.fn((event: string, cb: () => void) => {
          if (event === "spawn") queueMicrotask(cb);
        }),
        unref: vi.fn(),
      };
      const spawnFn = vi.fn(() => child);
      const launcher = createExternalTerminalLauncher({
        platform: "win32",
        spawnFn,
        env: { AGENT_DECK_PI_PATH: file }, // any existing file works as the pi override
        resolveCommand: (name) => (name === "wt" ? "C:\\wt\\wt.exe" : null),
      });
      await launcher.open({ cwd: dir, piSessionFile: file });
      expect(spawnFn).toHaveBeenCalledTimes(1);
      const [command, args, options] = spawnFn.mock.calls[0]! as unknown as [
        string,
        string[],
        Record<string, unknown>,
      ];
      expect(command).toBe("C:\\wt\\wt.exe");
      expect(args).toEqual(["-d", dir, file, "--session", file]);
      expect(options).toMatchObject({ detached: true, stdio: "ignore", shell: false });
      expect(child.unref).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("darwin writes an executable one-shot script and opens it", async () => {
    const { dir, file } = makeSessionFile();
    try {
      const child = {
        on: vi.fn(),
        once: vi.fn((event: string, cb: (code?: number) => void) => {
          if (event === "close") queueMicrotask(() => cb(0));
        }),
        unref: vi.fn(),
      };
      const spawnFn = vi.fn(() => child);
      const launcher = createExternalTerminalLauncher({
        platform: "darwin",
        spawnFn,
        env: { AGENT_DECK_PI_PATH: file },
        resolveCommand: (name) => (name === "open" ? "/usr/bin/open" : null),
      });
      await launcher.open({ cwd: dir, piSessionFile: file });
      const [command, args] = spawnFn.mock.calls[0]! as unknown as [string, string[]];
      expect(command).toBe("/usr/bin/open");
      const scriptPath = args[0]!;
      expect(scriptPath.endsWith(".command")).toBe(true);
      const written = readFileSync(scriptPath, "utf8");
      expect(written).toBe(buildResumeScript(dir, file, file));
      // Executable bit (POSIX semantics; on Windows the mode is best-effort).
      if (process.platform !== "win32") {
        expect(statSync(scriptPath).mode & 0o100).toBeTruthy();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("win32 without wt writes a unique resume script and starts it as the ONE quoted target", async () => {
    const { dir, file } = makeSessionFile();
    try {
      const scriptChild = () => ({
        on: vi.fn(),
        once: vi.fn((event: string, cb: (code?: number) => void) => {
          // Script plans settle on the WRAPPER's exit code, not 'spawn'.
          if (event === "close") queueMicrotask(() => cb(0));
        }),
        unref: vi.fn(),
      });
      const spawnFn = vi.fn(scriptChild);
      const launcher = createExternalTerminalLauncher({
        platform: "win32",
        spawnFn,
        env: { AGENT_DECK_PI_PATH: file },
        resolveCommand: () => null,
      });
      await launcher.open({ cwd: dir, piSessionFile: file });
      const [command, args, options] = spawnFn.mock.calls[0]! as unknown as [
        string,
        string[],
        Record<string, unknown>,
      ];
      expect(command).toBe("start");
      expect(args).toHaveLength(2);
      expect(args[0]).toBe('""');
      // The single quoted target is the script; it carries the args inside —
      // and the arg is EXACTLY the escaped script path (no looser match).
      const scriptPath = args[1]!.replaceAll("^", "").replaceAll('"', "");
      expect(args[1]).toBe(escapeWindowsShellArg(scriptPath));
      expect(scriptPath.endsWith(".cmd")).toBe(true);
      expect(readFileSync(scriptPath, "utf8")).toBe(buildWindowsResumeScript(dir, file, file));
      expect(options).toMatchObject({ shell: true, detached: true });

      // A second launch gets its OWN file — two rapid opens can never race on
      // one overwritten script.
      await launcher.open({ cwd: dir, piSessionFile: file });
      const secondArgs = (spawnFn.mock.calls[1] as unknown as [string, string[]])[1];
      expect(secondArgs[1]).not.toBe(args[1]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects with a stable message when the script wrapper exits nonzero", async () => {
    const { dir, file } = makeSessionFile();
    try {
      const child = {
        on: vi.fn(),
        once: vi.fn((event: string, cb: (code?: number) => void) => {
          if (event === "close") queueMicrotask(() => cb(1));
        }),
        unref: vi.fn(),
      };
      const launcher = createExternalTerminalLauncher({
        platform: "win32",
        spawnFn: vi.fn(() => child),
        env: { AGENT_DECK_PI_PATH: file },
        resolveCommand: () => null,
      });
      await expect(launcher.open({ cwd: dir, piSessionFile: file })).rejects.toThrow(
        /could not be started/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects when the terminal process fails to start, with a stable message", async () => {
    const { dir, file } = makeSessionFile();
    try {
      const child = {
        on: vi.fn(),
        once: vi.fn((event: string, cb: (error?: Error) => void) => {
          if (event === "error") queueMicrotask(() => cb(new Error("ENOENT wt")));
        }),
        unref: vi.fn(),
      };
      const launcher = createExternalTerminalLauncher({
        platform: "win32",
        spawnFn: vi.fn(() => child),
        env: { AGENT_DECK_PI_PATH: file },
        resolveCommand: (name) => (name === "wt" ? "C:\\gone\\wt.exe" : null),
      });
      await expect(launcher.open({ cwd: dir, piSessionFile: file })).rejects.toThrow(
        /could not be started/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("throws a typed no-terminal error when nothing can be planned", async () => {
    const { dir, file } = makeSessionFile();
    try {
      const launcher = createExternalTerminalLauncher({
        platform: "linux",
        spawnFn: vi.fn(),
        env: { AGENT_DECK_PI_PATH: file },
        resolveCommand: () => null,
      });
      await expect(launcher.open({ cwd: dir, piSessionFile: file })).rejects.toThrow(
        /no supported terminal/i,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
