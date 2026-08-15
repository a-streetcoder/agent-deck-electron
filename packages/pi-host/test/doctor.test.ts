import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// The doctor probes real subprocesses (bash/git/gh/node); individual checks
// run ~4s alone and exceed the 5s default under `pnpm -r test` parallel load.
// File-wide headroom per the diff/skill-repo-import precedent.
vi.setConfig({ testTimeout: 20_000 });
import {
  hasEffectiveEnvValue,
  MIN_NODE_VERSION,
  meetsMinNode,
  parseNodeVersion,
  probeVersion,
  resolveDoctorAgentDir,
  ghInstallFixCommand,
  runDoctor,
  summarizeSettings,
  webAccessChecks,
} from "../src/doctor.ts";

/**
 * The environment doctor probes real host tools. bash + git are cross-platform
 * prerequisites for pi's shell / version-control tools (bash comes from Git Bash
 * on Windows), and the Issues screen needs an authenticated GitHub CLI — so the
 * report surfaces each as a first-class check.
 */

describe("runDoctor", () => {
  it("includes a bash and a git preflight check with a verdict", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "doctor-home-"));
    const report = await runDoctor(home);
    const byId = new Map(report.checks.map((c) => [c.id, c]));

    // Both checks are surfaced with a verdict + a non-empty detail. Their exact
    // ok/warn/error is the host's truth, not something to hardcode — a valid host
    // could legitimately lack git or (on Windows) Git Bash.
    for (const id of ["bash", "git"]) {
      const check = byId.get(id);
      expect(check, `${id} check present`).toBeDefined();
      expect(check!.detail).not.toBe("");
      expect(["ok", "warn", "error"]).toContain(check!.status);
    }
  }, 20_000);

  it("diagnoses global and project settings independently without leaking content", async () => {
    const settingsPath = (home: string): string => path.join(home, ".pi", "agent", "settings.json");
    const projectSettingsPath = (projectPath: string): string =>
      path.join(projectPath, ".pi", "settings.json");
    const settingsChecks = async (home: string, projectPath: string) => {
      const report = await runDoctor(home, projectPath);
      expect(new Set(report.checks.map((check) => check.id)).size).toBe(report.checks.length);
      return {
        global: report.checks.find((check) => check.id === "settings")!,
        project: report.checks.find((check) => check.id === "settings-project")!,
      };
    };

    // Both absent files are healthy defaults, but still show their exact source paths.
    const missingHome = mkdtempSync(path.join(tmpdir(), "doctor-home-"));
    const missingProject = mkdtempSync(path.join(tmpdir(), "doctor-project-"));
    const missing = await settingsChecks(missingHome, missingProject);
    expect(missing.global).toMatchObject({
      status: "ok",
      label: "Global Pi settings (active candidate)",
    });
    expect(missing.global.detail).toContain(settingsPath(missingHome));
    expect(missing.global.detail).toMatch(/not present.*built-in defaults/i);
    expect(missing.project).toMatchObject({ status: "ok", label: "Project Pi settings" });
    expect(missing.project.detail).toContain(projectSettingsPath(missingProject));
    expect(missing.project.detail).toMatch(/not present.*global settings.*built-in defaults/i);
    expect(missing.project.detail).toMatch(/selected project's settings candidate/i);
    expect(missing.project.detail).toMatch(
      /new trusted Pi sessions load a valid candidate.*matching values then override global settings/i,
    );

    // Valid files expose only counts/booleans, not package, prompt, override, or secret names.
    const validHome = mkdtempSync(path.join(tmpdir(), "doctor-home-"));
    const validProject = mkdtempSync(path.join(tmpdir(), "doctor-project-"));
    mkdirSync(path.dirname(settingsPath(validHome)), { recursive: true });
    mkdirSync(path.dirname(projectSettingsPath(validProject)), { recursive: true });
    writeFileSync(
      settingsPath(validHome),
      JSON.stringify({
        subagents: {
          agentOverrides: { "sentinel-global-override": { token: "sentinel-global-secret" } },
          disableBuiltins: true,
        },
        packages: ["sentinel-global-package"],
        prompts: ["sentinel-global-prompt-a", "sentinel-global-prompt-b"],
      }),
    );
    writeFileSync(
      projectSettingsPath(validProject),
      JSON.stringify({
        subagents: {
          agentOverrides: {
            "sentinel-project-override-a": {},
            "sentinel-project-override-b": {},
          },
        },
        packages: ["sentinel-project-package-a", "sentinel-project-package-b"],
        prompts: ["sentinel-project-prompt"],
        apiKey: "sentinel-project-secret",
      }),
    );
    const valid = await settingsChecks(validHome, validProject);
    expect(valid.global.detail).toContain(`${settingsPath(validHome)} — valid JSON`);
    expect(valid.global.detail).toContain("1 agent override");
    expect(valid.global.detail).toContain("builtin agents disabled");
    expect(valid.global.detail).toContain("1 package");
    expect(valid.global.detail).toContain("2 extra prompt paths");
    expect(valid.project.detail).toContain(`${projectSettingsPath(validProject)} — valid JSON`);
    expect(valid.project.detail).toContain("2 agent overrides");
    expect(valid.project.detail).toContain("2 packages");
    expect(valid.project.detail).toContain("1 extra prompt path");
    expect(valid.project.detail).toMatch(/selected project's settings candidate/i);
    expect(valid.project.detail).toMatch(/new trusted Pi sessions load a valid candidate/i);
    const validDetails = `${valid.global.detail}\n${valid.project.detail}`;
    for (const sentinel of [
      "sentinel-global-override",
      "sentinel-global-secret",
      "sentinel-global-package",
      "sentinel-global-prompt",
      "sentinel-project-override",
      "sentinel-project-package",
      "sentinel-project-prompt",
      "sentinel-project-secret",
    ]) {
      expect(validDetails).not.toContain(sentinel);
    }

    // A malformed global file does not hide a valid project result.
    const badGlobalHome = mkdtempSync(path.join(tmpdir(), "doctor-home-"));
    const goodProject = mkdtempSync(path.join(tmpdir(), "doctor-project-"));
    mkdirSync(path.dirname(settingsPath(badGlobalHome)), { recursive: true });
    mkdirSync(path.dirname(projectSettingsPath(goodProject)), { recursive: true });
    writeFileSync(settingsPath(badGlobalHome), "{ sentinel-global-malformed-secret");
    writeFileSync(projectSettingsPath(goodProject), "{}");
    const badGlobal = await settingsChecks(badGlobalHome, goodProject);
    expect(badGlobal.global.status).toBe("warn");
    expect(badGlobal.global.detail).toMatch(/malformed JSON.*custom settings won't apply/i);
    expect(badGlobal.global.detail).not.toContain("sentinel-global-malformed-secret");
    expect(badGlobal.project.status).toBe("ok");
    expect(badGlobal.project.detail).toMatch(/valid JSON/i);

    // A malformed project file likewise leaves the global result intact.
    const goodGlobalHome = mkdtempSync(path.join(tmpdir(), "doctor-home-"));
    const badProject = mkdtempSync(path.join(tmpdir(), "doctor-project-"));
    mkdirSync(path.dirname(settingsPath(goodGlobalHome)), { recursive: true });
    mkdirSync(path.dirname(projectSettingsPath(badProject)), { recursive: true });
    writeFileSync(settingsPath(goodGlobalHome), "{}");
    writeFileSync(projectSettingsPath(badProject), "{ sentinel-project-malformed-secret");
    const malformedProject = await settingsChecks(goodGlobalHome, badProject);
    expect(malformedProject.global.status).toBe("ok");
    expect(malformedProject.project.status).toBe("warn");
    expect(malformedProject.project.detail).toMatch(/malformed JSON.*custom settings won't apply/i);
    expect(malformedProject.project.detail).toMatch(/selected project's settings candidate/i);
    expect(malformedProject.project.detail).not.toContain("sentinel-project-malformed-secret");

    // Pinned SettingsManager treats exactly empty content as {}, but JSON null
    // and primitives fail its migration and must not be reported as loadable.
    const emptyHome = mkdtempSync(path.join(tmpdir(), "doctor-home-"));
    const invalidProject = mkdtempSync(path.join(tmpdir(), "doctor-project-"));
    mkdirSync(path.dirname(settingsPath(emptyHome)), { recursive: true });
    mkdirSync(path.dirname(projectSettingsPath(invalidProject)), { recursive: true });
    writeFileSync(settingsPath(emptyHome), "");
    writeFileSync(projectSettingsPath(invalidProject), "null");
    const emptyAndNull = await settingsChecks(emptyHome, invalidProject);
    expect(emptyAndNull.global).toMatchObject({ status: "ok" });
    expect(emptyAndNull.global.detail).toMatch(/empty file.*loads empty settings/i);
    expect(emptyAndNull.project).toMatchObject({ status: "warn" });
    expect(emptyAndNull.project.detail).toMatch(/valid JSON, but not a settings object/i);

    writeFileSync(settingsPath(emptyHome), '"sentinel-primitive-secret"');
    writeFileSync(projectSettingsPath(invalidProject), "[]");
    const primitiveAndArray = await settingsChecks(emptyHome, invalidProject);
    expect(primitiveAndArray.global).toMatchObject({ status: "warn" });
    expect(primitiveAndArray.global.detail).toMatch(/valid JSON, but not a settings object/i);
    expect(primitiveAndArray.global.detail).not.toContain("sentinel-primitive-secret");
    // Arrays survive Pi's initial migration; Doctor avoids claiming they fail.
    expect(primitiveAndArray.project).toMatchObject({ status: "ok" });
    expect(primitiveAndArray.project.detail).toMatch(/valid JSON/i);

    // Pi follows valid file symlinks. Keep the platform-unreliable Windows
    // symlink privilege case out while exercising the behavior on POSIX.
    if (process.platform !== "win32") {
      const symlinkHome = mkdtempSync(path.join(tmpdir(), "doctor-home-"));
      const symlinkProject = mkdtempSync(path.join(tmpdir(), "doctor-project-"));
      const target = path.join(symlinkHome, "settings-target.json");
      mkdirSync(path.dirname(settingsPath(symlinkHome)), { recursive: true });
      writeFileSync(target, JSON.stringify({ packages: ["sentinel-symlink-package"] }));
      symlinkSync(target, settingsPath(symlinkHome));
      const symlinked = await settingsChecks(symlinkHome, symlinkProject);
      expect(symlinked.global).toMatchObject({ status: "ok" });
      expect(symlinked.global.detail).toContain("1 package");
      expect(symlinked.global.detail).not.toContain("sentinel-symlink-package");

      unlinkSync(target);
      const brokenSymlink = await settingsChecks(symlinkHome, symlinkProject);
      expect(brokenSymlink.global).toMatchObject({ status: "ok" });
      expect(brokenSymlink.global.detail).toMatch(/not present.*built-in defaults/i);
    }

    // Directories at either file path are deterministic, platform-neutral non-regular files.
    const directoryHome = mkdtempSync(path.join(tmpdir(), "doctor-home-"));
    const directoryProject = mkdtempSync(path.join(tmpdir(), "doctor-project-"));
    mkdirSync(settingsPath(directoryHome), { recursive: true });
    mkdirSync(projectSettingsPath(directoryProject), { recursive: true });
    const directories = await settingsChecks(directoryHome, directoryProject);
    expect(directories.global).toMatchObject({ status: "warn" });
    expect(directories.global.detail).toMatch(/does not resolve to a regular file/i);
    expect(directories.project).toMatchObject({ status: "warn" });
    expect(directories.project.detail).toMatch(/does not resolve to a regular file/i);
  }, 30_000);

  it("uses the effective agent directory and omits project settings without a project", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "doctor-home-"));
    const agentDir = path.join(home, "effective-agent-dir");
    const report = await runDoctor(home, undefined, agentDir);
    expect(report.checks.find((check) => check.id === "settings")?.detail).toContain(
      path.join(agentDir, "settings.json"),
    );
    expect(report.checks.some((check) => check.id === "settings-project")).toBe(false);
  });

  it("includes a Node.js runtime check (this runner meets pi's minimum)", async () => {
    const home = mkdtempSync(path.join(tmpdir(), "doctor-home-"));
    const report = await runDoctor(home);
    const node = report.checks.find((c) => c.id === "node");
    expect(node, "node check present").toBeDefined();
    expect(node!.detail).not.toBe("");
    // The test runner necessarily runs on Node ≥ pi's minimum, so this is "ok".
    expect(node!.status).toBe("ok");
    expect(node!.detail).toContain(MIN_NODE_VERSION);
  });
});

