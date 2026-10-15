/**
 * SRV-12b: the local desktop app's calls to a configured shared server
 * (AGENT_DECK_SHARED_SERVER_URL), for Make shared. The renderer is served by the
 * local backend and has no Access credential, so main makes the call with the
 * user's cloudflared token. The token never leaves this module: answers carry
 * only a status and a parsed JSON body.
 */
import { Buffer } from "node:buffer";
import { CLOUDFLARED_MISSING } from "./cloudflared-resolver.js";
import { cloudflaredLogin, cloudflaredToken, signInErrorText } from "./remote-server.js";

/** The only requests a renderer may ask for, as "METHOD /path". */
const ALLOWED = new Set(["GET /projects", "POST /projects", "GET /me"]);
/** SRV-12c1: a session move into one shared project (a UUID), the only patterned path. */
const IMPORT_PATH =
  /^\/projects\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/sessions\/import$/;
/** SRV-12c2: the live mirror of one moved session (UUIDs; the query exactly as the page builds it). */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/** A strictly percent-encoded cell id. */
const ID = "[A-Za-z0-9._~%-]{1,300}";
const MIRROR_READS = [
  new RegExp(String.raw`^/sessions/${UUID}$`),
  new RegExp(
    String.raw`^/sessions/${UUID}/transcript(?:\?afterEntryId=${ID}&prefixHash=[0-9a-f]{40}(?:&openId=${ID}){0,20})?$`,
  ),
  new RegExp(String.raw`^/events\?sessionId=${UUID}&afterSeq=\d{1,15}&limit=\d{1,4}$`),
];
const PROMPT_PATH = new RegExp(`^/sessions/${UUID}/prompt$`);
/** SRV-12c3: bringing one moved session back (preflight and snapshot, abort, confirmation). */
const RETURN_PATH = new RegExp(`^/sessions/${UUID}/return$`);
const RETURN_ABORT_PATH = new RegExp(`^/sessions/${UUID}/return/abort$`);
const RETURNED_PATH = new RegExp(`^/sessions/${UUID}/returned$`);
const UUID_ONLY = new RegExp(`^${UUID}$`);
/** The untracked file list a return may name at most (as the server checks it). */
const MAX_RETURN_FILES = 100_000;
/** The forwarded prompt's text at most, as the server's prompt route checks it. */
export const MAX_PROMPT_CHARS = 32_000;
/** The session export the server accepts at most; checked here before it travels. */
export const MAX_IMPORT_BYTES = 16 * 1024 * 1024;

const isPlainObject = (value) =>
  value !== null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** A parsed JSON value with `secret` replaced in every string and key. */
const redactParsed = (value, secret) => {
  if (typeof value === "string") return value.split(secret).join("<secret>");
  if (Array.isArray(value)) return value.map((item) => redactParsed(item, secret));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactParsed(key, secret),
        redactParsed(item, secret),
      ]),
    );
  }
  return value;
};

/**
 * `run(args, timeoutMs, signal)` runs cloudflared (null when none is found:
 * every request then needs a sign-in that points to the download in Settings). `fetchImpl` is Node's fetch in main.
 */
