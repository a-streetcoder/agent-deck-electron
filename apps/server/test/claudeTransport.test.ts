import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as PiHost from "@agent-deck/pi-host";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import {
  claudeChoice,
  claudeLaunchModel,
  discoveredUsable,
  unofferedLaunchModel,
} from "../src/claudeTransport.ts";
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
  "Claude through the Anthropic sign-in is not used. Add an Anthropic API key under Settings > Providers, pick the Claude model without the API badge, or refresh Models.";
// The host's Claude Code login (the claude-bridge source of truth), stubbed.
let claudeCodeLoggedIn = true;
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
  server = await startServer({ dataDir, claudeCodeLoggedIn: async () => claudeCodeLoggedIn });
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

  it("refuses a claude-bridge default when Claude Code is missing instead of letting Pi fall back", async () => {
    // PRV-02: without Claude Code the bridge provider never registers in Pi,
    // which then falls back to its own default: the refused sign-in.
    const settings = readFileSync(piSettingsFile, "utf8");
    writeFileSync(
      piSettingsFile,
      JSON.stringify({ defaultProvider: "claude-bridge", defaultModel: launchedTwin }),
    );
    claudeCodeLoggedIn = false;
    try {
      const launched = await launchPlan();
      expect(launched.status).toBe(409);
      expect(launched.body).toEqual({ error: REFUSED });
      expect(launched.plan).toBeUndefined();
    } finally {
      claudeCodeLoggedIn = true;
      writeFileSync(piSettingsFile, settings);
    }
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
    // A dated anthropic id matches its undated bridge alias.
    expect(claudeChoice("anthropic", "m-20251101", refused, bridge)).toEqual({
      provider: "claude-bridge",
      modelId: "m",
    });
    expect(claudeChoice("anthropic", "m", new Set(), [])).toEqual({
      provider: "anthropic",
      modelId: "m",
    });
  });

  it("previews the draft's launch model: the Pi default, or its bridge twin when refused", async () => {
    const draftModel = async () => {
      const { state } = (await (await fetch(endpoint(`/sessions/${sessionId}/state`))).json()) as {
        state: { model: { provider: string; id: string } | null };
      };
      return state.model && { provider: state.model.provider, id: state.model.id };
    };
    writeAuth(API_KEY);
    const modelId = (await anthropicModels())[0]!.id;
    writeFileSync(
      piSettingsFile,
      JSON.stringify({ defaultProvider: "anthropic", defaultModel: modelId }),
    );
    // The draft's plan names no provider: the chip previews the Pi settings default.
    expect(await draftModel()).toEqual({ provider: "anthropic", id: modelId });
    writeAuth(OAUTH);
    await discover([{ provider: "claude-bridge", id: modelId }]);
    expect(await draftModel()).toEqual({ provider: "claude-bridge", id: modelId });
    // No twin: nothing resolvable before the launch's own 409.
    await discover([]);
    expect(await draftModel()).toBeNull();
    writeAuth(API_KEY);
  });
});

