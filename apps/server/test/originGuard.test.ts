import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer, type AgentDeckServer } from "../src/index.ts";

// The REST origin guard (server.ts) must apply the WebSocket upgrade's rule.
// The server runs with the trusted-proxy variables set, so every request also
// carries a valid Access assertion; where that mode is absent they are inert.
const TEAM = "team.cloudflareaccess.test";
const AUD = "aud-origin";
const PUBLIC_ORIGIN = "https://deck.example.com";
const KID = "k1";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const now = Math.floor(Date.now() / 1000);
const signed = `${b64({ alg: "RS256", kid: KID })}.${b64({
  iss: `https://${TEAM}`,
  aud: [AUD],
  iat: now,
  exp: now + 600,
  email: "ale@example.com",
})}`;
const assertion = {
  "cf-access-jwt-assertion": `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`,
};

const dataDir = mkdtempSync(path.join(tmpdir(), "deck-origin-guard-"));
const fakeHome = mkdtempSync(path.join(tmpdir(), "deck-origin-home-"));
const savedEnv = { ...process.env };
let jwks: Server;
let server: AgentDeckServer;
const base = () => `http://127.0.0.1:${server.port}`;

const restStatus = async (
  method: string,
  pathname: string,
  origin: string | undefined,
): Promise<number> => {
  const response = await fetch(`${base()}${pathname}`, {
    method,
    headers: {
      ...assertion,
      ...(origin ? { origin } : {}),
      ...(method === "GET" ? {} : { "content-type": "application/json" }),
    },
    // An invalid body: a request that passes the guard stops at validation (400).
    ...(method === "GET" ? {} : { body: JSON.stringify({ cwd: 42 }) }),
  });
  if (response.status === 403) {
    expect(await response.json()).toMatchObject({ code: "untrusted_origin" });
  }
  return response.status;
};

const wsOpens = (origin: string | undefined): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`, {
      headers: { ...assertion, ...(origin ? { origin } : {}) },
    });
    socket.on("open", () => {
      socket.close();
      resolve(true);
    });
    socket.on("error", () => resolve(false));
    socket.on("close", () => resolve(false));
  });

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

describe("REST origin guard", () => {
  it("rejects a cross-origin POST", async () => {
    expect(await restStatus("POST", "/sessions", "https://evil.example")).toBe(403);
    // Another local port is a different origin, as on the WebSocket upgrade.
    expect(await restStatus("POST", "/sessions", "http://127.0.0.1:1")).toBe(403);
  });

  it("guards every mutating method", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      expect(await restStatus(method, "/sessions/x", "https://evil.example")).toBe(403);
    }
  });

  it("lets same-origin loopback and Origin-less requests through", async () => {
    expect(await restStatus("POST", "/sessions", base())).toBe(400);
    expect(await restStatus("POST", "/sessions", undefined)).toBe(400);
  });

  it("guards the server folder listing but not other reads", async () => {
    const listed = await restStatus("GET", "/fs/dirs", undefined);
    expect(listed).not.toBe(403);
    // Only where server-side folder browsing ships (404: no such route here).
    if (listed !== 404) {
      expect(await restStatus("GET", "/fs/dirs", "https://evil.example")).toBe(403);
    }
    expect(await restStatus("GET", "/health", "https://evil.example")).toBe(200);
  });

  it("applies the same origin rule as the WebSocket upgrade", async () => {
    const origins = [
      undefined,
      base(),
      PUBLIC_ORIGIN,
      "https://evil.example",
      "http://localhost:1",
      "not a url",
    ];
    for (const origin of origins) {
      const restAllowed = (await restStatus("POST", "/sessions", origin)) !== 403;
      expect({ origin, rest: restAllowed }).toEqual({ origin, rest: await wsOpens(origin) });
    }
  });
});
