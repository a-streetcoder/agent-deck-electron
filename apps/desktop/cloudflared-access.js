/**
 * Cloudflare Access through cloudflared for the team server client
 * (shared-server.js) and the Settings sign-in: token read and browser login,
 * logout, the token's team and audience for pinning, cached token files, and
 * readable error text. The token is a credential: it never leaves main.
 */
import { Buffer } from "node:buffer";
import path from "node:path";

/**
 * Per-user Cloudflare Access token through cloudflared's non-browser flow
 * (ade-1vjx): `access token` prints the cached token, or fails when there is
 * none or it expired. `run(args, timeoutMs, signal)` resolves stdout or
 * rejects. The token is a credential: never log it or hand it to a page.
 */
export async function cloudflaredToken(run, origin, signal) {
  const value = (await run(["access", "token", `-app=${origin}`], 15_000, signal)).trim();
  if (!/^[\w-]+\.[\w-]+\.[\w-]+$/.test(value)) {
    throw new Error("cloudflared access token did not print a token");
  }
  return value;
}

/**
 * `access login` opens the SYSTEM browser (where passkeys work) and caches a
 * fresh token, then reads it back. `signal` aborts the waiting login.
 */
export async function cloudflaredLogin(run, origin, signal) {
  await run(["access", "login", origin], 300_000, signal);
  return cloudflaredToken(run, origin, signal);
}

/**
 * SRV-16b: `access logout` for `origin` when this cloudflared has it (2025.8.1
 * does not: its `access --help` lists no logout). Answers whether it ran; the
 * caller treats any failure as best effort.
 */
export async function cloudflaredLogout(run, origin) {
  const help = String(await run(["access", "--help"], 15_000));
  if (!/^\s*logout\b/m.test(help)) return false;
  await run(["access", "logout", origin], 15_000);
  return true;
}

/**
 * SRV-16b: the Cloudflare Access team that issued `token`: the host of its
 * `iss` claim (`https://<team>.cloudflareaccess.com`), lowercased, or null.
 * Read only, never verified: it names the team for pinning, the edge and the
 * server do the verification.
 */
export function accessTokenTeam(token) {
  try {
    const { protocol, hostname } = new URL(tokenPayload(token).iss);
    return protocol === "https:" && hostname ? hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** SRV-16b: the Access application audience (`aud`, its first entry) of `token`, or null. */
export function accessTokenAudience(token) {
  try {
    const { aud } = tokenPayload(token);
    const first = Array.isArray(aud) ? aud[0] : aud;
    return typeof first === "string" && first ? first : null;
  } catch {
    return null;
  }
}

const tokenPayload = (token) =>
  JSON.parse(Buffer.from(String(token).split(".")[1], "base64url").toString());

/**
 * SRV-16b: the files in cloudflared's token folder that cache `host`'s
 * application token: `<host>-<aud>-token` (and its `.lock`), where the AUD tag
 * is hex, so another host whose name starts with `host-` never matches. The
 * team's org token (`<team>-org-token`) is not among them.
 */
export function cachedTokenFiles(names, host) {
  const escaped = host.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`^${escaped}-[0-9a-f]{32,128}-token(?:\\.lock)?$`);
  return names.filter((name) => pattern.test(name.toLowerCase()));
}

/** Delete `host`'s cached application token files in `dir`; answers how many. */
export function forgetCachedTokens({ dir, host, fs }) {
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  const files = cachedTokenFiles(names, host);
  for (const name of files) fs.rmSync(path.join(dir, name), { force: true });
  return files.length;
}

/**
 * Readable text for a failed login: cancel and timeout get their own words,
 * otherwise the last line cloudflared wrote to stderr (stdout, which carries
 * the token, is never used), capped so a page stays a page.
 */
export function signInErrorText(error, aborted = false) {
  if (aborted) return "Sign-in cancelled.";
  if (error?.killed) return "Timed out waiting for the browser approval.";
  const lines = String(error?.stderr ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const text = lines.at(-1) || error?.message || String(error);
  return text.length > 300 ? `${text.slice(0, 300)}...` : text;
}
