import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as PiHost from "@agent-deck/pi-host";
import type { UserCell } from "@agent-deck/domain";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { startServer, type AgentDeckServer } from "../src/index.ts";
import { SessionAuthorIndex, SessionIndex } from "../src/persistence.ts";
import { SessionAuthorStore } from "../src/sessionAuthors.ts";
import { userAgentDir } from "../src/userAgentDirs.ts";

// SRV-13: the operator's extension-discovered catalog, without spawning Pi.
// PRV-01: plus claude-bridge when a test turns it on.
const bridgeCatalog = vi.hoisted(() => ({ on: false }));
vi.mock("@agent-deck/pi-host", async (importOriginal) => ({
  ...(await importOriginal<typeof PiHost>()),
  discoverModelCatalog: async () =>
    [
      { provider: "ext-provider", id: "ext-model" },
      ...(bridgeCatalog.on ? [{ provider: "claude-bridge", id: "claude-bridge-model" }] : []),
    ].map((model) => ({
      ...model,
      contextWindow: 1000,
      maxTokens: 100,
      reasoning: false,
      input: ["text"],
    })),
}));
// PRV-01: the host's Claude Code login (claude-bridge), stubbed.
let claudeCodeLoggedIn = false;

const TEAM = "team.cloudflareaccess.test";
const AUD = "aud-remote";
const PUBLIC_ORIGIN = "https://deck.example.com";
const KID = "k1";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
function assertionFor(email: string, name?: string): string {
  const now = Math.floor(Date.now() / 1000);
  const signed = `${b64({ alg: "RS256", kid: KID })}.${b64({
    iss: `https://${TEAM}`,
    aud: [AUD],
    iat: now,
    exp: now + 300,
    email,
    ...(name ? { name } : {}),
  })}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}

const dataDir = mkdtempSync(path.join(tmpdir(), "deck-remote-identity-"));
const fakeHome = mkdtempSync(path.join(tmpdir(), "deck-remote-home-"));
const savedEnv = { ...process.env };
let jwks: Server;
let server: AgentDeckServer;
const endpoint = (pathname: string) => `http://127.0.0.1:${server.port}${pathname}`;
const ale = { "cf-access-jwt-assertion": assertionFor("ale@example.com", "Ale") };
const AUTHORED_SESSION = randomUUID();
const loginAuthPaths: string[] = [];
// SRV-06: github.com stand-in for the device flow; token answers are queued per test.
const tokenAnswers: Array<Record<string, unknown>> = [];
const githubJson = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const githubFetch = (async (url: string | URL) => {
  const target = String(url);
  if (target === "https://github.com/login/device/code") {
    return githubJson({
      device_code: "device-secret",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      interval: 0,
      expires_in: 900,
    });
  }
  if (target === "https://github.com/login/oauth/access_token") {
    return githubJson(tokenAnswers.shift() ?? { error: "authorization_pending" });
  }
  if (target === "https://api.github.com/user") {
    return githubJson({ login: "ale-gh", avatar_url: "https://avatars.example/ale" });
  }
  return githubJson({}, 404);
}) as typeof fetch;
const authorRowIds = (): string[] =>
  new SessionAuthorIndex(dataDir).list().map((record) => record.id);

