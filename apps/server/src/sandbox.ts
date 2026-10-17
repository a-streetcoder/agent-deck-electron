// ADR 0007: which process sandbox this server runs sessions in, and the
// policy of one session's spawn. The provider and the policy are applied by
// pi-host (PiProcess) and by the server's other spawns of worktree code.
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  isSandboxDomain,
  parseProjectSandboxConfig,
  type ProjectSandboxConfig,
  type SessionMeta,
  type UserIdentity,
} from "@agent-deck/contracts";
import {
  sandboxAllowsWrite,
  sandboxWriteRootProblem,
  sandboxPolicy,
  sandboxViolationOf,
  sessionOwner,
  type NoticeCell,
  type SandboxViolation,
  type SandboxPolicy,
  type SandboxSide,
} from "@agent-deck/domain";
import {
  noneProvider,
  sandboxProbeProblem,
  srtDeniedAddressesProblem,
  srtProblem,
  srtProvider,
  type PiSandbox,
  type SandboxProvider,
} from "@agent-deck/pi-host";
import { gitShowFileSync } from "./git.ts";

export interface SandboxChoice {
  provider: SandboxProvider;
  /** One line for the startup log when the choice deserves attention. */
  warning?: string;
}

/**
 * `AGENT_DECK_SANDBOX=srt|none`. Unset: `srt` on the shared server when srt
 * can run there (its package loads, bubblewrap and socat are installed, and a
 * real sandboxed `/bin/true` succeeds), otherwise `none` with a warning;
 * `none` on a desktop. Windows is always `none`. An explicit `srt` that cannot
 * run refuses to start (the operator asked for a sandbox: fail closed); any
 * other value is refused.
 */
export async function chooseSandboxProvider(options: {
  env: NodeJS.ProcessEnv;
  sharedServer: boolean;
  platform?: NodeJS.Platform;
  /** Why srt cannot run (default: the dependency check, then the probe). */
  problem?: () => Promise<string | undefined>;
  srt?: SandboxProvider;
}): Promise<SandboxChoice> {
  const platform = options.platform ?? process.platform;
  const srt = options.srt ?? srtProvider;
  const problem =
    options.problem ??
    (async () => (await srtProblem(undefined, platform)) ?? (await sandboxProbeProblem(srt)));
  const raw = options.env.AGENT_DECK_SANDBOX?.trim().toLowerCase() || undefined;
  if (raw !== undefined && raw !== "srt" && raw !== "none") {
    throw new Error(
      `AGENT_DECK_SANDBOX is "${options.env.AGENT_DECK_SANDBOX}": use "srt" or "none".`,
    );
  }
  if (platform === "win32") {
    return {
      provider: noneProvider,
      ...(raw === "srt"
        ? { warning: "sandbox: AGENT_DECK_SANDBOX=srt is not available on Windows; using none" }
        : {}),
    };
  }
  if (raw === "none") {
    return options.sharedServer
      ? {
          provider: noneProvider,
          warning:
            "sandbox: AGENT_DECK_SANDBOX=none on a shared server: sessions run without a process sandbox, and the container's userns-enabled seccomp/AppArmor profiles make that weaker than plain Docker; drop those security_opt entries (seccomp, apparmor, systempaths) when choosing none",
        }
      : { provider: noneProvider };
  }
  if (raw === undefined && !options.sharedServer) return { provider: noneProvider };
  const why = await problem();
  if (!why) return { provider: srt };
  await srt.dispose?.(); // the probe may have started srt's proxies
  if (raw === "srt") {
    throw new Error(`sandbox: AGENT_DECK_SANDBOX=srt was asked for but cannot run here: ${why}`);
  }
  return {
    provider: noneProvider,
    warning: `sandbox: WARNING srt cannot run here (${why}); sessions run WITHOUT a process sandbox. Deploy with deploy/seccomp.json, the agent-deck-sandbox AppArmor profile and systempaths=unconfined, or set AGENT_DECK_SANDBOX=none to accept this.`,
  };
}

/**
 * `AGENT_DECK_SANDBOX_DENY_ADDRESSES`: addresses or CIDR ranges (comma-separated)
 * a sandboxed host name must not resolve to, besides the private ranges (the
 * server's public IP, a Docker gateway outside 172.16.0.0/12). Read only for a
 * sandboxed server (`none` ignores it); an entry srt's own schema refuses stops
 * the start rather than fail every wrap.
 */
