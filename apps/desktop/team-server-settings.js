/**
 * SRV-16a: the team server setting, stored per machine in Electron userData
 * (team-server.json: { serverUrl: string | null, cloudflaredPath?: string }).
 * AGENT_DECK_SHARED_SERVER_URL stays as a dev override that wins when set.
 */
import fs from "node:fs";
import path from "node:path";

export const SETTINGS_FILE = "team-server.json";
const MAX_URL_CHARS = 2048;

/**
 * `raw` as a team server origin: `{ origin }` (null for an empty value, which
 * clears the setting) or `{ error }` with a text for the Settings screen.
 * Only a bare https origin is accepted: no credentials, path, query or fragment.
 */
export function validateServerUrl(raw) {
  if (raw === null || raw === undefined) return { origin: null };
  if (typeof raw !== "string" || raw.length > MAX_URL_CHARS) {
    return { error: "Enter the team server's https address." };
  }
  const value = raw.trim();
  if (!value) return { origin: null };
  let url;
  try {
    url = new URL(value);
  } catch {
    return { error: "Enter a full address, for example https://deck.example.com." };
  }
  if (url.protocol !== "https:")
    return { error: "The team server address must start with https://." };
  if (url.username || url.password)
    return { error: "Leave the user name and password out of the address." };
  if (url.pathname !== "/" || url.search || url.hash) {
    return { error: "Enter only the server address, without a path or query." };
  }
  // The parser keeps "*", empty labels, edge hyphens and a trailing dot; allow
  // only plain host name labels (IPv4 passes as digits) or a bracketed IPv6.
  const host = url.hostname;
  const label = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
  if (!host.startsWith("[") && !host.split(".").every((part) => label.test(part))) {
    return { error: "Enter a valid server name, for example deck.example.com." };
  }
  if (url.port === "0") return { error: "Port 0 is not a valid port." };
  return { origin: url.origin };
}

/**
 * The origin the shared-server client uses: the env override when set (an
 * invalid one throws, as at startup before), else the stored URL when valid.
 */
export function resolveServerOrigin(stored, env) {
  if (env) return { origin: envServerOrigin(env), overridden: true };
  const { origin } = validateServerUrl(stored);
  return { origin: origin ?? null, overridden: false };
}

/**
 * The AGENT_DECK_SHARED_SERVER_URL dev override as an origin; it throws (and so
 * fails startup) unless it is an absolute https URL without credentials. Looser
 * than validateServerUrl: a path or query is dropped, not refused.
 */
function envServerOrigin(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("AGENT_DECK_SHARED_SERVER_URL must be an absolute https URL");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("AGENT_DECK_SHARED_SERVER_URL must be an https URL without credentials");
  }
  return url.origin;
}

/**
 * The client for `origin`: `current` when it already talks to that origin,
 * else a new one (its own token and single-flight state) or null; a replaced
 * client's pending sign-in is cancelled.
 */
export function nextSharedServerClient(current, origin, create) {
  if ((current?.origin ?? null) === origin) return current;
  current?.cancelSignIn();
  return origin ? create(origin) : null;
}

export const RESTART_ERROR = "The team server changed. Restart Agent Deck to use it.";

/**
 * The page keeps the origin its window loaded with; while main's client
 * points elsewhere (another server, or none after clearing) the renderer's
 * calls get this soft error instead of reaching a server it does not show.
 * SRV-16b: Save reloads the window, so this is only the backstop for a reload
 * that did not happen (the draft flush failed or timed out).
 */
export function restartGate(client, windowOrigin) {
  return (client?.origin ?? null) !== windowOrigin ? RESTART_ERROR : null;
}

/**
 * SRV-16b: the answer to the preload's sendSync("shared-server:window-origin"):
 * `origin` (main's origin in effect, null for none) for the main window's main
 * frame showing the app's own renderer (`rendererOrigin`), which the caller
 * records as that load's origin; undefined for any other sender or page, which
 * records nothing and gets null.
 */
