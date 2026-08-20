import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";
import { PiNotFoundError, resolvePiBinary, resolvePiSpawnPlan } from "./resolve.ts";

/**
 * Environment health probe (native Doctor screen): is pi installed, what
 * version, and which providers have credentials. Auth is read as
 * presence-only from ~/.pi/agent/auth.json — never the credential values.
 */

export type CheckStatus = "ok" | "warn" | "error";

export interface HealthCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** A copyable shell command that fixes the check (native Doctor Fix action). */
  fixCommand?: string;
}

export interface DoctorReport {
  checks: HealthCheck[];
  /** Provider ids that have a credential entry (no secrets). */
  signedInProviders: string[];
}

/** The presence-only env fields Doctor needs; secret values and sources stay out. */
export interface DoctorEnvEntry {
  key: string;
  masked: string;
  overridden: boolean;
}

/**
 * Whether the effective (non-shadowed) value is non-empty. This intentionally
 * operates only on scanEnv's masked metadata, never on a credential value.
 */
export function hasEffectiveEnvValue(entries: readonly DoctorEnvEntry[], key: string): boolean {
  return entries.some(
    (entry) => entry.key === key && !entry.overridden && entry.masked.trim().length > 0,
  );
}

/** Honest, platform-neutral web diagnostics. These checks never access a network. */
export function webAccessChecks(exaConfigured: boolean): HealthCheck[] {
  return [
    {
      id: "web-access-exa",
      label: "Web Access — Exa search",
      status: "warn",
      detail: exaConfigured
        ? "EXA_API_KEY is configured, but Exa web tools are unavailable in this Electron build. No network or credential validity test ran."
        : "Optional: add EXA_API_KEY in Environment. Exa web tools are unavailable in this Electron build, and no network or credential validity test ran.",
    },
    {
      id: "web-access-url-fetch",
      label: "Web Access — URL fetch",
      status: "warn",
      detail:
        "Optional known-URL fetching is unavailable in this Electron build. No network test ran.",
    },
  ];
}

/** pi's minimum supported Node (package.json engines: node >=22.19.0). */
export const MIN_NODE_VERSION = "22.19.0";
const MIN_NODE_PARTS = MIN_NODE_VERSION.split(".").map(Number) as [number, number, number];

/**
 * Parse `v22.19.0` (or `22.19.0`) → [22,19,0]; null if unrecognizable. The
 * `(?![.\d])` boundary rejects an extra numeric segment (`22.19.0.1`) so a
 * malformed string isn't misread as a clean release, while still allowing a
 * trailing prerelease/build suffix (`-nightly`, `+build`) or ` (extra text)` —
 * the base X.Y.Z is what the minimum is compared against.
 */
export function parseNodeVersion(raw: string | null): [number, number, number] | null {
  if (!raw) return null;
  const match = raw.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?![.\d])/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * A compact human summary of the notable bits of a parsed pi settings.json
 * (native Doctor "Settings Files": builtin-agent overrides, disableBuiltins,
 * packages, extra prompt-template paths). Purely read-only and fully defensive
 * against missing/mistyped fields; returns "" when nothing notable is set.
 */
export function summarizeSettings(parsed: unknown): string {
  if (typeof parsed !== "object" || parsed === null) return "";
  const s = parsed as Record<string, unknown>;
  // Only a plain (non-array) object counts — subagents / agentOverrides are
  // `{...}` maps, never arrays, so a wrong-shaped array value must NOT be counted
  // by its indices.
  const asObject = (v: unknown): Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
  const plural = (n: number, one: string): string => `${n} ${one}${n === 1 ? "" : "s"}`;

  const parts: string[] = [];
  const subagents = asObject(s.subagents);
  const overrideCount = Object.keys(asObject(subagents.agentOverrides)).length;
  if (overrideCount > 0) parts.push(plural(overrideCount, "agent override"));
  if (subagents.disableBuiltins === true) parts.push("builtin agents disabled");
  const packageCount = Array.isArray(s.packages) ? s.packages.length : 0;
  if (packageCount > 0) parts.push(plural(packageCount, "package"));
  const promptCount = Array.isArray(s.prompts) ? s.prompts.length : 0;
  if (promptCount > 0) parts.push(plural(promptCount, "extra prompt path"));
  return parts.join(", ");
}

