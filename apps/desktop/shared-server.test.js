import assert from "node:assert/strict";
import test from "node:test";
import { createSharedServerClient } from "./shared-server.js";

const ORIGIN = "https://deck.example.test";
// A fake JWT-shaped value, never a real credential.
const TOKEN = "aaa.bbb.ccc";

function fakeRun({ token = TOKEN, login } = {}) {
  const calls = [];
  const run = async (args, _timeout, signal) => {
    calls.push(args);
    if (args[1] === "login") return login ? login(signal) : "";
    if (!token) throw Object.assign(new Error("no token"), { stderr: "no token cached" });
    return `${token}\n`;
  };
  return { run, calls };
}

function fakeFetch(answer = () => globalThis.Response.json({ ok: true })) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return answer(url, init);
  };
  return { fetchImpl, calls };
}

test("only allow-listed requests reach the shared origin", async () => {
  const { run } = fakeRun();
  const { fetchImpl, calls } = fakeFetch();
  const client = createSharedServerClient({ origin: ORIGIN, run, fetchImpl });
  for (const [method, path, body] of [
    ["DELETE", "/projects"],
    ["GET", "/projects/1"],
    ["GET", "https://evil.example/projects"],
    ["GET", "//evil.example/projects"],
    ["GET", "/projects?x=1"],
    ["get", "/projects"],
    ["GET", "/me", { a: 1 }],
    ["POST", "/projects", "repo=a/b"],
    ["POST", "/projects", { repo: "x".repeat(20_000) }],
    ["POST", "/projects", { path: "/etc" }],
    ["POST", "/projects", { repo: "acme/app", path: "/etc" }],
    ["POST", "/projects"],
    ["POST", "/projects", { repo: "" }],
    ["POST", "/projects", { repo: "   " }],
    ["POST", "/projects", ["acme/app"]],
    ["POST", "/projects", JSON.parse('{"repo":"acme/app","__proto__":{"path":"/etc"}}')],
    ["POST", "/projects", Object.create({ repo: "acme/app" })],
    [undefined, undefined],
  ]) {
    await assert.rejects(client.request(method, path, body), `${method} ${path}`);
  }
  assert.equal(calls.length, 0);

  assert.deepEqual(await client.request("POST", "/projects", { repo: "acme/app" }), {
    status: 200,
    body: { ok: true },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${ORIGIN}/projects`);
  assert.equal(calls[0].init.redirect, "manual");
  assert.equal(calls[0].init.headers["cf-access-token"], TOKEN);
  assert.equal(calls[0].init.body, JSON.stringify({ repo: "acme/app" }));
});

test("the token is read once per run and never comes back in an answer", async () => {
  const { run, calls: runs } = fakeRun();
  const { fetchImpl } = fakeFetch(
    () => new globalThis.Response("<html>oops</html>", { status: 502 }),
  );
  const client = createSharedServerClient({ origin: ORIGIN, run, fetchImpl });
  const first = await client.request("GET", "/me");
  await client.request("GET", "/projects");
  assert.deepEqual(first, { status: 502, body: null });
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], ["access", "token", `-app=${ORIGIN}`]);
  assert.equal(JSON.stringify(first).includes(TOKEN), false);
  assert.equal("cancelSignIn" in client && !("token" in client), true);
});

test("a missing token or an Access 401/302 answers signInRequired with no body", async () => {
  const missing = createSharedServerClient({
    origin: ORIGIN,
    run: fakeRun({ token: "" }).run,
    fetchImpl: fakeFetch().fetchImpl,
  });
  assert.deepEqual(await missing.request("GET", "/me"), { status: 401, signInRequired: true });

  const noCloudflared = createSharedServerClient({ origin: ORIGIN, run: null });
  assert.deepEqual(await noCloudflared.request("GET", "/me"), {
    status: 401,
    signInRequired: true,
  });
  assert.match((await noCloudflared.signIn()).error, /AGENT_DECK_CLOUDFLARED/);

  for (const status of [401, 302]) {
    const { run, calls: runs } = fakeRun();
    const { fetchImpl } = fakeFetch(
      () =>
        new globalThis.Response(`denied ${TOKEN}`, {
          status,
          headers: status === 302 ? { location: "https://team.cloudflareaccess.com/login" } : {},
        }),
    );
    const client = createSharedServerClient({ origin: ORIGIN, run, fetchImpl });
    assert.deepEqual(await client.request("GET", "/projects"), {
      status: 401,
      signInRequired: true,
    });
    // The refused token is dropped and not re-read until a sign-in succeeds.
    assert.deepEqual(await client.request("GET", "/projects"), {
      status: 401,
      signInRequired: true,
    });
    assert.equal(runs.length, 1);
  }
});

test("an unreachable server answers status 0 with fixed text", async () => {
  const client = createSharedServerClient({
    origin: ORIGIN,
    run: fakeRun().run,
    fetchImpl: async () => {
      throw new Error(`connect failed with header ${TOKEN}`);
    },
  });
  assert.deepEqual(await client.request("GET", "/me"), {
    status: 0,
    error: "The shared server could not be reached.",
  });
});

test("sign-in runs one login at a time and caches the fresh token", async () => {
  let finish;
  const { run, calls: runs } = fakeRun({
    login: () => new Promise((resolve) => (finish = resolve)),
  });
  const { fetchImpl, calls } = fakeFetch();
  const client = createSharedServerClient({ origin: ORIGIN, run, fetchImpl });
  const first = client.signIn();
  const second = client.signIn();
  assert.equal(first, second);
  await new Promise((resolve) => setTimeout(resolve, 0));
  finish("");
  assert.deepEqual(await first, { ok: true });
  assert.deepEqual(
    runs.map((args) => args[1]),
    ["login", "token"],
  );
  await client.request("GET", "/me");
  assert.equal(runs.length, 2);
  assert.equal(calls[0].init.headers["cf-access-token"], TOKEN);
});

test("a cancelled or failed sign-in answers readable text, never stdout", async () => {
  const failing = createSharedServerClient({
    origin: ORIGIN,
    run: async (args) => {
      if (args[1] === "login") {
        throw Object.assign(new Error("exit 1"), { stdout: TOKEN, stderr: "login refused\n" });
      }
      return TOKEN;
    },
  });
  assert.deepEqual(await failing.signIn(), { ok: false, error: "login refused" });

  const { run } = fakeRun({
    login: (signal) =>
      new Promise((_resolve, reject) =>
        signal.addEventListener("abort", () => reject(new Error("aborted"))),
      ),
  });
  const cancelled = createSharedServerClient({ origin: ORIGIN, run });
  const pending = cancelled.signIn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  cancelled.cancelSignIn();
  assert.deepEqual(await pending, { ok: false, error: "Sign-in cancelled." });
});

test("token lookups are single-flight and a failed one holds until sign-in", async () => {
  let release;
  const gate = new Promise((resolve) => (release = resolve));
  const runs = [];
  let signedIn = false;
  const run = async (args) => {
    runs.push(args[1]);
    if (args[1] === "login") {
      signedIn = true;
      return "";
    }
    await gate;
    if (!signedIn) throw Object.assign(new Error("no token"), { stderr: "none" });
    return TOKEN;
  };
  const { fetchImpl, calls } = fakeFetch();
  const client = createSharedServerClient({ origin: ORIGIN, run, fetchImpl });
  const both = Promise.all([client.request("GET", "/me"), client.request("GET", "/projects")]);
  release();
  for (const answer of await both) assert.deepEqual(answer, { status: 401, signInRequired: true });
  await client.request("GET", "/me");
  assert.deepEqual(runs, ["token"]);
  assert.deepEqual(await client.signIn(), { ok: true });
  assert.deepEqual(await client.request("GET", "/me"), { status: 200, body: { ok: true } });
  assert.deepEqual(runs, ["token", "login", "token"]);
  assert.equal(calls.length, 1);
});

test("a body echoing the token is redacted before it reaches the page", async () => {
  const { fetchImpl } = fakeFetch((_url, init) =>
    globalThis.Response.json(
      { error: `bad header ${init.headers["cf-access-token"]}` },
      { status: 400 },
    ),
  );
  const client = createSharedServerClient({ origin: ORIGIN, run: fakeRun().run, fetchImpl });
  const answer = await client.request("GET", "/me");
  assert.deepEqual(answer, { status: 400, body: { error: "bad header <secret>" } });
  assert.equal(JSON.stringify(answer).includes(TOKEN), false);
});

test("a 403 page from Access reads as a refused account; a JSON 403 keeps its text", async () => {
  const html = createSharedServerClient({
    origin: ORIGIN,
    run: fakeRun().run,
    fetchImpl: fakeFetch(() => new globalThis.Response("<html>Forbidden</html>", { status: 403 }))
      .fetchImpl,
  });
  assert.deepEqual(await html.request("GET", "/me"), {
    status: 403,
    error: "Your account is not allowed on deck.example.test.",
  });
  const json = createSharedServerClient({
    origin: ORIGIN,
    run: fakeRun().run,
    fetchImpl: fakeFetch(() =>
      globalThis.Response.json({ error: "only the creator" }, { status: 403 }),
    ).fetchImpl,
  });
  assert.deepEqual(await json.request("GET", "/me"), {
    status: 403,
    body: { error: "only the creator" },
  });
});
