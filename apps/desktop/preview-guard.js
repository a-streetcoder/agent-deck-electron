/**
 * Main-process policy for the dev-server preview guest (PRE-01). The renderer
 * embeds a real `<webview>` on this partition so a dev server's
 * X-Frame-Options / frame-ancestors can never blank the preview — which makes
 * the MAIN process the enforcement point for what that guest may do:
 *
 *  - Navigation (will-navigate AND will-redirect): loopback http(s) only, and
 *    never the app's own control-plane origin. The renderer's loopback gate
 *    covers only the INITIAL src; a redirect or in-page link could otherwise
 *    carry the guest to an arbitrary external origin inside the panel.
 *  - Session: every permission request (media, notifications, fullscreen,
 *    pointer lock, …) is denied and downloads are blocked — a loopback dev
 *    preview needs none of them, so fail closed.
 *
 * Mirrors the renderer's `lib/loopback.ts` host predicate (localhost /
 * 127.0.0.0/8 / ::1) — keep the two in sync.
 */

/** The preview guest's persisted partition (must match PreviewPanel.tsx). */
export const PREVIEW_PARTITION = "persist:agentdeck-preview";

function isLoopbackHost(hostname) {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127(?:\.\d{1,3}){3}$/.test(h);
}

/**
 * May the preview guest navigate to `url`? `isControlPlane(parsedUrl)` is the
 * caller's existing control-plane predicate (the agent-deck server origin has
 * no CSRF guard, so an embedded page must never be able to drive it).
 */
export function allowPreviewNavigation(url, isControlPlane) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  if (!isLoopbackHost(parsed.hostname)) return false;
  return !isControlPlane(parsed);
}

/**
 * May the preview guest issue a network REQUEST to `url`? Stricter surface than
 * navigation: this backs a session-wide `webRequest.onBeforeRequest` filter, the
 * one layer that also sees SUBFRAME documents and subresources (img/fetch/ws) —
 * `will-navigate` never fires for those. ws(s) is allowed (dev-server HMR);
 * everything else must be loopback http(s) and never the control plane.
 * (data:/blob: URLs never reach webRequest, so they are neither listed nor
 * reachable as an escape to a remote origin.)
 */
export function isAllowedPreviewRequest(url, isControlPlane) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol;
  if (scheme !== "http:" && scheme !== "https:" && scheme !== "ws:" && scheme !== "wss:")
    return false;
  if (!isLoopbackHost(parsed.hostname)) return false;
  return !isControlPlane(parsed);
}

/**
 * Clamp the preview partition's session: no permission grants (request AND
 * status-check paths), no downloads, and a request-level loopback filter —
 * the complete containment chokepoint for the guest (see above).
 */
export function configurePreviewSession(previewSession, isControlPlane) {
  previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  previewSession.setPermissionCheckHandler(() => false);
  previewSession.on("will-download", (event) => event.preventDefault());
  previewSession.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !isAllowedPreviewRequest(details.url, isControlPlane) }),
  );
}
