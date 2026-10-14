import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startServer, type AgentDeckServer } from "../src/index.ts";

// PRV-01: Pi's Anthropic OAuth sign-in impersonates Claude Code, so `anthropic/*`
// is offered and accepted only with an API key; Claude otherwise runs through
// claude-bridge.
const dataDir = mkdtempSync(path.join(tmpdir(), "deck-claude-transport-"));
const fakeHome = mkdtempSync(path.join(tmpdir(), "deck-claude-transport-home-"));
const authFile = path.join(fakeHome, ".pi", "agent", "auth.json");
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
