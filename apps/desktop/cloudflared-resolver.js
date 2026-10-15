/**
 * SRV-16c: find cloudflared on this machine, or download the pinned release
 * once and verify its sha256 before it is made executable or recorded.
 * Pure apart from the injected fs checks, fetch and runner, so node --test
 * can drive it.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { readTeamServerSettings, writeTeamServerSettings } from "./team-server-settings.js";

/** Bump together with CLOUDFLARED_SHA256, in one PR (docs/remote-server-poc.md). */
export const CLOUDFLARED_VERSION = "2026.10.0";

/** `${platform}-${arch}` to the official release asset. */
export const CLOUDFLARED_ASSETS = {
  "win32-x64": "cloudflared-windows-amd64.exe",
  "darwin-x64": "cloudflared-darwin-amd64.tgz",
  "darwin-arm64": "cloudflared-darwin-arm64.tgz",
  "linux-x64": "cloudflared-linux-amd64",
  "linux-arm64": "cloudflared-linux-arm64",
};

/**
 * The "SHA256 Checksums" Cloudflare publishes in the release notes of
 * CLOUDFLARED_VERSION. For the macOS .tgz assets that value is the sha256 of
 * the cloudflared binary inside the archive (not of the archive), so the
 * binary is extracted first and then verified.
 */
export const CLOUDFLARED_SHA256 = {
  "cloudflared-windows-amd64.exe":
    "86aee4017b26625cee8484c113558f48effa4cd47f7aa05fcf425604e5d2b23c",
  "cloudflared-darwin-amd64.tgz":
    "0560c9ab7281ac3f746055323623ed23bc0405b6dab9400474020cba33a978da",
  "cloudflared-darwin-arm64.tgz":
    "72edfd3eea463aef4d5cb89e2e209cecb048cc756c2b01915de2e0ad7cb39830",
  "cloudflared-linux-amd64": "d33ff2d14475178d2012c2c56beba87389ac5ded27649519f198a7d3134a99db",
  "cloudflared-linux-arm64": "e6422b9d4f72d3194bc5a38676f13667c06666523217b842a877d72a80b5ac08",
};

const isFile = (file) => {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
};

/** The folders the cloudflared installers use, per OS. */
function knownFolders(platform, env) {
  if (platform === "win32") {
    return [
      env["ProgramFiles(x86)"] && path.win32.join(env["ProgramFiles(x86)"], "cloudflared"),
      env.ProgramFiles && path.win32.join(env.ProgramFiles, "cloudflared"),
      env.LOCALAPPDATA && path.win32.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links"),
    ].filter(Boolean);
  }
  if (platform === "darwin") return ["/opt/homebrew/bin", "/usr/local/bin"];
  return ["/usr/local/bin", "/usr/bin"];
}

export const CLOUDFLARED_MISSING =
  "cloudflared is not available. Download it in Settings > Team server.";
export const ENV_MISSING_WARNING = "AGENT_DECK_CLOUDFLARED points at a missing file";

/**
 * The cloudflared to run: { path, source, warning } with source 'env'
 * (AGENT_DECK_CLOUDFLARED, the dev override, which wins like
 * AGENT_DECK_SHARED_SERVER_URL), 'setting' (the stored cloudflaredPath),
 * 'path' (PATH lookup) or 'known' (an install folder); path and source are
 * null when none is found. Each candidate must exist; an override pointing at
 * a missing file falls through with `warning` set (null otherwise).
 */
export function resolveCloudflared({
  storedPath,
  env = {},
  platform = process.platform,
  pathDirs,
  exists = isFile,
}) {
  const p = platform === "win32" ? path.win32 : path.posix;
  const override = env.AGENT_DECK_CLOUDFLARED;
  if (override && exists(override)) return { path: override, source: "env", warning: null };
  const warning = override ? ENV_MISSING_WARNING : null;
  if (typeof storedPath === "string" && storedPath && exists(storedPath)) {
    return { path: storedPath, source: "setting", warning };
  }
  const name = platform === "win32" ? "cloudflared.exe" : "cloudflared";
  const dirs = pathDirs ?? (env.PATH ?? env.Path ?? "").split(p.delimiter);
  for (const [source, list] of [
    ["path", dirs],
    ["known", knownFolders(platform, env)],
  ]) {
    for (const entry of list) {
      // Windows PATH entries may be quoted ("C:\Program Files\x").
      const dir = platform === "win32" ? entry?.replace(/^"(.*)"$/, "$1") : entry;
      if (!dir || !p.isAbsolute(dir)) continue;
      const file = p.join(dir, name);
      if (exists(file)) return { path: file, source, warning };
    }
  }
  return { path: null, source: null, warning };
}

