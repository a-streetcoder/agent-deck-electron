import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import zlib, { gzipSync } from "node:zlib";
import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_SHA256,
  CLOUDFLARED_VERSION,
  CLOUDFLARED_MISSING,
  cloudflaredVersion,
  downloadAndStoreCloudflared,
  downloadCloudflared,
  lazyCloudflaredRunner,
  resolveCloudflared,
  singleTarFile,
} from "./cloudflared-resolver.js";
import { createSharedServerClient } from "./shared-server.js";
import { readTeamServerSettings, writeTeamServerSettings } from "./team-server-settings.js";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const dirs = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cloudflared-test-"));
  dirs.push(dir);
  return dir;
};
test.after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});
const onlyFiles = (files) => (file) => files.includes(file);

test("resolution order: env, setting, PATH, known folders, else null", () => {
  const winEnv = {
    PATH: "C:\\Tools;relative\\dir",
    "ProgramFiles(x86)": "C:\\Program Files (x86)",
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
  };
  const stored = "D:\\cf\\cloudflared.exe";
  const onPath = "C:\\Tools\\cloudflared.exe";
  const x86 = "C:\\Program Files (x86)\\cloudflared\\cloudflared.exe";
  const winget = "C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\cloudflared.exe";
  const win = (exists, env = winEnv, storedPath = stored) =>
    resolveCloudflared({ storedPath, env, platform: "win32", exists });

  const dev = "C:\\dev\\cf.exe";
  const withDev = { ...winEnv, AGENT_DECK_CLOUDFLARED: dev };
  const all = onlyFiles([dev, stored, onPath, x86, winget]);
  // The dev override wins over the stored setting.
  assert.deepEqual(win(all, withDev), { path: dev, source: "env", warning: null });
  // An override pointing at a missing file falls through, with a warning.
  assert.deepEqual(win(onlyFiles([stored, onPath]), withDev), {
    path: stored,
    source: "setting",
    warning: "AGENT_DECK_CLOUDFLARED points at a missing file",
  });
  assert.deepEqual(win(onlyFiles([]), withDev), {
    path: null,
    source: null,
    warning: "AGENT_DECK_CLOUDFLARED points at a missing file",
  });
  assert.deepEqual(win(all), { path: stored, source: "setting", warning: null });
  // A stored path that no longer exists falls through to PATH.
  assert.deepEqual(win(onlyFiles([onPath, x86])), { path: onPath, source: "path", warning: null });
  assert.deepEqual(win(onlyFiles([x86, winget])), { path: x86, source: "known", warning: null });
  assert.deepEqual(win(onlyFiles([winget])), { path: winget, source: "known", warning: null });
  // Quoted PATH entries (allowed on Windows) are unquoted before the lookup.
  const quoted = "C:\\Quoted Dir\\cloudflared.exe";
  assert.deepEqual(win(onlyFiles([quoted]), { PATH: '"C:\\Quoted Dir";C:\\Tools' }), {
    path: quoted,
    source: "path",
    warning: null,
  });
  assert.deepEqual(win(onlyFiles([])), { path: null, source: null, warning: null });
  // A relative PATH entry is never searched.
  assert.deepEqual(win(onlyFiles(["relative\\dir\\cloudflared.exe"])), {
    path: null,
    source: null,
    warning: null,
  });

  const mac = (files) =>
    resolveCloudflared({ env: {}, platform: "darwin", pathDirs: [], exists: onlyFiles(files) });
  assert.deepEqual(mac(["/usr/local/bin/cloudflared", "/opt/homebrew/bin/cloudflared"]), {
    path: "/opt/homebrew/bin/cloudflared",
    source: "known",
    warning: null,
  });
  const linux = resolveCloudflared({
    env: { PATH: "/home/u/bin:/usr/bin" },
    platform: "linux",
    exists: onlyFiles(["/usr/bin/cloudflared", "/home/u/bin/cloudflared"]),
  });
  assert.deepEqual(linux, { path: "/home/u/bin/cloudflared", source: "path", warning: null });
});

