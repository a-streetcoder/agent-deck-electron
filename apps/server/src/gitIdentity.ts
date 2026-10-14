import { readFileSync } from "node:fs";
import path from "node:path";
import type { UserIdentity } from "@agent-deck/contracts";

/**
 * Per-session git identity on a shared server (remote-server POC, ADR 0003).
 *
 * A session's commits are attributed to its OWNER (`SessionMeta.createdBy`):
 * the Pi process env gets GIT_AUTHOR_* / GIT_COMMITTER_* at spawn, and the two
 * commits the app composes (worktree auto-commit, worktree merge) use the same
 * env plus a Co-authored-by trailer per other prompt author.
 *
 * This is ATTRIBUTION, NOT AUTHORIZATION. Everyone on the server runs as the
 * same Unix user with the same keys; a prompt can still run `git -c user.name=`
 * or edit the env inside a tool call. The identity labels who owned the work.
 *
 * `git-identities.json` in the data dir maps an Access email to the name and
 * email to commit with (typically a GitHub noreply address, because GitHub
 * rejects pushes that expose a private email). It is operator-maintained and
 * read on every lookup, so edits apply to the next spawn or commit. A user with
 * no mapping commits as their identity name (else the email's local part) and
 * the Access email, never the server's default identity.
 */
export interface GitIdentity {
  name: string;
  email: string;
}

/** Git ident and trailer lines must stay single-line and free of `<>`. */
const clean = (value: string): string =>
  value
    .replace(/[\p{Cc}<>]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

export const GIT_IDENTITIES_FILE = "git-identities.json";

export class GitIdentityMap {
  constructor(private readonly dataDir: string) {}

  resolve(user: UserIdentity): GitIdentity {
    const mapped = this.read()[user.id.toLowerCase()];
    if (mapped) return mapped;
    const email = clean(user.id);
    return { name: clean(user.name ?? "") || email.split("@")[0] || email, email };
  }

  private read(): Record<string, GitIdentity> {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path.join(this.dataDir, GIT_IDENTITIES_FILE), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        console.warn(
          `[git-identity] ignoring unreadable ${GIT_IDENTITIES_FILE}: ${(error as Error).message}`,
        );
      }
      return {};
    }
    const out: Record<string, GitIdentity> = {};
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const [key, value] of Object.entries(raw)) {
      const { name, email } = (value ?? {}) as Partial<GitIdentity>;
      if (typeof name === "string" && name.trim() && typeof email === "string" && email.trim()) {
        out[key.toLowerCase()] = { name: clean(name), email: clean(email) };
      }
    }
    return out;
  }
}

/** The git env for a session owner; empty (no change) when there is no owner. */
export function gitIdentityEnv(
  owner: UserIdentity | undefined,
  map: GitIdentityMap | undefined,
): Record<string, string> {
  if (!owner || !map) return {};
  const { name, email } = map.resolve(owner);
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

/** Co-authored-by lines for the session's other prompt authors (owner excluded). */
export function coAuthorTrailers(
  owner: UserIdentity | undefined,
  authors: readonly UserIdentity[],
  map: GitIdentityMap | undefined,
): string[] {
  if (!owner || !map) return [];
  const ownerEmail = map.resolve(owner).email.toLowerCase();
  const seen = new Set([ownerEmail]);
  const lines: string[] = [];
  for (const author of authors) {
    const { name, email } = map.resolve(author);
    if (seen.has(email.toLowerCase())) continue;
    seen.add(email.toLowerCase());
    lines.push(`Co-authored-by: ${name} <${email}>`);
  }
  return lines;
}

/** `message` with the trailers appended as git's final paragraph. */
export function withTrailers(message: string, trailers: readonly string[]): string {
  return trailers.length > 0 ? `${message}\n\n${trailers.join("\n")}` : message;
}