/**
 * A `run(args, timeoutMs, signal)` that resolves cloudflared on every call,
 * so one installed or downloaded while the app runs is picked up and a
 * deleted one is not called. Rejects with CLOUDFLARED_MISSING when none is found.
 */
export function lazyCloudflaredRunner(resolve, exec) {
  return async (args, timeout, signal) => {
    const { path: cloudflared } = resolve();
    if (!cloudflared) throw new Error(CLOUDFLARED_MISSING);
    return exec(cloudflared, args, timeout, signal);
  };
}

/** `cloudflared --version` as "2026.10.0" (or its first line); null when it fails. */
export async function cloudflaredVersion(run) {
  try {
    const out = String(await run(["--version"], 10_000));
    return out.match(/version\s+(\S+)/)?.[1] ?? (out.trim().split("\n")[0] || null);
  } catch {
    return null;
  }
}

/** The single regular file in a (ustar) tar archive. */
export function singleTarFile(tar) {
  let found = null;
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(header.subarray(124, 136).toString("latin1").trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) throw new Error("The cloudflared archive is damaged.");
    const body = offset + 512;
    // "0" or NUL is a regular file; directories, links and pax headers are skipped.
    if (header[156] === 0x30 || header[156] === 0) {
      if (found) throw new Error("The cloudflared archive holds more than one file.");
      found = tar.subarray(body, body + size);
    }
    offset = body + Math.ceil(size / 512) * 512;
  }
  if (!found) throw new Error("The cloudflared archive holds no file.");
  return found;
}

export const DOWNLOAD_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const MAX_REDIRECTS = 5;
const MB = 1024 * 1024;

/** Refuse a URL that is not https on an allowed GitHub download host. */
function assertDownloadUrl(url) {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !DOWNLOAD_HOSTS.has(parsed.hostname)) {
    throw new Error(`The cloudflared download was sent to ${parsed.origin}, which is not allowed.`);
  }
}

/**
 * Fetch `url` following at most MAX_REDIRECTS redirects by hand, so every
 * hop is checked (https, allowed host) before it is contacted.
 */
async function fetchAllowed(fetchImpl, url, signal) {
  for (let hop = 0; ; hop += 1) {
    assertDownloadUrl(url);
    const response = await fetchImpl(url, { redirect: "manual", signal });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    if (hop === MAX_REDIRECTS) throw new Error("The cloudflared download redirected too often.");
    const location = response.headers?.get?.("location");
    if (!location) throw new Error("The cloudflared download redirected nowhere.");
    url = new URL(location, url).href;
  }
}