describe("resolveDoctorAgentDir", () => {
  const home = path.resolve(path.join(tmpdir(), "doctor-effective-home"));
  const cwd = path.resolve(path.join(tmpdir(), "doctor-session-cwd"));

  it("uses the effective home by default", () => {
    expect(resolveDoctorAgentDir(home, cwd)).toBe(path.join(home, ".pi", "agent"));
    expect(resolveDoctorAgentDir(home, cwd, "")).toBe(path.join(home, ".pi", "agent"));
  });

  it("expands tilde against the effective home", () => {
    expect(resolveDoctorAgentDir(home, cwd, "~")).toBe(home);
    expect(resolveDoctorAgentDir(home, cwd, `~${path.sep}${path.join("custom", "agent")}`)).toBe(
      path.join(home, "custom", "agent"),
    );
  });

  it("resolves relative overrides against the session cwd", () => {
    const relative = path.join("relative", "agent-dir");
    expect(resolveDoctorAgentDir(home, cwd, relative)).toBe(path.resolve(cwd, relative));
  });

  it("preserves absolute override location semantics", () => {
    const absolute = path.resolve(path.join(tmpdir(), "doctor-absolute-agent-dir"));
    expect(resolveDoctorAgentDir(home, cwd, absolute)).toBe(absolute);
  });

  it("converts a file URL override to its cross-platform filesystem path", () => {
    const absolute = path.resolve(path.join(tmpdir(), "doctor-file-url-agent-dir"));
    expect(resolveDoctorAgentDir(home, cwd, pathToFileURL(absolute).href)).toBe(absolute);
  });
});