interface SettingsFileCheckOptions {
  id: string;
  label: string;
  filePath: string;
  project: boolean;
}

const PROJECT_SETTINGS_CANDIDATE =
  " This is the selected project's settings candidate. New trusted Pi sessions load a valid candidate; matching values then override global settings.";

/**
 * Resolve Pi's effective global agent directory without mutating process env.
 * This mirrors pinned Pi's path behavior while expanding `~` against the HOME
 * that the backend will give Pi, rather than the server process's own home.
 */
export function resolveDoctorAgentDir(home: string, cwd: string, override?: string): string {
  if (!override) return path.join(home, ".pi", "agent");
  let expanded = override;
  if (override === "~") {
    expanded = home;
  } else if (
    override.startsWith(`~${path.sep}`) ||
    (process.platform === "win32" && override.startsWith("~/"))
  ) {
    expanded = path.join(home, override.slice(2));
  }
  if (/^file:\/\//.test(expanded)) {
    try {
      expanded = fileURLToPath(expanded);
    } catch {
      // Preserve Pi's refusal while keeping the user-supplied URL out of an
      // HTTP error response if the launch-environment override is malformed.
      throw new Error("PI_CODING_AGENT_DIR contains an invalid file URL");
    }
  }
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(cwd, expanded);
}

/** Read-only, privacy-safe diagnosis for one Pi settings file. */
function settingsFileCheck(options: SettingsFileCheckOptions): HealthCheck {
  const { id, label, filePath, project } = options;
  const candidate = project ? PROJECT_SETTINGS_CANDIDATE : "";
  const missingDetail = project
    ? `${filePath} — not present; pi uses global settings and built-in defaults.${candidate}`
    : `${filePath} — not present; pi uses built-in defaults.`;

  let contents: string;
  try {
    // Pi's exists/read path follows settings symlinks. statSync does likewise,
    // while still letting Doctor distinguish a directory/non-regular target.
    const stats = statSync(filePath);
    if (!stats.isFile()) {
      return {
        id,
        label,
        status: "warn",
        detail: `${filePath} — the settings candidate does not resolve to a regular file.${candidate}`,
      };
    }
    contents = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { id, label, status: "ok", detail: missingDetail };
    }
    return {
      id,
      label,
      status: "warn",
      detail: `${filePath} — the settings candidate cannot be read.${candidate}`,
    };
  }

  // Pinned SettingsManager treats an exactly empty file as empty settings before
  // calling JSON.parse. Whitespace-only content still reaches JSON.parse.
  if (contents === "") {
    return {
      id,
      label,
      status: "ok",
      detail: `${filePath} — empty file; pi loads empty settings.${candidate}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return {
      id,
      label,
      status: "warn",
      detail: `${filePath} — malformed JSON; pi ignores this file, so its custom settings won't apply; fix or remove it.${candidate}`,
    };
  }
  // Pi's migration uses the `in` operator. null and JSON primitives therefore
  // fail to load, while arrays pass that initial migration and must not be
  // rejected here without stronger pinned behavior to support that claim.
  if (parsed === null || typeof parsed !== "object") {
    return {
      id,
      label,
      status: "warn",
      detail: `${filePath} — valid JSON, but not a settings object; pi cannot apply settings from it.${candidate}`,
    };
  }

  const summary = summarizeSettings(parsed);
  return {
    id,
    label,
    status: "ok",
    detail: `${filePath} — valid JSON${summary ? `; ${summary}` : ""}.${candidate}`,
  };
}

/** True iff the given version is >= MIN_NODE_VERSION (lexicographic by part). */
export function meetsMinNode(version: [number, number, number]): boolean {
  for (let i = 0; i < 3; i++) {
    if (version[i]! > MIN_NODE_PARTS[i]!) return true;
    if (version[i]! < MIN_NODE_PARTS[i]!) return false;
  }
  return true; // exactly equal
}

