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

test("a session export goes only to one project's import route, capped in size", async () => {
  const { run } = fakeRun();
  const { fetchImpl, calls } = fakeFetch(() => globalThis.Response.json({ sessionId: "s" }));
  const client = createSharedServerClient({ origin: ORIGIN, run, fetchImpl });
  const project = "0b6f1c2e-6a7d-4c1b-9a51-3f2a7c9d1e00";
  const envelope = {
    version: 1,
    localSessionId: "5d2c1b4a-1111-4222-8333-944445555666",
    transcript: '{"type":"session"}\n',
    meta: {},
    transfer: { mode: "conversation" },
  };
  for (const [method, path, body] of [
    ["POST", "/projects/not-a-uuid/sessions/import", envelope],
    ["POST", `/projects/${project}/sessions/import/x`, envelope],
    ["POST", `/projects/${project}/../me/sessions/import`, envelope],
    ["GET", `/projects/${project}/sessions/import`],
    ["POST", `/projects/${project}/sessions/import`, { ...envelope, version: 2 }],
    ["POST", `/projects/${project}/sessions/import`, { repo: "acme/app" }],
    ["POST", `/projects/${project}/sessions/import`, [envelope]],
    [
      "POST",
      `/projects/${project}/sessions/import`,
      { ...envelope, transcript: "x".repeat(16 * 1024 * 1024) },
    ],
  ]) {
    await assert.rejects(client.request(method, path, body), `${method} ${path}`);
  }
  assert.equal(calls.length, 0);
  const answer = await client.request("POST", `/projects/${project}/sessions/import`, envelope);
  assert.deepEqual(answer, { status: 200, body: { sessionId: "s" } });
  assert.equal(calls[0].url, `${ORIGIN}/projects/${project}/sessions/import`);
  assert.equal(calls[0].init.body, JSON.stringify(envelope));
});

test("the live mirror reads one session and forwards text-only prompts", async () => {
  const { run } = fakeRun();
  const { fetchImpl, calls } = fakeFetch();
  const client = createSharedServerClient({ origin: ORIGIN, run, fetchImpl });
  const id = "9f1d2c3b-4a5e-4f60-8a71-b2c3d4e5f600";
  for (const [method, path, body] of [
    ["GET", "/sessions/not-a-uuid"],
    ["GET", `/sessions/${id}/state`],
    ["GET", `/sessions/${id}/transcript?afterEntryId=a&b=1`],
    ["GET", `/sessions/${id}/transcript?afterEntryId=a b`],
    ["GET", `/sessions/${id}/transcript?afterEntryId=a`],
    ["GET", `/sessions/${id}/transcript?afterEntryId=a&prefixHash=xyz`],
    [
      "GET",
      `/sessions/${id}/transcript?afterEntryId=a&prefixHash=${"a".repeat(40)}${"&openId=o".repeat(21)}`,
    ],
    ["GET", `/sessions/${id}`, { a: 1 }],
    ["POST", `/sessions/${id}`],
    ["GET", `/events?sessionId=${id}&afterSeq=1`],
    ["GET", `/events?projectId=p&afterSeq=1&limit=10`],
    ["GET", `/events?sessionId=${id}&afterSeq=-1&limit=10`],
    ["GET", `/sessions/${id}/prompt`],
    ["POST", `/sessions/${id}/prompt`],
    ["POST", `/sessions/${id}/prompt`, { text: "" }],
    ["POST", `/sessions/${id}/prompt`, { text: "   " }],
    ["POST", `/sessions/${id}/prompt`, { text: 1 }],
    ["POST", `/sessions/${id}/prompt`, { text: "x".repeat(32_001) }],
    ["POST", `/sessions/${id}/prompt`, { text: "hi", images: [] }],
    ["POST", `/sessions/${id}/prompt`, { text: "hi", streamingBehavior: "steer" }],
    ["POST", `/sessions/${id}/prompt`, ["hi"]],
    ["POST", `/sessions/${id}/prompt/x`, { text: "hi" }],
  ]) {
    await assert.rejects(client.request(method, path, body), `${method} ${path}`);
  }
  assert.equal(calls.length, 0);
  for (const path of [
    `/sessions/${id}`,
    `/sessions/${id}/transcript`,
    `/sessions/${id}/transcript?afterEntryId=tool-call_1%2Fx&prefixHash=${"0f".repeat(20)}`,
    `/sessions/${id}/transcript?afterEntryId=a&prefixHash=${"0f".repeat(20)}${"&openId=tool-%28x%29".repeat(20)}`,
    `/events?sessionId=${id}&afterSeq=0&limit=200`,
  ]) {
    assert.equal((await client.request("GET", path)).status, 200, path);
  }
  await client.request("POST", `/sessions/${id}/prompt`, { text: "x".repeat(32_000) });
  assert.equal(calls.at(-1).url, `${ORIGIN}/sessions/${id}/prompt`);
  assert.equal(calls.at(-1).init.body, JSON.stringify({ text: "x".repeat(32_000) }));
  assert.equal(calls.length, 6);
});
