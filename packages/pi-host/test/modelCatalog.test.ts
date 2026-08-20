import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { discoverModelCatalog, ModelCatalogError, parseModelCatalog } from "../src/modelCatalog.ts";
import type { PiProcessExit, PiProcessOptions } from "../src/PiProcess.ts";

class FakeCatalogProcess extends EventEmitter {
  readonly stop = vi.fn(async (): Promise<PiProcessExit> => {
    await Promise.resolve();
    return { code: null, signal: "SIGTERM" };
  });
  start(): void {}
}

const HEADER = "provider model context max-out thinking images";

function expectCode(error: unknown, code: string): boolean {
  expect(error).toBeInstanceOf(ModelCatalogError);
  expect((error as ModelCatalogError).code).toBe(code);
  return true;
}

describe("parseModelCatalog", () => {
  it("requires the pinned six-column header and parses token-spaced rows", () => {
    expect(
      parseModelCatalog([
        `  ${HEADER}  `,
        "mock     mock-model       128K   4K       yes       yes",
      ]),
    ).toEqual([
      {
        provider: "mock",
        id: "mock-model",
        contextWindow: 128_000,
        maxTokens: 4_000,
        reasoning: true,
        input: ["text", "image"],
      },
    ]);
    expect(() => parseModelCatalog(["provider model context max-out thinking"])).toThrow(
      ModelCatalogError,
    );
  });

  it("recognizes Pi's pinned three-line successful empty response", () => {
    expect(
      parseModelCatalog([
        "No models available. Use /login to log into a provider via OAuth or API key. See:",
        "  /opt/pi-coding-agent/docs/providers.md",
        "  /opt/pi-coding-agent/docs/models.md",
      ]),
    ).toEqual([]);
    expect(parseModelCatalog(["No models available"])).toEqual([]);
  });

  it("rejects lookalike empty responses", () => {
    expect(() =>
      parseModelCatalog([
        "No models available. Use /login to log into a provider via OAuth or API key. See:",
        "/tmp/providers.md",
        "/tmp/models.md",
      ]),
    ).toThrow(ModelCatalogError);
  });

  it("parses integer and decimal K/M display counts plus strict yes/no metadata", () => {
    expect(parseModelCatalog([HEADER, "mock model 1500000 1.5K no no"])).toEqual([
      {
        provider: "mock",
        id: "model",
        contextWindow: 1_500_000,
        maxTokens: 1_500,
        reasoning: false,
        input: ["text"],
      },
    ]);
    expect(parseModelCatalog([HEADER, "mock model 1.25M 2K yes no"])[0]?.contextWindow).toBe(
      1_250_000,
    );
  });

  it("rounds decimal K/M counts that are not binary-exact", () => {
    expect(parseModelCatalog([HEADER, "neuralwatt gemma-4-31b 262.1K 16.4K yes yes"])).toEqual([
      {
        provider: "neuralwatt",
        id: "gemma-4-31b",
        contextWindow: 262_100,
        maxTokens: 16_400,
        reasoning: true,
        input: ["text", "image"],
      },
    ]);
  });

  it.each([
    "mock model 128K 4K yes",
    "mock model 128K 4K yes yes extra",
    "mock model 0 4K yes yes",
    "mock model -1K 4K yes yes",
    "mock model 01K 4K yes yes",
    "mock model 1.2 4K yes yes",
    "mock model 1e3 4K yes yes",
    "mock model 1KB 4K yes yes",
    "mock model 0.0001K 4K yes yes",
    "mock model Infinity 4K yes yes",
    "mock model 128K 4K true yes",
    "mock model 128K 4K yes YES",
  ])("rejects malformed row %s", (row) => {
    expect(() => parseModelCatalog([HEADER, row])).toThrow(ModelCatalogError);
  });
});

describe("discoverModelCatalog", () => {
  it("uses isolated list flags and returns parsed models on a zero exit", async () => {
    const fake = new FakeCatalogProcess();
    let spawned: PiProcessOptions | undefined;
    const result = discoverModelCatalog({
      binPath: "/pi",
      cwd: "/home",
      extensions: ["/provider.ts"],
      processFactory: (options) => {
        spawned = options;
        queueMicrotask(() => {
          fake.emit("line", HEADER);
          fake.emit("line", "mock mock-model 128K 4K yes yes");
          fake.emit("exit", { code: 0, signal: null });
        });
        return fake;
      },
    });

    await expect(result).resolves.toEqual([
      {
        provider: "mock",
        id: "mock-model",
        contextWindow: 128_000,
        maxTokens: 4_000,
        reasoning: true,
        input: ["text", "image"],
      },
    ]);
    expect(spawned?.args).toEqual([
      "--list-models",
      "--no-extensions",
      "--extension",
      "/provider.ts",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
    ]);
    expect(fake.stop).not.toHaveBeenCalled();
  });

  it("maps nonzero exits to a sanitized typed error", async () => {
    const fake = new FakeCatalogProcess();
    const result = discoverModelCatalog({
      binPath: "/pi",
      cwd: "/home",
      processFactory: () => {
        queueMicrotask(() => fake.emit("exit", { code: 2, signal: null }));
        return fake;
      },
    });
    await expect(result).rejects.toSatisfy((error: unknown) => {
      expect(String(error)).not.toContain("stderr-secret");
      return expectCode(error, "process_failed");
    });
  });

  it("awaits exactly one stop on timeout", async () => {
    const fake = new FakeCatalogProcess();
    const result = discoverModelCatalog({
      binPath: "/pi",
      cwd: "/home",
      timeoutMs: 1,
      processFactory: () => fake,
    });
    await expect(result).rejects.toSatisfy((error: unknown) => expectCode(error, "timeout"));
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });

  it("awaits exactly one stop on abort and ignores a later exit", async () => {
    const fake = new FakeCatalogProcess();
    const controller = new AbortController();
    const result = discoverModelCatalog({
      binPath: "/pi",
      cwd: "/home",
      signal: controller.signal,
      processFactory: () => fake,
    });
    controller.abort();
    fake.emit("exit", { code: 0, signal: null });
    await expect(result).rejects.toSatisfy((error: unknown) => expectCode(error, "aborted"));
    expect(fake.stop).toHaveBeenCalledTimes(1);
  });
});