/**
 * Run `cmd --version` (or the given args) and return its first stdout line, or
 * null if the command is missing or fails. cross-spawn, not node's execFile: on
 * Windows the resolved binary may be an npm `.cmd` shim, and Node refuses to run
 * .cmd/.bat via execFile without shell:true (CVE-2024-27980 mitigation → EINVAL);
 * cross-spawn rewrites the invocation — the same mechanism PiProcess relies on.
 */
export function probeVersion(
  cmd: string,
  args: string[] = ["--version"],
  env?: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, {
        stdio: ["ignore", "pipe", "pipe"],
        ...(env ? { env } : {}),
      });
    } catch {
      resolve(null);
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Resolve on the timeout itself — killing alone doesn't guarantee a 'close'
    // if the child ignores SIGTERM, which would hang runDoctor forever.
    const timer = setTimeout(() => {
      child.kill();
      settle(null);
    }, 10_000);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", () => settle(null));
    child.on("close", (code) => {
      // Most CLIs print versions to stdout, but some releases of the Windows
      // pi npm shim print a successful `--version` result to stderr.
      const first = (stdout.trim() || stderr.trim()).split("\n")[0];
      settle(code === 0 && first ? first : null);
    });
  });
}

/**
 * Run a command purely for its exit status (e.g. `gh auth status`), resolving
 * true iff it exits 0. Same cross-spawn / timeout handling as probeVersion.
 */
function probeSuccess(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: "ignore" });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(false);
    }, 10_000);
    child.on("error", () => settle(false));
    child.on("close", (code) => settle(code === 0));
  });
}

function readSignedInProviders(home: string): string[] {
  const authFile = path.join(home, ".pi", "agent", "auth.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(authFile, "utf8"));
    if (typeof parsed === "object" && parsed !== null) {
      // auth.json is a map keyed by provider id; presence = signed in.
      return Object.keys(parsed as Record<string, unknown>).sort();
    }
  } catch {
    // Missing/unreadable — no providers.
  }
  return [];
}

/** DOC-07 (native openGitHubSetupInTerminal): the guided gh INSTALL half.
 * Per-platform package-manager constants (SAFE_FIX_COMMAND-compatible);
 * linux has no universal manager, so it stays detail-only (cli.github.com). */
export function ghInstallFixCommand(platform: NodeJS.Platform): string | undefined {
  if (platform === "win32") return "winget install --id GitHub.cli";
  if (platform === "darwin") return "brew install gh";
  return undefined;
}

