import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createAnalytics,
  launchModelProps,
  type AnalyticsOptions,
  type AnalyticsTransport,
} from "../src/analytics.ts";
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

function setup(overrides: Partial<AnalyticsOptions> = {}) {
  const sent: Parameters<AnalyticsTransport["capture"]>[0][] = [];
  let created = 0;
  const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-analytics-"));
  const analytics = createAnalytics({
    enabled: () => true,
    key: "phc_test",
    dataDir,
    appVersion: "1.2.3",
    sharedServer: false,
    testMode: false,
    transport: () => {
      created += 1;
      return { capture: (message) => sent.push(message), shutdown: async () => undefined };
    },
    ...overrides,
  });
  return { analytics, sent, dataDir, transports: () => created };
}

describe("analytics", () => {
  it("sends only the allow-listed props plus appVersion and platform, keyed by the install id", async () => {
    const { analytics, sent, dataDir } = setup();
    expect(analytics.available).toBe(true);
    analytics.track("session_created", {
      provider: "anthropic",
      model: "claude-sonnet-4",
      cwd: "C:\\work\\secret-repo",
      title: "my private chat",
    });
    analytics.track("app_started");
    await analytics.shutdown();
    const installId = readFileSync(path.join(dataDir, "install-id"), "utf8").trim();
    expect(installId).toMatch(/^[0-9a-f-]{36}$/);
    expect(sent[0]).toEqual({
      distinctId: installId,
      event: "session_created",
      properties: {
        provider: "anthropic",
        model: "claude-sonnet-4",
        appVersion: "1.2.3",
        platform: `${process.platform}-${process.arch}`,
      },
    });
    expect(sent[1]?.distinctId).toBe(installId);
  });

  it("drops path-like and whitespace values", async () => {
    const { analytics, sent } = setup();
    analytics.track("session_created", { provider: "/home/me/repo" });
    analytics.track("session_moved", { direction: "to my server" });
    analytics.track("mcp_server_connected", { transport: "C:\\tools\\mcp.exe" });
    await analytics.shutdown();
    expect(sent.map((message) => Object.keys(message.properties))).toEqual([
      ["appVersion", "platform"],
      ["appVersion", "platform"],
      ["appVersion", "platform"],
    ]);
  });

  it.each([
    ["the user turned it off", { enabled: () => false }],
    ["on the shared server", { sharedServer: true }],
    ["under NODE_ENV=test / AGENT_DECK_TEST=1", { testMode: undefined }],
    ["without a key", { key: undefined }],
  ])("makes zero requests when %s", async (_case, overrides) => {
    const { analytics, sent, transports } = setup(overrides);
    analytics.track("app_started");
    analytics.track("loop_started");
    await analytics.shutdown();
    expect(sent).toEqual([]);
    expect(transports()).toBe(0);
    expect(analytics.active()).toBe(false);
  });

  describe("when sending fails", () => {
    function failing(fetch: (...args: unknown[]) => Promise<unknown>) {
      return createAnalytics({
        enabled: () => true,
        key: "phc_test",
        dataDir: mkdtempSync(path.join(tmpdir(), "agent-deck-analytics-fail-")),
        appVersion: "1.2.3",
        sharedServer: false,
        testMode: false,
        requestTimeoutMs: 50,
        fetch: fetch as unknown as typeof globalThis.fetch,
      });
    }
    async function silently(run: () => Promise<void>): Promise<string[]> {
      const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
      try {
        await run();
        expect(error).not.toHaveBeenCalled();
        return info.mock.calls
          .map((call) => String(call[0]))
          .filter((line) => line.startsWith("[analytics]"));
      } finally {
        error.mockRestore();
        info.mockRestore();
      }
    }

    it("stays silent on a network error: one info line, no SDK console.error", async () => {
      const fetch = vi.fn(async () => {
        throw new Error("network down");
      });
      const lines = await silently(async () => {
        const analytics = failing(fetch);
        analytics.track("app_started");
        analytics.track("loop_started");
        await analytics.shutdown();
      });
      expect(fetch).toHaveBeenCalled();
      expect(lines).toEqual([
        "[analytics] sending usage counts failed (not retried): network down",
      ]);
    });

    it("bounds a request that never settles and aborts it, before the SDK deadlines", async () => {
      const signals: AbortSignal[] = [];
      const fetch = vi.fn((_url: unknown, init: unknown) => {
        signals.push((init as RequestInit).signal!);
        return new Promise(() => undefined);
      });
      const started = Date.now();
      const lines = await silently(async () => {
        const analytics = failing(fetch);
        analytics.track("app_started");
        await analytics.shutdown();
      });
      expect(Date.now() - started).toBeLessThan(1500);
      expect(signals.length).toBeGreaterThan(0);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(lines).toEqual([
        "[analytics] sending usage counts failed (not retried): no answer within 50 ms",
      ]);
    });

    it("cancels the body of an HTTP error response", async () => {
      const cancel = vi.fn(async () => undefined);
      const fetch = vi.fn(async () => ({
        status: 503,
        body: { cancel },
        text: async () => "unavailable",
        json: async () => ({}),
      }));
      const lines = await silently(async () => {
        const analytics = failing(fetch);
        analytics.track("app_started");
        await analytics.shutdown();
      });
      expect(cancel).toHaveBeenCalled();
      expect(lines).toEqual(["[analytics] sending usage counts failed (not retried): HTTP 503"]);
    });
  });
});

