// ADR 0007: the process-sandbox policy of one session, derived from its record
// (ADR 0006) and where it runs. Pure; pi-host's SandboxProvider applies it.
import type { ProjectSandboxConfig, SessionMeta, UserIdentity } from "@agent-deck/contracts";
import type { SandboxViolation } from "./transcript.ts";
import { sessionOwner } from "./sessionRecord.ts";

/** Hosts every sandboxed session may reach: the model providers (and their
 * OAuth endpoints), GitHub (its release downloads are `*.githubusercontent.com`),
 * and the package registries and toolchain downloads of the common stacks.
 * A project adds its own. */
export const DEFAULT_SANDBOX_DOMAINS: readonly string[] = [
  "api.anthropic.com",
  "platform.claude.com",
  "claude.ai",
  "api.openai.com",
  "auth.openai.com",
  "chatgpt.com",
  "generativelanguage.googleapis.com",
  "openrouter.ai",
  "github.com",
  "*.github.com",
  "*.githubusercontent.com",
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "static.crates.io",
  "index.crates.io",
  "static.rust-lang.org",
  "proxy.golang.org",
  "sum.golang.org",
  "repo.maven.apache.org",
  // Toolchain downloads and the registries beyond those (docs/stack-matrix.md):
  // node-gyp's headers, yarn, gems
  "nodejs.org",
  "registry.yarnpkg.com",
  "repo.yarnpkg.com",
  "rubygems.org",
  "index.rubygems.org",
  // uv's managed Python, rustup's installer, Go's releases
  "releases.astral.sh",
  "sh.rustup.rs",
  "go.dev",
  "dl.google.com",
  // the Gradle wrapper and plugins, Temurin's "latest" links
  "services.gradle.org",
  "plugins.gradle.org",
  "plugins-artifacts.gradle.org",
  "api.adoptium.net",
  // Playwright's browsers (current releases; older ones use *.azureedge.net
  // mirrors, which a project grants)
  "cdn.playwright.dev",
  "playwright.download.prss.microsoft.com",
];

/** Folders under the server's `<dataDir>/home` that per-user toolchain
 * installs (rustup, cargo, uv, pipx, nvm, sdkman, bun, deno, go, npm, corepack,
 * maven, gradle) write to. They persist and, as there is one home on the
 * server, are shared by every user's sessions. */
export const SANDBOX_HOME_TOOLCHAIN_DIRS: readonly string[] = [
  ".cache",
  ".local",
  ".config",
  ".cargo",
  ".rustup",
  ".npm",
  ".npm-global",
  ".nvm",
  ".sdkman",
  ".bun",
  ".deno",
  ".m2",
  ".gradle",
  "go",
];

/** Files under the server's `<dataDir>/home` that the shell or git read as
 * configuration: never writable from a sandbox, whatever else is. */
export const SANDBOX_HOME_PROTECTED_FILES: readonly string[] = [
  ".gitconfig",
  ".bashrc",
  ".bash_profile",
  ".profile",
  ".zshrc",
  ".npmrc",
  ".config/git",
];

/** Credentials under the server's `<dataDir>/home`: never readable. */
export const SANDBOX_HOME_SECRETS: readonly string[] = [
  ".ssh",
  ".config/gh",
  ".git-credentials",
  ".npmrc",
  "oauth.json",
];

/** Entries of a Pi agent dir that carry code or configuration shared between
 * sessions: Pi may write the rest of its agent dir (auth.json and its lock,
 * models-store.json), never these. */
export const SANDBOX_AGENT_PROTECTED_ENTRIES: readonly string[] = [
  "extensions",
  "skills",
  "prompts",
  "agents",
  "agent-library",
  "loops",
  "bin",
  "npm",
  "git",
  "themes",
  "settings.json",
  "models.json",
  "mcp.json",
  "trust.json",
];

/** The operator's agent-dir entries a user's agent dir links to (the server's
 * `USER_AGENT_LINK_DIRS`/`FILES` without `sessions`): readable for every
 * session so a user's Pi sees the shared settings, models and extensions. */