/** A promise that rejects once `signal` aborts (one listener per download). */
function abortion(signal) {
  const promise = new Promise((_, reject) => {
    if (signal.aborted) reject(signal.reason);
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  promise.catch(() => {});
  return promise;
}

/**
 * Download CLOUDFLARED_VERSION for this platform over https into
 * userData/cloudflared/<version>/, verify its pinned sha256 and only then
 * rename it into place and chmod +x. Resolves { path, version }; on any
 * failure (checksum, size limits, redirect off GitHub, deadline) the partial
 * files are deleted and the promise rejects with a text for the Settings
 * screen. Nothing downloaded is run here.
 * `onProgress({ received, total })` reports bytes (total null when unknown).
 */
export async function downloadCloudflared({
  userDataDir,
  platform = process.platform,
  arch = process.arch,
  fetch: fetchImpl = fetch,
  onProgress = () => {},
  checksums = CLOUDFLARED_SHA256,
  writeSync = fs.writeSync,
  maxBytes = 200 * MB,
  maxUnpackedBytes = 300 * MB,
  timeoutMs = 10 * 60_000,
}) {
  const asset = CLOUDFLARED_ASSETS[`${platform}-${arch}`];
  if (!asset) throw new Error(`No cloudflared download for ${platform}/${arch}; install it.`);
  const expected = checksums[asset];
  if (!/^[0-9a-f]{64}$/.test(expected ?? "")) {
    throw new Error(`No checksum is pinned for ${asset}; refusing to download it.`);
  }
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`;
  const dir = path.join(userDataDir, "cloudflared", CLOUDFLARED_VERSION);
  const part = path.join(dir, `${asset}.part`);
  const binaryPart = path.join(dir, "cloudflared.part");
  const target = path.join(dir, platform === "win32" ? "cloudflared.exe" : "cloudflared");
  const tooLarge = () => new Error(`The cloudflared download is larger than ${maxBytes / MB} MB.`);
  // One deadline for the redirects, the headers and the whole body.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(new Error("timeout")), timeoutMs);
  const { signal } = controller;
  fs.mkdirSync(dir, { recursive: true });
  let iterator = null;
  const aborted = abortion(signal);
  try {
    const response = await fetchAllowed(fetchImpl, url, signal);
    if (!response.ok || !response.body) {
      throw new Error(`The cloudflared download failed (HTTP ${response.status}).`);
    }
    const length = Number(response.headers?.get?.("content-length"));
    const total = Number.isFinite(length) && length > 0 ? length : null;
    if (total && total > maxBytes) throw tooLarge();
    const out = fs.openSync(part, "w");
    let received = 0;
    try {
      iterator = response.body[Symbol.asyncIterator]();
      for (;;) {
        // Race each chunk against the deadline: a stalled body cannot hang it.
        const { done, value } = await Promise.race([iterator.next(), aborted]);
        if (done) break;
        const bytes = Buffer.from(value);
        received += bytes.length;
        if (received > maxBytes) throw tooLarge();
        // writeSync may write less than asked; finish the chunk.
        for (let offset = 0; offset < bytes.length; ) {
          offset += writeSync(out, bytes, offset, bytes.length - offset);
        }
        onProgress({ received, total });
      }
    } finally {
      fs.closeSync(out);
    }
    // Verify the bytes on disk, not the bytes that arrived.
    let verified = part;
    let checked = fs.readFileSync(part);
    if (asset.endsWith(".tgz")) {
      let tar;
      try {
        // maxOutputLength stops inflating once the limit is passed.
        tar = gunzipSync(checked, { maxOutputLength: maxUnpackedBytes });
      } catch (error) {
        if (error?.code !== "ERR_BUFFER_TOO_LARGE") throw error;
        throw new Error(
          `The cloudflared archive unpacks to more than ${maxUnpackedBytes / MB} MB.`,
        );
      }
      fs.writeFileSync(binaryPart, singleTarFile(tar));
      fs.rmSync(part, { force: true });
      verified = binaryPart;
      checked = fs.readFileSync(binaryPart);
    }
    if (createHash("sha256").update(checked).digest("hex") !== expected) {
      throw new Error("The downloaded cloudflared failed its checksum check and was deleted.");
    }
    fs.renameSync(verified, target);
    if (platform !== "win32") fs.chmodSync(target, 0o755);
    return { path: target, version: CLOUDFLARED_VERSION };
  } catch (error) {
    for (const file of [part, binaryPart]) fs.rmSync(file, { force: true });
    void iterator?.return?.().catch(() => {});
    if (signal.aborted) {
      throw new Error(
        `The cloudflared download took longer than ${timeoutMs / 60_000} minutes and was stopped.`,
      );
    }
    throw error;
  } finally {
    clearTimeout(deadline);
  }
}

/**
 * downloadCloudflared, then record the verified path as cloudflaredPath in
 * team-server.json (other keys kept). A failed download records nothing.
 */
export async function downloadAndStoreCloudflared(options) {
  const result = await downloadCloudflared(options);
  const dir = options.userDataDir;
  writeTeamServerSettings(dir, { ...readTeamServerSettings(dir), cloudflaredPath: result.path });
  return result;
}
