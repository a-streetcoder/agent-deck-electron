import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import { createSharedServerClient } from "./shared-server.js";
import {
  CHECK_TIMEOUT_MS,
  createTeamServerStatus,
  FOCUS_RECHECK_MS,
  relayWarning,
  statusFromMe,
  teamVerdict,
} from "./team-server-status.js";

const ORIGIN = "https://deck.example.test";
const TEAM = "acme.cloudflareaccess.com";

const AUD = "a".repeat(64);

/** A fake Access-shaped token naming `team` as its issuer (never a real credential). */
const tokenFor = (team, salt = "sig", aud = AUD) =>
  `e30.${Buffer.from(JSON.stringify({ iss: `https://${team}`, aud: [aud], email: "a@x.test" })).toString("base64url")}.${salt}`;

/** Pins in memory; `expected` defaults to TEAM (AGENT_DECK_CF_ACCESS_TEAM_DOMAIN set). */
function memoryPins({ expected = TEAM, pinned = {}, auds: pinnedAuds = {}, signedOut = [] } = {}) {
  const teams = { ...pinned };
  const auds = { ...pinnedAuds };
  const out = new Set(signedOut);
  const other = (map, origin, value) =>
    Object.entries(map).find(([key, pinned]) => key !== origin && pinned === value)?.[0] ?? null;
  return {
    teams,
    auds,
    out,
    pinned: (origin) => teams[origin] ?? null,
    pinnedElsewhere: (origin, team) => other(teams, origin, team),
    audElsewhere: (origin, aud) => other(auds, origin, aud),
    pin: (origin, team, aud) => {
      teams[origin] = team;
      if (aud) auds[origin] = aud;
    },
    expected: () => expected,
    signedOut: (origin) => out.has(origin),
    setSignedOut: (origin, value) => (value ? out.add(origin) : out.delete(origin)),
  };
}

/**
 * A real client on a fake cloudflared and fetch: `cached` is what `access
 * token` prints (null: none cached), `login` what a browser login caches.
 */
function setup({
  cached = tokenFor(TEAM),
  login = tokenFor(TEAM),
  me,
  pins = memoryPins(),
  forget,
} = {}) {
  const published = [];
  const logouts = [];
  let current = cached;
  const run = async (args) => {
    if (args[1] === "login") {
      current = login;
      return "";
    }
    if (!current) throw Object.assign(new Error("no token"), { stderr: "no token cached" });
    return `${current}\n`;
  };
  const fetches = [];
  const fetchImpl = async (url, init) => {
    fetches.push({ url, init });
    return me ? me(init) : Response.json({ user: { id: "u1", email: "ann@x.test", name: "Ann" } });
  };
  const status = createTeamServerStatus({
    publish: (next) => published.push(next),
    pins,
    logout: async (origin) => {
      logouts.push(origin);
      return false;
    },
    ...(forget ? { forget } : {}),
  });
  const client = createSharedServerClient({
    origin: ORIGIN,
    run,
    fetchImpl,
    trustTeam: (team, aud) => status.trustTeam(ORIGIN, team, aud),
  });
  return { status, client, published, logouts, pins, fetches };
}

test("startup with a cached token reads GET /me: signed in with name, email and team", async () => {
  const { status, client, published, pins } = setup();
  await status.attach(client);
  assert.deepEqual(status.get(), {
    state: "signedIn",
    user: { name: "Ann", email: "ann@x.test" },
    team: TEAM,
  });
  assert.deepEqual(published[0], { state: "needsSignIn", checking: true });
  // The first sign-in pins the host's team and the token's audience.
  assert.equal(pins.teams[ORIGIN], TEAM);
  assert.equal(pins.auds[ORIGIN], AUD);
});

test("startup without a cached (or with an expired) token needs a sign-in, without a browser", async () => {
  const { status, client } = setup({ cached: null });
  await status.attach(client);
  assert.deepEqual(status.get(), { state: "needsSignIn" });
});