test("the client's runner resolves cloudflared on every call", async () => {
  let installed = null;
  const execs = [];
  const run = lazyCloudflaredRunner(
    () => ({ path: installed }),
    async (file, args) => {
      execs.push([file, ...args]);
      return args[1] === "login" ? "" : "a.b.c\n";
    },
  );
  const client = createSharedServerClient({
    origin: "https://deck.example.com",
    run,
    fetchImpl: async () => Response.json({}),
  });
  assert.deepEqual(await client.signIn(), { ok: false, error: CLOUDFLARED_MISSING });
  assert.equal(execs.length, 0);

  // Downloaded while the app runs: the same client uses it.
  installed = "/data/cloudflared/2026.10.0/cloudflared";
  assert.deepEqual(await client.signIn(), { ok: true });
  assert.equal(execs[0][0], installed);

  // Deleted again: it is not called.
  installed = null;
  await assert.rejects(run(["--version"]), new RegExp(CLOUDFLARED_MISSING));
  assert.equal(execs.length, 2);
});

test("the version probe parses cloudflared's output and tolerates failure", async () => {
  const out = "cloudflared version 2026.10.0 (built 2026-10-05-1738 UTC)\n";
  assert.equal(await cloudflaredVersion(async () => out), "2026.10.0");
  assert.equal(
    await cloudflaredVersion(async () => {
      throw new Error("ENOENT");
    }),
    null,
  );
});

test("every supported platform has an asset and a pinned checksum", () => {
  assert.match(CLOUDFLARED_VERSION, /^\d{4}\.\d+\.\d+$/);
  for (const asset of Object.values(CLOUDFLARED_ASSETS)) {
    assert.match(CLOUDFLARED_SHA256[asset], /^[0-9a-f]{64}$/, asset);
  }
});

/**
 * A fetch answering `data` in two chunks. `redirects` maps a URL to the
 * Location it answers 302 with; `length: null` drops Content-Length.
 */
function fakeFetch(data, { status = 200, redirects = {}, length = data.length } = {}) {
  const calls = [];
  const fetchImpl = async (requested, init) => {
    calls.push({ requested, init });
    if (redirects[requested]) {
      return { ok: false, status: 302, headers: new Headers({ location: redirects[requested] }) };
    }
    const half = Math.ceil(data.length / 2);
    return {
      ok: status === 200,
      status,
      headers: new Headers(length === null ? {} : { "content-length": String(length) }),
      body: (async function* () {
        yield data.subarray(0, half);
        yield data.subarray(half);
      })(),
    };
  };
  return { fetchImpl, calls };
}

const LINUX_URL = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`;

const linuxOptions = (userDataDir, data, extra = {}) => {
  const asset = CLOUDFLARED_ASSETS["linux-x64"];
  return {
    userDataDir,
    platform: "linux",
    arch: "x64",
    fetch: fakeFetch(data).fetchImpl,
    checksums: { [asset]: sha(data) },
    ...extra,
  };
};

test("a verified download is renamed into place, made executable and recorded", async () => {
  const dir = tempDir();
  writeTeamServerSettings(dir, { serverUrl: "https://deck.example.com", extra: 1 });
  const data = Buffer.from("cloudflared binary bytes");
  const { fetchImpl, calls } = fakeFetch(data);
  const progress = [];
  const result = await downloadAndStoreCloudflared(
    linuxOptions(dir, data, { fetch: fetchImpl, onProgress: (p) => progress.push(p) }),
  );

  const target = path.join(dir, "cloudflared", CLOUDFLARED_VERSION, "cloudflared");
  assert.deepEqual(result, { path: target, version: CLOUDFLARED_VERSION });
  assert.equal(
    calls[0].requested,
    `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
  );
  assert.deepEqual(fs.readFileSync(target), data);
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o111, 0o111);
  assert.deepEqual(progress, [
    { received: 12, total: data.length },
    { received: data.length, total: data.length },
  ]);
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ["cloudflared"]);
  assert.deepEqual(readTeamServerSettings(dir), {
    serverUrl: "https://deck.example.com",
    extra: 1,
    cloudflaredPath: target,
  });
});

test("a wrong checksum deletes the download and records nothing", async () => {
  const dir = tempDir();
  const data = Buffer.from("tampered");
  await assert.rejects(
    downloadAndStoreCloudflared(
      linuxOptions(dir, data, { checksums: { "cloudflared-linux-amd64": "0".repeat(64) } }),
    ),
    /failed its checksum check/,
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, "cloudflared", CLOUDFLARED_VERSION)), []);
  assert.deepEqual(readTeamServerSettings(dir), { serverUrl: null });
});