export async function runDoctor(
  home: string = homedir(),
  projectPath?: string,
  agentDir: string = path.join(home, ".pi", "agent"),
): Promise<DoctorReport> {
  const checks: HealthCheck[] = [];

  let binPath: string | null = null;
  let binSource = "";
  try {
    const resolved = resolvePiBinary();
    binPath = resolved.path;
    binSource = resolved.source;
    checks.push({
      id: "pi-binary",
      label: "Pi binary",
      status: "ok",
      detail: `${resolved.path} (via ${resolved.source})`,
    });
  } catch (error) {
    checks.push({
      id: "pi-binary",
      label: "Pi binary",
      status: "error",
      detail: error instanceof PiNotFoundError ? error.message : String(error),
      fixCommand: "npm install -g @earendil-works/pi-coding-agent",
    });
  }

  if (binPath) {
    const plan = resolvePiSpawnPlan(binPath, ["--version"]);
    const version = await probeVersion(plan.command, plan.args, plan.env);
    checks.push({
      id: "pi-version",
      label: "Pi version",
      status: version ? "ok" : "warn",
      detail: version ?? "could not read --version",
      // DOC-03: a RESOLVING pi whose probe fails is corrupt/incompatible — the
      // guided repair is a reinstall (running `pi update pi` would invoke the
      // broken binary itself). Healthy installs carry no fix.
      fixCommand: version ? undefined : "npm install -g @earendil-works/pi-coding-agent",
    });
    void binSource;
  }

  // Pi runs under Agent Deck's own backend runtime. In packaged Electron builds
  // this is Electron's embedded Node, so a separate system `node` is not needed.
  const nodeVersion = process.version;
  const nodeParsed = parseNodeVersion(nodeVersion);
  if (nodeParsed && !meetsMinNode(nodeParsed)) {
    checks.push({
      id: "node",
      label: "Node.js runtime",
      status: "error",
      detail: `${nodeVersion} — Agent Deck requires Node.js ≥ ${MIN_NODE_VERSION}; update Agent Deck`,
    });
  } else {
    checks.push({
      id: "node",
      label: "Node.js runtime",
      status: "ok",
      detail: nodeParsed
        ? `${nodeVersion} embedded with Agent Deck (≥ ${MIN_NODE_VERSION})`
        : `${nodeVersion} embedded with Agent Deck`,
    });
  }

  // bash on PATH: pi's shell tools run through bash, which is native on
  // macOS/Linux but must come from Git Bash on Windows — a common cross-platform
  // gotcha, so it is a first-class preflight check.
  const bashVersion = await probeVersion("bash");
  const onWindows = process.platform === "win32";
  checks.push({
    id: "bash",
    label: "bash shell",
    status: bashVersion ? "ok" : "error",
    detail: bashVersion
      ? bashVersion
      : onWindows
        ? "bash not on PATH — install Git Bash and add it to PATH (pi's shell tools need bash)"
        : "bash not on PATH — pi's shell tools need bash",
  });

  // git: pi's version-control tools (and Agent Deck's fork/worktree flows) need it.
  const gitVersion = await probeVersion("git");
  checks.push({
    id: "git",
    label: "git",
    status: gitVersion ? "ok" : "warn",
    detail: gitVersion ?? "git not on PATH — version-control tools will be unavailable",
  });

  // GitHub CLI: the Issues screen shells out to `gh`, which must be installed
  // AND authenticated. Honors the same AGENT_DECK_GH_BIN override the Issues
  // routes use, so it can be exercised hermetically.
  const ghBin = process.env.AGENT_DECK_GH_BIN || "gh";
  const ghVersion = await probeVersion(ghBin);
  if (!ghVersion) {
    const ghInstall = ghInstallFixCommand(process.platform);
    checks.push({
      id: "github",
      label: "GitHub CLI",
      status: "warn",
      detail: "gh not on PATH — the Issues screen needs the GitHub CLI (install gh)",
      fixCommand: ghInstall,
    });
  } else {
    const authed = await probeSuccess(ghBin, ["auth", "status"]);
    checks.push({
      id: "github",
      label: "GitHub CLI",
      status: authed ? "ok" : "warn",
      detail: authed
        ? `${ghVersion} — authenticated`
        : `${ghVersion} — installed but not authenticated (run: gh auth login)`,
      fixCommand: authed ? undefined : "gh auth login",
    });
  }

  const signedInProviders = readSignedInProviders(home);
  const authFile = path.join(home, ".pi", "agent", "auth.json");
  checks.push({
    id: "auth",
    label: "AI model connection",
    status: signedInProviders.length > 0 ? "ok" : "warn",
    detail:
      signedInProviders.length > 0
        ? `${signedInProviders.length} connected: ${signedInProviders.join(", ")}`
        : existsSync(authFile)
          ? "Provider sign-in file exists, but no AI model provider is connected"
          : "Connect an AI model provider to run coding sessions",
    // A provider API key is the simplest fix (native Doctor "Add …_API_KEY").
    // The placeholder avoids shell metacharacters so it's safe to paste as-is.
    fixCommand: signedInProviders.length > 0 ? undefined : "export ANTHROPIC_API_KEY=YOUR_KEY_HERE",
  });

  // Pi loads global settings first, then a selected project's settings on top.
  // Diagnose each source independently and expose only its path plus a numeric /
  // boolean summary — never JSON keys, values, names, secrets, or raw OS errors.
  checks.push(
    settingsFileCheck({
      id: "settings",
      label: "Global Pi settings (active candidate)",
      filePath: path.join(agentDir, "settings.json"),
      project: false,
    }),
  );
  if (projectPath) {
    checks.push(
      settingsFileCheck({
        id: "settings-project",
        label: "Project Pi settings",
        filePath: path.join(projectPath, ".pi", "settings.json"),
        project: true,
      }),
    );
  }

  return { checks, signedInProviders };
}
