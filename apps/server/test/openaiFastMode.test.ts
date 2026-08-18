import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  fastModeConfigKey,
  isFastModeActive,
  isOpenAIFastEligible,
  writeOpenAIFastConfig,
  writeOpenAIFastExtension,
} from "../src/openaiFastMode.ts";

const dir = (): string => mkdtempSync(path.join(tmpdir(), "agent-deck-fast-"));

describe("OpenAI Fast mode (SES-34)", () => {
  it("admits only the models native admits", () => {
    // Native's rule (PiNativeSubagentBridgeExtensions.isOpenAIFastEligibleModel):
    // provider openai-codex, base model gpt-5.4/gpt-5.5, suffix ignored.
    expect(isOpenAIFastEligible("openai-codex", "gpt-5.4")).toBe(true);
    expect(isOpenAIFastEligible("openai-codex", "gpt-5.5")).toBe(true);
    expect(isOpenAIFastEligible("openai-codex", "gpt-5.4:thinking")).toBe(true);
    expect(isOpenAIFastEligible("openai-codex", "gpt-5.3")).toBe(false);
    expect(isOpenAIFastEligible("openai", "gpt-5.4")).toBe(false);
    expect(isOpenAIFastEligible("anthropic", "claude-opus-5")).toBe(false);
    expect(isOpenAIFastEligible("openai-codex", "")).toBe(false);
  });

  it("keys the config the way the extension reads it, not the way we store it", () => {
    // We persist `provider:id`; the extension looks up `provider/baseModel`.
    expect(fastModeConfigKey("openai-codex", "gpt-5.4:thinking")).toBe("openai-codex/gpt-5.4");
    expect(fastModeConfigKey("openai-codex", "gpt-5.5")).toBe("openai-codex/gpt-5.5");
    expect(fastModeConfigKey("openai", "gpt-5.4")).toBeUndefined();
  });

  it("writes sorted enabled models and rewrites only when the bytes change", () => {
    const home = dir();
    const file = writeOpenAIFastConfig(home, ["openai-codex:gpt-5.5", "openai-codex:gpt-5.4"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      enabledModels: ["openai-codex/gpt-5.4", "openai-codex/gpt-5.5"],
    });

    // Native rewrites only when the bytes differ, so an unchanged setting does
    // not churn a file every launch.
    const before = statSync(file).mtimeMs;
    writeOpenAIFastConfig(home, ["openai-codex:gpt-5.4", "openai-codex:gpt-5.5"]);
    expect(statSync(file).mtimeMs).toBe(before);

    writeOpenAIFastConfig(home, []);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ enabledModels: [] });
  });

  it("drops ineligible keys rather than advertising them to the extension", () => {
    const home = dir();
    const file = writeOpenAIFastConfig(home, ["anthropic:claude-opus-5", "openai-codex:gpt-5.4"]);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      enabledModels: ["openai-codex/gpt-5.4"],
    });
  });

  it("writes an extension that gates on provider, api, model, config and OAuth", () => {
    const home = dir();
    const file = writeOpenAIFastExtension(home);
    const source = readFileSync(file, "utf8");
    // Every gate native applies must survive the port; a missing one silently
    // upgrades a request the user never opted into.
    expect(source).toContain("openai-codex");
    expect(source).toContain("openai-codex-responses");
    expect(source).toContain("gpt-5.4");
    expect(source).toContain("gpt-5.5");
    expect(source).toContain("isUsingOAuth");
    expect(source).toContain("before_provider_request");
    expect(source).toContain("service_tier");
    expect(source).toContain("priority");
    expect(source).toContain("AGENT_DECK_OPENAI_FAST_CONFIG");
  });

  it("is inert on an empty config, which is why an unused launch need not load it", () => {
    // The extension no-ops when nothing is enabled, but "inert" is not "absent":
    // attaching it to every launch changed what pi loads for everyone and broke
    // the real-pi suite on all three platforms, so server.ts attaches it only
    // while a model is marked Fast. This pins the property that makes that guard
    // safe — an empty config authorizes nothing.
    const home = dir();
    const file = writeOpenAIFastConfig(home, []);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ enabledModels: [] });
    expect(isFastModeActive([], "openai-codex", "gpt-5.4")).toBe(false);
  });

  it("leaves an unreadable extension file rewritten rather than half-written", () => {
    const home = dir();
    const file = writeOpenAIFastExtension(home);
    writeFileSync(file, "corrupt");
    expect(readFileSync(writeOpenAIFastExtension(home), "utf8")).toContain("service_tier");
  });
});