export async function sandboxDenyAddresses(
  env: NodeJS.ProcessEnv,
  provider: SandboxProvider,
  problem: (entries: readonly string[]) => Promise<string | undefined> = srtDeniedAddressesProblem,
): Promise<string[]> {
  if (provider.name === "none") return [];
  const entries = (env.AGENT_DECK_SANDBOX_DENY_ADDRESSES ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const why = await problem(entries);
  if (why) throw new Error(`AGENT_DECK_SANDBOX_DENY_ADDRESSES: ${why}`);
  return entries;
}

/** The real path of `file`: its deepest existing ancestor resolved, the rest
 * appended (Pi may not have created the folder yet). */
export function realPathOf(file: string): string {
  const missing: string[] = [];
  let current = path.resolve(file);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    missing.unshift(path.basename(current));
    current = parent;
  }
  let real = current;
  try {
    // .native: the on-disk casing on a case-folding filesystem, links resolved.
    real = realpathSync.native(current);
  } catch {
    // Unreadable: keep the resolved path.
  }
  return path.join(real, ...missing);
}

/** The folder Pi writes a session file into, as Pi derives it: `--session-dir`,
 * else the resumed file's folder, else `<agentDir>/sessions/--<cwd>--`. */
export function piSessionDir(launch: {
  agentDir: string;
  cwd: string;
  sessionDir?: string;
  resumeSessionPath?: string;
}): string {
  if (launch.sessionDir) return path.resolve(launch.sessionDir);
  if (launch.resumeSessionPath) return path.dirname(path.resolve(launch.resumeSessionPath));
  const cwd = path.resolve(launch.cwd);
  const safe = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return path.join(path.resolve(launch.agentDir), "sessions", safe);
}

/** What the server knows that a session's policy needs. */
export interface SessionSandboxDeps {
  dataDir: string;
  side: SandboxSide;
  provider: SandboxProvider;
  /** The operator's shared Pi agent dir. */
  sharedAgentDir: () => string;
  operator?: UserIdentity;
  /** The session's project path (the cwd for a session without a project). */
  projectPath: (record: SessionMeta) => string;
  /** The owner's `<dataDir>/users/<hash>` on the server. */
  ownerDir?: (owner: UserIdentity) => string;
  /** Read the project's `.agent-deck/sandbox.json` at a commit (tests
   * inject one; default: {@link gitShowFileSync}). */
  showFile?: (cwd: string, rev: string, repoPath: string) => string | undefined;
  /** Hosts the owner or operator allowed for the session's project. */
  grantedHosts?: (record: SessionMeta) => readonly string[];
  /** Addresses to refuse besides the private ranges. */
  extraDeniedAddresses?: readonly string[];
}

/** One Pi spawn of a session (or of its helper or child). */
export interface SessionSandboxLaunch {
  cwd: string;
  env?: Record<string, string | undefined>;
  sessionDir?: string;
  resumeSessionPath?: string;
  /** The launch's own files: bridge extension and prompt folders, and the
   * extensions, skills and prompt templates on Pi's command line. */
  tempPaths?: readonly string[];
  /** A `--no-session` helper: Pi writes no session file. */
  noSession?: boolean;
  /** The session's own launch: read its sandbox.json proposal and report. */
  report?: boolean;
  /** A one-shot helper that belongs to no session (no violation events). */
  helper?: boolean;
}

/** The PI_CODING_AGENT_DIR the launch runs with. */
const launchAgentDir = (deps: SessionSandboxDeps, env: SessionSandboxLaunch["env"]): string =>
  env?.PI_CODING_AGENT_DIR ??
  (env?.HOME ? path.join(env.HOME, ".pi", "agent") : deps.sharedAgentDir());

/**
 * The policy of one launch of `record`. A launch in another cwd than the
 * session's (a child's own worktree) writes that cwd instead of the session's.
 */
