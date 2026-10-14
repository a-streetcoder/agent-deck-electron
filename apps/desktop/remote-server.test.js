import assert from "node:assert/strict";
import test from "node:test";
import {
  allowRemoteShellNavigation,
  cloudflaredAccessToken,
  isControlPlanePage,
  remoteServerOrigin,
  retryInSlots,
} from "./remote-server.js";

test("remote server origin accepts only credential-free https URLs", () => {
  assert.equal(remoteServerOrigin(undefined), null);
  assert.equal(remoteServerOrigin(""), null);
  assert.equal(remoteServerOrigin("https://deck.example.com"), "https://deck.example.com");
  assert.equal(
    remoteServerOrigin("https://deck.example.com/some/path?x=1"),
    "https://deck.example.com",
  );
  assert.throws(() => remoteServerOrigin("http://deck.example.com"));
  assert.throws(() => remoteServerOrigin("https://user:pw@deck.example.com"));
  assert.throws(() => remoteServerOrigin("not a url"));
});

test("remote shell navigation allows the app, the Access team domain, and GitHub", () => {
  const origin = "https://deck.example.com";
  const team = "team.cloudflareaccess.com";
  assert.equal(allowRemoteShellNavigation("https://deck.example.com/", origin, team), true);
  assert.equal(
    allowRemoteShellNavigation("https://deck.example.com/cdn-cgi/access/login", origin, team),
    true,
  );
  assert.equal(
    allowRemoteShellNavigation(
      "https://team.cloudflareaccess.com/cdn-cgi/access/callback?x",
      origin,
      team,
    ),
    true,
  );
  assert.equal(
    allowRemoteShellNavigation(
      "https://github.com/login/oauth/authorize?client_id=1",
      origin,
      team,
    ),
    true,
  );
  assert.equal(
    allowRemoteShellNavigation("https://www.github.com/sessions/two-factor", origin, team),
    true,
  );
  // Without a configured team domain any *.cloudflareaccess.com host is the login surface.
  assert.equal(
    allowRemoteShellNavigation("https://other.cloudflareaccess.com/x", origin, undefined),
    true,
  );
  assert.equal(
    allowRemoteShellNavigation("https://other.cloudflareaccess.com/x", origin, team),
    false,
  );
  assert.equal(allowRemoteShellNavigation("https://evil.example/", origin, team), false);
  assert.equal(allowRemoteShellNavigation("http://deck.example.com/", origin, team), false);
  assert.equal(
    allowRemoteShellNavigation("https://deck.example.com.evil.test/", origin, team),
    false,
  );
  assert.equal(allowRemoteShellNavigation("file:///etc/passwd", origin, team), false);
  assert.equal(allowRemoteShellNavigation("garbage", origin, team), false);
});

test("only a page on the control-plane origin counts as the app having loaded", () => {
  const origin = "https://deck.example.com";
  assert.equal(isControlPlanePage("https://deck.example.com/", origin), true);
  assert.equal(isControlPlanePage("https://deck.example.com/sessions?x=1", origin), true);
  assert.equal(
    isControlPlanePage("https://team.cloudflareaccess.com/cdn-cgi/access/login", origin),
    false,
  );
  assert.equal(isControlPlanePage("https://github.com/login", origin), false);
  assert.equal(isControlPlanePage("https://deck.example.com.evil.test/", origin), false);
  assert.equal(isControlPlanePage("garbage", origin), false);
});

test("remote health retry accepts a server that becomes healthy within 30 s", async () => {
  let clock = 0;
  const clockOptions = {
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
  };
  const timeouts = [];
  // Fast 502s, one attempt that hangs to its timeout, healthy at 29 s: the 30 s check passes.
  const result = await retryInSlots(async (timeoutMs) => {
    timeouts.push(timeoutMs);
    if (clock === 10_000) {
      clock += timeoutMs;
      throw new Error("timed out");
    }
    if (clock < 29_000) throw new Error("502");
    return "ok";
  }, clockOptions);
  assert.equal(result, "ok");
  assert.deepEqual(timeouts, Array(7).fill(5_000));

  clock = 0;
  let calls = 0;
  await assert.rejects(
    retryInSlots(async () => {
      calls += 1;
      throw new Error(`down ${calls}`);
    }, clockOptions),
    /down 7/,
  );
  assert.equal(calls, 7);
  assert.equal(clock, 30_000, "no wait after the last attempt");
});

test("cloudflared token: cached token first, system-browser login only when missing", async () => {
  const origin = "https://deck.example.com";
  const calls = [];
  const fake = (outputs) => async (args) => {
    calls.push(args[1]);
    const next = outputs.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  assert.equal(await cloudflaredAccessToken(fake(["a.b.c\n"]), origin), "a.b.c");
  assert.deepEqual(calls, ["token"]);

  calls.length = 0;
  const noToken = new Error("Unable to find token");
  assert.equal(await cloudflaredAccessToken(fake([noToken, "", "x.y.z"]), origin), "x.y.z");
  assert.deepEqual(calls, ["token", "login", "token"]);

  calls.length = 0;
  await assert.rejects(cloudflaredAccessToken(fake([noToken, "", "not a token"]), origin));
});
