import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import type { UserIdentity } from "@agent-deck/contracts";
import { SANDBOX_AGENT_PROTECTED_ENTRIES } from "@agent-deck/domain";
import type { ResourceRoots } from "@agent-deck/resources";

/**
 * Per-user Pi agent dir on a shared server (remote-server POC, SRV-11).
 *
 * Pi keeps provider credentials in `<agentDir>/auth.json` with no separate auth
 * path override, so each Access identity gets its own agent dir under
 * `<dataDir>/users/<hash>/agent` and its sessions spawn with
 * PI_CODING_AGENT_DIR pointing there. The dir holds a private auth.json; every
 * other shared Pi file in USER_AGENT_LINKS is a symlink to the operator's
 * shared agent dir, so settings, models, skills and extensions stay common.
 *
 * This is credential STORAGE and billing separation, NOT isolation (ADR 0003):
 * every Pi process runs as the same Unix user, so another user's agent can read
 * your auth.json (OAuth refresh tokens included) or /proc/<pid>/environ.
 *
 * The operator (AGENT_DECK_OPERATOR_EMAIL) keeps the shared ~/.pi/agent, so
 * the operator's existing sign-ins need no move. Sessions without an owner
 * (legacy, Doctor, the Pi CLI over ssh) also run on the shared dir.
 */

/**
 * Shared entries linked into each user dir. A FIXED list: anything else (new
 * Pi files, AGENTS.md, SYSTEM.md, .env) stays out until reviewed. auth.json is
 * private; oauth.json is never linked because Pi migrates it into a missing
 * auth.json. Pi 0.82 writes these with writeFileSync (follows the link);
 * Agent Deck's own rename-based writers are only ever called with shared roots.
 * Re-check against the Pi dist on every Pi upgrade.
 */
export const USER_AGENT_LINK_DIRS = [
  "bin",
  "npm",
  "git",
  "sessions",
  "extensions",
  "skills",
  "prompts",
  "themes",
  "agents",
  "agent-library",
  "loops",
] as const;
export const USER_AGENT_LINK_FILES = [
  "settings.json",
  "models.json",
  "models-store.json",
  "trust.json",
  "mcp.json",
  "keybindings.json",
  "claude-bridge.json",
] as const;

/** `<dataDir>/users/<first 16 hex of sha256(lowercased email)>/agent`: no identity in the path. */
export function userAgentDir(dataDir: string, userId: string): string {
  const hash = createHash("sha256").update(userId.toLowerCase()).digest("hex").slice(0, 16);
  return path.join(dataDir, "users", hash, "agent");
}

const lstatOrUndefined = (file: string): Stats | undefined => {
  try {
    return lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
};

const linkTarget = (link: string): string | undefined => {
  try {
    return readlinkSync(link);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    if (code === "EINVAL" || code === "UNKNOWN") return ""; // exists, not a link
    throw error;
  }
};

function refuseAliases(dirs: readonly string[]): void {
  for (const dir of dirs) {
    const stat = lstatOrUndefined(dir);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error(`[user-agent-dir] refusing ${dir}: not a real directory`);
    }
  }
}

/**
 * `<dataDir>/users/<hash>` (the parent of the agent dir), created 0700, for
 * per-user files outside Pi's dir (SRV-06 github.json). Same alias refusal.
 */