describe("Web Access doctor checks", () => {
  const global = (masked: string, overridden = false) => ({
    key: "EXA_API_KEY",
    masked,
    overridden,
  });
  const project = (masked: string) => ({ key: "EXA_API_KEY", masked, overridden: false });

  it.each([
    ["absent", [], false],
    ["blank global", [global("")], false],
    ["configured global", [global("••••••••cdef")], true],
    ["configured project override", [global("••••••••obal", true), project("••••••••ject")], true],
    ["blank project override", [global("••••••••obal", true), project("")], false],
  ] as const)("detects %s configuration without reading a value", (_name, entries, expected) => {
    expect(hasEffectiveEnvValue(entries, "EXA_API_KEY")).toBe(expected);
  });

  it("always warns truthfully and never leaks env metadata or a secret", () => {
    const secret = "exa-super-secret-credential";
    const checks = webAccessChecks(hasEffectiveEnvValue([global("••••••••Z9Q7")], "EXA_API_KEY"));
    const serialized = JSON.stringify(checks);

    expect(checks.map((check) => check.id)).toEqual(["web-access-exa", "web-access-url-fetch"]);
    expect(checks.every((check) => check.status === "warn")).toBe(true);
    expect(checks[0]!.detail).toMatch(/configured/i);
    expect(checks[0]!.detail).toMatch(/unavailable.*Electron build/i);
    expect(checks[0]!.detail).toMatch(/no network or credential validity test ran/i);
    expect(checks[1]!.detail).toMatch(/known-URL fetching is unavailable/i);
    expect(checks[1]!.detail).toMatch(/no network test ran/i);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("Z9Q7");
    expect(serialized).not.toContain("source");
    expect(checks.every((check) => check.fixCommand === undefined)).toBe(true);
  });

  it("directs an unconfigured user to Environment and calls the key optional", () => {
    const exa = webAccessChecks(false)[0]!;
    expect(exa.detail).toMatch(/optional/i);
    expect(exa.detail).toContain("EXA_API_KEY");
    expect(exa.detail).toContain("Environment");
  });
});

