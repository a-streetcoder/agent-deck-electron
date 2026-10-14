/**
 * Remote-server POC (docs/remote-server-poc.md): the desktop shell attaches to an
 * Agent Deck server published through Cloudflare Access instead of spawning one.
 *
 * Pure helpers so main.js stays thin and the policy is unit-testable:
 *  - which env value counts as a remote server origin;
 *  - where the main window may navigate while attached to it (the Access login
 *    round-trip goes through the team domain and GitHub before coming back).
 */

/**
 * The remote control-plane origin from `AGENT_DECK_REMOTE_SERVER_URL`, or null
 * when unset. Only https is accepted: the Access cookie must never travel in
 * clear, and the loopback case already has AGENT_DECK_SERVER_URL.
 */
export function remoteServerOrigin(raw) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AGENT_DECK_REMOTE_SERVER_URL must be an absolute https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("AGENT_DECK_REMOTE_SERVER_URL must be an https URL without credentials");
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