beforeAll(async () => {
  jwks = createServer((_request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(
      JSON.stringify({
        keys: [{ ...publicKey.export({ format: "jwk" }), kid: KID, alg: "RS256" }],
      }),
    );
  });
  await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: fakeHome });
  process.env.AGENT_DECK_TRUSTED_PROXY = "cloudflare";
  process.env.AGENT_DECK_CF_ACCESS_TEAM_DOMAIN = TEAM;
  process.env.AGENT_DECK_CF_ACCESS_AUD = AUD;
  process.env.AGENT_DECK_PUBLIC_ORIGIN = PUBLIC_ORIGIN;
  process.env.AGENT_DECK_CF_ACCESS_JWKS_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs`;
  // An ended session with an authors row, plus an authors row whose session is gone.
  const now = new Date().toISOString();
  writeFileSync(
    path.join(dataDir, "sessions.json"),
    JSON.stringify([
      { id: AUTHORED_SESSION, cwd: dataDir, createdAt: now, updatedAt: now, endedAt: now },
    ]),
  );
  const turn = { signature: "a".repeat(64), author: { id: "ale@example.com", name: "Ale" } };
  writeFileSync(
    path.join(dataDir, "session-authors.json"),
    JSON.stringify([
      { id: AUTHORED_SESSION, turns: [turn] },
      { id: "deleted-while-offline", turns: [turn] },
    ]),
  );
  server = await startServer({
    dataDir,
    providerLoginFn: async (authPath) => void loginAuthPaths.push(authPath),
    claudeCodeLoggedIn: async () => claudeCodeLoggedIn,
    githubFetch,
  });
});
afterAll(async () => {
  await server.close();
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (process.platform !== "win32") {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

describe("trusted proxy on the HTTP surface", () => {
  it("refuses unauthenticated requests except the health probe", async () => {
    expect((await fetch(endpoint("/health"))).status).toBe(200);
    const refused = await fetch(endpoint("/sessions"));
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({ code: "unauthenticated" });
    expect((await fetch(endpoint("/me"))).status).toBe(401);
    // A1c: the event log is the team stream; no identity, no read.
    expect((await fetch(endpoint("/events"))).status).toBe(401);
    const events = await fetch(endpoint("/events?projectId=null"), { headers: ale });
    expect(events.status).toBe(200);
    expect(await events.json()).toMatchObject({
      events: [expect.objectContaining({ kind: "server.started", projectId: null })],
    });
  });

  it("reports the verified user on /me (header or Access cookie)", async () => {
    const viaHeader = await fetch(endpoint("/me"), { headers: ale });
    expect(await viaHeader.json()).toMatchObject({
      user: { id: "ale@example.com", email: "ale@example.com", name: "Ale" },
    });
    const viaCookie = await fetch(endpoint("/me"), {
      headers: { cookie: `CF_Authorization=${assertionFor("andrea@example.com")}` },
    });
    expect(await viaCookie.json()).toMatchObject({
      user: { id: "andrea@example.com", email: "andrea@example.com" },
    });
  });

  it("stamps createdBy on new sessions and persists it with the index", async () => {
    const created = await fetch(endpoint("/sessions"), {
      method: "POST",
      headers: { ...ale, "content-type": "application/json" },
      body: JSON.stringify({ cwd: dataDir }),
    });
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as {
      session: { id: string; createdBy?: unknown };
    };
    expect(session.createdBy).toEqual({ id: "ale@example.com", name: "Ale" });
    const persisted = new SessionIndex(dataDir).find((item) => item.id === session.id);
    expect(persisted?.createdBy).toEqual({ id: "ale@example.com", name: "Ale" });
    const listed = (await (await fetch(endpoint("/sessions"), { headers: ale })).json()) as {
      sessions: Array<{ id: string; createdBy?: unknown }>;
    };
    expect(listed.sessions.find((item) => item.id === session.id)?.createdBy).toEqual({
      id: "ale@example.com",
      name: "Ale",
    });
  });
});

describe("SRV-09 host launchers on a shared server", () => {
  it("refuses the doctor terminal launchers with 409", async () => {
    for (const route of ["/runtime/doctor/update-pi", "/runtime/doctor/fix"]) {
      const refused = await fetch(endpoint(route), {
        method: "POST",
        headers: { ...ale, "content-type": "application/json" },
        body: JSON.stringify({ checkId: "pi" }),
      });
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error: "Not available on a shared server: use the in-app terminal",
      });
    }
  });
});

describe("SRV-10 shared provider keys on a shared server", () => {
  const agentDir = () => path.join(fakeHome, ".pi", "agent");
  const putEnv = (key: string) =>
    fetch(endpoint("/runtime/env"), {
      method: "PUT",
      headers: { ...ale, "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", key, value: "secret-value" }),
    });
  const deleteEnv = (key: string) =>
    fetch(endpoint("/runtime/env"), {
      method: "DELETE",
      headers: { ...ale, "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", key }),
    });

  it("refuses a provider key in the env but still writes EXA_API_KEY", async () => {
    const envFile = path.join(agentDir(), ".env");
    const before = existsSync(envFile) ? readFileSync(envFile, "utf8") : null;
    for (const key of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]) {
      const refused = await putEnv(key);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({
        error:
          "Not available on a shared server: provider keys are personal, add them under Providers",
      });
    }
    expect(existsSync(envFile) ? readFileSync(envFile, "utf8") : null).toBe(before);
    expect((await putEnv("EXA_API_KEY")).status).toBe(200);
    expect(readFileSync(envFile, "utf8")).toContain("EXA_API_KEY=");
  });

  it("refuses deleting a provider key from the env but still deletes EXA_API_KEY", async () => {
    mkdirSync(agentDir(), { recursive: true });
    const envFile = path.join(agentDir(), ".env");
    const seeded = "ANTHROPIC_API_KEY=operator\nEXA_API_KEY=shared\n";
    writeFileSync(envFile, seeded);
    const refused = await deleteEnv("ANTHROPIC_API_KEY");
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      error:
        "Not available on a shared server: provider keys are personal, add them under Providers",
    });
    expect(readFileSync(envFile, "utf8")).toBe(seeded);
    expect((await deleteEnv("EXA_API_KEY")).status).toBe(200);
    expect(readFileSync(envFile, "utf8")).not.toContain("EXA_API_KEY");
  });
});

// Windows without Developer Mode refuses symlinks, which user agent dirs need;
// the shared server is Linux, where this always runs.
const canSymlink = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "deck-symlink-probe-"));
  try {
    symlinkSync(probe, path.join(probe, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
if (!canSymlink)
  console.warn("remoteServerIdentity.test: symlinks need privileges; SRV-11 skipped");

describe.skipIf(!canSymlink)("SRV-11 per-user provider credentials on a shared server", () => {
  const andrea = { "cf-access-jwt-assertion": assertionFor("andrea@example.com") };
  const sharedAuth = () => path.join(fakeHome, ".pi", "agent", "auth.json");
  const userAuth = (email: string) =>
    path.join(userAgentDir(realpathSync(dataDir), email), "auth.json");
  const providers = async (headers: Record<string, string>) =>
    (
      (await (await fetch(endpoint("/runtime/providers"), { headers })).json()) as {
        providers: Array<{ id: string; signedIn: boolean; supportsAPIKey: boolean }>;
      }
    ).providers;
  const post = (route: string, headers: Record<string, string>, body: unknown) =>
    fetch(endpoint(route), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("lists, signs in and signs out against each user's own auth.json", async () => {
    mkdirSync(path.dirname(sharedAuth()), { recursive: true });
    const operator = JSON.stringify({ anthropic: { type: "api_key", key: "operator" } });
    writeFileSync(sharedAuth(), operator);
    // First contact creates each user's dir with an empty auth.json: no
    // fallback to the operator's sign-in.
    expect((await providers(ale)).find((p) => p.id === "anthropic")?.signedIn).toBe(false);
    expect(readFileSync(userAuth("ale@example.com"), "utf8")).toBe("{}");
    const own = JSON.stringify({ anthropic: { type: "api_key", key: "ale-own" } });
    writeFileSync(userAuth("ale@example.com"), own);
    expect((await providers(ale)).find((p) => p.id === "anthropic")?.signedIn).toBe(true);
    expect((await providers(andrea)).find((p) => p.id === "anthropic")?.signedIn).toBe(false);
    writeFileSync(userAuth("andrea@example.com"), own);

    const provider = (await providers(ale)).find((p) => p.supportsAPIKey)!;
    for (const headers of [ale, andrea]) {
      const route = `/runtime/providers/${provider.id}/login`;
      expect((await post(route, headers, { authType: "api_key" })).status).toBe(201);
    }
    expect(loginAuthPaths).toEqual([userAuth("ale@example.com"), userAuth("andrea@example.com")]);

    expect((await post("/runtime/providers/anthropic/logout", ale, {})).status).toBe(200);
    expect(JSON.parse(readFileSync(userAuth("ale@example.com"), "utf8"))).toEqual({});
    expect(readFileSync(userAuth("andrea@example.com"), "utf8")).toBe(own);
    expect(readFileSync(sharedAuth(), "utf8")).toBe(operator);
  });

  it("lets only the identity that started a login follow it (review3 R4)", async () => {
    const provider = (await providers(ale)).find((p) => p.supportsAPIKey)!;
    const started = await post(`/runtime/providers/${provider.id}/login`, ale, {
      authType: "api_key",
    });
    const { loginId } = (await started.json()) as { loginId: string };
    const route = `/runtime/providers/login/${loginId}`;
    expect((await fetch(endpoint(route), { headers: andrea })).status).toBe(404);
    expect((await post(`${route}/respond`, andrea, { value: "x" })).status).toBe(404);
    expect((await post(`${route}/cancel`, andrea, {})).status).toBe(404);
    expect((await fetch(endpoint(route), { headers: ale })).status).toBe(200);
    expect((await post(`${route}/cancel`, ale, {})).status).toBe(200);
  });
});

describe.skipIf(!canSymlink)("SRV-13 no provider connected on a shared server", () => {
  const andrea = { "cf-access-jwt-assertion": assertionFor("andrea@example.com") };
  const userAuth = (email: string) =>
    path.join(userAgentDir(realpathSync(dataDir), email), "auth.json");
  const NO_PROVIDER = "No model provider connected. Connect one under Settings > Providers.";
  const me = async (headers: Record<string, string>) =>
    (
      (await (await fetch(endpoint("/me"), { headers })).json()) as {
        user: { providersConnected: boolean };
      }
    ).user.providersConnected;
  const createSession = (headers: Record<string, string>, startImmediately: boolean) =>
    fetch(endpoint("/sessions"), {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ cwd: dataDir, startImmediately }),
    });

  it("reports providersConnected per user on /me", async () => {
    await me(ale); // creates both user dirs
    await me(andrea);
    writeFileSync(
      userAuth("ale@example.com"),
      JSON.stringify({ anthropic: { type: "api_key", key: "ale-own" } }),
    );
    writeFileSync(userAuth("andrea@example.com"), "{}");
    expect(await me(ale)).toBe(true);
    expect(await me(andrea)).toBe(false);
  });

  it("refuses a start by a user with no provider, on REST and RPC", async () => {
    // The operator-wide discovered catalog must not count as the user's models.
    const discovered = await fetch(endpoint("/runtime/models/discover"), {
      method: "POST",
      headers: { ...ale, "content-type": "application/json" },
      body: "{}",
    });
    expect(discovered.status).toBe(200);
    const immediate = await createSession(andrea, true);
    expect(immediate.status).toBe(409);
    expect(await immediate.json()).toEqual({ error: NO_PROVIDER });

    const created = await createSession(andrea, false);
    expect(created.status).toBe(201);
    const { session } = (await created.json()) as { session: { id: string } };
    const reply = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`, { headers: andrea });
      socket.on("open", () =>
        socket.send(
          JSON.stringify({
            id: 7,
            request: { type: "prompt", sessionId: session.id, message: "hello" },
          }),
        ),
      );
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as {
          kind: string;
          id?: number;
          ok: boolean;
          error?: string;
        };
        if (frame.kind !== "reply" || frame.id !== 7) return;
        socket.close();
        resolve(frame);
      });
      socket.on("error", reject);
    });
    expect(reply).toMatchObject({ ok: false, error: NO_PROVIDER });
  });
});