test("refuses to download without a pinned checksum, on an HTTP error or an unknown platform", async () => {
  const dir = tempDir();
  const data = Buffer.from("x");
  const { fetchImpl, calls } = fakeFetch(data);
  await assert.rejects(
    downloadCloudflared(linuxOptions(dir, data, { fetch: fetchImpl, checksums: {} })),
    /No checksum is pinned/,
  );
  assert.equal(calls.length, 0);
  await assert.rejects(
    downloadCloudflared(
      linuxOptions(dir, data, { fetch: fakeFetch(data, { status: 404 }).fetchImpl }),
    ),
    /HTTP 404/,
  );
  await assert.rejects(
    downloadCloudflared({ userDataDir: dir, platform: "win32", arch: "ia32", fetch: fetchImpl }),
    /No cloudflared download for win32\/ia32/,
  );
  assert.deepEqual(fs.readdirSync(path.join(dir, "cloudflared", CLOUDFLARED_VERSION)), []);
});

/** A one-file ustar archive, gzipped, like Cloudflare's macOS assets. */
function tgz(name, data) {
  const header = Buffer.alloc(512);
  header.write(name, 0, "latin1");
  header.write("0000755\0", 100, "latin1");
  header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  const padding = Buffer.alloc(Math.ceil(data.length / 512) * 512 - data.length);
  return gzipSync(Buffer.concat([header, data, padding, Buffer.alloc(1024)]));
}

test("macOS: the binary inside the tgz is what the checksum verifies", async () => {
  const dir = tempDir();
  const binary = Buffer.from("mach-o cloudflared");
  const archive = tgz("cloudflared", binary);
  const options = {
    userDataDir: dir,
    platform: "darwin",
    arch: "arm64",
    fetch: fakeFetch(archive).fetchImpl,
  };
  await assert.rejects(
    downloadCloudflared({
      ...options,
      checksums: { "cloudflared-darwin-arm64.tgz": sha(archive) },
    }),
    /failed its checksum check/,
  );
  const versionDir = path.join(dir, "cloudflared", CLOUDFLARED_VERSION);
  assert.deepEqual(fs.readdirSync(versionDir), []);

  const result = await downloadCloudflared({
    ...options,
    fetch: fakeFetch(archive).fetchImpl,
    checksums: { "cloudflared-darwin-arm64.tgz": sha(binary) },
  });
  assert.equal(result.path, path.join(versionDir, "cloudflared"));
  assert.deepEqual(fs.readFileSync(result.path), binary);
  assert.deepEqual(fs.readdirSync(versionDir), ["cloudflared"]);
});

test("redirects are followed by hand to allowed https hosts only", async () => {
  const dir = tempDir();
  const data = Buffer.from("cloudflared");
  const asset = "https://release-assets.githubusercontent.com/asset?sig=1";
  const ok = fakeFetch(data, { redirects: { [LINUX_URL]: asset } });
  await downloadCloudflared(linuxOptions(dir, data, { fetch: ok.fetchImpl }));
  assert.deepEqual(
    ok.calls.map((call) => [call.requested, call.init.redirect]),
    [
      [LINUX_URL, "manual"],
      [asset, "manual"],
    ],
  );

  // https -> http -> https: refused before the http hop is contacted.
  const downgrade = fakeFetch(data, {
    redirects: {
      [LINUX_URL]: "http://objects.githubusercontent.com/x",
      "http://objects.githubusercontent.com/x": asset,
    },
  });
  await assert.rejects(
    downloadCloudflared(linuxOptions(dir, data, { fetch: downgrade.fetchImpl })),
    /not allowed/,
  );
  assert.deepEqual(
    downgrade.calls.map((call) => call.requested),
    [LINUX_URL],
  );

  const offsite = fakeFetch(data, { redirects: { [LINUX_URL]: "https://evil.example/cf" } });
  await assert.rejects(
    downloadCloudflared(linuxOptions(dir, data, { fetch: offsite.fetchImpl })),
    /https:\/\/evil\.example, which is not allowed/,
  );
  assert.equal(offsite.calls.length, 1);

  const loop = fakeFetch(data, { redirects: { [LINUX_URL]: LINUX_URL } });
  await assert.rejects(
    downloadCloudflared(linuxOptions(dir, data, { fetch: loop.fetchImpl })),
    /redirected too often/,
  );
  assert.equal(loop.calls.length, 6);
});