export const SANDBOX_SHARED_AGENT_ENTRIES: readonly string[] = [
  "bin",
  "npm",
  "git",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "agents",
  "agent-library",
  "loops",
  "settings.json",
  "models.json",
  "models-store.json",
  "trust.json",
  "mcp.json",
  "keybindings.json",
  "claude-bridge.json",
];

/** Credential files in the operator's agent dir, unreadable to other users. */
const OPERATOR_AUTH_FILES = ["auth.json", "mcp-auth.json", "oauth.json"];

/** Private-use ranges an allowed hostname must never resolve to (srt already
 * refuses loopback, link-local, metadata endpoints and the host's own addresses). */
export const DEFAULT_SANDBOX_DENIED_ADDRESSES: readonly string[] = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "fc00::/7",
];

export type SandboxSide = "local" | "server";

export interface SandboxPolicyInput {
  /** Compare paths without case (default: on darwin and win32, whose usual
   * filesystems fold case). The server passes on-disk paths. */
  caseInsensitivePaths?: boolean;
  dataDir: string;
  projectPath: string;
  /** The operator's shared Pi agent dir (holds the operator's auth files). */
  piAgentDir: string;
  /** The PI_CODING_AGENT_DIR the session runs with: `piAgentDir` for the
   * operator, `<dataDir>/users/<hash>/agent` for a user. */
  agentDir: string;
  /** The folder Pi writes the session file into (`--session-dir`, or
   * `<agentDir>/sessions/<encoded cwd>`), as a real path. */
  sessionDir: string;
  /** Who runs the server; absent when nobody is configured as operator. */
  operator?: UserIdentity;
  /** The session owner's `<dataDir>/users/<hash>` folder on the server. */
  ownerDir?: string;
  /** The project's parsed `.agent-deck/sandbox.json`. */
  project?: ProjectSandboxConfig;
  /** The session's own `/tmp/agent-deck-*` paths (its bridge extension
   * folder, prompt files); readable inside the otherwise denied set. */
  sessionTmpPaths?: readonly string[];
  /** Addresses to refuse besides the private ranges (the Docker gateway). */
  extraDeniedAddresses?: readonly string[];
}

/** A path that must never be writable, and what it is when it exists: the
 * provider creates an absent one of that kind under a writable root, so the
 * session cannot create it first (and srt binds it read-only). */
export interface SandboxDenyEntry {
  path: string;
  kind: "dir" | "file";
}

export interface SandboxPolicy {
  allowWrite: string[];
  /** Never writable, even inside an `allowWrite` folder. */
  denyWrite: SandboxDenyEntry[];
  denyRead: string[];
  /** Re-allowed for reading inside a `denyRead` folder. */
  allowRead: string[];
  /** The session's own temp folder (inside its scratch folder). */
  tmpDir: string;
  /** `/tmp` inside the sandbox is the sandbox's own, empty and writable (for
   * tools that ignore TMPDIR: the JVM, turbo's strict env), never the host's.
   * Set on the server; the provider applies it where it can (srt on Linux). */
  privateTmp?: boolean;
  /** Writable folders the provider creates before the wrap (srt skips
   * write paths that do not exist). */
  createDirs: string[];
  allowedDomains: string[];
  /** Addresses an allowed hostname must not resolve to. */
  deniedResolvedAddresses: string[];
}

/** A record or input the policy refuses to derive paths from. */
export class SandboxPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxPolicyError";
  }
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;
const isSegment = (value: string): boolean =>
  SEGMENT.test(value) && value !== "." && value !== "..";

const trimEnd = (dir: string): string => dir.replace(/[\\/]+$/, "") || "/";
const join = (dir: string, ...parts: string[]): string =>
  [trimEnd(dir).replace(/\/$/, ""), ...parts].join("/");
const baseName = (dir: string): string => trimEnd(dir).replace(/^.*[\\/]/, "");
const unique = (items: readonly string[]): string[] => [...new Set(items)];

