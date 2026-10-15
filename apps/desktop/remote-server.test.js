import assert from "node:assert/strict";
import test from "node:test";
import {
  accessTokenHeaders,
  allowRemoteShellNavigation,
  cloudflaredLogin,
  cloudflaredToken,
  createRemoteSignIn,
  isControlPlanePage,
  remoteServerOrigin,
  retryInSlots,
  signInErrorText,
} from "./remote-server.js";

test("cf-access-token goes only to the Access host and is stripped after a redirect", () => {
  const host = "deck.example.test";
  const sent = { accept: "*/*", "CF-Access-Token": "stale", "cf-access-token": "stale" };
  for (const url of [`https://${host}/api`, `wss://${host}/ws`]) {
    assert.deepEqual(accessTokenHeaders(url, sent, host, "tok"), {
      accept: "*/*",
      "cf-access-token": "tok",
    });
  }
  for (const url of [
    "https://evil.example/steal",
    `https://${host}.evil.example/`,
    `http://${host}/`,
    "not a url",
  ]) {
    assert.deepEqual(accessTokenHeaders(url, sent, host, "tok"), { accept: "*/*" }, url);
  }
});

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

test("cloudflared token reads the cache only; login runs the browser flow then reads it", async () => {
  const origin = "https://deck.example.com";
  const calls = [];
  const fake = (outputs) => async (args, _timeout, signal) => {
    calls.push(args[1]);
    if (signal) calls.push(signal);
    const next = outputs.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  assert.equal(await cloudflaredToken(fake(["a.b.c\n"]), origin), "a.b.c");
  assert.deepEqual(calls, ["token"]);

  calls.length = 0;
  const noToken = new Error("Unable to find token");
  await assert.rejects(cloudflaredToken(fake([noToken]), origin), noToken);
  assert.deepEqual(calls, ["token"], "token() never opens a browser");

  calls.length = 0;
  await assert.rejects(cloudflaredToken(fake(["not a token"]), origin), /did not print a token/);

  calls.length = 0;
  const signal = new AbortController().signal;
  assert.equal(await cloudflaredLogin(fake(["", "x.y.z"]), origin, signal), "x.y.z");
  assert.deepEqual(calls, ["login", signal, "token", signal], "the token read is cancellable too");
});

test("remote sign-in: a cancel after browser approval but before the token read never attaches", async () => {
  const attached = [];
  let resolveToken;
  let tokenSignal;
  const run = (args, _timeout, signal) => {
    if (args[1] === "login") return Promise.resolve("");
    tokenSignal = signal;
    return new Promise((resolve) => (resolveToken = resolve));
  };
  const handle = createRemoteSignIn({
    login: (signal) => cloudflaredLogin(run, "https://deck.example.com", signal),
    attach: (token) => attached.push(token),
  });
  const started = handle("start");
  while (!resolveToken) await new Promise((resolve) => setTimeout(resolve, 0));
  await handle("cancel");
  assert.equal(tokenSignal.aborted, true, "the token read sees the cancel");
  resolveToken("x.y.z"); // the token read finished anyway (raced the kill)
  assert.deepEqual(await started, { ok: false, error: "Sign-in cancelled." });
  assert.deepEqual(attached, []);
});

test("remote sign-in: start, join, fail with text, retry, cancel, and never return the token", async () => {
  const attached = [];
  let pending = [];
  const login = (signal) =>
    new Promise((resolve, reject) => {
      pending.push({ resolve, reject });
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    });
  const handle = createRemoteSignIn({ login, attach: (token) => attached.push(token) });

  // A failure answers readable cloudflared text, not the token or stdout.
  const first = handle("start");
  assert.equal(handle("start"), first, "a second click joins the running login");
  pending[0].reject(Object.assign(new Error("Command failed"), { stderr: "info\nlogin failed\n" }));
  assert.deepEqual(await first, { ok: false, error: "login failed" });
  assert.deepEqual(attached, []);

  // Cancel aborts the running login and leaves a retry.
  pending = [];
  const cancelled = handle("start");
  assert.deepEqual(await handle("cancel"), { ok: true });
  assert.deepEqual(await cancelled, { ok: false, error: "Sign-in cancelled." });

  // Retry succeeds: the token goes to attach, the page gets only { ok: true }.
  pending = [];
  const retried = handle("start");
  pending[0].resolve("x.y.z");
  assert.deepEqual(await retried, { ok: true });
  assert.deepEqual(attached, ["x.y.z"]);
  assert.deepEqual(await handle("start"), { ok: true }, "no second login after success");
  assert.equal(pending.length, 1);
  assert.equal((await handle("bogus")).ok, false);
});

test("sign-in error text: timeout, message fallback, and a length cap", () => {
  assert.equal(
    signInErrorText({ killed: true, stderr: "x" }),
    "Timed out waiting for the browser approval.",
  );
  assert.equal(signInErrorText(new Error("spawn ENOENT")), "spawn ENOENT");
  assert.equal(signInErrorText({ stderr: "e".repeat(400) }).length, 303);
});
