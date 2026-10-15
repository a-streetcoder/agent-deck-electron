/**
 * Remote-server POC (docs/remote-server-poc.md): the desktop shell attaches to an
 * Agent Deck server published through Cloudflare Access instead of spawning one.
 *
 * Pure helpers so main.js stays thin and the policy is unit-testable:
 *  - which env value counts as a remote server origin;
 *  - where the main window may navigate while attached to it (the Access login
 *    round-trip goes through the team domain and GitHub before coming back).
 */
import { Buffer } from "node:buffer";
import path from "node:path";

/**
 * The remote control-plane origin from `AGENT_DECK_REMOTE_SERVER_URL`, or null
 * when unset. Only https is accepted: the Access cookie must never travel in
 * clear, and the loopback case already has AGENT_DECK_SERVER_URL.
 */
export function remoteServerOrigin(raw, variable = "AGENT_DECK_REMOTE_SERVER_URL") {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be an absolute https URL`);
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error(`${variable} must be an https URL without credentials`);
  }
  return url.origin;
}

/**
 * May the main window navigate to `url` while attached to `controlPlaneOrigin`?
 * The app itself, the Cloudflare Access team domain (login/consent pages) and
 * GitHub (the identity provider) are the whole round-trip; anything else opens
 * in the system browser instead.
 */
export function allowRemoteShellNavigation(url, controlPlaneOrigin, teamDomain) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.origin === controlPlaneOrigin) return true;
  if (parsed.protocol !== "https:") return false;
  const host = parsed.hostname.toLowerCase();
  if (teamDomain && host === teamDomain.toLowerCase()) return true;
  if (!teamDomain && host.endsWith(".cloudflareaccess.com")) return true;
  return host === "github.com" || host === "www.github.com";
}

/**
 * ade-q0pz: the headers to send for `url`: `cf-access-token` set only for
 * https/wss requests to the Access `host`, and removed (in any case) from every
 * other request, so a redirect to another host never carries the token.
 */
export function accessTokenHeaders(url, requestHeaders, host, accessToken) {
  const headers = { ...requestHeaders };
  for (const name of Object.keys(headers)) {
    if (name.toLowerCase() === "cf-access-token") delete headers[name];
  }
  let parsed = null;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL: no token.
  }
  if (parsed?.host === host && (parsed.protocol === "https:" || parsed.protocol === "wss:")) {
    headers["cf-access-token"] = accessToken;
  }
  return headers;
}

/**
 * Run `check(timeoutMs)` up to `attempts` times, one `slotMs` window each: a
 * fast failure (a 502 while the server restarts) waits out the rest of its
 * window, so attempt N starts at (N-1) x slotMs. The default 7 attempts put
 * the last check at 30 s, so a server healthy within 30 s is accepted even
 * when every earlier attempt failed instantly. Rejects with the last error.
 */
export async function retryInSlots(
  check,
  {
    attempts = 7,
    slotMs = 5_000,
    now = Date.now,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  for (let attempt = 1; ; attempt += 1) {
    const started = now();
    try {
      return await check(slotMs);
    } catch (error) {
      if (attempt >= attempts) throw error;
      await sleep(Math.max(0, slotMs - (now() - started)));
    }
  }
}

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
 * State behind the sign-in page's one IPC channel (ade-zvv5). `handle("start")`
 * runs `login(signal)` once at a time (a second click joins the running one),
 * hands the token to `attach` and answers `{ ok: true }`; a failure or
 * `handle("cancel")` answers `{ ok: false, error }` with readable text so the
 * page can offer a retry. The token itself never leaves main.
 */
export function createRemoteSignIn({ login, attach }) {
  let running = null;
  let controller = null;
  let done = false;
  return function handle(action) {
    if (action === "cancel") {
      controller?.abort();
      return Promise.resolve({ ok: true });
    }
    if (action !== "start") return Promise.resolve({ ok: false, error: "Unknown action." });
    if (done) return Promise.resolve({ ok: true });
    if (running) return running;
    controller = new AbortController();
    const { signal } = controller;
    running = login(signal)
      .then((token) => {
        // A cancel that lands after login resolved must still win (REV-01).
        if (signal.aborted) throw new Error("Sign-in cancelled.");
        attach(token);
        done = true;
        return { ok: true };
      })
      .catch((error) => ({ ok: false, error: signInErrorText(error, signal.aborted) }))
      .finally(() => {
        running = null;
        controller = null;
      });
    return running;
  };
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

/**
 * Did the main frame land on the app itself? True only for a page on the
 * control-plane origin, so the Access login pages (team domain, GitHub) that
 * precede it never count as "the app loaded".
 */
export function isControlPlanePage(url, controlPlaneOrigin) {
  try {
    return new URL(url).origin === controlPlaneOrigin;
  } catch {
    return false;
  }
}
