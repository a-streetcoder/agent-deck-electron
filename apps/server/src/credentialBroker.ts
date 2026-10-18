import { execFile } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  type PathLike,
} from "node:fs";
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { SessionMeta, UserIdentity } from "@agent-deck/contracts";
import { redactSecrets, sessionOwner } from "@agent-deck/domain";
import { resolveClaudeCodeExecutable } from "@agent-deck/pi-host";
import type { ModelAuth } from "@earendil-works/pi-ai";
import { ModelRuntime, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { envDefaults } from "./context.ts";
import { isSessionSegment } from "./sandbox.ts";
import { serverLog } from "./serverLog.ts";
import { ensureUserAgentDir } from "./userAgentDirs.ts";

/**
 * The credential broker (ADR 0009, CRB-02; shared-server profile only).
 *
 * Sessions never hold a real credential: a brokered session's models.json
 * points every Pi provider at `http://<ip>:<port>/<sessionId>/<token>/<provider>`
 * with the session's placeholder as its API key, and Claude Code gets the same
 * through ANTHROPIC_BASE_URL and CLAUDE_CODE_OAUTH_TOKEN. Per request the broker
 * picks the sponsor (the running turn's author, then a participant who shared;
 * only a credential in their OWN auth.json counts), swaps the placeholder for
 * the sponsor's real credential in the credential headers and the `key` query
 * parameter (a placeholder anywhere else is refused), and pipes the request and
 * the response through, the response headers masked again. OAuth refresh is
 * pi-ai's own, run by `ModelRuntime.getAuth()`.
 *
 * WebSocket upgrades are refused (426): Pi keeps a Codex socket per session for
 * up to 55 minutes, so the sponsor chosen at the handshake would outlive other
 * participants' turns and a withdrawn share. On the refusal pi-ai keeps the
 * session on SSE, where every request picks its sponsor again.
 *
 * The token is random per launch and lives in memory until the session is
 * forgotten: a token from an earlier server process is dead.
 */

export const BROKER_CLAUDE_CODE = "claude-code";
const DEFAULT_PORT = 4211;
const CLAUDE_UPSTREAM = "https://api.anthropic.com";
const CODEX = "openai-codex";
const CODEX_CLAIM = "https://api.openai.com/auth";
const RUNTIME_TTL_MS = 60_000;
const CLAUDE_MIN_VALIDITY_MS = 5 * 60_000;
const CLAUDE_REFRESH_RETRY_MS = 60_000;
/** The only places a placeholder is swapped (header names, lowercase). */
const CREDENTIAL_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "x-goog-api-key",
  "api-key",
  "chatgpt-account-id",
]);
const CREDENTIAL_QUERY = "key";
/** Request and response headers that belong to one hop, never forwarded. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-connection",
  "proxy-authorization",
  "proxy-authenticate",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
]);

export interface CredentialBrokerDeps {
  dataDir: string;
  /** The operator's shared Pi agent dir: its models.json is every session's base. */
  sharedAgentDir: () => string;
  /** A session's record, live or indexed. */
  session: (sessionId: string) => SessionMeta | undefined;
  /** The author of the session's running turn. */
  latestAuthor: (sessionId: string) => UserIdentity | undefined;
  /** A user's own Pi agent dir (the operator's is the shared one). */
  agentDirOf: (user: UserIdentity) => string;
  /** The operator may also sponsor a key configured in the shared models.json. */
  isOperator: (user: UserIdentity) => boolean;
  /** A user's Claude Code config dir. */
  claudeConfigDirOf: (user: UserIdentity) => string;
  /** Default: AGENT_DECK_BROKER_HOST, else the first non-internal IPv4. */
  host?: string;
  /** Default: AGENT_DECK_BROKER_PORT, else 4211. */
  port?: number;
  /** Test seam: where Claude Code's requests go. */
  claudeUpstream?: string;
}

interface Target {
  meta: SessionMeta;
  token: string;
  providerId: string;
  /** The path after the provider segment, with its query. */
  rest: string;
}

interface Sponsor {
  user: UserIdentity;
  author: UserIdentity | undefined;
  auth: ModelAuth;
  upstream: string;
}