/** `..`-resolved, `/`-separated form, for containment checks only. */
function normalize(file: string): string {
  const out: string[] = [];
  for (const part of file.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return `/${out.join("/")}`;
}

/** `file` is `root` or lies beneath it (lexically, `..` resolved,
 * trailing separators ignored, case folded when asked). */
function isWithin(root: string, file: string, caseInsensitive = false): boolean {
  const fold = (value: string): string => (caseInsensitive ? value.toLowerCase() : value);
  const base = fold(normalize(root));
  const target = fold(normalize(file));
  return target === base || target.startsWith(`${base === "/" ? "" : base}/`);
}

/** Whether this process's platform usually folds path case (darwin, win32). */
const platformFoldsCase = (): boolean => {
  const platform = (globalThis as { process?: { platform?: string } }).process?.platform;
  return platform === "darwin" || platform === "win32";
};

/** Folders of the server's data dir that hold its own or every user's state;
 * no write root may be, hold or lie inside one (a worktree may lie inside
 * `session-worktrees`, the folder the server allocates them in). */
export const SANDBOX_RESERVED_DATA_DIRS: readonly string[] = [
  "users",
  "sandbox",
  "home",
  "imported-sessions",
  "events",
  "session-worktrees",
  "Subagent Runs",
  "checkpoints",
  "loop-artifacts",
  "memory",
  "session-images",
  "session-pastes",
  "composer-drafts",
  "agent-avatars",
  "injected-commands",
  "openai-fast",
  "plan-events",
];

/**
 * Why `root` cannot be a sandbox write root (or a session's project folder),
 * or undefined when it can: it must not be, hold or lie inside the data dir's
 * reserved folders, the operator's agent dir or the session's agent dir, and
 * must not hold the data dir. A worktree root strictly inside the server's
 * `session-worktrees` folder is legitimate. Paths are compared as given:
 * the caller canonicalises them (real, on-disk paths) first.
 */
export function sandboxWriteRootProblem(
  root: string,
  dirs: {
    dataDir: string;
    piAgentDir: string;
    agentDir?: string;
    worktree?: boolean;
    caseInsensitive?: boolean;
  },
): string | undefined {
  const fold = dirs.caseInsensitive ?? platformFoldsCase();
  const within = (outer: string, inner: string): boolean => isWithin(outer, inner, fold);
  if (within(root, dirs.dataDir)) return `sandbox write root ${root} contains ${dirs.dataDir}`;
  for (const agent of [dirs.piAgentDir, dirs.agentDir]) {
    if (agent && (within(root, agent) || within(agent, root))) {
      return `sandbox write root ${root} overlaps the agent dir ${agent}`;
    }
  }
  const worktrees = join(dirs.dataDir, "session-worktrees");
  if (dirs.worktree && within(worktrees, root) && !within(root, worktrees)) return undefined;
  for (const entry of SANDBOX_RESERVED_DATA_DIRS) {
    const reserved = join(dirs.dataDir, entry);
    if (within(root, reserved) || within(reserved, root)) {
      return `sandbox write root ${root} overlaps the server's ${reserved}`;
    }
  }
  return undefined;
}

function assertWithin(root: string, paths: readonly string[]): void {
  const base = normalize(root);
  for (const file of paths) {
    const target = normalize(file);
    if (target !== base && !target.startsWith(`${base === "/" ? "" : base}/`)) {
      throw new SandboxPolicyError(`sandbox path ${file} is outside ${root}`);
    }
  }
}

/** True when the session's owner is the operator. Locally it always is: the
 * desktop runs as the one person using it. */
const ownedByOperator = (
  record: Pick<SessionMeta, "location" | "createdBy">,
  side: SandboxSide,
  operator: UserIdentity | undefined,
): boolean => {
  if (side === "local") return true;
  const owner = sessionOwner(record);
  return !!owner && !!operator && owner.id.toLowerCase() === operator.id.toLowerCase();
};

/**
 * What the session's Pi process may write, read and reach.
 *
 * Writes: the worktree (else the project), Pi's agent dir (without its
 * code-bearing and shared entries), the session folder and the session's own
 * scratch folder, plus the home toolchain folders on the server. Git: a
 * worktree session writes objects, refs, logs and its own worktree admin
 * folder of `<projectPath>/.git`, never the config, hooks, alternates or the
 * pointers that tell the server's git where the repository is; a session
 * without a worktree cannot write `<projectPath>/.git` at all.
 *
 * Reads on the server: all of `<dataDir>` is denied but what the session works
 * on (above, the owner's folder, the shared agent entries), plus the home's
 * credentials and other sessions' `/tmp/agent-deck-*`; the operator's auth
 * files are denied unless the owner is the operator; `/tmp` is the sandbox's
 * own (`privateTmp`). Network: the default
 * hosts plus the project's, and never a private address.
 *
 * Throws SandboxPolicyError for a session id that is not one path segment
 * or a derived path that would leave `<dataDir>`.
 */
export function sandboxPolicy(
  record: Pick<SessionMeta, "id" | "workspace" | "piSessionFile" | "location" | "createdBy">,
  side: SandboxSide,
  input: SandboxPolicyInput,
): SandboxPolicy {
  if (!isSegment(record.id)) {
    throw new SandboxPolicyError(`session id ${JSON.stringify(record.id)} is not one path segment`);
  }
  const server = side === "server";
  const home = (entry: string): string => join(input.dataDir, "home", entry);
  const scratch = join(input.dataDir, "sandbox", record.id);
  const tmpDir = join(scratch, "tmp");
  const toolchains = server ? SANDBOX_HOME_TOOLCHAIN_DIRS.map(home) : [];
  assertWithin(input.dataDir, [scratch, tmpDir, ...toolchains]);

  const projectPath = trimEnd(input.projectPath);
  const agentDir = trimEnd(input.agentDir);
  const sessionDir = trimEnd(input.sessionDir);
  const worktree = record.workspace?.path ? trimEnd(record.workspace.path) : undefined;
  const writeRoot = worktree ?? projectPath;
  const gitDir = join(projectPath, ".git");
  // A write root must not hand the session the server's or other users'
  // state: see sandboxWriteRootProblem.
  const fold = input.caseInsensitivePaths ?? platformFoldsCase();
  for (const [root, isWorktree] of [
    [writeRoot, worktree !== undefined],
    [projectPath, false],
  ] as const) {
    const problem = sandboxWriteRootProblem(root, {
      dataDir: input.dataDir,
      piAgentDir: input.piAgentDir,
      agentDir: input.agentDir,
      worktree: isWorktree,
      caseInsensitive: fold,
    });
    if (problem) throw new SandboxPolicyError(problem);
  }

  // The transcript file itself, never its folder: an imported session's file
  // sits in a folder every imported session of every user shares.
  const transcript = record.piSessionFile ? trimEnd(record.piSessionFile) : undefined;
  const allowWrite = [writeRoot, agentDir, sessionDir];
  if (transcript) allowWrite.push(transcript);
  allowWrite.push(scratch, ...toolchains);

  const denyWrite: SandboxDenyEntry[] = [];
  const dir = (path: string): SandboxDenyEntry => ({ path, kind: "dir" });
  const file = (path: string): SandboxDenyEntry => ({ path, kind: "file" });
  if (worktree) {
    const name = baseName(worktree);
    if (!isSegment(name)) {
      throw new SandboxPolicyError(`worktree ${worktree} has no usable folder name`);
    }
    const admin = join(gitDir, "worktrees", name);
    assertWithin(gitDir, [admin]);
    allowWrite.push(join(gitDir, "objects"), join(gitDir, "refs"), join(gitDir, "logs"), admin);
    denyWrite.push(
      file(join(worktree, ".git")),
      file(join(gitDir, "config")),
      dir(join(gitDir, "hooks")),
      dir(join(gitDir, "objects", "info")),
      file(join(admin, "commondir")),
      file(join(admin, "gitdir")),
      file(join(admin, "config.worktree")),
    );
  } else {
    denyWrite.push(dir(gitDir));
  }
  // The server's launch files (bridge extension, prompts, a child's checker
  // shell) sit in the scratch folder, but only the server writes them.
  denyWrite.push(dir(join(scratch, "launch")));
  for (const entry of SANDBOX_AGENT_PROTECTED_ENTRIES) {
    const path = join(agentDir, entry);
    denyWrite.push(entry.endsWith(".json") ? file(path) : dir(path));
  }
  if (server) {
    for (const entry of SANDBOX_HOME_PROTECTED_FILES) {
      denyWrite.push(entry === ".config/git" ? dir(home(entry)) : file(home(entry)));
    }
  }

  const denyRead: string[] = [];
  const allowRead: string[] = [];
  if (server) {
    denyRead.push(trimEnd(input.dataDir), "/tmp/agent-deck-*", ...SANDBOX_HOME_SECRETS.map(home));
    allowRead.push(writeRoot, projectPath, scratch, agentDir);
    if (input.ownerDir) allowRead.push(trimEnd(input.ownerDir));
    for (const entry of SANDBOX_SHARED_AGENT_ENTRIES) allowRead.push(join(input.piAgentDir, entry));
    allowRead.push(...toolchains, ...(input.sessionTmpPaths ?? []).map(trimEnd));
  }
  // Every session's transcripts share one `sessions` tree (a user's agent dir
  // links into the operator's). Deny it, re-allow only this session's folder
  // and file. Not a denyWrite: srt lets denyWrite win over a deeper
  // allowWrite. A read-denied folder is an empty tmpfs inside the sandbox, so
  // writes elsewhere in the tree land there and never reach the host, while
  // the re-allowed `sessionDir` is bound back writable.
  denyRead.push(join(agentDir, "sessions"), join(input.piAgentDir, "sessions"));
  allowRead.push(sessionDir);
  if (transcript) allowRead.push(transcript);
  if (!ownedByOperator(record, side, input.operator)) {
    denyRead.push(...OPERATOR_AUTH_FILES.map((file) => join(input.piAgentDir, file)));
  }

  const seen = new Set<string>();
  const allowedDomains = [
    ...DEFAULT_SANDBOX_DOMAINS,
    ...(input.project?.allowedDomains ?? []),
  ].filter((domain) => {
    const key = domain.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    allowWrite: unique(allowWrite),
    denyWrite: denyWrite.filter(
      (entry, index) => denyWrite.findIndex((other) => other.path === entry.path) === index,
    ),
    denyRead: unique(denyRead),
    allowRead: unique(allowRead),
    tmpDir,
    ...(server ? { privateTmp: true } : {}),
    createDirs: unique([scratch, tmpDir, sessionDir, ...toolchains]),
    allowedDomains,
    deniedResolvedAddresses: unique([
      ...DEFAULT_SANDBOX_DENIED_ADDRESSES,
      ...(input.extraDeniedAddresses ?? []),
    ]),
  };
}

/**
 * One of srt's violation lines as a violation, or undefined for a line of
 * another shape. srt writes `deny network-outbound <host>:<port> (<reason>)`
 * for a refused connection (its proxy), `deny <syscall> <path>` for a refused
 * write on Linux (its seccomp observer) and the Seatbelt rule with its path on
 * macOS (`file-write-create /path`, `file-read-data /path`).
 */
export function sandboxViolationOf(line: string): SandboxViolation | undefined {
  const network = /^deny network-outbound (\S+?)(?::(\d+))? \((.*)\)$/.exec(line.trim());
  if (network) {
    const host = network[1]!.replace(/^\[(.*)\]$/, "$1");
    return { kind: "network", target: host, operation: "network-outbound" };
  }
  const seatbelt = /(file-(read|write)[\w-]*)\s+(\/.*)$/.exec(line.trim());
  if (seatbelt) {
    return {
      kind: seatbelt[2] === "read" ? "read" : "write",
      target: seatbelt[3]!,
      operation: seatbelt[1]!,
    };
  }
  const seccomp = /^deny (\w+) (\/.*)$/.exec(line.trim());
  if (seccomp) return { kind: "write", target: seccomp[2]!, operation: seccomp[1]! };
  return undefined;
}

/**
 * Whether `policy` lets the session write `file`: inside an `allowWrite` root
 * and no `denyWrite` entry. srt's Linux observer reports every write outside
 * the roots it knew at its start; this drops the ones the session's own wrap
 * allowed, writes into a private `/tmp` (Linux) included.
 */
export function sandboxAllowsWrite(
  policy: Pick<SandboxPolicy, "allowWrite" | "denyWrite" | "privateTmp">,
  file: string,
  /** srt's rules differ per platform (srtDeniesInWorkingFolder). */
  platform: string | undefined = (globalThis as { process?: { platform?: string } }).process
    ?.platform,
): boolean {
  const target = normalize(file);
  const covers = (root: string): boolean => {
    const base = normalize(root);
    return target === base || target.startsWith(`${base === "/" ? "" : base}/`);
  };
  // The sandbox's own tmpfs: the write never reaches the host.
  if (policy.privateTmp && platform === "linux" && covers("/tmp")) return true;
  if (!policy.allowWrite.some(covers) || policy.denyWrite.some((entry) => covers(entry.path))) {
    return false;
  }
  // srt's own denies inside the working folder (the first write root).
  const root = policy.allowWrite[0];
  return !root || !srtDeniesInWorkingFolder(root, file, platform);
}

/** srt's DANGEROUS_FILES (sandbox-utils.js; sandboxPolicy.srt test pins the copy). */
export const SRT_DANGEROUS_FILES: readonly string[] = [
  ".gitconfig",
  ".gitmodules",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ripgreprc",
  ".mcp.json",
];
/** srt's getDangerousDirectories() (same source, same pin). */
export const SRT_DANGEROUS_DIRECTORIES: readonly string[] = [
  ".vscode",
  ".idea",
  ".claude/commands",
  ".claude/agents",
];
/** srt's ripgrep depth for the nested matches (DEFAULT_MANDATORY_DENY_SEARCH_DEPTH). */
const SRT_DENY_SEARCH_DEPTH = 3;

/**
 * Whether srt itself refuses a write to `file` in the working folder `cwd`,
 * whatever the policy: its dangerous files and directories at the top of the
 * folder, and found by its scan down to three levels (a file's depth), plus
 * nested repositories' `.git/hooks` and `.git/config`. Matched without
 * case, as srt does.
 */
export function srtDeniesInWorkingFolder(
  cwd: string,
  file: string,
  platform: string | undefined = (globalThis as { process?: { platform?: string } }).process
    ?.platform,
): boolean {
  const base = normalize(cwd).toLowerCase();
  const target = normalize(file).toLowerCase();
  if (!target.startsWith(`${base === "/" ? "" : base}/`)) return false;
  const parts = target.slice(base.length).split("/").filter(Boolean);
  const name = parts.at(-1) ?? "";
  // macOS: Seatbelt rules match the names at any depth; Linux: srt's scan
  // finds what lies within its depth (a file's depth, as ripgrep counts).
  const unlimited = platform === "darwin";
  const dirs = SRT_DANGEROUS_DIRECTORIES.map((dir) => dir.split("/"));
  const startsAt = (index: number, segments: readonly string[]): boolean =>
    segments.every((segment, offset) => parts[index + offset] === segment);
  if (SRT_DANGEROUS_FILES.includes(name)) {
    if (parts.length === 1 || unlimited || parts.length <= SRT_DENY_SEARCH_DEPTH) return true;
  }
  // A protected directory is denied whole: itself and anything below it. srt
  // denies one at the top always, a nested one its scan reaches (a file in
  // it within the depth: the directory at most one level above that).
  const protectedDirs = [...dirs, [".git", "hooks"]];
  for (let index = 0; index < parts.length; index++) {
    for (const segments of protectedDirs) {
      if (!startsAt(index, segments)) continue;
      const depth = index + segments.length;
      const reached =
        unlimited ||
        index === 0 ||
        depth <= SRT_DENY_SEARCH_DEPTH - 1 ||
        // .git/hooks: srt looks one level further for hooks.
        (segments[0] === ".git" && depth <= SRT_DENY_SEARCH_DEPTH);
      if (reached) return true;
    }
    if (parts[index] === ".git" && parts[index + 1] === "config" && parts.length === index + 2) {
      if (unlimited || parts.length <= SRT_DENY_SEARCH_DEPTH) return true;
    }
  }
  return false;
}
