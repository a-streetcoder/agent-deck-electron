import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as PiHost from "@agent-deck/pi-host";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { claudeChoice } from "../src/claudeTransport.ts";
import { startServer, type AgentDeckServer } from "../src/index.ts";

// The extension-discovered catalog (claude-bridge), without spawning Pi.
const discovered = vi.hoisted(() => ({
  models: [] as Array<{ provider: string; id: string }>,
  calls: 0,
}));
vi.mock("@agent-deck/pi-host", async (importOriginal) => ({
  ...(await importOriginal<typeof PiHost>()),
  discoverModelCatalog: async () =>
    ++discovered.calls &&
    discovered.models.map((model) => ({
      ...model,
      contextWindow: 1000,
      maxTokens: 100,
      reasoning: false,
      input: ["text"],
    })),
}));

// PRV-01: Pi's Anthropic OAuth sign-in impersonates Claude Code, so `anthropic/*`
// is offered and accepted only with an API key; Claude otherwise runs through
// claude-bridge.
const dataDir = mkdtempSync(path.join(tmpdir(), "deck-claude-transport-"));
const fakeHome = mkdtempSync(path.join(tmpdir(), "deck-claude-transport-home-"));
const authFile = path.join(fakeHome, ".pi", "agent", "auth.json");
const piSettingsFile = path.join(fakeHome, ".pi", "agent", "settings.json");
const savedEnv = { ...process.env };
const REFUSED =
  "Claude through the Anthropic sign-in is not used. Add an Anthropic API key under Settings > Providers, or pick the Claude model without the API badge.";
let server: AgentDeckServer;
let sessionId: string;
const endpoint = (pathname: string) => `http://127.0.0.1:${server.port}${pathname}`;

const writeAuth = (anthropic: unknown) => writeFileSync(authFile, JSON.stringify({ anthropic }));
const OAUTH = { type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 };
const API_KEY = { type: "api_key", key: "sk-ant-test" };

const anthropicModels = async () =>
  (
    (await (await fetch(endpoint(`/sessions/${sessionId}/models`))).json()) as {
      models: Array<{ provider: string; id: string }>;
    }
  ).models.filter((model) => model.provider === "anthropic");

const setModel = (modelId: string) =>
  new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
    socket.on("open", () =>
      socket.send(
        JSON.stringify({
          id: 3,
          request: { type: "set_model", sessionId, provider: "anthropic", modelId },
        }),
      ),
    );
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString()) as { kind: string; id?: number; ok: boolean };
      if (frame.kind !== "reply" || frame.id !== 3) return;
      socket.close();
      resolve(frame);
    });
    socket.on("error", reject);
  });

const anthropicProvider = async () =>
  (
    (await (await fetch(endpoint("/runtime/providers"))).json()) as {
      providers: Array<{ id: string; supportsOAuth: boolean; credentialType?: string }>;
    }
  ).providers.find((provider) => provider.id === "anthropic");

beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_OAUTH_TOKEN;
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: fakeHome });
  mkdirSync(path.dirname(authFile), { recursive: true });
  writeAuth(API_KEY);
  server = await startServer({ dataDir });
  const created = await fetch(endpoint("/sessions"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cwd: dataDir, startImmediately: false }),
  });
  expect(created.status).toBe(201);
  sessionId = ((await created.json()) as { session: { id: string } }).session.id;
});
afterAll(async () => {
  await server.close();
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  if (process.platform !== "win32") {
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(fakeHome, { recursive: true, force: true });
  }
});