/**
 * The session's placeholder, JWT-shaped: pi-ai's Codex API reads the account
 * id from the token's own claim (`extractAccountId`), so part 2 carries a
 * placeholder claim the broker swaps as well. Standard base64, unpadded:
 * pi-ai decodes it with `atob`, which refuses base64url's `-` and `_`.
 */
export function sessionPlaceholder(token: string): { key: string; account: string } {
  const account = `ph-acct-${token}`;
  const claim = Buffer.from(JSON.stringify({ [CODEX_CLAIM]: { chatgpt_account_id: account } }))
    .toString("base64")
    .replace(/=+$/, "");
  return { key: `ph.${claim}.${token}`, account };
}

/** The `chatgpt_account_id` claim of a real Codex access token (pi-ai does not export its reader). */
function accountIdOf(token: string): string | undefined {
  try {
    const part = token.split(".")[1] ?? "";
    const payload = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as Record<
      string,
      { chatgpt_account_id?: unknown } | undefined
    >;
    const id = payload[CODEX_CLAIM]?.chatgpt_account_id;
    return typeof id === "string" && id ? id : undefined;
  } catch {
    return undefined;
  }
}

type ModelsJson = { providers?: Record<string, Record<string, unknown>> } & Record<string, unknown>;

/** Neither a per-model baseUrl (it would bypass the broker) nor headers (they may carry keys). */
const withoutRouting = (value: unknown): unknown => {
  if (!value || typeof value !== "object") return value;
  const { baseUrl: _baseUrl, headers: _headers, ...rest } = value as Record<string, unknown>;
  return rest;
};

/**
 * The session's models.json: the operator's, with every provider pointed at
 * the broker and given the placeholder as its key. Per-model baseUrls and all
 * configured headers are dropped: the broker adds the sponsor runtime's
 * resolved headers server-side (the runbook documents the baseUrl limitation).
 */
export function sessionModels(
  shared: ModelsJson,
  providerIds: readonly string[],
  base: string,
  placeholder: string,
): ModelsJson {
  const providers: Record<string, Record<string, unknown>> = { ...(shared.providers ?? {}) };
  const brokered = new Set(providerIds);
  for (const id of new Set([...providerIds, ...Object.keys(providers)])) {
    const {
      models,
      modelOverrides,
      headers: _headers,
      apiKey: _apiKey,
      ...rest
    } = providers[id] ?? {};
    // A provider nobody in the session can sponsor keeps its shape minus every
    // credential: Pi then lists it as not signed in and fetches nothing for it
    // (a placeholder on all 42 built-ins made Pi probe openrouter and radius.pi.dev).
    if (!brokered.has(id)) {
      const stripped = {
        ...rest,
        ...(Array.isArray(models) ? { models: models.map(withoutRouting) } : {}),
      };
      if (Object.keys(stripped).length === 0) delete providers[id];
      else providers[id] = stripped;
      continue;
    }
    providers[id] = {
      ...rest,
      ...(Array.isArray(models) ? { models: models.map(withoutRouting) } : {}),
      ...(modelOverrides && typeof modelOverrides === "object"
        ? {
            modelOverrides: Object.fromEntries(
              Object.entries(modelOverrides).map(([model, value]) => [
                model,
                withoutRouting(value),
              ]),
            ),
          }
        : {}),
      baseUrl: `${base}/${id}`,
      apiKey: placeholder,
    };
  }
  return { ...shared, providers };
}

function readJson(file: PathLike): unknown {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** The container's address: the first non-internal IPv4 (loopback when none). */
function containerAddress(): string {
  for (const entries of Object.values(os.networkInterfaces())) {
    const ipv4 = entries?.find((entry) => entry.family === "IPv4" && !entry.internal);
    if (ipv4) return ipv4.address;
  }
  return "127.0.0.1";
}

/** A malformed auth.json error quotes text around the bad token: log the name only. */
const errorName = (error: unknown): string => (error instanceof Error ? error.name : typeof error);
/** Name and redacted, truncated message, cause included: a malformed auth.json
 * error quotes text around the bad token, so the message never goes out raw. */
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  const text = (e: Error) =>
    `${e.name}: ${redactSecrets(e.message)
      .replace(/[A-Za-z0-9_.-]{20,}/g, "<redacted>")
      .slice(0, 160)}`;
  const cause = error.cause instanceof Error ? ` <- ${text(error.cause)}` : "";
  return `${text(error)}${cause}`;
}

