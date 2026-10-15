/**
 * SRV-16d: what the main window may load. The renderer is always this app's
 * own loopback backend or the Vite dev server, so no remote page can become the
 * origin the IPC sender checks trust.
 */

/**
 * `raw` as a loopback HTTP URL with an explicit port (1-65535), or a throw
 * naming `variable`. Used for AGENT_DECK_SERVER_URL and AGENT_DECK_RENDERER_URL.
 */
export function loopbackHttpUrl(raw, variable) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${variable} must be a loopback HTTP URL with an explicit port`);
  }
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") ||
    !url.port
  ) {
    throw new Error(`${variable} must be a loopback HTTP URL with an explicit port`);
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${variable} contains an invalid port`);
  }
  return url;
}

/**
 * The main window's answer to a navigation or redirect to `url`: "allow" on the
 * renderer origin, "external" (hand to the system browser) for any other
 * http(s) URL, "deny" for everything else.
 */
export function mainWindowNavigation(url, rendererOrigin) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return "deny";
  }
  if (rendererOrigin && parsed.origin === rendererOrigin) return "allow";
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? "external" : "deny";
}
