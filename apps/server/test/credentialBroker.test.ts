import { randomBytes } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta, UserIdentity } from "@agent-deck/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CredentialBroker, sessionModels, sessionPlaceholder } from "../src/credentialBroker.ts";
import { PROVIDER_CREDENTIAL_ENV_KEYS, withoutProviderCredentialEnv } from "../src/sessionEnv.ts";
import { USER_AGENT_LINK_DIRS, USER_AGENT_LINK_FILES } from "../src/userAgentDirs.ts";

// CRB-02. Fake sentinels only: the echo upstream reports PLACEHOLDER, real:<label>
// or other for each credential-bearing value, never the value itself.
const ALICE = "alice@example.com";
const BOB = "bob@example.com";
const CAROL = "carol@example.com";
const OPS = "ops@example.com";
const ALICE_KEY = "sk-test-alice-not-a-real-key";
const BOB_KEY = "sk-test-bob-not-a-real-key";
const ALICE_CLAUDE = "sk-ant-oat-test-alice-not-real";
const CONFIGURED_KEY = "sk-test-configured-not-real";
const ENV_KEY = "sk-test-env-not-real";
const NO_CLAIM_CODEX = "no-claim-codex-test-token";
const REAL_ACCOUNT = "acct-test-alice-not-real";
const b64url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");
const ALICE_CODEX = `${b64url({ alg: "none" })}.${b64url({
  "https://api.openai.com/auth": { chatgpt_account_id: REAL_ACCOUNT },
})}.sig-test`;
const SENTINELS: [string, string][] = [
  [ALICE_CODEX, "alice-codex"],
  [ALICE_KEY, "alice"],
  [BOB_KEY, "bob"],
  [ALICE_CLAUDE, "alice-claude"],
  [REAL_ACCOUNT, "account"],
  [CONFIGURED_KEY, "configured"],
  [ENV_KEY, "env"],
  [NO_CLAIM_CODEX, "no-claim"],
];
const label = (value: string | string[] | null | undefined): string => {
  if (value === undefined || value === null) return "absent";
  const text = Array.isArray(value) ? value.join(",") : value;
  if (text.includes("ph.") || text.includes("ph-acct-")) return "PLACEHOLDER";
  for (const [sentinel, name] of SENTINELS) if (text.includes(sentinel)) return `real:${name}`;
  return "other";
};
const report = (headers: IncomingHttpHeaders, url: URL) => ({
  path: url.pathname,
  authorization: label(headers.authorization),
  apiKey: label(headers["x-api-key"]),
  account: label(headers["chatgpt-account-id"]),
  key: label(url.searchParams.get("key")),
  plain: url.searchParams.get("plain"),
});

let dir: string;
let dataDir: string;
let shared: string;
let echo: Server;
let echoUrl: string;
let broker: CredentialBroker;
let upstreamUpgrades = 0;
const savedEnv = { ...process.env };
const sessions: Record<string, SessionMeta> = {};
const latest: Record<string, UserIdentity> = {};

const session = (id: string, owner: string, shares: string[] = []): SessionMeta => {
  const meta: SessionMeta = {
    id,
    cwd: "/tmp",
    createdAt: new Date().toISOString(),
    createdBy: { id: owner },
    ...(shares.length > 0
      ? {
          shares: Object.fromEntries(
            shares.map((user) => [user, { providers: "all" as const, at: "2026-10-18T00:00:00Z" }]),
          ),
        }
      : {}),
  };
  sessions[id] = meta;
  return meta;
};
const writeJson = (file: string, value: unknown): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(value));
};
const brokerUrl = (sessionId: string, provider: string, rest = ""): string =>
  `http://${broker.address}/${sessionId}/${broker.register(sessionId)}/${provider}${rest}`;