/** The hop-by-hop names, plus those a `connection` header lists. */
function hopByHop(connection: string | string[] | undefined): Set<string> {
  const names = new Set(HOP_BY_HOP);
  for (const value of [connection ?? []].flat()) {
    for (const name of value.split(",")) if (name.trim()) names.add(name.trim().toLowerCase());
  }
  return names;
}

const replaceAll = (value: string, from: string, to: string): string =>
  from ? value.split(from).join(to) : value;

function readClaudeOAuth(dir: string): { accessToken: string; expiresAt: number } | undefined {
  const parsed = readJson(path.join(dir, ".credentials.json")) as
    | { claudeAiOauth?: { accessToken?: unknown; expiresAt?: unknown } }
    | undefined;
  const oauth = parsed?.claudeAiOauth;
  return typeof oauth?.accessToken === "string" && typeof oauth.expiresAt === "number"
    ? { accessToken: oauth.accessToken, expiresAt: oauth.expiresAt }
    : undefined;
}

export class CredentialBroker {
  /** `<ip>:<port>` once listening: the session sandbox's allow literal. */
  address = "";
  private server?: http.Server;
  private catalog?: { at: number; runtime: ModelRuntime };
  private catalogBuilding = false;
  private readonly tokens = new Map<string, string>();
  /** CRB-03: one-shot helpers, which have no session record, by id. */
  private readonly transients = new Map<string, SessionMeta>();
  private readonly runtimes = new Map<string, { at: number; runtime: Promise<ModelRuntime> }>();
  private readonly claudeRefreshes = new Map<string, { at: number; done: Promise<void> }>();

  constructor(private readonly deps: CredentialBrokerDeps) {}

  /** Doctor (CRB-03): the HTTP server is up. */
  get listening(): boolean {
    return this.server?.listening ?? false;
  }