test("startup: server down is unreachable, an Access 403 is forbidden", async () => {
  const down = setup({
    me: () => {
      throw new TypeError("fetch failed");
    },
  });
  await down.status.attach(down.client);
  assert.deepEqual(down.status.get(), {
    state: "unreachable",
    error: "The shared server could not be reached.",
  });

  const refused = setup({ me: () => new Response("<html>denied</html>", { status: 403 }) });
  await refused.status.attach(refused.client);
  assert.equal(refused.status.get().state, "forbidden");
  assert.match(refused.status.get().error, /not allowed on deck\.example\.test/);

  const bad = setup({ me: () => new Response("", { status: 502 }) });
  await bad.status.attach(bad.client);
  assert.deepEqual(bad.status.get(), {
    state: "unreachable",
    error: "The team server answered 502.",
  });
});

test("no origin is off; a changed origin starts over and a late answer never wins", async () => {
  const { status, client } = setup();
  status.attach(null);
  assert.deepEqual(status.get(), { state: "off" });
  const pending = status.attach(client);
  status.attach(null);
  await pending;
  assert.deepEqual(status.get(), { state: "off" });
});

test("sign-in goes signingIn then signedIn; a failure or cancel is needsSignIn with the text", async () => {
  const { status, client, published } = setup({ cached: null });
  await status.attach(client);
  assert.deepEqual(await status.signIn(), { ok: true });
  assert.ok(published.some((item) => item.state === "signingIn"));
  assert.equal(status.get().state, "signedIn");

  const failed = setup({ cached: null, login: null });
  await failed.status.attach(failed.client);
  const result = await failed.status.signIn();
  assert.equal(result.ok, false);
  assert.deepEqual(failed.status.get(), { state: "needsSignIn", error: "no token cached" });

  assert.deepEqual(await createTeamServerStatus({ publish() {}, pins: memoryPins() }).signIn(), {
    ok: false,
    error: "No team server is configured.",
  });
});

test("sign-out clears the token, is remembered for the host and runs the logout", async () => {
  const { status, client, logouts, pins } = setup();
  await status.attach(client);
  assert.equal(status.get().state, "signedIn");
  assert.deepEqual(status.signOut(), { ok: true });
  assert.deepEqual(status.get(), { state: "needsSignIn" });
  assert.deepEqual(logouts, [ORIGIN]);
  assert.ok(pins.out.has(ORIGIN));
  // The client asks for a sign-in again instead of reusing the cached token.
  assert.deepEqual(await client.request("GET", "/me"), { status: 401, signInRequired: true });

  // The next launch does not pick up the cached cloudflared token silently...
  const next = setup({ pins });
  await next.status.attach(next.client);
  assert.deepEqual(next.status.get(), { state: "needsSignIn" });
  // ...until the user signs in again.
  await next.status.signIn();
  assert.equal(next.status.get().state, "signedIn");
  assert.equal(pins.out.has(ORIGIN), false);
});

test("a token from another team than the pinned one is held until confirmed", async () => {
  const pins = memoryPins({ expected: null, pinned: { [ORIGIN]: TEAM } });
  const { status, client } = setup({
    cached: null,
    login: tokenFor("evil.cloudflareaccess.com"),
    pins,
  });
  await status.attach(client);
  const result = await status.signIn();
  assert.equal(result.ok, false);
  assert.equal(result.held, true);
  const held = status.get();
  assert.equal(held.state, "needsSignIn");
  assert.equal(held.team, "evil.cloudflareaccess.com");
  assert.match(held.warning, /before, it was acme\.cloudflareaccess\.com/);
  // Held: not used for any request.
  assert.deepEqual(await client.request("GET", "/projects"), { status: 401, signInRequired: true });

  assert.deepEqual(await status.acceptTeam(), { ok: true });
  assert.equal(status.get().state, "signedIn");
  assert.equal(status.get().team, "evil.cloudflareaccess.com");
  assert.equal(pins.teams[ORIGIN], "evil.cloudflareaccess.com");
  assert.deepEqual(await status.acceptTeam(), {
    ok: false,
    error: "No sign-in is waiting for confirmation.",
  });
});