export function sessionSandboxPolicy(
  deps: SessionSandboxDeps,
  record: SessionMeta,
  launch: SessionSandboxLaunch,
  project?: ProjectSandboxConfig,
): SandboxPolicy {
  // Every compared path canonical the same way (ADR 0007 review round 2).
  const agentDir = realPathOf(launchAgentDir(deps, launch.env));
  // Real paths: a link inside a project must not make the policy write elsewhere.
  const projectPath = realPathOf(sandboxProjectPath(deps, record));
  const owner = sessionOwner(record);
  // A child in its own worktree writes that worktree, not the session's.
  const workspace =
    path.resolve(launch.cwd) !== path.resolve(record.cwd)
      ? { ...record.workspace, path: realPathOf(launch.cwd) }
      : record.workspace?.path
        ? { ...record.workspace, path: realPathOf(record.workspace.path) }
        : record.workspace;
  // A --no-session helper writes no session file: its folder is its own temp.
  const sessionDir = launch.noSession
    ? path.join(deps.dataDir, "sandbox", record.id, "tmp")
    : realPathOf(piSessionDir({ ...launch, agentDir }));
  return sandboxPolicy({ ...record, workspace }, deps.side, {
    dataDir: realPathOf(deps.dataDir),
    projectPath,
    piAgentDir: realPathOf(deps.sharedAgentDir()),
    agentDir,
    sessionDir,
    ...(deps.operator ? { operator: deps.operator } : {}),
    ...(owner && deps.ownerDir ? { ownerDir: deps.ownerDir(owner) } : {}),
    ...(project ? { project } : {}),
    sessionTmpPaths: launch.tempPaths ?? [],
    ...(deps.extraDeniedAddresses ? { extraDeniedAddresses: deps.extraDeniedAddresses } : {}),
  });
}

/** The project folder of a session's policy: its project's path, or its cwd
 * when it has no worktree and runs outside the project. */
function sandboxProjectPath(deps: SessionSandboxDeps, record: SessionMeta): string {
  const project = deps.projectPath(record);
  const relative = path.relative(path.resolve(project), path.resolve(record.cwd));
  const insideProject = !relative.startsWith("..") && !path.isAbsolute(relative);
  return record.workspace?.path || insideProject ? project : record.cwd;
}

export const PROJECT_SANDBOX_FILE = ".agent-deck/sandbox.json";

export interface ProjectSandboxRead {
  config?: ProjectSandboxConfig;
  /** Why the file was refused (the defaults apply); absent when it was fine
   * or absent. */
  problems?: string[];
}

/**
 * A session's `.agent-deck/sandbox.json`, read from the project's git at the
 * commit the server recorded as the base of its worktree (a session can move
 * refs, never that commit), or at the project's HEAD for a session without a
 * worktree (which cannot write the project's .git). Never from the files the
 * session edits. A worktree recorded without a base, a missing file or a
 * folder that is not a repository give the defaults.
 */