export function windowOriginFor(event, mainWindow, origin, rendererOrigin) {
  const contents = mainWindow && !mainWindow.isDestroyed() ? mainWindow.webContents : null;
  if (!contents || event?.sender !== contents) return undefined;
  if (!event.senderFrame || event.senderFrame !== contents.mainFrame) return undefined;
  let senderOrigin = null;
  try {
    senderOrigin = new URL(event.senderFrame.url).origin;
  } catch {
    return undefined;
  }
  if (!rendererOrigin || senderOrigin !== rendererOrigin) return undefined;
  return origin;
}

/**
 * The team-server:get / team-server:set logic. `context()` gives
 * { dir, env, windowOrigin } at call time; `apply()` re-points the client.
 */
export function createTeamServerHandlers({ context, apply }) {
  const state = () => {
    const { dir, env, windowOrigin } = context();
    const { serverUrl } = readTeamServerSettings(dir);
    const { origin, overridden } = resolveServerOrigin(serverUrl, env);
    return { serverUrl, overridden, origin, restartRequired: origin !== windowOrigin };
  };
  return {
    state,
    get() {
      return state();
    },
    set(input) {
      const { dir } = context();
      const result = validateServerUrl(input?.serverUrl);
      if (result.error) return { ok: false, error: result.error };
      writeTeamServerSettings(dir, { ...readTeamServerSettings(dir), serverUrl: result.origin });
      apply();
      return { ok: true, ...state() };
    },
  };
}

/** The stored settings; a missing or unreadable file reads as not configured. */
export function readTeamServerSettings(dir) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(path.join(dir, SETTINGS_FILE), "utf8"));
  } catch (error) {
    if (error?.code !== "ENOENT") console.warn(`[team-server] ignoring ${SETTINGS_FILE}: ${error}`);
    return { serverUrl: null };
  }
  // Keys this version does not know (added by later tickets) survive a Save.
  const settings =
    parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? { ...parsed } : {};
  if (typeof settings.serverUrl !== "string") settings.serverUrl = null;
  if (typeof settings.cloudflaredPath !== "string") delete settings.cloudflaredPath;
  return settings;
}

/** Replace the stored settings (write then rename, so a crash leaves the old file). */
export function writeTeamServerSettings(dir, settings) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, SETTINGS_FILE);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(settings, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/**
 * SRV-16b: the per-host sign-in records kept next to the URL in
 * team-server.json: `teams` ({ [origin]: Access team domain }, pinned at the
 * first sign-in), `auds` ({ [origin]: Access application audience }) and
 * `signedOut` (origins signed out here, so a cached cloudflared token is not
 * picked up silently again).
 */
export function createTeamPins(dir, expectedTeam) {
  const read = () => readTeamServerSettings(dir);
  const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
  const update = (change) => {
    const settings = read();
    writeTeamServerSettings(dir, { ...settings, ...change(settings) });
  };
  const otherWith = (map, origin, value) =>
    (isRecord(map) &&
      Object.entries(map).find(([other, pinned]) => other !== origin && pinned === value)?.[0]) ||
    null;
  const signedOutList = (settings) =>
    Array.isArray(settings.signedOut)
      ? settings.signedOut.filter((item) => typeof item === "string")
      : [];
  return {
    pinned(origin) {
      const { teams } = read();
      const team = isRecord(teams) && Object.hasOwn(teams, origin) ? teams[origin] : null;
      return typeof team === "string" ? team : null;
    },
    /** Another origin that pinned `team`, or null. */
    pinnedElsewhere: (origin, team) => otherWith(read().teams, origin, team),
    /** Another origin that pinned the Access application audience `aud`, or null. */
    audElsewhere: (origin, aud) => otherWith(read().auds, origin, aud),
    /** Pin `team` (and `aud` when known) for `origin`. */
    pin(origin, team, aud = null) {
      update((settings) => ({
        teams: { ...(isRecord(settings.teams) ? settings.teams : {}), [origin]: team },
        ...(aud
          ? { auds: { ...(isRecord(settings.auds) ? settings.auds : {}), [origin]: aud } }
          : {}),
      }));
    },
    expected: () => expectedTeam?.trim().toLowerCase() || null,
    signedOut: (origin) => signedOutList(read()).includes(origin),
    setSignedOut(origin, value) {
      const list = signedOutList(read());
      if (list.includes(origin) === value) return;
      update(() => ({
        signedOut: value ? [...list, origin] : list.filter((item) => item !== origin),
      }));
    },
  };
}