test("AGENT_DECK_CF_ACCESS_TEAM_DOMAIN holds a cached token of another team at startup", async () => {
  const pins = memoryPins({ expected: TEAM });
  const { status, client } = setup({ cached: tokenFor("other.cloudflareaccess.com"), pins });
  await status.attach(client);
  assert.equal(status.get().state, "needsSignIn");
  assert.match(status.get().warning, /not acme\.cloudflareaccess\.com/);
  assert.equal(pins.teams[ORIGIN], undefined);
});

test("a request that loses the token turns signedIn into needsSignIn", async () => {
  let expired = false;
  const { status, client } = setup({
    me: () =>
      expired
        ? new Response("", { status: 302, headers: { location: "https://x/login" } })
        : Response.json({ user: { id: "u", email: "ann@x.test" } }),
  });
  await status.attach(client);
  assert.deepEqual(status.get().user, { name: "ann@x.test", email: "ann@x.test" });
  expired = true;
  status.observe(await client.request("GET", "/projects"), client);
  assert.deepEqual(status.get(), { state: "needsSignIn" });
});

test("no status payload ever carries the token", async () => {
  const token = tokenFor(TEAM, "SECRET-SIGNATURE");
  const { status, client, published } = setup({
    cached: token,
    login: token,
    me: () => Response.json({ user: { id: "u", email: "ann@x.test", name: token } }),
  });
  await status.attach(client);
  await status.signIn();
  status.signOut();
  for (const item of [...published, status.get()]) {
    assert.ok(!JSON.stringify(item).includes("SECRET-SIGNATURE"), JSON.stringify(item));
  }
});

test("teamVerdict and statusFromMe", () => {
  assert.equal(teamVerdict(TEAM, { pinned: null, expected: null }).ok, false);
  assert.deepEqual(teamVerdict(TEAM, { pinned: null, expected: TEAM }), { ok: true });
  assert.equal(teamVerdict(TEAM, { pinned: null, expected: TEAM, elsewhere: true }).ok, false);
  assert.deepEqual(teamVerdict(TEAM, { pinned: TEAM, expected: null, elsewhere: true }), {
    ok: true,
  });
  assert.deepEqual(teamVerdict(TEAM, { pinned: TEAM, expected: "ACME.cloudflareaccess.com" }), {
    ok: true,
  });
  assert.equal(teamVerdict(null, { pinned: null, expected: null }).ok, false);
  assert.equal(teamVerdict(TEAM, { pinned: "b.cloudflareaccess.com", expected: null }).ok, false);
  const unexpected = { state: "unreachable", error: "The server answered unexpectedly." };
  for (const body of [
    { user: null },
    { user: "ann" },
    { user: { id: "u" } },
    { user: { email: 3, name: "  " } },
    null,
    [],
  ]) {
    assert.deepEqual(statusFromMe({ status: 200, body }, TEAM), unexpected, JSON.stringify(body));
  }
  assert.deepEqual(statusFromMe({ status: 200, body: { user: { name: "Ann" } } }, null), {
    state: "signedIn",
    user: { name: "Ann" },
  });
  assert.deepEqual(statusFromMe({ status: 403, body: { error: "Ask an admin." } }, TEAM), {
    state: "forbidden",
    error: "Ask an admin.",
  });
  assert.deepEqual(statusFromMe({ status: 403, error: "Your account is not allowed on x." }), {
    state: "forbidden",
    error: "Your account is not allowed on x.",
  });
  assert.equal(statusFromMe({ status: 404, body: {} }).state, "unreachable");
  assert.deepEqual(statusFromMe({ status: 401, signInRequired: true }, TEAM), {
    state: "needsSignIn",
  });
});

test("a first sign-in without AGENT_DECK_CF_ACCESS_TEAM_DOMAIN waits for confirmation", async () => {
  const pins = memoryPins({ expected: null });
  const { status, client } = setup({ pins });
  await status.attach(client);
  assert.deepEqual(status.get(), {
    state: "needsSignIn",
    team: TEAM,
    warning: `This server uses the ${TEAM} Access team. Continue only if that is your team.`,
  });
  assert.equal(pins.teams[ORIGIN], undefined);
  assert.deepEqual(await client.request("GET", "/projects"), { status: 401, signInRequired: true });
  await status.acceptTeam();
  assert.equal(status.get().state, "signedIn");
  assert.equal(pins.teams[ORIGIN], TEAM);
});