describe("probeVersion", () => {
  it("accepts a successful version written to stderr", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "version-stub-"));
    const stub = path.join(dir, process.platform === "win32" ? "version.cmd" : "version");
    writeFileSync(
      stub,
      process.platform === "win32"
        ? "@echo off\necho 0.70.6 1>&2\n"
        : "#!/bin/sh\necho 0.70.6 >&2\n",
    );
    if (process.platform !== "win32") chmodSync(stub, 0o755);

    await expect(probeVersion(stub)).resolves.toBe("0.70.6");
  });
});

describe("summarizeSettings (native Settings Files summary)", () => {
  it("returns empty for non-objects, null, and an empty settings object", () => {
    expect(summarizeSettings(null)).toBe("");
    expect(summarizeSettings("nope")).toBe("");
    expect(summarizeSettings(42)).toBe("");
    expect(summarizeSettings({})).toBe("");
    expect(summarizeSettings({ subagents: {} })).toBe("");
  });

  it("counts overrides/packages/prompts and flags disableBuiltins, pluralizing", () => {
    expect(summarizeSettings({ subagents: { agentOverrides: { a: {} } } })).toBe(
      "1 agent override",
    );
    expect(summarizeSettings({ subagents: { agentOverrides: { a: {}, b: {} } } })).toBe(
      "2 agent overrides",
    );
    expect(summarizeSettings({ subagents: { disableBuiltins: true } })).toBe(
      "builtin agents disabled",
    );
    // disableBuiltins:false is not notable.
    expect(summarizeSettings({ subagents: { disableBuiltins: false } })).toBe("");
    expect(summarizeSettings({ packages: ["x", "y"], prompts: ["p"] })).toBe(
      "2 packages, 1 extra prompt path",
    );
  });

  it("is defensive against mistyped fields", () => {
    // Wrong types must not throw or count.
    expect(summarizeSettings({ subagents: "oops", packages: "nope", prompts: 3 })).toBe("");
    // A wrong-shaped agentOverrides ARRAY must be rejected (not counted by its
    // indices) — empty AND non-empty.
    expect(summarizeSettings({ subagents: { agentOverrides: [] } })).toBe("");
    expect(summarizeSettings({ subagents: { agentOverrides: ["x", "y"] } })).toBe("");
    // A subagents value that is itself an array is likewise not an object map.
    expect(summarizeSettings({ subagents: ["nope"] })).toBe("");
  });
});

