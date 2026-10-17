/**
 * The address the CLI entry binds (`AGENT_DECK_HOST`, default loopback).
 *
 * Only loopback or wildcard values: the container HEALTHCHECK and local tooling
 * reach the server on 127.0.0.1, which a specific non-loopback address would
 * not answer (the Pi tool bridge rides on Pi's stdio, ADR 0007). A wildcard exposes the server beyond loopback, so it needs
 * `AGENT_DECK_TRUSTED_PROXY=cloudflare` (every request authenticated) or the
 * explicit opt-out `AGENT_DECK_ALLOW_UNAUTHENTICATED_HOST=1` (local smoke tests).
 * A set `AGENT_DECK_TRUSTED_PROXY` other than exactly `cloudflare` (a typo)
 * is refused: it would silently turn authentication off. Empty is local mode.
 * `::1` and `localhost` become 127.0.0.1: either can bind IPv6 only, which the
 * IPv4 HEALTHCHECK would not reach. `::` stays: Node listens on it
 * dual-stack (ipv6Only defaults to false), so 127.0.0.1 still answers.
 */
const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);
const WILDCARD = new Set(["0.0.0.0", "::"]);

export function resolveBindHost(env: NodeJS.ProcessEnv): { host: string | undefined } {
  const proxy = env.AGENT_DECK_TRUSTED_PROXY;
  if (proxy !== undefined && proxy !== "" && proxy !== "cloudflare") {
    throw new Error(
      `AGENT_DECK_TRUSTED_PROXY is "${proxy}", not "cloudflare": refusing to start without authentication. Use exactly "cloudflare", or leave it empty for local mode.`,
    );
  }
  const host = env.AGENT_DECK_HOST?.trim() || undefined;
  if (!host) return { host };
  if (LOOPBACK.has(host)) return { host: "127.0.0.1" };
  if (!WILDCARD.has(host)) {
    throw new Error(
      `AGENT_DECK_HOST="${host}" is not supported: use a loopback address or 0.0.0.0 / :: (the server must answer on 127.0.0.1).`,
    );
  }
  if (proxy !== "cloudflare" && env.AGENT_DECK_ALLOW_UNAUTHENTICATED_HOST !== "1") {
    throw new Error(
      `AGENT_DECK_HOST="${host}" exposes an unauthenticated server: set AGENT_DECK_TRUSTED_PROXY=cloudflare, or AGENT_DECK_ALLOW_UNAUTHENTICATED_HOST=1 for a local smoke test.`,
    );
  }
  return { host };
}
