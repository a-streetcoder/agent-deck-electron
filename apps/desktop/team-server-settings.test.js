import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  REMOTE_MODE_ERROR,
  RESTART_ERROR,
  SETTINGS_FILE,
  createTeamServerHandlers,
  nextSharedServerClient,
  readTeamServerSettings,
  resolveServerOrigin,
  restartGate,
  validateServerUrl,
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

test("set validates, keeps cloudflaredPath and unknown keys, re-points the client; remote mode refuses both", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "team-server-"));
  try {
    const context = { dir, env: undefined, remote: false, windowOrigin: null };
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

    context.remote = true;
    assert.deepEqual(handlers.set({ serverUrl: "https://attacker.example.com" }), {
      ok: false,
      error: REMOTE_MODE_ERROR,
    });
    assert.throws(() => handlers.get(), { message: REMOTE_MODE_ERROR });
    assert.equal(readTeamServerSettings(dir).serverUrl, "https://deck.example.com");
    assert.equal(applied, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
