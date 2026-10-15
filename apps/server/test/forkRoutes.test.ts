import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { SessionMeta, UserIdentity } from "@agent-deck/contracts";
import type * as PiHostModule from "../src/services/piHost.ts";
import type * as UserAgentDirsModule from "../src/userAgentDirs.ts";
import { startServer, type AgentDeckServer } from "../src/index.ts";
import { SessionIndex } from "../src/persistence.ts";

// SRV-15a route-level coverage without symlinks or a real Pi: every spawn runs
// the scripted fake Pi (and is recorded), and user agent dirs are plain dirs
// holding an Anthropic API key, so the forker's catalog offers the source model.
const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.cjs");
const spawned = vi.hoisted(() => [] as Array<{ env?: Record<string, string | undefined> }>);
vi.mock("../src/services/piHost.ts", async (importOriginal) => {
  const original = await importOriginal<typeof PiHostModule>();
  const { Layer } = await import("effect");
  return {
    ...original,
    PiHostLive: Layer.succeed(original.PiHost, {
      spawn: (options: PiHostModule.PiSpawnOptions) => {
        spawned.push({ env: options.env });
        return original.spawnPiProcess({ ...options, binPath: process.execPath, args: [FIXTURE] });
      },
    }),
  };
});
vi.mock("../src/userAgentDirs.ts", async (importOriginal) => {
  const original = await importOriginal<typeof UserAgentDirsModule>();
  class PlainUserAgentDirs extends original.UserAgentDirs {
    override resolve(user: UserIdentity): string {
      const dir = original.userAgentDir((this as unknown as { dataDir: string }).dataDir, user.id);
      mkdirSync(dir, { recursive: true });
      const auth = path.join(dir, "auth.json");
      if (!existsSync(auth)) {
        writeFileSync(auth, JSON.stringify({ anthropic: { type: "api_key", key: "test" } }));
      }
      return dir;
    }
  }
  return { ...original, UserAgentDirs: PlainUserAgentDirs };
});

const TEAM = "team.cloudflareaccess.test";
const AUD = "aud-fork";
const KID = "k1";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
function assertionFor(email: string, name: string): Record<string, string> {
  const now = Math.floor(Date.now() / 1000);
  const signed = `${b64({ alg: "RS256", kid: KID })}.${b64({
    iss: `https://${TEAM}`,
    aud: [AUD],
    iat: now,
    exp: now + 300,
    email,
    name,
  })}`;
  const signature = sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url");
  return { "cf-access-jwt-assertion": `${signed}.${signature}` };
}

const dataDir = mkdtempSync(path.join(tmpdir(), "deck-fork-routes-"));
const fakeHome = mkdtempSync(path.join(tmpdir(), "deck-fork-routes-home-"));
const savedEnv = { ...process.env };
const SOURCE = randomUUID();
const alice = { id: "alice@example.com", name: "Alice" };
const bob = { id: "bob@example.com", name: "Bob" };
const asBob = assertionFor(bob.id, bob.name);
let jwks: Server;
let server: AgentDeckServer;
const endpoint = (pathname: string) => `http://127.0.0.1:${server.port}${pathname}`;

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
  process.env.AGENT_DECK_PUBLIC_ORIGIN = "https://deck.example.com";
  process.env.AGENT_DECK_CF_ACCESS_JWKS_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs`;
  // Alice's ended session; its one turn (the fake Pi's entry-user-1) is hers.
  const now = new Date().toISOString();
  const piSessionFile = path.join(dataDir, "source.jsonl");
  writeFileSync(piSessionFile, "");
  writeFileSync(
    path.join(dataDir, "sessions.json"),
    JSON.stringify([
      {
        id: SOURCE,
        cwd: dataDir,
        createdAt: now,
        updatedAt: now,
        endedAt: now,
        piSessionFile,
        createdBy: alice,
        launchPlan: { kind: "parent", provider: "anthropic", model: "claude-haiku-4-5" },
      },
    ]),
  );
  const signature = createHash("sha256").update("hello world").digest("hex");
  writeFileSync(
    path.join(dataDir, "session-authors.json"),
    JSON.stringify([
      { id: SOURCE, turns: [{ signature, author: alice, claimed: true, entryId: "entry-user-1" }] },
    ]),
  );
  server = await startServer({ dataDir, claudeCodeLoggedIn: async () => false });
});
afterAll(async () => {
  await server.close();
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  // The fake Pi's `fork` writes its branch file to the temp dir.
  for (const name of readdirSync(tmpdir())) {
    if (name.startsWith("fake-pi-branch-")) rmSync(path.join(tmpdir(), name), { force: true });
  }
  if (process.platform !== "win32") {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

/** The author on the fork's rebuilt user cell, from a websocket snapshot. */
function snapshotAuthor(sessionId: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`, { headers: asBob });
    const timer = setTimeout(() => reject(new Error("no snapshot")), 15_000);
    socket.on("open", () =>
      socket.send(JSON.stringify({ id: 1, request: { type: "subscribe_session", sessionId } })),
    );
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as {
        kind: string;
        message?: { type: string; state?: { cells: Array<{ kind: string; author?: unknown }> } };
      };
      if (frame.kind !== "push" || frame.message?.type !== "snapshot") return;
      clearTimeout(timer);
      socket.close();
      resolve(frame.message.state?.cells.find((cell) => cell.kind === "user")?.author);
    });
    socket.on("error", reject);
  });
}

