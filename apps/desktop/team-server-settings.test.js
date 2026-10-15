import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RESTART_ERROR,
  SETTINGS_FILE,
  createTeamPins,
  createTeamServerHandlers,
  nextSharedServerClient,
  readTeamServerSettings,
  resolveServerOrigin,
  restartGate,
  validateServerUrl,
  windowOriginFor,
  writeTeamServerSettings,
} from "./team-server-settings.js";

test("only a bare https origin is a team server URL", () => {
  assert.deepEqual(validateServerUrl(" https://Deck.Example.com/ "), {
    origin: "https://deck.example.com",
  });
  assert.deepEqual(validateServerUrl("https://deck.example.com:8443"), {
    origin: "https://deck.example.com:8443",
  });
  assert.deepEqual(validateServerUrl(""), { origin: null });
  assert.deepEqual(validateServerUrl(null), { origin: null });
  for (const bad of [
    "http://deck.example.com",
    "deck.example.com",
    "https://user:pass@deck.example.com",
    "https://deck.example.com/app",
    "https://deck.example.com/?x=1",
    "https://deck.example.com/#x",
    "javascript:alert(1)",
    42,
    `https://${"a".repeat(3000)}.com`,
  ]) {
    assert.equal(typeof validateServerUrl(bad).error, "string", String(bad));
  }
});

test("the host must be plain name labels or an IP literal, and the port not 0", () => {
  for (const good of ["https://10.0.0.5", "https://[::1]:8443", "https://xn--bcher-kva.example"]) {
    assert.equal(validateServerUrl(good).origin, new URL(good).origin, good);
  }
  for (const bad of [
    "https://deck.example.com.",
    "https://*.example.com",
    "https://deck..example.com",
    "https://-deck.example.com",
    "https://deck-.example.com",
    "https://deck_1.example.com",
    "https://deck.example.com:0",
  ]) {
    assert.equal(typeof validateServerUrl(bad).error, "string", bad);
  }
});

test("a changed or cleared setting gates the window's calls with the restart error", () => {
  const a = { origin: "https://a.example.com" };
  assert.equal(restartGate(a, "https://a.example.com"), null);
  assert.equal(restartGate(null, null), null);
  assert.equal(restartGate({ origin: "https://b.example.com" }, a.origin), RESTART_ERROR);
  // Cleared after the window started with a server: restart, not "unavailable".
  assert.equal(restartGate(null, a.origin), RESTART_ERROR);
});

test("the env variable overrides the stored URL", () => {
  assert.deepEqual(resolveServerOrigin("https://stored.example.com", undefined), {
    origin: "https://stored.example.com",
    overridden: false,
  });
  assert.deepEqual(resolveServerOrigin("https://stored.example.com", "https://env.example.com"), {
    origin: "https://env.example.com",
    overridden: true,
  });
  assert.deepEqual(resolveServerOrigin(null, ""), { origin: null, overridden: false });
  // A hand-edited invalid stored value means no client, not a crash.
  assert.deepEqual(resolveServerOrigin("http://stored.example.com", undefined), {
    origin: null,
    overridden: false,
  });
  assert.throws(() => resolveServerOrigin(null, "http://env.example.com"), /SHARED_SERVER_URL/);
  assert.throws(() => resolveServerOrigin(null, "https://u:p@env.example.com"), /credentials/);
  assert.throws(() => resolveServerOrigin(null, "not a url"), /absolute https URL/);
  assert.equal(
    resolveServerOrigin(null, "https://env.example.com/a?x=1").origin,
    "https://env.example.com",
  );
});

test("a changed origin replaces the client and cancels its sign-in; null drops it", () => {
  const created = [];
  const create = (origin) => {
    const client = { origin, cancelled: false, cancelSignIn: () => (client.cancelled = true) };
    created.push(client);
    return client;
  };
  const first = nextSharedServerClient(null, "https://a.example.com", create);
  assert.equal(nextSharedServerClient(first, "https://a.example.com", create), first);
  assert.equal(first.cancelled, false);
  const second = nextSharedServerClient(first, "https://b.example.com", create);
  assert.notEqual(second, first);
  assert.equal(second.origin, "https://b.example.com");
  assert.equal(first.cancelled, true);
  assert.equal(nextSharedServerClient(second, null, create), null);
  assert.equal(second.cancelled, true);
  assert.equal(nextSharedServerClient(null, null, create), null);
  assert.equal(created.length, 2);
});

