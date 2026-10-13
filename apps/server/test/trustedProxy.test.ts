import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccessTokenError,
  CloudflareAccessVerifier,
  extractAccessToken,
  isLoopbackAddress,
  trustedProxyConfigFromEnv,
} from "../src/trustedProxy.ts";

const TEAM = "team.cloudflareaccess.test";
const AUD = "aud-1234";

interface SigningKey {
  kid: string;
  privateKey: KeyObject;
  jwk: Record<string, unknown>;
}

function makeKey(kid: string): SigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { kid, privateKey, jwk: { ...publicKey.export({ format: "jwk" }), kid, alg: "RS256" } };
}

const b64 = (value: unknown): string =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

function mint(
  key: SigningKey,
  claims: Record<string, unknown>,
  header: Record<string, unknown> = { alg: "RS256", kid: key.kid },
): string {
  const signed = `${b64(header)}.${b64(claims)}`;
  const signature = sign("RSA-SHA256", Buffer.from(signed), key.privateKey);
  return `${signed}.${signature.toString("base64url")}`;
}

const nowSeconds = Math.floor(Date.now() / 1000);
const validClaims = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: `https://${TEAM}`,
  aud: [AUD],
  iat: nowSeconds - 10,
  exp: nowSeconds + 600,
  email: "Ale@Example.com",
  name: "Ale",
  ...extra,
});

describe("CloudflareAccessVerifier", () => {
  const keyA = makeKey("key-a");
  const keyB = makeKey("key-b");
  let served: SigningKey[] = [keyA];
  let jwksRequests = 0;
  let jwks: Server;
  let jwksUrl: string;

  beforeAll(async () => {
    jwks = createServer((_request, response) => {
      jwksRequests += 1;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ keys: served.map((key) => key.jwk) }));
    });
    await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
    jwksUrl = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs`;
  });
  afterAll(async () => {
    await new Promise<void>((resolve) => jwks.close(() => resolve()));
  });

  const verifier = () => new CloudflareAccessVerifier({ teamDomain: TEAM, aud: AUD }, { jwksUrl });

  it("accepts a valid assertion and normalizes the email into the user id", async () => {
    const user = await verifier().verify(mint(keyA, validClaims()));
    expect(user).toEqual({ id: "ale@example.com", email: "ale@example.com", name: "Ale" });
  });

  it("caches JWKS keys and refreshes only on an unknown kid", async () => {
    let clock = Date.now();
    const subject = new CloudflareAccessVerifier(
      { teamDomain: TEAM, aud: AUD },
      { jwksUrl, now: () => clock },
    );
    const before = jwksRequests;
    await subject.verify(mint(keyA, validClaims()));
    await subject.verify(mint(keyA, validClaims()));
    expect(jwksRequests).toBe(before + 1);
    // Key rotation: the new kid is unknown; within the refresh floor it is refused,
    // after it the JWKS is fetched again and the new key accepted.
    served = [keyA, keyB];
    await expect(subject.verify(mint(keyB, validClaims()))).rejects.toThrow("unknown signing key");
    clock += CloudflareAccessVerifier.MIN_REFRESH_MS + 1;
    await expect(subject.verify(mint(keyB, validClaims()))).resolves.toMatchObject({
      email: "ale@example.com",
    });
    expect(jwksRequests).toBe(before + 2);
    served = [keyA];
  });

  it("rejects an expired assertion", async () => {
    await expect(
      verifier().verify(mint(keyA, validClaims({ exp: nowSeconds - 1 }))),
    ).rejects.toThrow("expired");
  });

  it("rejects the wrong audience", async () => {
    await expect(
      verifier().verify(mint(keyA, validClaims({ aud: ["someone-else"] }))),
    ).rejects.toThrow("bad audience");
    await expect(
      verifier().verify(mint(keyA, validClaims({ aud: "someone-else" }))),
    ).rejects.toThrow("bad audience");
  });

  it("rejects the wrong issuer and an implausible iat", async () => {
    await expect(
      verifier().verify(mint(keyA, validClaims({ iss: "https://other.example" }))),
    ).rejects.toThrow("bad issuer");
    await expect(
      verifier().verify(mint(keyA, validClaims({ iat: nowSeconds + 3600 }))),
    ).rejects.toThrow("bad iat");
  });

  it("rejects a bad signature, even with a trusted kid", async () => {
    const rogue = makeKey("key-a"); // same kid, different private key
    await expect(verifier().verify(mint(rogue, validClaims()))).rejects.toThrow("bad signature");
    const tampered = mint(keyA, validClaims()).replace(/\.[^.]+$/, ".AAAA");
    await expect(verifier().verify(tampered)).rejects.toThrow("bad signature");
  });

  it("rejects malformed tokens, non-RS256 headers, and missing email", async () => {
    const subject = verifier();
    await expect(subject.verify("")).rejects.toBeInstanceOf(AccessTokenError);
    await expect(subject.verify("a.b")).rejects.toThrow("malformed token");
    await expect(subject.verify("a.b.c")).rejects.toThrow("malformed token");
    await expect(
      subject.verify(mint(keyA, validClaims(), { alg: "none", kid: keyA.kid })),
    ).rejects.toThrow("unsupported alg");
    await expect(subject.verify(mint(keyA, validClaims({ email: undefined })))).rejects.toThrow(
      "missing email",
    );
  });
});

describe("extractAccessToken", () => {
  it("prefers the header cloudflared injects and falls back to the Access cookie", () => {
    expect(extractAccessToken({ "cf-access-jwt-assertion": "hdr" })).toBe("hdr");
    expect(extractAccessToken({ cookie: "a=1; CF_Authorization=cookie.tok.en; b=2" })).toBe(
      "cookie.tok.en",
    );
    expect(extractAccessToken({ cookie: "a=1" })).toBeUndefined();
    expect(extractAccessToken({})).toBeUndefined();
  });
});

describe("isLoopbackAddress", () => {
  it("accepts only loopback peers", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("::1")).toBe(true);
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopbackAddress("10.0.0.12")).toBe(false);
    expect(isLoopbackAddress(undefined)).toBe(false);
  });
});

describe("trustedProxyConfigFromEnv", () => {
  it("is off unless AGENT_DECK_TRUSTED_PROXY=cloudflare", () => {
    expect(trustedProxyConfigFromEnv({})).toBeNull();
    expect(trustedProxyConfigFromEnv({ AGENT_DECK_TRUSTED_PROXY: "nginx" })).toBeNull();
  });
  it("requires the team domain and audience, and normalizes the public origin", () => {
    expect(() => trustedProxyConfigFromEnv({ AGENT_DECK_TRUSTED_PROXY: "cloudflare" })).toThrow();
    expect(
      trustedProxyConfigFromEnv({
        AGENT_DECK_TRUSTED_PROXY: "cloudflare",
        AGENT_DECK_CF_ACCESS_TEAM_DOMAIN: TEAM,
        AGENT_DECK_CF_ACCESS_AUD: AUD,
        AGENT_DECK_PUBLIC_ORIGIN: "https://deck.example.com/some/path",
      }),
    ).toEqual({ teamDomain: TEAM, aud: AUD, publicOrigin: "https://deck.example.com" });
  });
});
