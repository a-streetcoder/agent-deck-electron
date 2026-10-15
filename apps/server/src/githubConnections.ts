import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { UserIdentity } from "@agent-deck/contracts";
import { ensureUserDir, type UserAgentDirs } from "./userAgentDirs.ts";

/**
 * Per-user GitHub connection on a shared server (remote-server POC, SRV-06).
 *
 * A user connects GitHub with the OAuth device flow (RFC 8628; client id from
 * AGENT_DECK_GITHUB_CLIENT_ID, no client secret). The token is stored in the
 * user's own dir (`<dataDir>/users/<hash>/github.json`, 0600; the operator's in
 * `<dataDir>/github.json`) and injected into the session OWNER's Pi env as
 * GH_TOKEN plus a git credential helper for github.com, so pushes and PRs are
 * made as the owner. An owner with no connection gets nothing: git and gh fall
 * back to the server default.
 *
 * This is ATTRIBUTION, NOT ISOLATION (ADR 0003): every agent runs as the same
 * Unix user, so any agent can read every user's github.json or GH_TOKEN from
 * /proc/<pid>/environ. The token is never returned by an API or logged.
 */

export const GITHUB_FILE = "github.json";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const SCOPES = "repo read:user";

export interface GitHubStatus {
  login: string;
  avatarUrl: string;
  scopes: string[];
  connectedAt: string;
}
interface GitHubConnection extends GitHubStatus {
  token: string;
}

export type GitHubPollResult =
  | { status: "pending"; interval: number }
  | { status: "done"; login: string }
  | { status: "expired" | "denied" | "error"; error: string };

interface DeviceFlow {
  userId: string;
  user: UserIdentity;
  deviceCode: string;
  intervalMs: number;
  nextPollAt: number;
  expiresAt: number;
  polling: boolean;
  result?: GitHubPollResult;
}

/** Thrown by `start` with an HTTP status and a message safe to show. */
export class GitHubConnectError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const RESULT_TTL_MS = 5 * 60_000;

export class GitHubConnections {
  private readonly flows = new Map<string, DeviceFlow>();