export function readProjectSandboxConfig(
  projectPath: string,
  record: Pick<SessionMeta, "workspace">,
  showFile: NonNullable<SessionSandboxDeps["showFile"]> = gitShowFileSync,
): ProjectSandboxRead {
  const rev = record.workspace?.path ? record.workspace.baseCommit : "HEAD";
  if (!rev) return {};
  let raw: string | undefined;
  try {
    raw = showFile(projectPath, rev, PROJECT_SANDBOX_FILE);
  } catch {
    return {}; // not a commit id: nothing recorded to read
  }
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    return { problems: [`not JSON: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const parsed = parseProjectSandboxConfig(value);
  return parsed.ok ? { config: parsed.config } : { problems: parsed.problems };
}

/** One launch's sandbox, and what its project's sandbox.json said. */
export interface SessionLaunchSandbox {
  sandbox: PiSandbox;
  /** Why the file was refused. */
  configProblems?: string[];
  /** Hosts the file proposes that the project has not been granted. */
  proposals?: string[];
}

/** The sandbox of one launch, or undefined with the `none` provider (no
 * policy is derived then: nothing would apply it). */
export function sessionSandbox(
  deps: SessionSandboxDeps,
  record: SessionMeta,
  launch: SessionSandboxLaunch,
): SessionLaunchSandbox | undefined {
  if (deps.provider.name === "none") return undefined;
  // The allow-list is server state only (granted by the owner or operator).
  // sandbox.json in git is a proposal: a session can write objects and refs
  // (or move the HEAD it would be read at), so it can never grant itself a host.
  const granted = deps.grantedHosts?.(record) ?? [];
  const known = new Set(granted.map((host) => host.toLowerCase()));
  const read: ProjectSandboxRead = launch.report
    ? readProjectSandboxConfig(sandboxProjectPath(deps, record), record, deps.showFile)
    : {};
  const proposals = (read.config?.allowedDomains ?? []).filter(
    (host) => !known.has(host.toLowerCase()),
  );
  return {
    sandbox: {
      provider: deps.provider,
      policy: sessionSandboxPolicy(
        deps,
        record,
        launch,
        granted.length > 0 ? { allowedDomains: [...granted] } : undefined,
      ),
    },
    ...(read.problems ? { configProblems: read.problems } : {}),
    ...(proposals.length > 0 ? { proposals } : {}),
  };
}

/**
 * The project allow-lists (ADR 0007, review round 1): server state only,
 * `<dataDir>/sandbox-hosts.json` keyed by project id, which no sandbox can
 * write, changed only through the owner/operator route. A project's
 * sandbox.json only proposes hosts.
 */
export class SandboxHostGrants {
  constructor(private readonly file: string) {}

  private read(): Record<string, string[]> {
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
      const out: Record<string, string[]> = {};
      for (const [projectId, hosts] of Object.entries(raw)) {
        if (Array.isArray(hosts)) out[projectId] = hosts.filter(isSandboxDomain);
      }
      return out;
    } catch {
      return {};
    }
  }

  hosts(projectId: string): string[] {
    return this.read()[projectId] ?? [];
  }

  /** False when the host was not granted. */
  remove(projectId: string, host: string): boolean {
    const all = this.read();
    const hosts = all[projectId] ?? [];
    const kept = hosts.filter((entry) => entry.toLowerCase() !== host.toLowerCase());
    if (kept.length === hosts.length) return false;
    all[projectId] = kept;
    this.write(all);
    return true;
  }

  add(projectId: string, host: string): void {
    const all = this.read();
    const hosts = all[projectId] ?? [];
    if (hosts.some((entry) => entry.toLowerCase() === host.toLowerCase())) return;
    all[projectId] = [...hosts, host];
    this.write(all);
  }

  private write(all: Record<string, string[]>): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(temp, this.file);
  }
}

/**
 * Lines raised for a session before its launch registered it (a quarantined
 * agent-dir entry, found while its env is built), shown with that launch's
 * own initial notices.
 */
export function createLaunchNoticeQueue(): {
  add: (sessionId: string, notice: NoticeCell) => void;
  /** The queued lines, once. */
  take: (sessionId: string) => NoticeCell[];
  forget: (sessionId: string) => void;
} {
  const queued = new Map<string, NoticeCell[]>();
  return {
    add: (sessionId, notice) => {
      queued.set(sessionId, [...(queued.get(sessionId) ?? []), notice]);
    },
    take: (sessionId) => {
      const notices = queued.get(sessionId) ?? [];
      queued.delete(sessionId);
      return notices;
    },
    forget: (sessionId) => {
      queued.delete(sessionId);
    },
  };
}

/** The transcript line of a violation. */
export function sandboxViolationNotice(
  violation: SandboxViolation,
  allowHost: string | undefined,
  id: string,
): NoticeCell {
  if (violation.kind === "proposal") {
    return {
      kind: "notice",
      id,
      level: "info",
      message: `sandbox.json proposes host ${violation.target}`,
      sandbox: { violation, ...(allowHost ? { allowHost } : {}) },
    };
  }
  const what =
    violation.kind === "network"
      ? `network to ${violation.target}`
      : violation.kind === "read"
        ? `read of ${violation.target}`
        : `write to ${violation.target}`;
  return {
    kind: "notice",
    id,
    level: "warning",
    message: `Sandbox refused: ${what}`,
    sandbox: { violation, ...(allowHost ? { allowHost } : {}) },
  };
}

/**
 * Turn the provider's violation lines into session violations: classified,
 * writes the session's own policy allowed dropped (srt's Linux observer
 * judges by the roots it had at its start), each target once per session.
 */
export const MAX_SANDBOX_VIOLATION_TARGETS = 200;

export function createSandboxViolationReporter(report: {
  /** The session a wrap's policy belongs to (set when it was derived). */
  sessionOf: (policy: SandboxPolicy) => SessionMeta | undefined;
  emit: (record: SessionMeta, violation: SandboxViolation) => void;
  /** Once per session, when it reached the cap: no further lines. */
  truncated: (record: SessionMeta) => void;
  limit?: number;
}): {
  report: (event: { policy: SandboxPolicy; line: string }) => void;
  /** Drop a session's keys (it was deleted). */
  forget: (sessionId: string) => void;
} {
  const limit = report.limit ?? MAX_SANDBOX_VIOLATION_TARGETS;
  const seen = new Map<string, Set<string>>();
  return {
    report: ({ policy, line }) => {
      const record = report.sessionOf(policy);
      const violation = sandboxViolationOf(line);
      if (!record || !violation) return;
      if (violation.kind === "write" && sandboxAllowsWrite(policy, violation.target)) return;
      let keys = seen.get(record.id);
      if (!keys) seen.set(record.id, (keys = new Set()));
      if (keys.size > limit) return; // already truncated
      const key = JSON.stringify([violation.kind, violation.target]);
      if (keys.has(key)) return;
      keys.add(key);
      if (keys.size > limit) report.truncated(record);
      else report.emit(record, violation);
    },
    forget: (sessionId) => {
      seen.delete(sessionId);
    },
  };
}

/** Every folder prefix the server creates for one launch's files. */
export const LAUNCH_FOLDER_PREFIXES: readonly string[] = [
  "agent-deck-bridge-ext-",
  "agent-deck-mem-append-",
  "agent-deck-agent-prompt-",
  "agent-deck-subagent-",
];

/**
 * Remove launch folders a crash left in `roots` (a bridge extension can hold
 * resolved MCP credentials). Only those older than `maxAgeMs`: another
 * instance sharing a root may own the fresh ones. Returns how many went.
 */
export function sweepStaleLaunchFolders(
  roots: readonly string[],
  maxAgeMs = 60 * 60 * 1000,
): number {
  let removed = 0;
  for (const root of roots) {
    let entries: string[];
    try {
      entries = readdirSync(root);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!LAUNCH_FOLDER_PREFIXES.some((prefix) => entry.startsWith(prefix))) continue;
      const dir = path.join(root, entry);
      try {
        if (Date.now() - statSync(dir).mtimeMs < maxAgeMs) continue;
        rmSync(dir, { recursive: true, force: true });
        removed++;
      } catch {
        // Raced with its owner or locked: the next start retries.
      }
    }
  }
  return removed;
}

/** Whether `cwd` (its real path) is a registered project folder or inside one. */
export function cwdInsideProjects(cwd: string, projectPaths: readonly string[]): boolean {
  const target = realPathOf(cwd);
  return projectPaths.some((projectPath) => {
    const relative = path.relative(realPathOf(projectPath), target);
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  });
}

/** A session id usable as one path segment. */
export const isSessionSegment = (id: string): boolean =>
  /^[A-Za-z0-9._-]+$/.test(id) && id !== "." && id !== "..";

/**
 * `<sandboxRoot>/<id>/launch`, the session's server-written launch files.
 * A legacy id that is no path segment gets undefined (the OS temp folder)
 * under `none`; a sandboxed server refuses it, as its policy would.
 */
export function launchDirOf(
  sandboxRoot: string,
  sessionId: string,
  sandboxed: boolean,
): string | undefined {
  if (isSessionSegment(sessionId)) return path.join(sandboxRoot, sessionId, "launch");
  if (!sandboxed) return undefined;
  throw new Error(`session id ${JSON.stringify(sessionId)} is not one path segment`);
}

/**
 * Why `root` cannot be a sandboxed session's folder on this server (a project
 * to register, a session cwd), or undefined: sandboxWriteRootProblem on the
 * real, on-disk paths of the root, the data dir and the operator's agent dir.
 */
export function serverWriteRootProblem(
  root: string,
  dirs: { dataDir: string; piAgentDir: string },
): string | undefined {
  return sandboxWriteRootProblem(realPathOf(root), {
    dataDir: realPathOf(dirs.dataDir),
    piAgentDir: realPathOf(dirs.piAgentDir),
  });
}