describe("Node.js version gate (pi engines >= " + MIN_NODE_VERSION + ")", () => {
  it("parses v-prefixed and bare versions, rejecting junk", () => {
    expect(parseNodeVersion("v22.19.0")).toEqual([22, 19, 0]);
    expect(parseNodeVersion("24.3.1")).toEqual([24, 3, 1]);
    expect(parseNodeVersion("v20.11.1 (some build)")).toEqual([20, 11, 1]);
    expect(parseNodeVersion("not-a-version")).toBeNull();
    expect(parseNodeVersion(null)).toBeNull();
    // A prerelease/build suffix still yields the base X.Y.Z (so a prerelease of
    // an OLD version still trips the minimum): v20.0.0-nightly → below min.
    expect(parseNodeVersion("v20.0.0-nightly20240101")).toEqual([20, 0, 0]);
    expect(parseNodeVersion("v22.19.0+build")).toEqual([22, 19, 0]);
    // But an extra numeric segment is rejected (not a clean release string).
    expect(parseNodeVersion("22.19.0.1")).toBeNull();
  });

  it("accepts the exact minimum and anything newer, rejects older", () => {
    expect(meetsMinNode([22, 19, 0])).toBe(true); // exact minimum
    expect(meetsMinNode([22, 19, 1])).toBe(true); // newer patch
    expect(meetsMinNode([22, 20, 0])).toBe(true); // newer minor
    expect(meetsMinNode([23, 0, 0])).toBe(true); // newer major
    expect(meetsMinNode([24, 5, 2])).toBe(true);
    expect(meetsMinNode([22, 18, 9])).toBe(false); // older patch/minor
    expect(meetsMinNode([22, 0, 0])).toBe(false);
    expect(meetsMinNode([21, 99, 99])).toBe(false); // older major
  });
});

/** A gh stub: `--version` succeeds; `auth status` exits with `authExit`. */
function ghStub(authExit: number): string {
  const stub = path.join(mkdtempSync(path.join(tmpdir(), "gh-stub-")), "gh");
  writeFileSync(
    stub,
    `#!/bin/sh
if [ "$1" = "--version" ]; then echo "gh version 2.40.0"; exit 0; fi
if [ "$1" = "auth" ]; then exit ${authExit}; fi
exit 0
`,
  );
  chmodSync(stub, 0o755);
  return stub;
}