  constructor(
    private readonly dataDir: string,
    private readonly dirs: UserAgentDirs,
    private readonly clientId: () => string | undefined = () =>
      process.env.AGENT_DECK_GITHUB_CLIENT_ID?.trim() || undefined,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  configured(): boolean {
    return this.clientId() !== undefined;
  }

  /** `<dataDir>/users/<hash>/github.json` (dir alias-checked); the operator's in `<dataDir>`. */
  private file(user: UserIdentity): string {
    if (this.dirs.isOperator(user)) return path.join(this.dataDir, GITHUB_FILE);
    return path.join(ensureUserDir(this.dataDir, user.id), GITHUB_FILE);
  }

  read(user: UserIdentity): GitHubConnection | undefined {
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file(user), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        // Never the content: it holds the token.
        console.warn(`[github] ignoring an unreadable ${GITHUB_FILE}`);
      }
      return undefined;
    }
    const value = (raw ?? {}) as Partial<GitHubConnection>;
    if (typeof value.token !== "string" || !value.token) return undefined;
    return {
      token: value.token,
      login: typeof value.login === "string" ? value.login : "",
      avatarUrl: typeof value.avatarUrl === "string" ? value.avatarUrl : "",
      scopes: Array.isArray(value.scopes) ? value.scopes.filter((s) => typeof s === "string") : [],
      connectedAt: typeof value.connectedAt === "string" ? value.connectedAt : "",
    };
  }

  status(user: UserIdentity): GitHubStatus | null {
    const connection = this.read(user);
    if (!connection) return null;
    const { token: _token, ...status } = connection;
    return status;
  }

  remove(user: UserIdentity): void {
    rmSync(this.file(user), { force: true });
  }

  private write(user: UserIdentity, connection: GitHubConnection): void {
    const file = this.file(user);
    // A fresh 0600 file renamed over the target: never follows a planted link.
    const temp = `${file}.${randomUUID()}.tmp`;
    writeFileSync(temp, JSON.stringify(connection, null, 2), { mode: 0o600, flag: "wx" });
    renameSync(temp, file);
  }

  /** Start a device flow for `user`. The device code stays server-side. */
  async start(user: UserIdentity): Promise<{
    id: string;
    userCode: string;
    verificationUri: string;
    interval: number;
    expiresIn: number;
  }> {
    const clientId = this.clientId();
    if (!clientId) throw new GitHubConnectError(409, "GitHub app not configured");
    this.prune();
    const body = await this.post(DEVICE_CODE_URL, { client_id: clientId, scope: SCOPES });
    const { device_code, user_code, verification_uri, interval, expires_in } = body;
    if (
      typeof device_code !== "string" ||
      typeof user_code !== "string" ||
      typeof verification_uri !== "string"
    ) {
      throw new GitHubConnectError(502, githubError(body, "GitHub did not start the sign-in."));
    }
    const seconds = typeof interval === "number" && interval >= 0 ? interval : 5;
    const expiresIn = typeof expires_in === "number" && expires_in > 0 ? expires_in : 900;
    const id = randomUUID();
    this.flows.set(id, {
      userId: user.id,
      user,
      deviceCode: device_code,
      intervalMs: seconds * 1000,
      nextPollAt: Date.now() + seconds * 1000,
      expiresAt: Date.now() + expiresIn * 1000,
      polling: false,
    });
    return {
      id,
      userCode: user_code,
      verificationUri: verification_uri,
      interval: seconds,
      expiresIn,
    };
  }

  /**
   * One poll step, at most one GitHub request per interval (RFC 8628 3.5).
   * `undefined` for an unknown flow or one another identity started.
   */
  async poll(id: string, requesterId: string): Promise<GitHubPollResult | undefined> {
    const flow = this.flows.get(id);
    if (!flow || flow.userId !== requesterId) return undefined;
    if (flow.result) return flow.result;
    const pending = (): GitHubPollResult => ({
      status: "pending",
      interval: Math.ceil(flow.intervalMs / 1000),
    });
    if (Date.now() >= flow.expiresAt) {
      return this.finish(flow, { status: "expired", error: "The GitHub code expired." });
    }
    if (flow.polling || Date.now() < flow.nextPollAt) return pending();
    flow.polling = true;
    try {
      const clientId = this.clientId();
      if (!clientId)
        return this.finish(flow, { status: "error", error: "GitHub app not configured" });
      const body = await this.post(ACCESS_TOKEN_URL, {
        client_id: clientId,
        device_code: flow.deviceCode,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      });
      if (typeof body.access_token === "string" && body.access_token) {
        const token = body.access_token;
        const account = await this.account(token);
        this.write(flow.user, {
          token,
          login: account.login,
          avatarUrl: account.avatarUrl,
          scopes: typeof body.scope === "string" ? body.scope.split(/[,\s]+/).filter(Boolean) : [],
          connectedAt: new Date().toISOString(),
        });
        return this.finish(flow, { status: "done", login: account.login });
      }
      switch (body.error) {
        case "authorization_pending":
          return pending();
        case "slow_down":
          flow.intervalMs =
            typeof body.interval === "number" ? body.interval * 1000 : flow.intervalMs + 5000;
          return pending();
        case "expired_token":
          return this.finish(flow, { status: "expired", error: "The GitHub code expired." });
        case "access_denied":
          return this.finish(flow, {
            status: "denied",
            error: "The sign-in was denied on GitHub.",
          });
        default:
          return this.finish(flow, {
            status: "error",
            error: githubError(body, "GitHub refused the sign-in."),
          });
      }
    } catch (error) {
      // GitHub unreachable or a bad answer: keep polling until the code expires.
      console.warn(`[github] device flow poll failed: ${(error as Error).message}`);
      return pending();
    } finally {
      flow.polling = false;
      flow.nextPollAt = Date.now() + flow.intervalMs;
    }
  }

  private finish(flow: DeviceFlow, result: GitHubPollResult): GitHubPollResult {
    flow.result = result;
    flow.expiresAt = Math.min(flow.expiresAt, Date.now() + RESULT_TTL_MS);
    return result;
  }

  private prune(): void {
    const now = Date.now();
    for (const [id, flow] of this.flows) {
      if (now >= flow.expiresAt + RESULT_TTL_MS) this.flows.delete(id);
    }
  }

  private async post(url: string, form: Record<string, string>): Promise<Record<string, unknown>> {
    const response = await this.fetchFn(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    const body = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body || typeof body !== "object") throw new Error(`GitHub answered ${response.status}`);
    return body;
  }

  private async account(token: string): Promise<{ login: string; avatarUrl: string }> {
    const response = await this.fetchFn(USER_URL, {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "agent-deck",
      },
    });
    const body = (await response.json().catch(() => null)) as {
      login?: unknown;
      avatar_url?: unknown;
    } | null;
    if (!response.ok || typeof body?.login !== "string") {
      throw new Error(`GitHub user lookup answered ${response.status}`);
    }
    return {
      login: body.login,
      avatarUrl: typeof body.avatar_url === "string" ? body.avatar_url : "",
    };
  }
}

/** GitHub's own error text (never contains a token), else `fallback`. */
function githubError(body: Record<string, unknown>, fallback: string): string {
  const text = body.error_description ?? body.error;
  return typeof text === "string" && text ? text : fallback;
}

/**
 * Git reads the helper for github.com from the env (GIT_CONFIG_COUNT, git >=
 * 2.31). The empty value first clears every inherited helper for github.com, so
 * the server's own store never sees (or saves) the token; the helper answers
 * `get` only, printing GH_TOKEN from the env, so the token is not in the config.
 */
export const GITHUB_CREDENTIAL_HELPER =
  '!f() { test "$1" = get && printf \'username=x-access-token\\npassword=%s\\n\' "$GH_TOKEN"; }; f';

/** The owner's GitHub env (GH_TOKEN for gh, a credential helper for git); empty without one. */
export function githubEnv(
  owner: UserIdentity | undefined,
  connections: GitHubConnections | undefined,
): Record<string, string> {
  const token = owner && connections?.read(owner)?.token;
  if (!token) return {};
  const config: Array<[string, string]> = [
    ["credential.https://github.com.helper", ""],
    ["credential.https://github.com.helper", GITHUB_CREDENTIAL_HELPER],
    // SSH remotes push over HTTPS so the owner's token, not the server's key, is used.
    ["url.https://github.com/.pushInsteadOf", "git@github.com:"],
    ["url.https://github.com/.pushInsteadOf", "ssh://git@github.com/"],
  ];
  const env: Record<string, string> = {
    GH_TOKEN: token,
    GIT_CONFIG_COUNT: String(config.length),
  };
  config.forEach(([key, value], index) => {
    env[`GIT_CONFIG_KEY_${index}`] = key;
    env[`GIT_CONFIG_VALUE_${index}`] = value;
  });
  return env;
}
