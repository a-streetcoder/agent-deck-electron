import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readlinkSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from "node:fs";
import path from "node:path";
import type { UserIdentity } from "@agent-deck/contracts";
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

/**
 * Create the user dir (0700) and its private auth.json ("{}", 0600) when
 * missing, then link the fixed shared entries. auth.json is written BEFORE any
 * link so Pi's migrateAuthToAuthJson can never copy oauth.json or settings
 * apiKeys into it. Idempotent: correct links are skipped, links pointing
 * elsewhere are replaced, real files or dirs (a private copy) are left alone
 * with a warning rather than deleted.
 */
export function ensureUserAgentDir(sharedAgentDir: string, userDir: string): void {
  // Refuse aliases (review3 R2): a symlinked `users`, `<hash>` or `agent` dir, or
  // an auth.json that is a link or not a regular file, could point a sign-in or
  // a spawn at someone else's credentials. Throwing stops the login or spawn.
  const users = path.dirname(path.dirname(userDir));
  for (const dir of [users, path.dirname(userDir), userDir]) {
    const stat = lstatOrUndefined(dir);
    if (stat && (stat.isSymbolicLink() || !stat.isDirectory())) {
      throw new Error(`[user-agent-dir] refusing ${dir}: not a real directory`);
    }
  }
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
    if (current === "") {
      console.warn(
        `[user-agent-dir] ${link} is a private copy, not a link to ${target}; leaving it`,
      );
      continue;
    }
    if (current !== undefined) unlinkSync(link);
    symlinkSync(target, link, type);
  }
}

export class UserAgentDirs {
  constructor(
    private readonly dataDir: string,
    /** The shared agent dir, resolved live (it follows the Pi HOME override). */
    private readonly sharedAgentDir: () => string,
    private readonly operatorEmail?: string,
  ) {}

  /** The prepared agent dir for `user`; the shared dir for the operator. */
  resolve(user: UserIdentity): string {
    const shared = this.sharedAgentDir();
    if (this.operatorEmail && user.id.toLowerCase() === this.operatorEmail.toLowerCase()) {
      return shared;
    }
    const dir = userAgentDir(this.dataDir, user.id);
    ensureUserAgentDir(shared, dir);
    return dir;
  }
}

/** The Pi env for a session owner; empty (shared dir) when there is no owner. */
export function userAgentDirEnv(
  owner: UserIdentity | undefined,
  dirs: UserAgentDirs | undefined,
): Record<string, string> {
  if (!owner || !dirs) return {};
  return { PI_CODING_AGENT_DIR: dirs.resolve(owner) };
}

/** `roots` with the user's agent dir, for provider auth reads and writes. */
export function userRoots(
  roots: ResourceRoots,
  user: UserIdentity | undefined,
  dirs: UserAgentDirs | undefined,
): ResourceRoots {
  return user && dirs ? { ...roots, agentDir: dirs.resolve(user) } : roots;
}
