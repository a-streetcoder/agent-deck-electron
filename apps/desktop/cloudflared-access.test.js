import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";
import {
  accessTokenAudience,
  accessTokenTeam,
  cachedTokenFiles,
  cloudflaredLogin,
  cloudflaredLogout,
  cloudflaredToken,
  forgetCachedTokens,
  signInErrorText,
} from "./cloudflared-access.js";

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

test("sign-in error text: cancel, timeout, stderr's last line, message fallback, and a length cap", () => {
  assert.equal(signInErrorText(new Error("x"), true), "Sign-in cancelled.");
  assert.equal(
    signInErrorText(Object.assign(new Error("Command failed"), { stderr: "info\nlogin failed\n" })),
    "login failed",
  );
  assert.equal(
    signInErrorText({ killed: true, stderr: "x" }),
    "Timed out waiting for the browser approval.",
  );
  assert.equal(signInErrorText(new Error("spawn ENOENT")), "spawn ENOENT");
  assert.equal(signInErrorText({ stderr: "e".repeat(400) }).length, 303);
});

test("accessTokenTeam reads the issuer host of a token, never more", () => {
  const payload = (claims) => Buffer.from(JSON.stringify(claims)).toString("base64url");
  assert.equal(
    accessTokenTeam(`e30.${payload({ iss: "https://Acme.cloudflareaccess.com" })}.sig`),
    "acme.cloudflareaccess.com",
  );
  for (const bad of [
    "aaa.bbb.ccc",
    `e30.${payload({ iss: "http://acme.cloudflareaccess.com" })}.sig`,
    `e30.${payload({ iss: 42 })}.sig`,
    `e30.${payload({ email: "a@x.test" })}.sig`,
    "",
    null,
  ]) {
    assert.equal(accessTokenTeam(bad), null, String(bad));
  }
});

test("cloudflaredLogout runs access logout only when this cloudflared lists it", async () => {
  const calls = [];
  const runWith = (help) => async (args) => {
    calls.push(args.join(" "));
    return args[1] === "--help" ? help : "";
  };
  assert.equal(
    await cloudflaredLogout(
      runWith("COMMANDS:\n   login   login <url>\n   token\n"),
      "https://a.test",
    ),
    false,
  );
  assert.deepEqual(calls, ["access --help"]);
  calls.length = 0;
  assert.equal(
    await cloudflaredLogout(runWith("COMMANDS:\n   logout   logout <url>\n"), "https://a.test"),
    true,
  );
  assert.deepEqual(calls, ["access --help", "access logout https://a.test"]);
});

test("accessTokenAudience reads the first aud entry", () => {
  const payload = (claims) => Buffer.from(JSON.stringify(claims)).toString("base64url");
  assert.equal(accessTokenAudience(`e30.${payload({ aud: ["abc", "def"] })}.s`), "abc");
  assert.equal(accessTokenAudience(`e30.${payload({ aud: "abc" })}.s`), "abc");
  for (const bad of [`e30.${payload({ aud: [] })}.s`, `e30.${payload({})}.s`, "aaa.bbb.ccc"]) {
    assert.equal(accessTokenAudience(bad), null);
  }
});

test("only the host's own application token files are selected and deleted", () => {
  const aud = "0123456789abcdef".repeat(4);
  const names = [
    `deck.example.com-${aud}-token`,
    `deck.example.com-${aud}-token.lock`,
    `DECK.example.com-${aud}-token`,
    "acme.cloudflareaccess.com-org-token",
    `deck.example.com.evil.test-${aud}-token`,
    `deck.example.com-tunnel.example-${aud}-token`,
    `other.example.com-${aud}-token`,
    "deck.example.com-xyz-token",
    `deck.example.com-${aud}-token.bak`,
  ];
  const selected = [
    `deck.example.com-${aud}-token`,
    `deck.example.com-${aud}-token.lock`,
    `DECK.example.com-${aud}-token`,
  ];
  assert.deepEqual(cachedTokenFiles(names, "deck.example.com"), selected);
  assert.deepEqual(cachedTokenFiles(names, "deck.example"), []);

  const removed = [];
  const fakeFs = {
    readdirSync: (dir) => {
      assert.equal(dir, "/home/u/.cloudflared");
      return names;
    },
    rmSync: (file, options) => {
      assert.deepEqual(options, { force: true });
      removed.push(file.replaceAll("\\", "/"));
    },
  };
  assert.equal(
    forgetCachedTokens({ dir: "/home/u/.cloudflared", host: "deck.example.com", fs: fakeFs }),
    3,
  );
  assert.deepEqual(
    removed,
    selected.map((name) => `/home/u/.cloudflared/${name}`),
  );
  const missing = {
    readdirSync: () => {
      throw Object.assign(new Error("none"), { code: "ENOENT" });
    },
  };
  assert.equal(forgetCachedTokens({ dir: "/x", host: "deck.example.com", fs: missing }), 0);
});