test("a new host presenting a team pinned for another host waits, also with the env pin", async () => {
  const pins = memoryPins({ pinned: { "https://real.example.test": TEAM } });
  const { status, client } = setup({ pins, cached: tokenFor(TEAM, "sig", "b".repeat(64)) });
  await status.attach(client);
  assert.equal(status.get().state, "needsSignIn");
  assert.equal(status.get().warning, relayWarning("https://real.example.test"));
  assert.match(status.get().warning, /^https:\/\/real\.example\.test signs in through this same/);
  assert.equal(pins.teams[ORIGIN], undefined);
});

test("a late 401 from a replaced client leaves the new client's status alone", async () => {
  const a = setup();
  const b = setup();
  await a.status.attach(a.client);
  await a.status.attach(b.client);
  assert.equal(a.status.get().state, "signedIn");
  a.status.observe({ status: 401, signInRequired: true }, a.client);
  assert.equal(a.status.get().state, "signedIn");
  a.status.observe({ status: 401, signInRequired: true }, b.client);
  assert.equal(a.status.get().state, "needsSignIn");
});

test("a token whose audience another origin pinned is held, also with the team pinned here", async () => {
  const pins = memoryPins({
    pinned: { [ORIGIN]: TEAM },
    auds: { "https://real.example.test": AUD },
  });
  const { status, client } = setup({ pins });
  await status.attach(client);
  assert.equal(status.get().state, "needsSignIn");
  assert.equal(status.get().warning, relayWarning("https://real.example.test"));
  assert.deepEqual(await client.request("GET", "/projects"), { status: 401, signInRequired: true });
});

test("unreachable and forbidden recover on a 2xx, on screen mount and on focus", async () => {
  let down = true;
  const { status, client, fetches } = setup({
    me: () =>
      down
        ? new Response("", { status: 502 })
        : Response.json({ user: { id: "u", email: "ann@x.test", name: "Ann" } }),
  });
  await status.attach(client);
  assert.equal(status.get().state, "unreachable");
  down = false;
  status.observe({ status: 201, body: {} }, client);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(status.get().state, "signedIn");

  down = true;
  await status.recheck();
  assert.equal(status.get().state, "unreachable");
  down = false;
  await status.recheck();
  assert.equal(status.get().state, "signedIn");
  // The /me check waits CHECK_TIMEOUT_MS, not the client's two minutes.
  assert.equal(CHECK_TIMEOUT_MS, 10_000);
  assert.ok(fetches.every(({ init }) => init.signal instanceof AbortSignal));
});

test("focus re-checks at most once per minute", async () => {
  const { status, client, fetches } = setup();
  await status.attach(client);
  const before = fetches.length;
  await status.focused(1_000_000);
  await status.focused(1_000_000 + FOCUS_RECHECK_MS - 1);
  assert.equal(fetches.length, before + 1);
  await status.focused(1_000_000 + FOCUS_RECHECK_MS);
  assert.equal(fetches.length, before + 2);
});

test("focus and mount do nothing while signed out or off", async () => {
  const { status, client, fetches } = setup({ cached: null });
  await status.attach(client);
  const before = fetches.length;
  await status.focused(5);
  await status.recheck();
  assert.equal(fetches.length, before);
  assert.equal(status.get().state, "needsSignIn");
});

test("Remove cached token signs out and deletes the host's token files", async () => {
  const forgotten = [];
  const { status, client, pins } = setup({
    forget: (origin) => {
      forgotten.push(origin);
      return 2;
    },
  });
  await status.attach(client);
  assert.deepEqual(status.forgetToken(), { ok: true, removed: 2 });
  assert.deepEqual(forgotten, [ORIGIN]);
  assert.deepEqual(status.get(), { state: "needsSignIn" });
  assert.ok(pins.out.has(ORIGIN));

  const failing = setup({
    forget: () => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    },
  });
  await failing.status.attach(failing.client);
  assert.deepEqual(failing.status.forgetToken(), {
    ok: false,
    error: "The cached token could not be removed (EPERM).",
  });
});