// The stub is a unix shell script; on Windows gh runs natively. The ubuntu/macos
// runners cover this leg (mirrors the Issues gh-stub precedent).
describe.skipIf(process.platform === "win32")("runDoctor GitHub CLI check", () => {
  afterEach(() => {
    delete process.env.AGENT_DECK_GH_BIN;
  });

  async function githubCheck() {
    const report = await runDoctor(mkdtempSync(path.join(tmpdir(), "doctor-home-")));
    return report.checks.find((c) => c.id === "github")!;
  }

  it("is ok when gh is installed and authenticated", async () => {
    process.env.AGENT_DECK_GH_BIN = ghStub(0);
    const check = await githubCheck();
    expect(check.status).toBe("ok");
    expect(check.detail).toContain("authenticated");
  });

  it("warns when gh is installed but not authenticated", async () => {
    process.env.AGENT_DECK_GH_BIN = ghStub(1);
    const check = await githubCheck();
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("not authenticated");
  });

  it("warns when gh is not on PATH", async () => {
    process.env.AGENT_DECK_GH_BIN = path.join(tmpdir(), "definitely-no-such-gh-binary");
    const check = await githubCheck();
    expect(check.status).toBe("warn");
    expect(check.detail).toContain("not on PATH");
  });

  it("attaches a `gh auth login` fix command when installed but unauthenticated", async () => {
    process.env.AGENT_DECK_GH_BIN = ghStub(1);
    expect((await githubCheck()).fixCommand).toBe("gh auth login");
    process.env.AGENT_DECK_GH_BIN = ghStub(0);
    expect((await githubCheck()).fixCommand).toBeUndefined(); // authenticated → no fix
  });
});

describe("runDoctor fix commands", () => {
  it("offers a provider-key fix when no providers are signed in", async () => {
    const report = await runDoctor(mkdtempSync(path.join(tmpdir(), "doctor-home-")));
    const auth = report.checks.find((c) => c.id === "auth")!;
    // A fresh home has no auth.json → the check warns with a copyable fix.
    expect(auth.status).toBe("warn");
    expect(auth.fixCommand).toContain("API_KEY");
  });
});

describe("pi-version repair fix (DOC-03)", () => {
  it("a resolving pi whose --version probe fails carries the reinstall fixCommand", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doctor-doc03-"));
    const isWindows = process.platform === "win32";
    const stub = path.join(dir, isWindows ? "pi.cmd" : "pi");
    writeFileSync(stub, isWindows ? "@echo off\r\nexit /b 1\r\n" : "#!/bin/sh\nexit 1\n");
    if (!isWindows) chmodSync(stub, 0o755);
    const previous = process.env.AGENT_DECK_PI_PATH;
    process.env.AGENT_DECK_PI_PATH = stub;
    try {
      const report = await runDoctor(dir);
      const version = report.checks.find((check) => check.id === "pi-version");
      expect(version).toBeDefined();
      expect(version!.status).toBe("warn");
      // The corrupt-but-resolving runtime's OWN row must carry the guided
      // repair (reinstall) — "Update pi" alone would run the broken binary.
      expect(version!.fixCommand).toBe("npm install -g @earendil-works/pi-coding-agent");
    } finally {
      if (previous === undefined) delete process.env.AGENT_DECK_PI_PATH;
      else process.env.AGENT_DECK_PI_PATH = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("gh install guidance (DOC-07)", () => {
  it("selects the per-platform install command deterministically for ALL platforms", () => {
    expect(ghInstallFixCommand("win32")).toBe("winget install --id GitHub.cli");
    expect(ghInstallFixCommand("darwin")).toBe("brew install gh");
    expect(ghInstallFixCommand("linux")).toBeUndefined();
  });

  it("a MISSING gh carries a platform-appropriate runnable install command", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "doctor-doc07-"));
    const previous = process.env.AGENT_DECK_GH_BIN;
    process.env.AGENT_DECK_GH_BIN = path.join(dir, "definitely-not-gh");
    try {
      const report = await runDoctor(dir);
      const github = report.checks.find((check) => check.id === "github");
      expect(github).toBeDefined();
      expect(github!.status).toBe("warn");
      expect(github!.fixCommand).toBe(ghInstallFixCommand(process.platform));
    } finally {
      if (previous === undefined) delete process.env.AGENT_DECK_GH_BIN;
      else process.env.AGENT_DECK_GH_BIN = previous;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