const placeholderOf = (sessionId: string) => sessionPlaceholder(broker.register(sessionId));
const spendLines = (): Record<string, unknown>[] => {
  const file = path.join(dataDir, "credential-spend.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};
const oauth = (access: string) => ({
  type: "oauth",
  access,
  refresh: "refresh-test-not-real",
  expires: Date.now() + 3_600_000,
});

beforeAll(async () => {
  // The server's env must not configure a provider for everyone.
  for (const name of PROVIDER_CREDENTIAL_ENV_KEYS) delete process.env[name];
  dir = mkdtempSync(path.join(tmpdir(), "deck-broker-"));
  dataDir = path.join(dir, "data");
  shared = path.join(dir, "shared");
  mkdirSync(dataDir);
  echo = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://echo");
    if (url.pathname.endsWith("/upload")) {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      request.pipe(response);
      return;
    }
    if (url.pathname.endsWith("/echo-header")) {
      // An upstream that hands a request header back in its response.
      response.writeHead(200, { "x-echo": request.headers.authorization ?? "" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(report(request.headers, url)));
  });
  echo.on("upgrade", (_request, socket) => {
    upstreamUpgrades += 1;
    socket.destroy();
  });
  await new Promise<void>((resolve) => echo.listen(0, "127.0.0.1", resolve));
  echoUrl = `http://127.0.0.1:${(echo.address() as AddressInfo).port}`;
  writeJson(path.join(shared, "models.json"), {
    providers: {
      openai: { baseUrl: `${echoUrl}/openai` },
      "openai-codex": { baseUrl: `${echoUrl}/codex-base` },
      anthropic: { baseUrl: `${echoUrl}/anthropic-api` },
      groq: { baseUrl: `${echoUrl}/groq`, apiKey: CONFIGURED_KEY },
    },
  });
  writeJson(path.join(shared, "auth.json"), {});
  const agentDir = (user: string) => path.join(dir, "agents", user);
  writeJson(path.join(agentDir(ALICE), "auth.json"), {
    openai: { type: "api_key", key: ALICE_KEY },
    "openai-codex": oauth(ALICE_CODEX),
  });
  writeJson(path.join(agentDir(BOB), "auth.json"), {
    openai: { type: "api_key", key: BOB_KEY },
    "openai-codex": oauth(NO_CLAIM_CODEX),
  });
  writeJson(path.join(agentDir(CAROL), "auth.json"), {});
  writeJson(path.join(agentDir(OPS), "auth.json"), {});
  writeJson(path.join(dir, "claude", ALICE, ".credentials.json"), {
    claudeAiOauth: { accessToken: ALICE_CLAUDE, expiresAt: Date.now() + 3_600_000 },
  });
  writeJson(path.join(dir, "claude", CAROL, ".credentials.json"), {
    claudeAiOauth: { accessToken: "sk-ant-oat-test-expired", expiresAt: Date.now() - 1000 },
  });
  broker = new CredentialBroker({
    dataDir,
    sharedAgentDir: () => shared,
    session: (id) => sessions[id],
    latestAuthor: (id) => latest[id],
    agentDirOf: (user) => agentDir(user.id),
    isOperator: (user) => user.id === OPS,
    claudeConfigDirOf: (user) => path.join(dir, "claude", user.id),
    host: "127.0.0.1",
    port: 0,
    claudeUpstream: `${echoUrl}/anthropic`,
  });
  await broker.start();
}, 30_000);

afterAll(async () => {
  await broker?.stop();
  await new Promise<void>((resolve) => echo?.close(() => resolve()));
  process.env = { ...savedEnv };
  rmSync(dir, { recursive: true, force: true });
});

describe("the session placeholder", () => {
  it("is JWT-shaped and decodes under pi-ai's extractAccountId algorithm", () => {
    const { key, account } = sessionPlaceholder("ab".repeat(32));
    const parts = key.split(".");
    expect(parts).toHaveLength(3);
    // pi-ai: JSON.parse(atob(parts[1]))["https://api.openai.com/auth"].chatgpt_account_id
    const payload = JSON.parse(atob(parts[1]!)) as Record<string, { chatgpt_account_id: string }>;
    expect(payload["https://api.openai.com/auth"]!.chatgpt_account_id).toBe(account);
  });
});

describe("the credential broker", () => {
  it("swaps bearer, x-api-key, key query and account placeholders for the sponsor's", async () => {
    session("s-swap", ALICE);
    const { key, account } = placeholderOf("s-swap");
    const response = await fetch(
      brokerUrl("s-swap", "openai", `/chat?key=${encodeURIComponent(key)}&plain=x%20y`),
      {
        headers: {
          authorization: `Bearer ${key}`,
          "x-api-key": key,
          "chatgpt-account-id": account,
        },
      },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/openai/chat",
      authorization: "real:alice",
      apiKey: "real:alice",
      // openai's key carries no account claim: the account placeholder stays.
      account: "PLACEHOLDER",
      key: "real:alice",
      plain: "x y",
    });
  });

  it("puts the Codex account id from the sponsor's own token claim", async () => {
    session("s-codex", ALICE);
    const { key, account } = placeholderOf("s-codex");
    const response = await fetch(brokerUrl("s-codex", "openai-codex", "/codex/responses"), {
      headers: { authorization: `Bearer ${key}`, "chatgpt-account-id": account },
    });
    expect(await response.json()).toMatchObject({
      path: "/codex-base/codex/responses",
      authorization: "real:alice-codex",
      account: "real:account",
    });
  });

  it("refuses a Codex sign-in whose token carries no account claim", async () => {
    session("s-no-claim", BOB);
    const { key, account } = placeholderOf("s-no-claim");
    const response = await fetch(brokerUrl("s-no-claim", "openai-codex", "/codex/responses"), {
      headers: { authorization: `Bearer ${key}`, "chatgpt-account-id": account },
    });
    expect(response.status).toBe(401);
  });

  it("picks the author's own subscription, then a sharer's, else refuses", async () => {
    const ask = async (sessionId: string) =>
      fetch(brokerUrl(sessionId, "openai", "/x"), {
        headers: { authorization: `Bearer ${placeholderOf(sessionId).key}` },
      });
    session("s-own", BOB, [ALICE]);
    expect(await (await ask("s-own")).json()).toMatchObject({ authorization: "real:bob" });
    // The running turn's author goes first, ahead of the owner.
    session("s-author", BOB);
    latest["s-author"] = { id: ALICE };
    expect(await (await ask("s-author")).json()).toMatchObject({ authorization: "real:alice" });
    session("s-shared", CAROL, [BOB]);
    expect(await (await ask("s-shared")).json()).toMatchObject({ authorization: "real:bob" });
    session("s-none", CAROL);
    const refused = await ask("s-none");
    expect(refused.status).toBe(401);
    expect(((await refused.json()) as { error: string }).error).toMatch(
      /openai needs a subscription/,
    );
  });

  it("qualifies only a candidate's own credential; env keys sponsor nobody", async () => {
    const ask = async (sessionId: string, provider: string) => {
      const { key } = placeholderOf(sessionId);
      return fetch(brokerUrl(sessionId, provider, "/x"), {
        headers: { authorization: `Bearer ${key}`, "x-api-key": key },
      });
    };
    process.env.ANTHROPIC_API_KEY = ENV_KEY;
    try {
      session("s-env", CAROL);
      expect((await ask("s-env", "anthropic")).status).toBe(401);
      // Not even the operator spends the server's env.
      session("s-env-ops", OPS);
      expect((await ask("s-env-ops", "anthropic")).status).toBe(401);
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
    // A key configured in the shared models.json: the operator's to spend, nobody else's.
    session("s-configured-ops", OPS);
    expect(await (await ask("s-configured-ops", "groq")).json()).toMatchObject({
      authorization: "real:configured",
    });
    session("s-configured-alice", ALICE);
    expect((await ask("s-configured-alice", "groq")).status).toBe(401);
  });

  it("refuses a placeholder outside the credential headers and the key parameter", async () => {
    session("s-400", ALICE);
    const { key, account } = placeholderOf("s-400");
    const header = await fetch(brokerUrl("s-400", "openai", "/x"), {
      headers: { "x-custom": `token ${key}` },
    });
    expect(header.status).toBe(400);
    const query = await fetch(brokerUrl("s-400", "openai", `/x?q=${encodeURIComponent(key)}`));
    expect(query.status).toBe(400);
    const accountQuery = await fetch(brokerUrl("s-400", "openai", `/x?a=${account}`));
    expect(accountQuery.status).toBe(400);
    expect(await accountQuery.text()).toBe("");
  });

  it("masks the credential in response headers again", async () => {
    session("s-mask", ALICE);
    const { key } = placeholderOf("s-mask");
    const response = await fetch(brokerUrl("s-mask", "openai", "/echo-header"), {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(response.headers.get("x-echo")).toBe(`Bearer ${key}`);
  });

  it("answers 404 for a bad token, an unknown session or a forgotten one", async () => {
    session("s-404", ALICE);
    broker.register("s-404");
    const bad = await fetch(`http://${broker.address}/s-404/${"0".repeat(64)}/openai/x`);
    expect(bad.status).toBe(404);
    const unknown = await fetch(brokerUrl("s-unknown", "openai", "/x"));
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("");
    const url = brokerUrl("s-404", "openai", "/x");
    broker.forget("s-404");
    expect((await fetch(url)).status).toBe(404);
  });

  it("brokers a one-shot helper with its requester as sponsor until forgotten (CRB-03)", async () => {
    // No session record: the helper is known to the broker only.
    const helper: SessionMeta = {
      id: "helper-test-1",
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
      createdBy: { id: ALICE },
    };
    broker.registerTransient(helper);
    const { key } = placeholderOf(helper.id);
    const url = brokerUrl(helper.id, "openai", "/chat");
    const response = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    expect(response.status).toBe(200);
    expect(((await response.json()) as { authorization: string }).authorization).toBe("real:alice");
    expect(spendLines().at(-1)).toMatchObject({ sessionId: helper.id, sponsor: ALICE });
    broker.forget(helper.id);
    const gone = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
    expect(gone.status).toBe(404);
    // Its record went with the token: a fresh token finds no session either.
    expect((await fetch(brokerUrl(helper.id, "openai", "/chat"))).status).toBe(404);
  });

  it("brokers Claude Code with the sponsor's sign-in", async () => {
    session("s-claude", ALICE);
    const { key } = placeholderOf("s-claude");
    const response = await fetch(brokerUrl("s-claude", "claude-code", "/v1/messages"), {
      method: "POST",
      headers: { authorization: `Bearer ${key}` },
      body: "{}",
    });
    expect(await response.json()).toMatchObject({
      path: "/anthropic/v1/messages",
      authorization: "real:alice-claude",
    });
    session("s-claude-none", BOB);
    expect((await fetch(brokerUrl("s-claude-none", "claude-code", "/v1/messages"))).status).toBe(
      401,
    );
  });

  it("refuses an expired Claude Code sign-in without naming its owner", async () => {
    session("s-claude-expired", CAROL);
    const response = await fetch(brokerUrl("s-claude-expired", "claude-code", "/v1/messages"));
    expect(response.status).toBe(401);
    const { error } = (await response.json()) as { error: string };
    expect(error).toMatch(/a participant's Claude Code sign-in has expired/i);
    expect(error).not.toContain(CAROL);
  });

  it("streams a 1 MB body up and back unchanged", async () => {
    session("s-body", ALICE);
    const body = randomBytes(1024 * 1024);
    const response = await fetch(brokerUrl("s-body", "openai", "/upload"), {
      method: "POST",
      body,
    });
    expect(Buffer.from(await response.arrayBuffer()).equals(body)).toBe(true);
  });

  it("refuses a WebSocket upgrade with 426 and opens no upstream connection", async () => {
    session("s-ws", ALICE);
    const { key, account } = placeholderOf("s-ws");
    const ws = new WebSocket(
      brokerUrl("s-ws", "openai-codex", "/codex/responses").replace("http:", "ws:"),
      { headers: { authorization: `Bearer ${key}`, "chatgpt-account-id": account } },
    );
    const status = await new Promise<number | undefined>((resolve) => {
      ws.on("unexpected-response", (_request, response) => resolve(response.statusCode));
      ws.on("open", () => resolve(101));
      ws.on("error", () => resolve(undefined));
    });
    ws.terminate();
    expect(status).toBe(426);
    expect(upstreamUpgrades).toBe(0);
  });

  it("logs one spend line per upstream request and per refusal, without credentials", async () => {
    const before = spendLines().length;
    session("s-spend", CAROL, [BOB]);
    latest["s-spend"] = { id: CAROL };
    await (await fetch(brokerUrl("s-spend", "openai", "/a"))).text();
    await (await fetch(brokerUrl("s-spend", "openai", "/b"))).text();
    session("s-spend-refused", CAROL);
    await (await fetch(brokerUrl("s-spend-refused", "openai", "/a"))).text();
    // The line is written when the response closes, just after the body ends.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const lines = spendLines().slice(before);
    const mine = lines.filter((line) => line.sessionId === "s-spend");
    expect(mine).toHaveLength(2);
    expect(mine[0]).toMatchObject({ provider: "openai", sponsor: BOB, author: CAROL, status: 200 });
    const refused = lines.filter((line) => line.sessionId === "s-spend-refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ status: 401, author: CAROL });
    expect(refused[0]).not.toHaveProperty("sponsor");
    const text = readFileSync(path.join(dataDir, "credential-spend.jsonl"), "utf8");
    for (const [sentinel] of SENTINELS) expect(text).not.toContain(sentinel);
  });
});

describe("the session's models.json", () => {
  it("points every provider at the broker with the placeholder, without baseUrls or headers", () => {
    const models = sessionModels(
      {
        providers: {
          custom: {
            api: "openai-completions",
            apiKey: "${CUSTOM_KEY}",
            baseUrl: "https://custom.example/v1",
            headers: { "x-secret": "${CUSTOM_SECRET}" },
            models: [{ id: "m1", baseUrl: "https://elsewhere.example", headers: { a: "b" } }],
            modelOverrides: {
              m2: { baseUrl: "https://other.example", headers: { a: "b" }, name: "M2" },
            },
          },
        },
        other: true,
      },
      ["openai", "openai-codex", "custom"],
      "http://10.0.0.2:4211/s1/tok",
      "ph.x.tok",
    );
    expect(models).toEqual({
      other: true,
      providers: {
        custom: {
          api: "openai-completions",
          apiKey: "ph.x.tok",
          baseUrl: "http://10.0.0.2:4211/s1/tok/custom",
          models: [{ id: "m1" }],
          modelOverrides: { m2: { name: "M2" } },
        },
        openai: { baseUrl: "http://10.0.0.2:4211/s1/tok/openai", apiKey: "ph.x.tok" },
        "openai-codex": { baseUrl: "http://10.0.0.2:4211/s1/tok/openai-codex", apiKey: "ph.x.tok" },
      },
    });
  });

  it("strips every credential from a provider nobody in the session can sponsor", () => {
    const models = sessionModels(
      {
        providers: {
          custom: {
            api: "openai-completions",
            apiKey: "${CUSTOM_KEY}",
            baseUrl: "https://custom.example/v1",
            headers: { "x-secret": "${CUSTOM_SECRET}" },
            models: [{ id: "m1", headers: { a: "b" } }],
          },
          bare: { apiKey: "sk-literal-operator-key" },
        },
      },
      ["openai-codex"],
      "http://10.0.0.2:4211/s1/tok",
      "ph.x.tok",
    );
    expect(models.providers).toEqual({
      custom: {
        api: "openai-completions",
        baseUrl: "https://custom.example/v1",
        models: [{ id: "m1" }],
      },
      "openai-codex": { baseUrl: "http://10.0.0.2:4211/s1/tok/openai-codex", apiKey: "ph.x.tok" },
    });
    expect(JSON.stringify(models)).not.toContain("sk-literal");
  });

  it("strips every provider credential from a brokered launch env", () => {
    process.env.AWS_SECRET_ACCESS_KEY = "aws-test-not-real";
    const env = withoutProviderCredentialEnv({
      ANTHROPIC_API_KEY: "x",
      OPENAI_API_KEY: "y",
      A: "1",
    });
    delete process.env.AWS_SECRET_ACCESS_KEY;
    expect(env.A).toBe("1");
    // Unset over the inherited env, not just absent: spawn drops an undefined value.
    for (const name of [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "AWS_SECRET_ACCESS_KEY",
      "AWS_BEARER_TOKEN_BEDROCK",
      "AWS_ACCESS_KEY_ID",
      "AWS_SESSION_TOKEN",
    ]) {
      expect(name in env).toBe(true);
      expect(env[name]).toBeUndefined();
    }
  });
});

// Windows without Developer Mode refuses symlinks (EPERM); the shared server runs these.
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

describe.skipIf(!canSymlink)("the session's agent dir", () => {
  it("holds an {} auth.json, the shared links and its own models.json", () => {
    const meta = session("s-dir", ALICE);
    const env = broker.launchEnv(meta);
    const agentDir = path.join(dataDir, "sandbox", "s-dir", "agent");
    const token = broker.register("s-dir");
    const { key } = sessionPlaceholder(token);
    expect(env).toEqual({
      PI_CODING_AGENT_DIR: agentDir,
      ANTHROPIC_BASE_URL: `http://${broker.address}/s-dir/${token}/claude-code`,
      CLAUDE_CODE_OAUTH_TOKEN: key,
      CLAUDE_CONFIG_DIR: path.join(dataDir, "sandbox", "s-dir", "claude"),
      NO_PROXY: "",
      no_proxy: "",
    });
    expect(readFileSync(path.join(agentDir, "auth.json"), "utf8")).toBe("{}");
    for (const name of [...USER_AGENT_LINK_DIRS, ...USER_AGENT_LINK_FILES]) {
      if (name === "models.json") continue;
      expect(lstatSync(path.join(agentDir, name)).isSymbolicLink()).toBe(true);
    }
    // `except`: models.json is the session's own file, not the shared link.
    const modelsFile = path.join(agentDir, "models.json");
    expect(lstatSync(modelsFile).isFile()).toBe(true);
    const models = JSON.parse(readFileSync(modelsFile, "utf8")) as {
      providers: Record<string, { baseUrl: string; apiKey: string }>;
    };
    expect(models.providers.openai).toEqual({
      baseUrl: `http://${broker.address}/s-dir/${token}/openai`,
      apiKey: key,
    });
    expect(Object.keys(models.providers)).toEqual(
      expect.arrayContaining(["openai", "openai-codex", "anthropic", "groq"]),
    );
    for (const provider of Object.values(models.providers)) {
      expect(provider.baseUrl.startsWith(`http://${broker.address}/s-dir/`)).toBe(true);
      expect(provider.apiKey).toBe(key);
    }
    const text = readFileSync(modelsFile, "utf8");
    for (const [sentinel] of SENTINELS) expect(text).not.toContain(sentinel);
    // A second launch keeps the token and rewrites the file in place.
    expect(broker.launchEnv(meta).CLAUDE_CODE_OAUTH_TOKEN).toBe(key);
    expect(lstatSync(modelsFile).isFile()).toBe(true);
  });

  it("gives a one-shot helper its own brokered agent dir (CRB-03)", () => {
    const helper: SessionMeta = {
      id: "helper-test-2",
      cwd: "/tmp",
      createdAt: new Date().toISOString(),
      createdBy: { id: ALICE },
    };
    broker.registerTransient(helper);
    const env = broker.launchEnv(helper);
    expect(env.PI_CODING_AGENT_DIR).toBe(path.join(dataDir, "sandbox", helper.id, "agent"));
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(placeholderOf(helper.id).key);
    broker.forget(helper.id);
  });
});
