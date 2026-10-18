import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * ADR 0008: the behaviour matrix, one case per row that a route can show
 * without spawning Pi, run under BOTH profiles so a change to one product is
 * caught by the other's expectations. The shared server is the identity tests'
 * setup in miniature: a trusted proxy whose assertions a local JWKS verifies.
 */
const TEAM = "team.cloudflareaccess.test";
const AUD = "aud-matrix";
const KID = "k1";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
function assertionFor(email: string): string {
  const now = Math.floor(Date.now() / 1000);
  const signed = `${b64({ alg: "RS256", kid: KID })}.${b64({
    iss: `https://${TEAM}`,
    aud: [AUD],
    iat: now,
    exp: now + 300,
    email,
  })}`;
  return `${signed}.${sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url")}`;
}

type Profile = "desktop" | "shared-server";
const savedEnv = { ...process.env };
let jwks: Server;
const servers = new Map<Profile, AgentDeckServer>();
const dirs: string[] = [];
const headers: Record<Profile, Record<string, string>> = {
  desktop: {},
  "shared-server": { "cf-access-jwt-assertion": assertionFor("ale@example.com") },
};

async function start(profile: Profile): Promise<AgentDeckServer> {
  const dataDir = mkdtempSync(path.join(tmpdir(), `deck-profile-${profile}-`));
  const home = mkdtempSync(path.join(tmpdir(), `deck-profile-home-${profile}-`));
  dirs.push(dataDir, home);
  process.env = { ...savedEnv, AGENT_DECK_PI_ENV: JSON.stringify({ HOME: home }) };
  delete process.env.AGENT_DECK_TRUSTED_PROXY;
  if (profile === "shared-server") {
    process.env.AGENT_DECK_TRUSTED_PROXY = "cloudflare";
    process.env.AGENT_DECK_CF_ACCESS_TEAM_DOMAIN = TEAM;
    process.env.AGENT_DECK_CF_ACCESS_AUD = AUD;
    process.env.AGENT_DECK_PUBLIC_ORIGIN = "https://deck.example.com";
    process.env.AGENT_DECK_CF_ACCESS_JWKS_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs`;
  }
  return startServer({ port: 0, host: "127.0.0.1", dataDir });
}

const call = async (profile: Profile, pathname: string, init: RequestInit = {}) => {
  const server = servers.get(profile)!;
  return fetch(`http://127.0.0.1:${server.port}${pathname}`, {
    ...init,
    headers: { "content-type": "application/json", ...headers[profile], ...(init.headers ?? {}) },
  });
};

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
  servers.set("desktop", await start("desktop"));
  servers.set("shared-server", await start("shared-server"));
  process.env = { ...savedEnv };
}, 60_000);

afterAll(async () => {
  for (const server of servers.values()) await server.close();
  await new Promise<void>((resolve) => jwks.close(() => resolve()));
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe.each<Profile>(["desktop", "shared-server"])("ADR 0008 matrix under %s", (profile) => {
  const shared = profile === "shared-server";

  it("reports the profile in the capabilities", async () => {
    const body = (await (await call(profile, "/settings")).json()) as {
      capabilities: { profile: string };
    };
    expect(body.capabilities.profile).toBe(profile);
  });

  it("reports the credential broker only on the shared server", async () => {
    const body = (await (await call(profile, "/settings")).json()) as {
      capabilities: { broker?: boolean };
    };
    expect(body.capabilities.broker).toBe(shared ? true : undefined);
  });

  it("refuses provider credentials in Environment only on the shared server", async () => {
    const response = await call(profile, "/runtime/env", {
      method: "PUT",
      body: JSON.stringify({ scope: "global", key: "ANTHROPIC_API_KEY", value: "x" }),
    });
    expect(response.status).toBe(shared ? 409 : 200);
  });

  it("adds the server's own Doctor checks only on the shared server", async () => {
    const body = (await (await call(profile, "/runtime/doctor")).json()) as {
      report: { checks: Array<{ id: string }> };
    };
    const ids = body.report.checks.map((check) => check.id);
    expect(ids.includes("server-sandbox")).toBe(shared);
    expect(ids.includes("server-git-identity")).toBe(shared);
    expect(ids.includes("server-broker")).toBe(shared);
  });

  it("records new sessions on its own side", async () => {
    const response = await call(profile, "/sessions", {
      method: "POST",
      body: JSON.stringify({ cwd: tmpdir() }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as {
      session: { location?: { kind: string } };
    };
    expect(session.location?.kind).toBe(shared ? "server" : "local");
  });
});