// Runs on the Linux VM (symlinks); skipped on Windows without Developer Mode.
describe.skipIf(!canSymlink)("PRV-01 claude-bridge for a trusted-proxy owner", () => {
  const andrea = { "cf-access-jwt-assertion": assertionFor("andrea@example.com") };
  const userAuth = (email: string) =>
    path.join(userAgentDir(realpathSync(dataDir), email), "auth.json");
  const oauth = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
  const me = async () =>
    (
      (await (await fetch(endpoint("/me"), { headers: andrea })).json()) as {
        user: { providersConnected: boolean };
      }
    ).user.providersConnected;

  it("reaches the bridge with only an Anthropic sign-in, and counts it as connected", async () => {
    await me(); // creates the user dir
    writeFileSync(userAuth("andrea@example.com"), JSON.stringify({ anthropic: oauth }));
    claudeCodeLoggedIn = false;
    expect(await me()).toBe(false); // the sign-in alone is not a usable transport
    claudeCodeLoggedIn = true;
    bridgeCatalog.on = true;
    try {
      expect(await me()).toBe(true);
      const discovered = await fetch(endpoint("/runtime/models/discover"), {
        method: "POST",
        headers: { ...andrea, "content-type": "application/json" },
        body: "{}",
      });
      expect(discovered.status).toBe(200);
      const created = await fetch(endpoint("/sessions"), {
        method: "POST",
        headers: { ...andrea, "content-type": "application/json" },
        body: JSON.stringify({ cwd: dataDir, startImmediately: false }),
      });
      expect(created.status).toBe(201);
      const { session } = (await created.json()) as { session: { id: string } };
      const { models } = (await (
        await fetch(endpoint(`/sessions/${session.id}/models`), { headers: andrea })
      ).json()) as { models: Array<{ provider: string }> };
      expect(models.some((model) => model.provider === "claude-bridge")).toBe(true);
      expect(models.some((model) => model.provider === "anthropic")).toBe(false);
    } finally {
      claudeCodeLoggedIn = false;
      bridgeCatalog.on = false;
    }
  });
});