test("short writes are completed and the checksum covers the file on disk", async () => {
  const dir = tempDir();
  const data = Buffer.from("a cloudflared binary longer than three bytes");
  const short = (fd, buffer, offset, length) =>
    fs.writeSync(fd, buffer, offset, Math.min(length, 3));
  const result = await downloadCloudflared(linuxOptions(dir, data, { writeSync: short }));
  assert.deepEqual(fs.readFileSync(result.path), data);

  // A writer that claims full writes but drops bytes fails the check.
  const lossy = (fd, buffer, offset, length) => {
    fs.writeSync(fd, buffer, offset, Math.max(0, length - 1));
    return length;
  };
  const other = tempDir();
  await assert.rejects(
    downloadCloudflared(linuxOptions(other, data, { writeSync: lossy })),
    /failed its checksum check/,
  );
  assert.deepEqual(fs.readdirSync(path.join(other, "cloudflared", CLOUDFLARED_VERSION)), []);
});

test("the download and the unpacked archive are size-bounded", async () => {
  const dir = tempDir();
  const versionDir = path.join(dir, "cloudflared", CLOUDFLARED_VERSION);
  const data = Buffer.alloc(100, 1);
  const { fetchImpl, calls } = fakeFetch(data);
  await assert.rejects(
    downloadCloudflared(linuxOptions(dir, data, { fetch: fetchImpl, maxBytes: 99 })),
    /larger than/,
  );
  assert.equal(calls.length, 1);
  // No Content-Length: the count of received bytes stops it.
  await assert.rejects(
    downloadCloudflared(
      linuxOptions(dir, data, { fetch: fakeFetch(data, { length: null }).fetchImpl, maxBytes: 60 }),
    ),
    /larger than/,
  );
  assert.deepEqual(fs.readdirSync(versionDir), []);

  const archive = tgz("cloudflared", Buffer.alloc(4096));
  await assert.rejects(
    downloadCloudflared({
      userDataDir: dir,
      platform: "darwin",
      arch: "arm64",
      fetch: fakeFetch(archive).fetchImpl,
      checksums: { "cloudflared-darwin-arm64.tgz": "0".repeat(64) },
      maxUnpackedBytes: 2048,
    }),
    /unpacks to more than/,
  );
  assert.deepEqual(fs.readdirSync(versionDir), []);
});

test("a stalled download stops at the deadline, cleans up and can be retried", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = tempDir();
  const data = Buffer.from("cloudflared");
  const stalled = async () => ({
    ok: true,
    status: 200,
    headers: new Headers(),
    body: (async function* () {
      yield data.subarray(0, 4);
      await new Promise(() => {});
    })(),
  });
  const pending = downloadCloudflared(linuxOptions(dir, data, { fetch: stalled, timeoutMs: 1000 }));
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(1000);
  await assert.rejects(pending, /took longer than/);
  const versionDir = path.join(dir, "cloudflared", CLOUDFLARED_VERSION);
  assert.deepEqual(fs.readdirSync(versionDir), []);

  const retry = await downloadCloudflared(linuxOptions(dir, data));
  assert.deepEqual(fs.readFileSync(retry.path), data);
});

test("the tar reader refuses two files, no file and a damaged size", () => {
  const tar = (archive) => zlib.gunzipSync(archive);
  const one = tar(tgz("cloudflared", Buffer.from("bin")));
  assert.deepEqual(singleTarFile(one), Buffer.from("bin"));
  const entry = one.subarray(0, 1024);
  assert.throws(
    () => singleTarFile(Buffer.concat([entry, entry, Buffer.alloc(1024)])),
    /more than one file/,
  );

  const directory = Buffer.from(one);
  directory[156] = 0x35; // "5": a directory entry
  assert.throws(() => singleTarFile(directory), /holds no file/);
  assert.throws(() => singleTarFile(Buffer.alloc(1024)), /holds no file/);

  const damaged = Buffer.from(one);
  damaged.write("zzzzzzzzzzz\0", 124, "latin1");
  assert.throws(() => singleTarFile(damaged), /damaged/);
});
