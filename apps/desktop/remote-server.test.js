import assert from "node:assert/strict";
import test from "node:test";
import {
  allowRemoteShellNavigation,
  isControlPlanePage,
  remoteServerOrigin,
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