describe("SRV-15a the model a fork inherits", () => {
  const catalog = [
    { provider: "anthropic", id: "claude-x" },
    { provider: "openrouter", id: "meta/llama" },
  ];
  // No owner: the operator's registry (no models.json) decides which providers Pi knows.
  const ctx = { rootsFor: () => ({ home: fakeHome }) } as never;
  const unoffered = (
    chosen: { provider?: string; model?: string },
    where: { sessionFile?: string; entryId?: string } = {},
    available: Array<{ provider: string; id: string }> = catalog,
  ) => unofferedLaunchModel(ctx, undefined, chosen, { cwd: dataDir, ...where }, available);

  it("names a concrete model the catalog lacks, ignoring the thinking suffix", async () => {
    expect(await unoffered({ provider: "openai-codex", model: "gpt-5.5:high" })).toBe(
      "openai-codex/gpt-5.5",
    );
    expect(await unoffered({ model: "openai-codex/gpt-5.5:max" })).toBe("openai-codex/gpt-5.5");
    expect(await unoffered({ provider: "anthropic", model: "claude-x:max" })).toBeUndefined();
    expect(await unoffered({ model: "anthropic/claude-x" })).toBeUndefined();
    expect(await unoffered({ model: "meta/llama" })).toBeUndefined();
  });

  it("reads a provider-prefixed model with its provider either way, still exactly", async () => {
    expect(
      await unoffered({ provider: "openrouter", model: "openrouter/meta/llama:high" }),
    ).toBeUndefined();
    expect(await unoffered({ provider: "anthropic", model: "anthropic/claude-x" })).toBeUndefined();
    expect(await unoffered({ provider: "openai-codex", model: "openai-codex/gpt-5.5" })).toBe(
      "openai-codex/gpt-5.5",
    );
    // The catalog's anthropic model is not offered under another provider.
    expect(await unoffered({ provider: "openai-codex", model: "claude-x" })).toBeUndefined();
  });

  it("pins a refused anthropic model with a thinking suffix on its bridge twin, keeping the suffix", async () => {
    writeAuth(OAUTH);
    const bridgeModel = {
      provider: "claude-bridge",
      id: "claude-haiku-4-5",
      contextWindow: 1000,
      maxTokens: 100,
      reasoning: false,
      input: ["text"],
    };
    const bridgeCtx = {
      rootsFor: () => ({ home: fakeHome }),
      settings: { get: () => ({ disabledModels: [] }) },
      discoveredModels: [bridgeModel],
      discoverModels: async () => {},
      claudeCodeLoggedIn: async () => true,
    } as never;
    expect(
      await claudeLaunchModel(
        bridgeCtx,
        undefined,
        { provider: "anthropic", model: "claude-haiku-4-5:high" },
        { cwd: dataDir },
      ),
    ).toEqual({ provider: "claude-bridge", model: "claude-haiku-4-5:high" });
  });

  it("leaves patterns and extension providers to Pi (agent models, claude-bridge)", async () => {
    expect(await unoffered({ model: "sonnet" })).toBeUndefined();
    expect(await unoffered({ provider: "anthropic", model: "sonnet" })).toBeUndefined();
    // No Models refresh since a restart: the bridge is not listed yet, the fork still runs.
    expect(
      await unoffered({ provider: "claude-bridge", model: "claude-opus-4-5" }, {}, []),
    ).toBeUndefined();
  });

  it("reads the model in force at the forked message, else the last one", async () => {
    const file = path.join(dataDir, "srv15a-history.jsonl");
    const timestamp = new Date().toISOString();
    const user = (id: string, parentId: string) => ({
      type: "message",
      id,
      parentId,
      timestamp,
      message: { role: "user", content: "hi", timestamp: 0 },
    });
    const change = (id: string, parentId: string | null, provider: string, modelId: string) => ({
      type: "model_change",
      id,
      parentId,
      timestamp,
      provider,
      modelId,
    });
    writeFileSync(
      file,
      [
        { type: "session", version: 3, id: "s", timestamp, cwd: dataDir },
        change("m1", null, "openai-codex", "gpt-5.5"),
        user("u1", "m1"),
        change("m2", "u1", "anthropic", "claude-x"),
        user("u2", "m2"),
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n"),
    );
    expect(await unoffered({}, { sessionFile: file })).toBeUndefined();
    expect(await unoffered({}, { sessionFile: file, entryId: "u1" })).toBe("openai-codex/gpt-5.5");
  });
});

describe("PRV-01 transport sources of truth", () => {
  const draftModels = async () =>
    (
      (await (await fetch(endpoint(`/sessions/${sessionId}/models`))).json()) as {
        models: Array<{ provider: string; id: string }>;
      }
    ).models;
  const discover = async (models: Array<{ provider: string; id: string }>) => {
    discovered.models = models;
    expect(
      (
        await fetch(endpoint("/runtime/models/discover"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(200);
  };

  it("classifies a subscription token pasted as an API key as OAuth", async () => {
    writeAuth({ type: "api_key", key: "sk-ant-oat01-subscription" });
    expect(await anthropicModels()).toEqual([]);
    expect(await anthropicProvider()).toMatchObject({ credentialType: "oauth" });
  });

  it("classifies env-only ANTHROPIC_OAUTH_TOKEN (and an oat ANTHROPIC_API_KEY) as OAuth", async () => {
    writeFileSync(authFile, "{}");
    try {
      process.env.ANTHROPIC_OAUTH_TOKEN = "sk-ant-oat01-env";
      process.env.ANTHROPIC_API_KEY = "sk-ant-api-real";
      // Pi prefers ANTHROPIC_OAUTH_TOKEN over ANTHROPIC_API_KEY.
      expect(await anthropicProvider()).toMatchObject({ credentialType: "oauth" });
      delete process.env.ANTHROPIC_OAUTH_TOKEN;
      expect(await anthropicProvider()).toMatchObject({ credentialType: "api_key" });
      process.env.ANTHROPIC_API_KEY = "sk-ant-oat01-env";
      expect(await anthropicProvider()).toMatchObject({ credentialType: "oauth" });
      expect(await anthropicModels()).toEqual([]);
    } finally {
      delete process.env.ANTHROPIC_OAUTH_TOKEN;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it("drops discovered anthropic entries once the API key is gone", async () => {
    writeAuth(API_KEY);
    const modelId = (await anthropicModels())[0]!.id;
    await discover([{ provider: "anthropic", id: `${modelId}-cached` }]);
    expect((await anthropicModels()).some((model) => model.id === `${modelId}-cached`)).toBe(true);
    writeFileSync(authFile, "{}");
    expect(await anthropicModels()).toEqual([]);
  });

  it("offers claude-bridge only while Claude Code is logged in", async () => {
    writeAuth(OAUTH);
    await discover([{ provider: "claude-bridge", id: "claude-x" }]);
    expect((await draftModels()).some((model) => model.provider === "claude-bridge")).toBe(true);
    claudeCodeLoggedIn = false;
    try {
      expect((await draftModels()).some((model) => model.provider === "claude-bridge")).toBe(false);
    } finally {
      claudeCodeLoggedIn = true;
    }
  });

  it("refuses a launch with no model and nothing usable instead of letting Pi pick the sign-in", async () => {
    writeAuth(OAUTH);
    writeFileSync(piSettingsFile, "{}");
    await discover([]);
    claudeCodeLoggedIn = false;
    const create = vi.spyOn(server.sessions, "create");
    try {
      const response = await fetch(endpoint("/sessions"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ cwd: dataDir, startImmediately: true }),
      });
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ error: REFUSED });
      expect(create).not.toHaveBeenCalled();
    } finally {
      create.mockRestore();
      claudeCodeLoggedIn = true;
    }
  });

  it("makes claude-bridge usable for every owner on the host login alone", () => {
    const transport = { refused: new Set(["anthropic"]), apiKey: new Set<string>(), bridge: true };
    // A trusted-proxy owner whose own runtime reports the bridge unconfigured.
    const ownerConfigured = (provider: string) => provider === "openai";
    expect(discoveredUsable("claude-bridge", transport, ownerConfigured)).toBe(true);
    expect(discoveredUsable("claude-bridge", { ...transport, bridge: false }, undefined)).toBe(
      false,
    );
    expect(discoveredUsable("anthropic", transport, undefined)).toBe(false);
    expect(
      discoveredUsable("anthropic", { ...transport, apiKey: new Set(["anthropic"]) }, undefined),
    ).toBe(true);
    expect(discoveredUsable("ext", transport, ownerConfigured)).toBe(false);
    expect(discoveredUsable("openai", transport, ownerConfigured)).toBe(true);
  });
});
