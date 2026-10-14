import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { UserCell } from "@agent-deck/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer, type AgentDeckServer } from "../src/index.ts";
import { SessionAuthorIndex, SessionIndex } from "../src/persistence.ts";
import { SessionAuthorStore } from "../src/sessionAuthors.ts";

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
  server = await startServer({ dataDir });
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
  });

  it("reports the verified user on /me (header or Access cookie)", async () => {
    const viaHeader = await fetch(endpoint("/me"), { headers: ale });
    expect(await viaHeader.json()).toEqual({
      user: { id: "ale@example.com", email: "ale@example.com", name: "Ale" },
    });
    const viaCookie = await fetch(endpoint("/me"), {
      headers: { cookie: `CF_Authorization=${assertionFor("andrea@example.com")}` },
    });
    expect(await viaCookie.json()).toEqual({
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