describe("GET /fs/dirs", () => {
  it("browses directories inside the configured root only", async () => {
    const browseRoot = mkdtempSync(path.join(tmpdir(), "deck-browse-root-"));
    mkdirSync(path.join(browseRoot, "beta", "nested"), { recursive: true });
    mkdirSync(path.join(browseRoot, "alpha"));
    mkdirSync(path.join(browseRoot, ".hidden"));
    writeFileSync(path.join(browseRoot, "file.txt"), "x");
    process.env.AGENT_DECK_PROJECT_ROOT = browseRoot;
    try {
      const realRoot = realpathSync.native(browseRoot);
      const top = (await (await fetch(endpoint("/fs/dirs"), { headers: ale })).json()) as {
        root: string;
        path: string;
        parent: string | null;
        dirs: Array<{ name: string; path: string }>;
      };
      expect(top.root).toBe(realRoot);
      expect(top.path).toBe(realRoot);
      expect(top.parent).toBeNull();
      expect(top.dirs.map((dir) => dir.name)).toEqual(["alpha", "beta"]);

      const beta = (await (
        await fetch(endpoint(`/fs/dirs?path=${encodeURIComponent(top.dirs[1]!.path)}`), {
          headers: ale,
        })
      ).json()) as { parent: string | null; dirs: Array<{ name: string }> };
      expect(beta.parent).toBe(realRoot);
      expect(beta.dirs.map((dir) => dir.name)).toEqual(["nested"]);

      const escaped = await fetch(
        endpoint(`/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, ".."))}`),
        { headers: ale },
      );
      expect(escaped.status).toBe(404);
      const file = await fetch(
        endpoint(`/fs/dirs?path=${encodeURIComponent(path.join(browseRoot, "file.txt"))}`),
        { headers: ale },
      );
      expect(file.status).toBe(404);
      expect((await fetch(endpoint("/fs/dirs"))).status).toBe(401);
    } finally {
      delete process.env.AGENT_DECK_PROJECT_ROOT;
      if (process.platform !== "win32") rmSync(browseRoot, { recursive: true, force: true });
    }
  });
});