test("settings round-trip; a missing or corrupt file reads as not configured", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-server-"));
  try {
    assert.deepEqual(readTeamServerSettings(dir), { serverUrl: null });
    fs.writeFileSync(path.join(dir, SETTINGS_FILE), "{not json");
    assert.deepEqual(readTeamServerSettings(dir), { serverUrl: null });
    fs.writeFileSync(
      path.join(dir, SETTINGS_FILE),
      JSON.stringify({ serverUrl: 7, cloudflaredPath: 1 }),
    );
    assert.deepEqual(readTeamServerSettings(dir), { serverUrl: null });
    fs.writeFileSync(path.join(dir, SETTINGS_FILE), "[1]");
    assert.deepEqual(readTeamServerSettings(dir), { serverUrl: null });
    writeTeamServerSettings(dir, {
      serverUrl: "https://deck.example.com",
      cloudflaredPath: "C:/cf.exe",
    });
    assert.deepEqual(readTeamServerSettings(dir), {
      serverUrl: "https://deck.example.com",
      cloudflaredPath: "C:/cf.exe",
    });
    assert.deepEqual(fs.readdirSync(dir), [SETTINGS_FILE]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("set validates, keeps cloudflaredPath and unknown keys, re-points the client", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-server-"));
  try {
    const context = { dir, env: undefined, windowOrigin: null };
    let applied = 0;
    const handlers = createTeamServerHandlers({ context: () => context, apply: () => applied++ });
    writeTeamServerSettings(dir, {
      serverUrl: null,
      cloudflaredPath: "C:/cf.exe",
      signedInAs: { name: "later ticket" },
    });

    assert.equal(handlers.set({ serverUrl: "http://deck.example.com" }).ok, false);
    assert.equal(applied, 0);
    assert.deepEqual(handlers.set({ serverUrl: "https://deck.example.com/" }), {
      ok: true,
      serverUrl: "https://deck.example.com",
      overridden: false,
      origin: "https://deck.example.com",
      restartRequired: true,
    });
    assert.equal(applied, 1);
    assert.deepEqual(readTeamServerSettings(dir), {
      serverUrl: "https://deck.example.com",
      cloudflaredPath: "C:/cf.exe",
      signedInAs: { name: "later ticket" },
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("the window origin goes only to the main window's main frame on the renderer origin", () => {
  const mainFrame = { url: "http://127.0.0.1:4200/" };
  const contents = { mainFrame };
  const win = { webContents: contents, isDestroyed: () => false };
  const origin = "https://deck.example.com";
  const renderer = "http://127.0.0.1:4200";
  const ask = (event, window = win, value = origin, expected = renderer) =>
    windowOriginFor(event, window, value, expected);
  const fromMain = { sender: contents, senderFrame: mainFrame };
  assert.equal(ask(fromMain), origin);
  assert.equal(ask(fromMain, win, null), null);
  for (const event of [
    { sender: contents, senderFrame: { url: "https://evil.example/" } },
    { sender: contents, senderFrame: null },
    { sender: { mainFrame }, senderFrame: mainFrame },
    {},
  ]) {
    assert.equal(ask(event), undefined);
  }
  // The main frame itself, but showing another page: nothing is answered or recorded.
  for (const url of ["https://evil.example/", "http://127.0.0.1:4201/", "", "not a url"]) {
    // Same window and frame shape as the accepted case above; only the page differs.
    const frame = { url };
    const other = { mainFrame: frame };
    const window = { webContents: other, isDestroyed: () => false };
    assert.equal(ask({ sender: other, senderFrame: frame }, window), undefined, url);
  }
  assert.equal(ask(fromMain, win, origin, null), undefined);
  assert.equal(ask(fromMain, null), undefined);
  assert.equal(ask(fromMain, { ...win, isDestroyed: () => true }), undefined);
});

test("team pins and sign-outs are stored per host next to the URL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-pins-"));
  try {
    writeTeamServerSettings(dir, { serverUrl: "https://a.example", extra: 1 });
    const pins = createTeamPins(dir, " Acme.CloudflareAccess.com ");
    assert.equal(pins.expected(), "acme.cloudflareaccess.com");
    assert.equal(createTeamPins(dir, "").expected(), null);
    assert.equal(pins.pinned("https://a.example"), null);
    pins.pin("https://a.example", "acme.cloudflareaccess.com", "f".repeat(64));
    pins.setSignedOut("https://a.example", true);
    pins.setSignedOut("https://a.example", true);
    assert.equal(pins.pinned("https://a.example"), "acme.cloudflareaccess.com");
    assert.equal(pins.pinned("https://b.example"), null);
    assert.equal(pins.pinned("toString"), null);
    assert.equal(
      pins.pinnedElsewhere("https://b.example", "acme.cloudflareaccess.com"),
      "https://a.example",
    );
    assert.equal(pins.pinnedElsewhere("https://a.example", "acme.cloudflareaccess.com"), null);
    assert.equal(pins.pinnedElsewhere("https://b.example", "other.cloudflareaccess.com"), null);
    assert.equal(pins.audElsewhere("https://b.example", "f".repeat(64)), "https://a.example");
    assert.equal(pins.audElsewhere("https://a.example", "f".repeat(64)), null);
    assert.equal(pins.signedOut("https://a.example"), true);
    assert.deepEqual(readTeamServerSettings(dir), {
      serverUrl: "https://a.example",
      extra: 1,
      teams: { "https://a.example": "acme.cloudflareaccess.com" },
      auds: { "https://a.example": "f".repeat(64) },
      signedOut: ["https://a.example"],
    });
    pins.setSignedOut("https://a.example", false);
    assert.equal(pins.signedOut("https://a.example"), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