describe("SRV-15a fork routes on a shared server", () => {
  it.each([
    ["plain", "fork"],
    ["message", "history/fork"],
  ])(
    "a %s fork of another member's session is the requester's and keeps the source's author labels",
    async (_kind, route) => {
      const before = spawned.length;
      const response = await fetch(endpoint(`/sessions/${SOURCE}/${route}`), {
        method: "POST",
        headers: { ...asBob, "content-type": "application/json" },
        body: JSON.stringify({ entryId: "entry-user-1" }),
      });
      expect(response.status).toBe(201);
      const { session } = (await response.json()) as {
        session: { id: string; createdBy?: unknown; forkedFrom?: unknown };
      };
      expect(session.createdBy).toEqual(bob);
      // SRV-15b: a plain fork records whose session it copies (provenance line).
      if (route === "fork") expect(session.forkedFrom).toEqual({ sessionId: SOURCE, owner: alice });
      expect(new SessionIndex(dataDir).find((item) => item.id === session.id)?.createdBy).toEqual(
        bob,
      );
      // The fork's Pi ran on Bob's agent dir (the last spawn; a message fork
      // resumes Alice's source first, on hers).
      const bobHash = createHash("sha256").update(bob.id).digest("hex").slice(0, 16);
      const forkSpawn = spawned.slice(before).at(-1);
      expect(forkSpawn?.env?.PI_CODING_AGENT_DIR).toContain(bobHash);
      expect(await snapshotAuthor(session.id)).toEqual(alice);
    },
    30_000,
  );

  it("a message fork of a plain fork names the plain fork, not its source (SRV-15b)", async () => {
    const fork = async (id: string, route: string) => {
      const response = await fetch(endpoint(`/sessions/${id}/${route}`), {
        method: "POST",
        headers: { ...asBob, "content-type": "application/json" },
        body: JSON.stringify({ entryId: "entry-user-1" }),
      });
      expect(response.status).toBe(201);
      return ((await response.json()) as { session: SessionMeta }).session;
    };
    const plain = await fork(SOURCE, "fork");
    expect(plain.forkedFrom?.sessionId).toBe(SOURCE);
    const message = await fork(plain.id, "history/fork");
    expect(message.forkedFrom).toBeUndefined();
    expect(message.forkProvenance?.sourceSessionId).toBe(plain.id);
  }, 30_000);
});
