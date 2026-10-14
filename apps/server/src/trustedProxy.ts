import { createPublicKey, verify as verifySignature, type KeyObject } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";

/**
 * Trusted-proxy identity (remote-server POC, docs/remote-server-poc.md).
 *
 * The server runs behind cloudflared + Cloudflare Access on the same VM. Access
 * authenticates the person (GitHub IdP) and cloudflared forwards the request
 * over loopback with a `cf-access-jwt-assertion` header. This module verifies
 * that assertion (RS256 against the team's JWKS) and turns it into the
 * {@link AuthenticatedUser} the rest of the server stamps on data.
 *
 * Everything here is opt-in through `AGENT_DECK_TRUSTED_PROXY=cloudflare`; with
 * the variable unset {@link trustedProxyConfigFromEnv} returns null and no
 * request is touched.
 */

export interface AuthenticatedUser {
  /** Stable identity: the verified email. */
  id: string;
  email: string;
  name?: string;
}

export interface TrustedProxyConfig {
  teamDomain: string;
  aud: string;
  publicOrigin?: string;
  /** Override of `https://<teamDomain>/cdn-cgi/access/certs` (tests, staging). */
  jwksUrl?: string;
}

/** SRV-09: host launchers would spawn on the headless shared server, not on the user's
 * machine, so every launcher entry point refuses with one of these messages. */
export const SHARED_SERVER_REFUSAL = {
  terminal: "Not available on a shared server: use the in-app terminal",
  editor: "Not available on a shared server: open the file from your own machine",
} as const;

export const CF_ACCESS_HEADER = "cf-access-jwt-assertion";
export const CF_ACCESS_COOKIE = "CF_Authorization";

export function trustedProxyConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): TrustedProxyConfig | null {
  if (env.AGENT_DECK_TRUSTED_PROXY !== "cloudflare") return null;
  const teamDomain = env.AGENT_DECK_CF_ACCESS_TEAM_DOMAIN?.trim();
  const aud = env.AGENT_DECK_CF_ACCESS_AUD?.trim();
  if (!teamDomain || !aud) {
    throw new Error(
      "AGENT_DECK_TRUSTED_PROXY=cloudflare requires AGENT_DECK_CF_ACCESS_TEAM_DOMAIN and AGENT_DECK_CF_ACCESS_AUD",
    );
  }
  const publicOrigin = env.AGENT_DECK_PUBLIC_ORIGIN?.trim();
  const jwksUrl = env.AGENT_DECK_CF_ACCESS_JWKS_URL?.trim();
  return {
    teamDomain,
    aud,
    ...(publicOrigin ? { publicOrigin: new URL(publicOrigin).origin } : {}),
    ...(jwksUrl ? { jwksUrl } : {}),
  };
}

/** cloudflared runs on this VM: only a loopback peer can be the trusted proxy. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith("::ffff:") ? address.slice(7) : address;
  return bare === "::1" || /^127(?:\.\d{1,3}){3}$/.test(bare);
}

/** The assertion from the header cloudflared injects, else the Access cookie. */
export function extractAccessToken(headers: IncomingHttpHeaders): string | undefined {
  const header = headers[CF_ACCESS_HEADER];
  const fromHeader = Array.isArray(header) ? header[0] : header;
  if (fromHeader) return fromHeader;
  const cookie = headers.cookie;
  if (!cookie) return undefined;
  for (const part of cookie.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === CF_ACCESS_COOKIE && rest.length > 0) return rest.join("=");
  }
  return undefined;
}

interface Jwk {
  kid?: string;
  kty?: string;
  alg?: string;
  n?: string;
  e?: string;
}

const base64UrlToBuffer = (value: string): Buffer => Buffer.from(value, "base64url");
const decodeJson = (segment: string): Record<string, unknown> => {
  const parsed: unknown = JSON.parse(base64UrlToBuffer(segment).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JWT segment is not an object");
  }
  return parsed as Record<string, unknown>;
};

export class AccessTokenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AccessTokenError";
  }
}

/** Fetches Access' JWKS, caches keys by kid, refreshes on an unknown kid. */
export class CloudflareAccessVerifier {
  private readonly issuer: string;
  private readonly jwksUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private keys = new Map<string, KeyObject>();
  private lastRefresh = 0;
  private refreshing: Promise<void> | undefined;
  /** Bounds how often an unknown kid may trigger a JWKS fetch. */
  static readonly MIN_REFRESH_MS = 30_000;
  /** Tolerated clock difference for iat/nbf. */
  static readonly CLOCK_SKEW_SECONDS = 60;