describe("PRV-01 anthropic needs an API key", () => {
  it("lists and accepts anthropic models with an API key", async () => {
    writeAuth(API_KEY);
    const models = await anthropicModels();
    expect(models.length).toBeGreaterThan(0);
    expect(await setModel(models[0]!.id)).toMatchObject({ ok: true });
    expect(await anthropicProvider()).toMatchObject({
      supportsOAuth: false,
      credentialType: "api_key",
    });
  });

  it("hides and refuses anthropic models backed only by the OAuth sign-in", async () => {
    writeAuth(API_KEY);
    const modelId = (await anthropicModels())[0]!.id;
    writeAuth(OAUTH);
    expect(await anthropicModels()).toEqual([]);
    expect(await setModel(modelId)).toMatchObject({ ok: false, error: REFUSED });
    expect(await anthropicProvider()).toMatchObject({
      supportsOAuth: false,
      credentialType: "oauth",
    });
    const login = await fetch(endpoint("/runtime/providers/anthropic/login"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authType: "oauth" }),
    });
    expect(login.status).toBe(400);
  });
});

describe("PRV-01 launch and set_model choices", () => {
  let launchedTwin = "";
  const discover = async (models: Array<{ provider: string; id: string }>) => {
    discovered.models = models;
    const response = await fetch(endpoint("/runtime/models/discover"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(response.status).toBe(200);
  };
  // Capture the plan a launch would spawn with, without spawning Pi.
  const launchPlans = async (count: number) => {
    const create = vi.spyOn(server.sessions, "create").mockImplementation(() => {
      throw new Error("not spawned in this test");
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: count }, () =>
          fetch(endpoint("/sessions"), {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cwd: dataDir, startImmediately: true }),
          }),
        ),
      );
      const plans = create.mock.calls.map(
        (call) => call[0].plan as { provider?: string; model?: string },
      );
      return await Promise.all(
        responses.map(async (response, index) => ({
          status: response.status,
          body: (await response.json()) as unknown,
          plan: plans[index],
        })),
      );
    } finally {
      create.mockRestore();
    }
  };
  const launchPlan = async () => (await launchPlans(1))[0]!;

  it("launches a Pi-default anthropic model on its claude-bridge twin", async () => {
    writeAuth(API_KEY);
    const modelId = (await anthropicModels())[0]!.id;
    writeFileSync(
      piSettingsFile,
      JSON.stringify({ defaultProvider: "anthropic", defaultModel: modelId }),
    );
    writeAuth(OAUTH);
    await discover([{ provider: "claude-bridge", id: modelId }]);
    const launched = await launchPlan();
    expect(launched.plan).toMatchObject({ provider: "claude-bridge", model: modelId });
    launchedTwin = modelId;
  });

  it("runs the discovery once when the bridge catalog is missing (after a restart)", async () => {
    const modelId = launchedTwin;
    await discover([]); // the list a restart leaves: no claude-bridge entry
    discovered.models = [{ provider: "claude-bridge", id: modelId }];
    const before = discovered.calls;
    const [first, second] = await launchPlans(2);
    expect(discovered.calls - before).toBe(1);
    expect(first!.plan).toMatchObject({ provider: "claude-bridge", model: modelId });
    expect(second!.plan).toMatchObject({ provider: "claude-bridge", model: modelId });
  });

  it("refuses the launch with the stable 409 when no bridge twin exists", async () => {
    // Within the retry window a list without the twin is not rediscovered.
    await discover([]);
    const launched = await launchPlan();
    expect(launched.status).toBe(409);
    expect(launched.body).toEqual({ error: REFUSED });
    expect(launched.plan).toBeUndefined();
  });

  it("leaves an API-key owner's anthropic default alone", async () => {
    writeAuth(API_KEY);
    const launched = await launchPlan();
    expect(launched.plan).toBeDefined();
    expect(launched.plan?.provider).not.toBe("claude-bridge");
  });

  it("maps a set_model choice onto the bridge twin or refuses it", () => {
    const refused = new Set(["anthropic"]);
    const bridge = [{ provider: "claude-bridge", id: "m" }];
    expect(claudeChoice("anthropic", "m", refused, bridge)).toEqual({
      provider: "claude-bridge",
      modelId: "m",
    });
    expect(() => claudeChoice("anthropic", "other", refused, bridge)).toThrow(REFUSED);
    expect(claudeChoice("anthropic", "m", new Set(), [])).toEqual({
      provider: "anthropic",
      modelId: "m",
    });
  });
});