  /** Builds the provider catalog (a failure is logged, launches then refuse)
   * and listens; throws only when it cannot listen. */
  async start(): Promise<void> {
    await this.buildCatalog();
    const host =
      this.deps.host ?? (process.env.AGENT_DECK_BROKER_HOST?.trim() || containerAddress());
    const port = this.deps.port ?? Number(process.env.AGENT_DECK_BROKER_PORT ?? DEFAULT_PORT);
    const server = http.createServer((request, response) => {
      this.forward(request, response).catch((error: unknown) => {
        serverLog.warn("broker", `request failed (${errorName(error)})`);
        if (!response.headersSent) response.writeHead(502).end();
        else response.destroy();
      });
    });
    server.on("upgrade", (_request: IncomingMessage, socket: Duplex) => {
      socket.on("error", () => socket.destroy());
      socket.end(
        "HTTP/1.1 426 Upgrade Required\r\nconnection: close\r\ncontent-length: 0\r\n\r\n",
        () => socket.destroy(),
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.address = `${host}:${(server.address() as AddressInfo).port}`;
    serverLog.info("broker", `listening on ${this.address}`);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** The session's token: issued at its first launch, kept while it lives. */
  register(sessionId: string): string {
    let token = this.tokens.get(sessionId);
    if (!token) {
      token = randomBytes(32).toString("hex");
      this.tokens.set(sessionId, token);
    }
    return token;
  }

  /** CRB-03: a one-shot helper's record (`helper-<uuid>`, its requester as
   * owner and so as sponsor) until `forget(meta.id)`. */
  registerTransient(meta: SessionMeta): void {
    this.transients.set(meta.id, meta);
  }

  /** The session (or helper) is gone: its token stops working. */
  forget(sessionId: string): void {
    this.tokens.delete(sessionId);
    this.transients.delete(sessionId);
  }

  /**
   * The env of a brokered launch of `meta`: its own agent dir
   * `<dataDir>/sandbox/<sessionId>/agent` (an `{}` auth.json, the shared
   * links, a generated models.json), Claude Code at the broker with the
   * placeholder and its own config dir, and an empty NO_PROXY (CRB-01 finding
   * 2). Under srt the policy's `noProxy`, set in front of the command, is the
   * one that counts: srt's own NO_PROXY would override this one (CRB-03).
   */
  launchEnv(meta: SessionMeta, sandboxed = false): Record<string, string> {
    if (!this.address) throw new Error("credential broker not listening");
    if (!isSessionSegment(meta.id)) {
      throw new Error(`[broker] session id ${meta.id} is not a segment`);
    }
    const providerIds = this.sponsorableProviders(meta);
    const root = path.join(this.deps.dataDir, "sandbox", meta.id);
    const agentDir = path.join(root, "agent");
    const shared = this.deps.sharedAgentDir();
    for (const entry of ensureUserAgentDir(shared, agentDir, sandboxed, {
      except: ["models.json"],
    })) {
      serverLog.warn(
        "sandbox",
        `${entry.path} was not the link to the shared entry; moved to ${entry.movedTo} and linked again`,
      );
    }
    const token = this.register(meta.id);
    const base = `http://${this.address}/${meta.id}/${token}`;
    const { key } = sessionPlaceholder(token);
    const models = sessionModels(
      (readJson(path.join(shared, "models.json")) as ModelsJson | undefined) ?? {},
      providerIds,
      base,
      key,
    );
    // Removed, then created exclusively: a link planted in the session's
    // scratch folder is never followed (a planted one fails the launch).
    const modelsFile = path.join(agentDir, "models.json");
    rmSync(modelsFile, { force: true });
    writeFileSync(modelsFile, `${JSON.stringify(models, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    const claudeDir = path.join(root, "claude");
    mkdirSync(claudeDir, { recursive: true, mode: 0o700 });
    return {
      PI_CODING_AGENT_DIR: agentDir,
      ANTHROPIC_BASE_URL: `${base}/${BROKER_CLAUDE_CODE}`,
      CLAUDE_CODE_OAUTH_TOKEN: key,
      CLAUDE_CONFIG_DIR: claudeDir,
      NO_PROXY: "",
      no_proxy: "",
    };
  }

  private async buildCatalog(): Promise<void> {
    if (this.catalogBuilding) return;
    this.catalogBuilding = true;
    try {
      this.catalog = {
        at: Date.now(),
        runtime: await this.createRuntime(this.deps.sharedAgentDir()),
      };
    } catch (error) {
      serverLog.warn("broker", `could not build the provider catalog (${errorName(error)})`);
    } finally {
      this.catalogBuilding = false;
    }
  }

  /**
   * The providers the session's participants (owner and sharers) can sponsor
   * today: those with a credential in their own auth.json, plus, for the
   * operator, keys configured in the shared models.json. Only these point at
   * the broker; the rest stay unsigned-in in the session (sessionModels).
   */
  private sponsorableProviders(meta: SessionMeta): string[] {
    const all = this.providerIds();
    const owner = sessionOwner(meta);
    const candidates: UserIdentity[] = [
      ...(owner ? [owner] : []),
      ...Object.keys(meta.shares ?? {}).map((id) => ({ id })),
    ];
    const ids = new Set<string>();
    for (const user of candidates) {
      const authPath = path.join(this.deps.agentDirOf(user), "auth.json");
      for (const id of all) {
        const stored = readStoredCredential(id, authPath);
        if (stored?.type === "oauth" || (stored?.type === "api_key" && stored.key)) ids.add(id);
      }
      if (this.deps.isOperator(user)) {
        for (const id of all) {
          const source = this.catalog?.runtime.getProviderAuthStatus(id).source;
          if (source === "models_json_key" || source === "models_json_command") ids.add(id);
        }
      }
    }
    return [...ids];
  }

  /** The operator catalog's provider ids; rebuilt in the background once a minute. */
  private providerIds(): string[] {
    if (!this.catalog || Date.now() - this.catalog.at > RUNTIME_TTL_MS) void this.buildCatalog();
    if (!this.catalog) throw new Error("credential broker has no provider catalog");
    return this.catalog.runtime.getProviders().map((provider) => provider.id);
  }

  private createRuntime(agentDir: string): Promise<ModelRuntime> {
    return ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(this.deps.sharedAgentDir(), "models.json"),
      allowModelNetwork: false,
    });
  }

  /** A user's runtime over their own credentials, cached a minute. */
  private runtimeOf(user: UserIdentity, agentDir: string): Promise<ModelRuntime> {
    const cached = this.runtimes.get(user.id);
    if (cached && Date.now() - cached.at < RUNTIME_TTL_MS) return cached.runtime;
    const runtime = this.createRuntime(agentDir);
    const entry = { at: Date.now(), runtime };
    this.runtimes.set(user.id, entry);
    runtime.catch(() => {
      if (this.runtimes.get(user.id) === entry) this.runtimes.delete(user.id);
    });
    return runtime;
  }

  private route(url: string | undefined): Target | undefined {
    // A proxy may forward the absolute form; only the path and query matter.
    const parsed = new URL(url ?? "/", "http://broker.invalid");
    const [, sessionId, token, providerId] = parsed.pathname.split("/");
    if (!sessionId || !token || !providerId) return undefined;
    const expected = this.tokens.get(sessionId);
    if (!expected) return undefined;
    const given = Buffer.from(token);
    const wanted = Buffer.from(expected);
    if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return undefined;
    const meta = this.transients.get(sessionId) ?? this.deps.session(sessionId);
    if (!meta) return undefined;
    // From the raw URL: URL.search would re-encode a `+` in the placeholder.
    const raw = url ?? "/";
    const query = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
    const prefix = `/${sessionId}/${token}/${providerId}`.length;
    return { meta, token, providerId, rest: parsed.pathname.slice(prefix) + query };
  }

  /** The running turn's author first (their own subscription), then whoever shared into the session. */
  private async sponsor(
    target: Target,
  ): Promise<Sponsor | { error: string; author: UserIdentity | undefined }> {
    const { meta, providerId } = target;
    const author = this.deps.latestAuthor(meta.id) ?? sessionOwner(meta);
    const ids = [...(author ? [author.id] : []), ...Object.keys(meta.shares ?? {})];
    let expired = false;
    for (const id of new Set(ids)) {
      const user = id === author?.id ? author : { id };
      try {
        if (providerId === BROKER_CLAUDE_CODE) {
          const claude = await this.claudeToken(user);
          if (claude.token) {
            const upstream = this.deps.claudeUpstream ?? CLAUDE_UPSTREAM;
            return { user, author, auth: { apiKey: claude.token }, upstream };
          }
          expired ||= !!claude.expired;
          continue;
        }
        // Only the candidate's OWN credential counts: pi-ai also falls back to
        // the server's env and ambient files, which are nobody's subscription.
        const agentDir = this.deps.agentDirOf(user);
        const stored = readStoredCredential(providerId, path.join(agentDir, "auth.json"));
        const own = stored?.type === "oauth" || (stored?.type === "api_key" && !!stored.key);
        const operator = this.deps.isOperator(user);
        if (!own && !operator) continue;
        const runtime = await this.runtimeOf(user, agentDir);
        // The operator may also sponsor a key configured in the shared
        // models.json (a literal or a command, not a `${ENV}` reference).
        // pi-ai reports such a key of a built-in provider as a "stored
        // credential", so the provider's auth status says where it is from.
        if (!own) {
          const source = runtime.getProviderAuthStatus(providerId).source;
          if (source !== "models_json_key" && source !== "models_json_command") continue;
        }
        const result = await runtime.getAuth(providerId);
        if (!result) continue;
        const upstream =
          result.auth.baseUrl ??
          runtime.getProvider(providerId)?.baseUrl ??
          runtime.getModels(providerId)[0]?.baseUrl;
        if (upstream) return { user, author, auth: result.auth, upstream };
      } catch (error) {
        serverLog.warn(
          "broker",
          `${providerId}: a candidate sponsor's credentials failed (${describeError(error)})`,
        );
      }
    }
    return {
      author,
      error: expired
        ? "A participant's Claude Code sign-in has expired; they need to sign in again"
        : `${providerId} needs a subscription: sign in under Settings > Providers, or ask a participant to share theirs`,
    };
  }

  /**
   * The Claude Code access token of `user`. Within five minutes of its expiry
   * `claude auth status` runs once with that config dir (whether it refreshes
   * is SUB-05's to settle) and the file is read again.
   */
  private async claudeToken(user: UserIdentity): Promise<{ token?: string; expired?: boolean }> {
    const dir = this.deps.claudeConfigDirOf(user);
    let oauth = readClaudeOAuth(dir);
    if (!oauth) return {};
    if (oauth.expiresAt - Date.now() < CLAUDE_MIN_VALIDITY_MS) {
      await this.claudeStatus(dir);
      oauth = readClaudeOAuth(dir) ?? oauth;
    }
    return oauth.expiresAt > Date.now() ? { token: oauth.accessToken } : { expired: true };
  }

  /** `claude auth status --json` under `dir`, at most once a minute per dir. */
  private claudeStatus(dir: string): Promise<void> {
    const last = this.claudeRefreshes.get(dir);
    if (last && Date.now() - last.at < CLAUDE_REFRESH_RETRY_MS) return last.done;
    const env = { ...process.env, ...envDefaults().env, CLAUDE_CONFIG_DIR: dir };
    const claude = resolveClaudeCodeExecutable(env);
    const done = claude
      ? new Promise<void>((resolve) => {
          execFile(claude, ["auth", "status", "--json"], { env, timeout: 15_000 }, () => resolve());
        })
      : Promise.resolve();
    this.claudeRefreshes.set(dir, { at: Date.now(), done });
    return done;
  }

  /**
   * The upstream URL and headers: placeholders swapped in the credential
   * headers and the `key` parameter only, the sponsor's headers on top, the
   * hop-by-hop ones dropped. Undefined: a placeholder sits anywhere else.
   * `mask` puts the placeholders back into a response header value.
   */
  private outgoing(
    incoming: IncomingHttpHeaders,
    target: Target,
    sponsor: Sponsor,
  ): { url: URL; headers: OutgoingHttpHeaders; mask: (value: string) => string } | undefined {
    const { key, account } = sessionPlaceholder(target.token);
    const encodedKey = encodeURIComponent(key);
    const real = sponsor.auth.apiKey ?? "";
    const realAccount = accountIdOf(real) ?? "";
    const carries = (value: string): boolean =>
      value.includes(key) || value.includes(encodedKey) || value.includes(account);
    const expand = (value: string): string =>
      realAccount
        ? replaceAll(replaceAll(value, key, real), account, realAccount)
        : replaceAll(value, key, real);
    // Response headers: every secret the sponsor's auth injected goes back
    // as the placeholder, header-borne credentials (Copilot) included.
    const secrets = [
      real,
      realAccount,
      ...Object.values(sponsor.auth.headers ?? {}).filter(
        (value): value is string => typeof value === "string",
      ),
    ].filter((secret) => secret.length >= 8);
    const mask = (value: string): string =>
      secrets.reduce(
        (masked, secret) => replaceAll(masked, secret, secret === realAccount ? account : key),
        value,
      );

    const queryAt = target.rest.indexOf("?");
    const pathname = queryAt === -1 ? target.rest : target.rest.slice(0, queryAt);
    const params = queryAt === -1 ? [] : target.rest.slice(queryAt + 1).split("&");
    const query: string[] = [];
    for (const param of params) {
      const name = param.split("=", 1)[0];
      if (name === CREDENTIAL_QUERY) {
        const encodedReal = encodeURIComponent(real);
        query.push(replaceAll(replaceAll(param, encodedKey, encodedReal), key, encodedReal));
      } else if (carries(decodeURIComponentSafe(param)) || carries(param)) {
        return undefined;
      } else query.push(param);
    }
    const url = new URL(
      `${sponsor.upstream.replace(/\/+$/, "")}${pathname}${params.length > 0 ? `?${query.join("&")}` : ""}`,
    );

    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(incoming)) {
      if (value === undefined) continue;
      if (CREDENTIAL_HEADERS.has(name)) {
        headers[name] = Array.isArray(value) ? value.map(expand) : expand(value);
      } else if ([value].flat().some(carries)) {
        return undefined;
      } else headers[name] = value;
    }
    for (const [name, value] of Object.entries(sponsor.auth.headers ?? {})) {
      if (value === null) delete headers[name.toLowerCase()];
      else headers[name.toLowerCase()] = value;
    }
    // Nominations from the client AND from the sponsor's configured headers.
    const nominated = hopByHop(
      [incoming.connection ?? [], headers.connection ?? []].flat() as string[],
    );
    for (const name of nominated) delete headers[name];
    headers.host = url.host;
    return { url, headers, mask };
  }

  /** One line per upstream request or refusal: who paid and who asked, never a credential. */
  private spent(
    target: Target,
    method: string,
    status: number,
    started: number,
    sponsor: UserIdentity | undefined,
    author: UserIdentity | undefined,
  ): void {
    const ms = Date.now() - started;
    const line = {
      at: new Date().toISOString(),
      sessionId: target.meta.id,
      provider: target.providerId,
      ...(sponsor ? { sponsor: sponsor.id } : {}),
      ...(author ? { author: author.id } : {}),
      status,
      ms,
    };
    try {
      appendFileSync(
        path.join(this.deps.dataDir, "credential-spend.jsonl"),
        `${JSON.stringify(line)}\n`,
        { mode: 0o600 },
      );
    } catch (error) {
      serverLog.warn("broker", "could not append to credential-spend.jsonl", error);
    }
    serverLog.info("broker", `${target.providerId} ${method} ${status} ${ms}ms`);
  }

  private async forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const started = Date.now();
    const method = request.method ?? "GET";
    const target = this.route(request.url);
    if (!target) {
      response.writeHead(404).end();
      return;
    }
    const refuse = (error: string, author: UserIdentity | undefined): void => {
      this.spent(target, method, 401, started, undefined, author);
      response
        .writeHead(401, { "content-type": "application/json" })
        .end(JSON.stringify({ error }));
    };
    const sponsor = await this.sponsor(target);
    if ("error" in sponsor) return refuse(sponsor.error, sponsor.author);
    if (target.providerId === CODEX && !accountIdOf(sponsor.auth.apiKey ?? "")) {
      return refuse(`${CODEX}: the sign-in carries no account id; sign in again`, sponsor.author);
    }
    const outgoing = this.outgoing(request.headers, target, sponsor);
    if (!outgoing) {
      response.writeHead(400).end();
      return;
    }
    const { url, headers, mask } = outgoing;
    const upstream = (url.protocol === "https:" ? https : http).request(
      url,
      { method, headers },
      (reply) => {
        reply.on("error", () => response.destroy());
        reply.on("aborted", () => response.destroy());
        const drop = hopByHop(reply.headers.connection);
        const replyHeaders: Record<string, string | string[]> = {};
        for (const [name, value] of Object.entries(reply.headers)) {
          if (value === undefined || drop.has(name)) continue;
          // An upstream echoing a header must not hand the credential back.
          replyHeaders[name] = Array.isArray(value) ? value.map(mask) : mask(value);
        }
        response.writeHead(reply.statusCode ?? 502, reply.statusMessage, replyHeaders);
        reply.pipe(response);
      },
    );
    upstream.on("error", (error) => {
      serverLog.warn("broker", `${target.providerId} upstream failed (${errorName(error)})`);
      if (!response.headersSent) response.writeHead(502).end();
      else response.destroy();
    });
    // The client went away mid-body.
    request.on("close", () => {
      if (!request.complete) upstream.destroy();
    });
    response.on("close", () => {
      if (!response.writableFinished) upstream.destroy();
      // 499: the client went away before an answer.
      const status = response.headersSent ? response.statusCode : 499;
      this.spent(target, method, status, started, sponsor.user, sponsor.author);
    });
    request.pipe(upstream);
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value.replace(/\+/g, " "));
  } catch {
    return value;
  }
}