export function createSharedServerClient({ origin, run, fetchImpl = fetch, timeoutMs = 120_000 }) {
  const host = new URL(origin).host;
  let token = null;
  // A failed lookup (or a token the server refused) holds until signIn()
  // succeeds, so a signed-out user does not spawn cloudflared on every call.
  let needsSignIn = false;
  let lookup = null;
  let signingIn = null;
  let controller = null;

  function currentToken() {
    if (token || needsSignIn || !run) return Promise.resolve(token);
    lookup ??= cloudflaredToken(run, origin)
      .then((value) => (token = value))
      .catch(() => {
        needsSignIn = true;
        return null;
      })
      .finally(() => {
        lookup = null;
      });
    return lookup;
  }

  async function request(method, path, body) {
    const sessionImport = method === "POST" && typeof path === "string" && IMPORT_PATH.test(path);
    const prompt = method === "POST" && typeof path === "string" && PROMPT_PATH.test(path);
    const sessionReturn = method === "POST" && typeof path === "string" && RETURN_PATH.test(path);
    const returnAbort =
      method === "POST" && typeof path === "string" && RETURN_ABORT_PATH.test(path);
    const returned = method === "PATCH" && typeof path === "string" && RETURNED_PATH.test(path);
    const mirrorRead =
      method === "GET" && typeof path === "string" && MIRROR_READS.some((read) => read.test(path));
    if (
      typeof method !== "string" ||
      typeof path !== "string" ||
      (!sessionImport &&
        !prompt &&
        !mirrorRead &&
        !sessionReturn &&
        !returnAbort &&
        !returned &&
        !ALLOWED.has(`${method} ${path}`))
    ) {
      throw new Error("This request to the shared server is not allowed.");
    }
    let payload;
    const only = (keys) =>
      isPlainObject(body) && Object.keys(body).every((key) => keys.includes(key));
    const refused = () => {
      throw new Error("This request to the shared server is not allowed.");
    };
    if (sessionReturn) {
      // {} (preflight) or exactly { confirmedUntracked: [file names] }.
      const files = isPlainObject(body) ? body.confirmedUntracked : undefined;
      const valid =
        only(["confirmedUntracked"]) &&
        (files === undefined ||
          (Array.isArray(files) &&
            files.length <= MAX_RETURN_FILES &&
            files.every((name) => typeof name === "string" && name.length <= 4096)));
      if (!valid) refused();
      payload = JSON.stringify(files === undefined ? {} : { confirmedUntracked: files });
    } else if (returnAbort) {
      const handoff = isPlainObject(body) ? body.handoff : undefined;
      const valid =
        only(["handoff"]) &&
        (handoff === undefined || (typeof handoff === "string" && UUID_ONLY.test(handoff)));
      if (!valid) refused();
      payload = JSON.stringify(handoff === undefined ? {} : { handoff });
    } else if (returned) {
      const valid =
        only(["deviceSessionId", "handoff"]) &&
        typeof body.deviceSessionId === "string" &&
        typeof body.handoff === "string" &&
        UUID_ONLY.test(body.deviceSessionId) &&
        UUID_ONLY.test(body.handoff);
      if (!valid) refused();
      payload = JSON.stringify({ deviceSessionId: body.deviceSessionId, handoff: body.handoff });
    } else if (prompt) {
      // A forwarded prompt is text only: no images, files, steering or other keys.
      const valid =
        isPlainObject(body) &&
        Object.keys(body).length === 1 &&
        typeof body.text === "string" &&
        body.text.trim() !== "" &&
        body.text.length <= MAX_PROMPT_CHARS;
      if (!valid) throw new Error("This request to the shared server is not allowed.");
      payload = JSON.stringify({ text: body.text });
    } else if (sessionImport) {
      // The shape the server validates in full (sessionTransfer.ts); here only
      // what keeps the call from carrying anything but a session export.
      const valid =
        isPlainObject(body) &&
        body.version === 1 &&
        typeof body.localSessionId === "string" &&
        typeof body.transcript === "string" &&
        isPlainObject(body.meta) &&
        isPlainObject(body.transfer);
      if (!valid) throw new Error("This request to the shared server is not allowed.");
      payload = JSON.stringify(body);
      if (Buffer.byteLength(payload) > MAX_IMPORT_BYTES) {
        throw new Error("This session is larger than 16 MB and cannot move to the shared server.");
      }
    } else if (method === "POST") {
      // Make shared only: { repo, ref? }, never the server-folder { path } form.
      const plain = isPlainObject(body);
      const keys = plain ? Object.keys(body) : [];
      const valid =
        plain &&
        Object.hasOwn(body, "repo") &&
        typeof body.repo === "string" &&
        body.repo.trim() !== "" &&
        body.repo.length <= 300 &&
        (body.ref === undefined || (typeof body.ref === "string" && body.ref.length <= 250)) &&
        keys.every((key) => key === "repo" || key === "ref");
      if (!valid) throw new Error("This request to the shared server is not allowed.");
      payload = JSON.stringify({ repo: body.repo, ...(body.ref ? { ref: body.ref } : {}) });
    } else if (body !== undefined) {
      throw new Error("This request to the shared server is not allowed.");
    }
    const accessToken = await currentToken();
    if (!accessToken) return { status: 401, signInRequired: true };
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method,
        // Access answers a login redirect when the token is not accepted: never follow it.
        redirect: "manual",
        headers: {
          accept: "application/json",
          "cf-access-token": accessToken,
          ...(payload !== undefined ? { "content-type": "application/json" } : {}),
        },
        ...(payload !== undefined ? { body: payload } : {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      // Fixed text: a fetch error never needs to reach the page verbatim.
      return {
        status: 0,
        error:
          error?.name === "TimeoutError"
            ? "The shared server did not answer in time."
            : "The shared server could not be reached.",
      };
    }
    if (response.status === 401 || (response.status >= 300 && response.status < 400)) {
      token = null;
      needsSignIn = true;
      return { status: 401, signInRequired: true };
    }
    // Redact before parsing and again after: nothing the server echoes (also as
    // \uXXXX escapes, which only parsing decodes) can carry the token out.
    const text = (await response.text().catch(() => "")).split(accessToken).join("<secret>");
    let parsed = null;
    try {
      parsed = text ? redactParsed(JSON.parse(text), accessToken) : null;
    } catch {
      parsed = null;
    }
    if (response.status === 403 && parsed === null) {
      // Access refuses an account outside its policy with an HTML page.
      return { status: 403, error: `Your account is not allowed on ${host}.` };
    }
    return { status: response.status, body: parsed };
  }

  /** `access login` in the system browser, one at a time; answers { ok, error? }. */
  function signIn() {
    if (signingIn) return signingIn;
    if (!run) {
      return Promise.resolve({
        ok: false,
        error: CLOUDFLARED_MISSING,
      });
    }
    controller = new AbortController();
    const { signal } = controller;
    signingIn = cloudflaredLogin(run, origin, signal)
      .then((fresh) => {
        if (signal.aborted) throw new Error("Sign-in cancelled.");
        token = fresh;
        needsSignIn = false;
        return { ok: true };
      })
      .catch((error) => ({ ok: false, error: signInErrorText(error, signal.aborted) }))
      .finally(() => {
        signingIn = null;
        controller = null;
      });
    return signingIn;
  }

  /** Kill a pending `access login` (app quit). */
  function cancelSignIn() {
    controller?.abort();
  }

  return { origin, request, signIn, cancelSignIn };
}