describe("launchModelProps", () => {
  it("sends Pi's built-in ids as is, with a thinking suffix stripped", () => {
    expect(launchModelProps({ provider: "anthropic", model: "claude-haiku-4-5" })).toEqual({
      provider: "anthropic",
      model: "claude-haiku-4-5",
    });
    expect(
      launchModelProps({ provider: "openrouter", model: "anthropic/claude-haiku-4.5:high" }),
    ).toEqual({ provider: "openrouter", model: "anthropic/claude-haiku-4.5" });
    // The bridge serves Pi's built-in Anthropic list.
    expect(launchModelProps({ provider: "claude-bridge", model: "claude-haiku-4-5" })).toEqual({
      provider: "claude-bridge",
      model: "claude-haiku-4-5",
    });
  });

  it("reports a private models.json id under a built-in provider as custom", () => {
    // Such an entry is in the launch catalog (ownerCatalog); only Pi's static list counts.
    expect(launchModelProps({ provider: "openai", model: "customer-x-private" })).toEqual({
      provider: "openai",
      model: "custom",
    });
    expect(launchModelProps({ provider: "claude-bridge", model: "customer-x-private" })).toEqual({
      provider: "claude-bridge",
      model: "custom",
    });
  });

  it("reports custom providers and a missing provider as custom", () => {
    expect(launchModelProps({ provider: "acme-internal", model: "client-x-model" })).toEqual({
      provider: "custom",
      model: "custom",
    });
    expect(launchModelProps({ model: "claude-haiku-4-5" })).toEqual({
      provider: "custom",
      model: "custom",
    });
    expect(launchModelProps({ kind: "parent" })).toEqual({});
  });

  it("keeps / and : in a model id through track, never a backslash or whitespace", async () => {
    const { analytics, sent } = setup();
    analytics.track(
      "session_created",
      launchModelProps({ provider: "openrouter", model: "anthropic/claude-fable-5:batch" }),
    );
    analytics.track("session_created", { model: "a b" });
    analytics.track("session_created", { model: "a\\b" });
    await analytics.shutdown();
    expect(sent.map((message) => message.properties.model)).toEqual([
      "anthropic/claude-fable-5:batch",
      undefined,
      undefined,
    ]);
  });
});

describe("analytics settings", () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-analytics-settings-"));
  let server: AgentDeckServer | undefined;
  afterAll(async () => server?.close());
  const read = async (headers: Record<string, string> = {}) =>
    (await (await fetch(`http://127.0.0.1:${server!.port}/settings`, { headers })).json()) as {
      settings: { analyticsEnabled: boolean; analyticsNoticeSeen: boolean };
      capabilities: { analytics: boolean; sandbox: { provider: string }; profile: string };
    };

  it("defaults on with the notice unseen, and PATCH /settings persists both", async () => {
    server = await startServer({ dataDir });
    const first = await read();
    expect(first.settings).toMatchObject({ analyticsEnabled: true, analyticsNoticeSeen: false });
    expect(first.capabilities.analytics).toBe(false); // AGENT_DECK_TEST=1
    // ADR 0007: a desktop (no trusted proxy) runs sessions without a sandbox.
    expect(first.capabilities.sandbox).toEqual({ provider: "none" });
    expect(first.capabilities.profile).toBe("desktop"); // ADR 0008: no trusted proxy in tests
    const patch = (body: unknown) =>
      fetch(`http://127.0.0.1:${server!.port}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    // Turning it off also retires the one-time notice.
    expect((await patch({ analyticsEnabled: false })).status).toBe(200);
    await server.close();
    server = await startServer({ dataDir });
    expect((await read()).settings).toMatchObject({
      analyticsEnabled: false,
      analyticsNoticeSeen: true,
    });
  });

  it("reports analytics off, the notice seen and no capability on the shared server", async () => {
    const TEAM = "team.cloudflareaccess.test";
    const AUD = "aud-analytics";
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwks = createServer((_request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k1", alg: "RS256" }],
        }),
      );
    });
    await new Promise<void>((resolve) => jwks.listen(0, "127.0.0.1", resolve));
    const saved = { ...process.env };
    const sharedDir = mkdtempSync(path.join(tmpdir(), "agent-deck-analytics-shared-"));
    let shared: AgentDeckServer | undefined;
    try {
      process.env.AGENT_DECK_TRUSTED_PROXY = "cloudflare";
      process.env.AGENT_DECK_CF_ACCESS_TEAM_DOMAIN = TEAM;
      process.env.AGENT_DECK_CF_ACCESS_AUD = AUD;
      process.env.AGENT_DECK_CF_ACCESS_JWKS_URL = `http://127.0.0.1:${(jwks.address() as AddressInfo).port}/certs`;
      shared = await startServer({ dataDir: sharedDir });
      const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      const signed = `${b64({ alg: "RS256", kid: "k1" })}.${b64({
        iss: `https://${TEAM}`,
        aud: [AUD],
        iat: now,
        exp: now + 300,
        email: "alice@example.com",
        name: "Alice",
      })}`;
      const signature = sign("RSA-SHA256", Buffer.from(signed), privateKey).toString("base64url");
      const response = await fetch(`http://127.0.0.1:${shared.port}/settings`, {
        headers: { "cf-access-jwt-assertion": `${signed}.${signature}` },
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as Awaited<ReturnType<typeof read>>;
      expect(body.settings).toMatchObject({ analyticsEnabled: false, analyticsNoticeSeen: true });
      expect(body.capabilities.analytics).toBe(false);
    } finally {
      await shared?.close();
      await new Promise<void>((resolve) => jwks.close(() => resolve()));
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });
});
