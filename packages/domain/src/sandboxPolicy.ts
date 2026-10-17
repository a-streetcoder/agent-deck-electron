// ADR 0007: the process-sandbox policy of one session, derived from its record
// (ADR 0006) and where it runs. Pure; pi-host's SandboxProvider applies it.
import type { ProjectSandboxConfig, SessionMeta, UserIdentity } from "@agent-deck/contracts";
import { sessionOwner } from "./sessionRecord.ts";

/** Hosts every sandboxed session may reach: the model providers (and their
 * OAuth endpoints), GitHub and the package registries of the common stacks.
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
  "repo.maven.apache.org",
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
 * files are denied unless the owner is the operator. Network: the default
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
    createDirs: unique([scratch, tmpDir, sessionDir, ...toolchains]),
    allowedDomains,
    deniedResolvedAddresses: unique([
      ...DEFAULT_SANDBOX_DENIED_ADDRESSES,
      ...(input.extraDeniedAddresses ?? []),
    ]),
  };
}
