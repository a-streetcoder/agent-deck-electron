import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { reconcileNeuralWattCatalog } from "../src/neuralwattCatalog.ts";

function makeHome(): string {
  return mkdtempSync(path.join(tmpdir(), "neuralwatt-home-"));
}

function modelsFile(home: string): string {
  return path.join(home, ".pi", "agent", "models.json");
}

function readModels(home: string): Record<string, unknown> {
  return JSON.parse(readFileSync(modelsFile(home), "utf8")) as Record<string, unknown>;
}

function writeModels(home: string, value: unknown): void {
  mkdirSync(path.dirname(modelsFile(home)), { recursive: true });
  writeFileSync(modelsFile(home), typeof value === "string" ? value : JSON.stringify(value));
}

const catalog = {
  data: [
    {
      id: "glm-5.2",
      metadata: {
        display_name: "GLM 5.2",
        capabilities: { reasoning: true, vision: true, reasoning_effort: true },
        limits: { max_context_length: 200000, max_output_tokens: 8192 },
        pricing: { input_per_million: 0.6, output_per_million: 2.2, cached_input_per_million: 0.1 },
      },
    },
    {
      id: "watt-mini",
      metadata: {
        display_name: "Watt Mini",
        capabilities: {},
        limits: {},
        pricing: {},
      },
    },
  ],
};

const providers = (home: string): Record<string, { models?: { id: string }[] }> =>
  (readModels(home).providers ?? {}) as Record<string, { models?: { id: string }[] }>;

describe("NeuralWatt catalog sync (SES-33)", () => {
  it("writes the live catalog as a pi provider block when a key exists", async () => {
    const home = makeHome();
    const ids = await reconcileNeuralWattCatalog(
      { home },
      { hasRealKey: true, fetchCatalog: async () => catalog },
    );

    expect(ids).toEqual(["glm-5.2", "watt-mini"]);
    const block = providers(home).neuralwatt as Record<string, unknown>;
    expect(block.baseUrl).toBe("https://api.neuralwatt.com/v1");
    expect(block.api).toBe("openai-completions");
    expect(block.authHeader).toBe(true);
    // Pi refuses a custom provider that declares models without an apiKey field;
    // the real key comes from auth.json at a higher priority, so this literal is
    // only there to satisfy that loader check.
    expect(block.apiKey).toBe("placeholder");
    expect(block.compat).toEqual({ supportsDeveloperRole: false });

    const models = block.models as Record<string, unknown>[];
    expect(models[0]).toMatchObject({
      id: "glm-5.2",
      name: "GLM 5.2",
      reasoning: true,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 8192,
      compat: { supportsReasoningEffort: true },
      cost: { input: 0.6, output: 2.2, cacheRead: 0.1, cacheWrite: 0 },
    });
    // No reported output cap means the field is OMITTED, so a reader shows a dash
    // instead of inheriting pi's 16384 default; and reasoning-effort is a curated
    // allowlist, not whatever the endpoint advertises.
    expect(models[1]).toMatchObject({ id: "watt-mini", reasoning: false, input: ["text"] });
    expect(models[1]!.maxTokens).toBeUndefined();
    expect(models[1]!.compat).toBeUndefined();
    expect(models[1]!.contextWindow).toBe(131072);
  });

  it("removes the block when no key is stored, and never touches other providers", async () => {
    const home = makeHome();
    writeModels(home, {
      providers: {
        neuralwatt: { name: "NeuralWatt", models: [{ id: "stale" }] },
        someone_else: { name: "Other", models: [{ id: "keep" }] },
      },
    });

    const ids = await reconcileNeuralWattCatalog(
      { home },
      {
        hasRealKey: false,
        fetchCatalog: async () => {
          throw new Error("must not fetch without a key");
        },
      },
    );

    expect(ids).toEqual([]);
    expect(providers(home).neuralwatt).toBeUndefined();
    expect(providers(home).someone_else?.models?.[0]?.id).toBe("keep");
  });

  it("leaves what is on disk alone when the fetch fails, is unparseable, or is empty", async () => {
    for (const fetchCatalog of [
      async () => {
        throw new Error("network down");
      },
      async () => ({ nonsense: true }),
      async () => ({ data: [] }),
    ]) {
      const home = makeHome();
      writeModels(home, {
        providers: { neuralwatt: { name: "NeuralWatt", models: [{ id: "old" }] } },
      });
      await reconcileNeuralWattCatalog({ home }, { hasRealKey: true, fetchCatalog });
      // A flaky endpoint must not empty a working provider block.
      expect(providers(home).neuralwatt?.models?.[0]?.id).toBe("old");
    }
  });

  it("backs up an unreadable models.json, keeping its exact bytes", async () => {
    const home = makeHome();
    const corrupt = '{ "providers": { "someone_else": broken';
    writeModels(home, corrupt);
    await reconcileNeuralWattCatalog(
      { home },
      { hasRealKey: true, fetchCatalog: async () => catalog },
    );
    expect(providers(home).neuralwatt).toBeDefined();
    // Assert the BACKUP, not just the rewritten file: without this the test
    // passed even if the copy never happened (Codex).
    const directory = path.dirname(modelsFile(home));
    const backup = readdirSync(directory).find((name) => name.startsWith("models.json.bak-"));
    expect(backup).toBeDefined();
    expect(readFileSync(path.join(directory, backup!), "utf8")).toBe(corrupt);
  });

  it("leaves an unreadable models.json untouched when it cannot be backed up", async () => {
    const home = makeHome();
    const corrupt = '{ "providers": { "someone_else": broken';
    writeModels(home, corrupt);
    const directory = path.dirname(modelsFile(home));
    // A backup that cannot be written used to be swallowed, and the reconcile
    // then replaced the original with a file holding only our block — the user's
    // other providers gone with no copy anywhere. Freeze the clock so the backup
    // path is known, then occupy it with a directory: a REAL copy failure, no
    // filesystem mocking.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-17T00:00:00.000Z"));
    mkdirSync(path.join(directory, `models.json.bak-${Date.now()}`), { recursive: true });
    try {
      const ids = await reconcileNeuralWattCatalog(
        { home },
        { hasRealKey: true, fetchCatalog: async () => catalog },
      );
      expect(ids).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
    expect(readFileSync(modelsFile(home), "utf8")).toBe(corrupt);
  });

  it("does not rewrite a models.json whose providers value is not an object", async () => {
    const home = makeHome();
    const odd = JSON.stringify({ providers: ["not", "a", "map"], keepMe: true });
    writeModels(home, odd);
    const ids = await reconcileNeuralWattCatalog(
      { home },
      { hasRealKey: true, fetchCatalog: async () => catalog },
    );
    expect(ids).toEqual([]);
    expect(readFileSync(modelsFile(home), "utf8")).toBe(odd);
  });
});