  constructor(
    private readonly config: TrustedProxyConfig,
    options: { jwksUrl?: string; fetch?: typeof fetch; now?: () => number } = {},
  ) {
    this.issuer = `https://${config.teamDomain}`;
    this.jwksUrl = options.jwksUrl ?? config.jwksUrl ?? `${this.issuer}/cdn-cgi/access/certs`;
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? (() => Date.now());
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    const segments = token.split(".");
    if (segments.length !== 3) throw new AccessTokenError("malformed token");
    const [headerSegment, payloadSegment, signatureSegment] = segments as [string, string, string];
    let header: Record<string, unknown>;
    let payload: Record<string, unknown>;
    try {
      header = decodeJson(headerSegment);
      payload = decodeJson(payloadSegment);
    } catch {
      throw new AccessTokenError("malformed token");
    }
    if (header.alg !== "RS256") throw new AccessTokenError("unsupported alg");
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    if (!kid) throw new AccessTokenError("missing kid");

    const key = await this.keyFor(kid);
    if (!key) throw new AccessTokenError("unknown signing key");
    const signed = Buffer.from(`${headerSegment}.${payloadSegment}`);
    let valid = false;
    try {
      valid = verifySignature("RSA-SHA256", signed, key, base64UrlToBuffer(signatureSegment));
    } catch {
      valid = false;
    }
    if (!valid) throw new AccessTokenError("bad signature");

    const nowSeconds = Math.floor(this.now() / 1000);
    const skew = CloudflareAccessVerifier.CLOCK_SKEW_SECONDS;
    if (payload.iss !== this.issuer) throw new AccessTokenError("bad issuer");
    const aud = payload.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(this.config.aud)) throw new AccessTokenError("bad audience");
    if (typeof payload.exp !== "number" || payload.exp <= nowSeconds) {
      throw new AccessTokenError("expired");
    }
    if (typeof payload.iat !== "number" || payload.iat > nowSeconds + skew) {
      throw new AccessTokenError("bad iat");
    }
    if (typeof payload.nbf === "number" && payload.nbf > nowSeconds + skew) {
      throw new AccessTokenError("not yet valid");
    }
    const email = typeof payload.email === "string" ? payload.email.trim().toLowerCase() : "";
    if (!email) throw new AccessTokenError("missing email");
    const name =
      typeof payload.name === "string" && payload.name.trim() ? payload.name.trim() : undefined;
    return { id: email, email, ...(name ? { name } : {}) };
  }

  private async keyFor(kid: string): Promise<KeyObject | undefined> {
    const cached = this.keys.get(kid);
    if (cached) return cached;
    if (this.now() - this.lastRefresh >= CloudflareAccessVerifier.MIN_REFRESH_MS) {
      await this.refresh();
    }
    return this.keys.get(kid);
  }

  private refresh(): Promise<void> {
    this.refreshing ??= (async () => {
      try {
        const response = await this.fetchImpl(this.jwksUrl);
        if (!response.ok) throw new Error(`JWKS fetch failed (${response.status})`);
        const body = (await response.json()) as { keys?: Jwk[] };
        const next = new Map<string, KeyObject>();
        for (const jwk of body.keys ?? []) {
          if (jwk.kty !== "RSA" || !jwk.kid || !jwk.n || !jwk.e) continue;
          try {
            next.set(jwk.kid, createPublicKey({ key: jwk as never, format: "jwk" }));
          } catch {
            // Skip an unparseable key; the others remain usable.
          }
        }
        this.keys = next;
        this.lastRefresh = this.now();
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }
}

// The authenticated user travels on the raw Node request so the HTTP hook, the
// WebSocket upgrade, and the route handlers share one lookup without a Fastify
// type augmentation.
const requestUsers = new WeakMap<object, AuthenticatedUser>();
export const setRequestUser = (raw: IncomingMessage, user: AuthenticatedUser): void => {
  requestUsers.set(raw, user);
};
export const requestUser = (raw: IncomingMessage): AuthenticatedUser | undefined =>
  requestUsers.get(raw);

/**
 * Authenticate one proxied request: loopback peer + valid assertion. Returns
 * the user, or `null` with the reason when the request must be rejected.
 */
export async function authenticateProxiedRequest(
  verifier: CloudflareAccessVerifier,
  raw: IncomingMessage,
): Promise<{ user: AuthenticatedUser } | { user: null; reason: string }> {
  if (!isLoopbackAddress(raw.socket.remoteAddress)) {
    return { user: null, reason: "request did not arrive through the trusted proxy" };
  }
  const token = extractAccessToken(raw.headers);
  if (!token) return { user: null, reason: "missing Cloudflare Access assertion" };
  try {
    const user = await verifier.verify(token);
    setRequestUser(raw, user);
    return { user };
  } catch (error) {
    return { user: null, reason: error instanceof Error ? error.message : String(error) };
  }
}
