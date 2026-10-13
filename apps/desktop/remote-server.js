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