export function ensureUserDir(dataDir: string, userId: string): string {
  const dir = path.dirname(userAgentDir(dataDir, userId));
  refuseAliases([path.dirname(dir), dir]);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/** A protected entry that was not the expected link, moved aside (ADR 0007). */
export interface QuarantinedEntry {
  /** `<userDir>/<name>`, linked again to the shared entry. */
  path: string;
  /** Where what was there went: `<path>.quarantined-<ISO timestamp>`. */
  movedTo: string;
}

/**
 * Create the user dir (0700) and its private auth.json ("{}", 0600) when
 * missing, then link the fixed shared entries. auth.json is written BEFORE any
 * link so Pi's migrateAuthToAuthJson can never copy oauth.json or settings
 * apiKeys into it. Idempotent: correct links are skipped, links pointing
 * elsewhere are replaced, real files or dirs (a private copy) are left alone
 * with a warning rather than deleted.
 *
 * `sandboxed` (a launch on a server whose provider is not `none`): a sandbox
 * protects what a link points at, not the link, so a session can swap a
 * code-bearing entry (SANDBOX_AGENT_PROTECTED_ENTRIES) for a real folder or
 * file of its own. Such an entry is moved aside to
 * `<name>.quarantined-<timestamp>` and linked again (fail closed), and
 * returned so the caller can report it; a link that merely points elsewhere
 * is relinked as always. Residual (accepted): another live session of the
 * same user can swap it again after this check.
 */
export function ensureUserAgentDir(
  sharedAgentDir: string,
  userDir: string,
  sandboxed = false,
): QuarantinedEntry[] {
  const quarantined: QuarantinedEntry[] = [];
  // Refuse aliases (review3 R2): a symlinked `users`, `<hash>` or `agent` dir, or
  // an auth.json that is a link or not a regular file, could point a sign-in or
  // a spawn at someone else's credentials. Throwing stops the login or spawn.
  refuseAliases([path.dirname(path.dirname(userDir)), path.dirname(userDir), userDir]);
  mkdirSync(userDir, { recursive: true, mode: 0o700 });
  const auth = path.join(userDir, "auth.json");
  const authStat = lstatOrUndefined(auth);
  if (!authStat) {
    // wx (O_EXCL) never follows a link planted between the check and the write.
    writeFileSync(auth, "{}", { mode: 0o600, flag: "wx" });
  } else if (authStat.isSymbolicLink() || !authStat.isFile()) {
    throw new Error(`[user-agent-dir] refusing ${auth}: not a regular file`);
  }
  const entries = [
    ...USER_AGENT_LINK_DIRS.map((name) => ({ name, type: "dir" as const })),
    ...USER_AGENT_LINK_FILES.map((name) => ({ name, type: "file" as const })),
  ];
  for (const { name, type } of entries) {
    const target = path.join(sharedAgentDir, name);
    const link = path.join(userDir, name);
    // Directories are pre-created so the link resolves; a missing shared file
    // stays a dangling link, and Pi's writeFileSync through it creates the
    // shared file, exactly as it would without a user dir.
    if (type === "dir") mkdirSync(target, { recursive: true });
    const current = linkTarget(link);
    if (current === target) continue;
    if (sandboxed && current === "" && SANDBOX_AGENT_PROTECTED_ENTRIES.includes(name)) {
      const movedTo = `${link}.quarantined-${new Date().toISOString().replace(/[:.]/g, "-")}`;
      renameSync(link, movedTo);
      symlinkSync(target, link, type);
      quarantined.push({ path: link, movedTo });
      continue;
    }
    if (current === "") {
      console.warn(
        `[user-agent-dir] ${link} is a private copy, not a link to ${target}; leaving it`,
      );
      continue;
    }
    if (current !== undefined) unlinkSync(link);
    symlinkSync(target, link, type);
  }
  return quarantined;
}

export class UserAgentDirs {
  constructor(
    private readonly dataDir: string,
    /** The shared agent dir, resolved live (it follows the Pi HOME override). */
    private readonly sharedAgentDir: () => string,
    private readonly operatorEmail?: string,
    /** Sessions run sandboxed: protected entries are quarantined (ADR 0007).
     * Resolved live: the provider is chosen after construction. */
    private readonly sandbox?: {
      on: () => boolean;
      quarantined: (user: UserIdentity, entry: QuarantinedEntry, sessionId: string) => void;
    },
  ) {}

  isOperator(user: UserIdentity): boolean {
    return !!this.operatorEmail && user.id.toLowerCase() === this.operatorEmail.toLowerCase();
  }

  /** The prepared agent dir for `user`; the shared dir for the operator. */
  /** `sessionId`: the launch this is for; only a launch quarantines. */
  resolve(user: UserIdentity, sessionId?: string): string {
    const shared = this.sharedAgentDir();
    if (this.isOperator(user)) return shared;
    const dir = userAgentDir(this.dataDir, user.id);
    const sandbox = sessionId !== undefined && this.sandbox?.on() ? this.sandbox : undefined;
    for (const entry of ensureUserAgentDir(shared, dir, sandbox !== undefined)) {
      sandbox?.quarantined(user, entry, sessionId!);
    }
    return dir;
  }
}

/** The Pi env for a session owner; empty (shared dir) when there is no owner. */
export function userAgentDirEnv(
  owner: UserIdentity | undefined,
  dirs: UserAgentDirs | undefined,
  sessionId?: string,
): Record<string, string> {
  if (!owner || !dirs) return {};
  return { PI_CODING_AGENT_DIR: dirs.resolve(owner, sessionId) };
}

/** `roots` with the user's agent dir, for provider auth reads and writes. */
export function userRoots(
  roots: ResourceRoots,
  user: UserIdentity | undefined,
  dirs: UserAgentDirs | undefined,
): ResourceRoots {
  return user && dirs ? { ...roots, agentDir: dirs.resolve(user) } : roots;
}