describe("trusted proxy on the WebSocket upgrade", () => {
  const attempt = (
    headers: Record<string, string>,
  ): Promise<{ opened: boolean; helloOk?: boolean }> =>
    new Promise((resolve) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`, { headers });
      socket.on("open", () => socket.send(JSON.stringify({ id: 1, request: { type: "hello" } })));
      socket.on("message", (raw) => {
        const frame = JSON.parse(raw.toString()) as { kind: string };
        socket.close();
        resolve({ opened: true, helloOk: frame.kind === "hello_ok" });
      });
      socket.on("error", () => resolve({ opened: false }));
      socket.on("close", () => resolve({ opened: false }));
    });

  it("accepts the public origin with a valid assertion", async () => {
    await expect(attempt({ origin: PUBLIC_ORIGIN, ...ale })).resolves.toEqual({
      opened: true,
      helloOk: true,
    });
  });

  it("still accepts header-only clients (no Origin) carrying the assertion", async () => {
    await expect(attempt(ale)).resolves.toEqual({ opened: true, helloOk: true });
  });

  it("rejects a foreign origin even with a valid assertion", async () => {
    await expect(attempt({ origin: "https://evil.example", ...ale })).resolves.toEqual({
      opened: false,
    });
  });

  it("rejects an upgrade without an assertion", async () => {
    await expect(attempt({ origin: PUBLIC_ORIGIN })).resolves.toEqual({ opened: false });
  });
});

describe("session-authors.json pruning", () => {
  it("drops orphan rows at startup and the session's row on delete", async () => {
    expect(authorRowIds()).toEqual([AUTHORED_SESSION]);
    const deleted = await fetch(endpoint(`/sessions/${AUTHORED_SESSION}`), {
      method: "DELETE",
      headers: ale,
    });
    expect(deleted.status).toBe(200);
    expect(authorRowIds()).toEqual([]);
  });
});

describe("SessionAuthorStore", () => {
  it("binds a staged author to the live cell, then to the stable history entry", () => {
    const store = new SessionAuthorStore(new SessionAuthorIndex(dataDir));
    const andrea = { id: "andrea@example.com", name: "Andrea" };
    store.stage("s1", "hello", { id: "ale@example.com", name: "Ale" });
    store.stage("s1", "hello", andrea);
    const live = (text: string): UserCell => ({ kind: "user", id: `u-${text}`, text });
    const raw = (text: string) => ({ role: "user", content: [{ type: "text", text }] });

    expect(store.attachToUserCell("s1", live("hello"), raw("hello")).author).toEqual({
      id: "ale@example.com",
      name: "Ale",
    });
    expect(store.attachToUserCell("s1", live("hello"), raw("hello")).author).toEqual(andrea);
    // A third identical live message has no staged author left.
    expect(store.attachToUserCell("s1", live("hello"), raw("hello")).author).toBeUndefined();
    // Unknown text stays unattributed.
    expect(store.attachToUserCell("s1", live("other"), raw("other")).author).toBeUndefined();

    // History rebuild: stable entry ids bind the claimed turns in order and survive reload.
    const history = (entryId: string): UserCell => ({
      kind: "user",
      id: `user-${entryId}`,
      entryId,
      text: "hello",
    });
    expect(store.attachToUserCell("s1", history("e1"), raw("hello")).author?.id).toBe(
      "ale@example.com",
    );
    const reloaded = new SessionAuthorStore(new SessionAuthorIndex(dataDir));
    expect(reloaded.attachToUserCell("s1", history("e2"), raw("hello")).author).toEqual(andrea);
    expect(reloaded.attachToUserCell("s1", history("e1"), raw("hello")).author?.id).toBe(
      "ale@example.com",
    );
    // Other sessions are unaffected.
    expect(reloaded.attachToUserCell("s2", live("hello"), raw("hello")).author).toBeUndefined();
  });

  it("a rejected message's staged author is rolled back, so the next sender gets the cell", () => {
    const store = new SessionAuthorStore(new SessionAuthorIndex(dataDir));
    const ale = { id: "ale@example.com", name: "Ale" };
    const andrea = { id: "andrea@example.com", name: "Andrea" };
    const cell: UserCell = { kind: "user", id: "u-retry", text: "retry me" };
    store.stage("s3", "retry me", ale);
    store.unstage("s3", "retry me", ale);
    store.stage("s3", "retry me", andrea);
    expect(store.attachToUserCell("s3", cell, undefined).author).toEqual(andrea);

    // Identical text in flight from both users: the first sender's rejection
    // must not remove the second sender's (newer) record.
    store.stage("s4", "retry me", ale);
    store.stage("s4", "retry me", andrea);
    store.unstage("s4", "retry me", ale);
    expect(store.attachToUserCell("s4", cell, undefined).author).toEqual(andrea);
    expect(store.attachToUserCell("s4", cell, undefined).author).toBeUndefined();
  });
});

describe("SRV-06 GitHub connection on a shared server", () => {
  const andrea = { "cf-access-jwt-assertion": assertionFor("andrea@example.com") };
  const status = async (headers: Record<string, string>) =>
    (await fetch(endpoint("/runtime/github"), { headers })).json();
  const connect = () =>
    fetch(endpoint("/runtime/github/connect"), { method: "POST", headers: ale });
  const poll = (id: string, headers: Record<string, string>) =>
    fetch(endpoint(`/runtime/github/connect/${id}`), { headers });
  const githubFile = () =>
    path.join(path.dirname(userAgentDir(realpathSync(dataDir), "ale@example.com")), "github.json");
  const TOKEN = "gho_aleToken0123456789abcdefXYZ";

  it("answers 409 until the GitHub app's client id is set", async () => {
    delete process.env.AGENT_DECK_GITHUB_CLIENT_ID;
    expect(await status(ale)).toEqual({ available: true, configured: false, connection: null });
    const refused = await connect();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "GitHub app not configured" });
  });

  it("connects through the device flow for the initiator only, then disconnects", async () => {
    process.env.AGENT_DECK_GITHUB_CLIENT_ID = "client-1";
    const started = await connect();
    expect(started.status).toBe(201);
    const flow = (await started.json()) as Record<string, unknown>;
    expect(flow).toMatchObject({
      userCode: "ABCD-1234",
      verificationUri: "https://github.com/login/device",
      interval: 0,
    });
    expect(JSON.stringify(flow)).not.toContain("device-secret");
    const id = flow.id as string;
    expect((await poll(id, andrea)).status).toBe(404);
    tokenAnswers.push(
      { error: "authorization_pending" },
      { error: "slow_down", interval: 0 },
      { access_token: TOKEN, token_type: "bearer", scope: "repo,read:user" },
    );
    expect(await (await poll(id, ale)).json()).toEqual({ status: "pending", interval: 0 });
    expect(await (await poll(id, ale)).json()).toEqual({ status: "pending", interval: 0 });
    expect(await (await poll(id, ale)).json()).toEqual({ status: "done", login: "ale-gh" });
    expect((await poll(id, andrea)).status).toBe(404);

    const connected = await status(ale);
    expect(connected).toMatchObject({
      configured: true,
      connection: {
        login: "ale-gh",
        avatarUrl: "https://avatars.example/ale",
        scopes: ["repo", "read:user"],
      },
    });
    expect(JSON.stringify(connected)).not.toContain(TOKEN);
    expect((await status(andrea)) as { connection: unknown }).toMatchObject({ connection: null });
    expect(JSON.parse(readFileSync(githubFile(), "utf8")).token).toBe(TOKEN);
    if (process.platform !== "win32") {
      expect(statSync(githubFile()).mode & 0o777).toBe(0o600);
    }

    const removed = await fetch(endpoint("/runtime/github"), { method: "DELETE", headers: ale });
    expect(removed.status).toBe(200);
    expect(existsSync(githubFile())).toBe(false);
    expect(await status(ale)).toMatchObject({ connection: null });
  });

  it("reports an expired code", async () => {
    process.env.AGENT_DECK_GITHUB_CLIENT_ID = "client-1";
    const { id } = (await (await connect()).json()) as { id: string };
    tokenAnswers.push({ error: "expired_token" });
    expect(await (await poll(id, ale)).json()).toEqual({
      status: "expired",
      error: "The GitHub code expired.",
    });
  });
});
