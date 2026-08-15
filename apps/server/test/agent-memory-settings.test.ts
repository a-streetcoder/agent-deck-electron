import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/persistence.ts";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-deck-memory-settings-"));
}

describe("agent memory settings persistence", () => {
  it("matches native defaults and persisted budget decoding", () => {
    const fresh = new SettingsStore(freshDir()).get();
    expect(fresh.agentMemoryInjectionCharacterBudget).toBe(6000);
    expect(fresh.agentMemorySubagentsEnabled).toBe(true);

    const lowDir = freshDir();
    writeFileSync(
      path.join(lowDir, "app-settings.json"),
      JSON.stringify({
        agentMemoryInjectionCharacterBudget: 12,
        agentMemorySubagentsEnabled: "yes",
      }),
    );
    expect(new SettingsStore(lowDir).get()).toMatchObject({
      agentMemoryInjectionCharacterBudget: 1000,
      agentMemorySubagentsEnabled: true,
    });

    const highDir = freshDir();
    writeFileSync(
      path.join(highDir, "app-settings.json"),
      JSON.stringify({ agentMemoryInjectionCharacterBudget: 99999 }),
    );
    expect(new SettingsStore(highDir).get().agentMemoryInjectionCharacterBudget).toBe(99999);
  });

  it("omits shipped budget/child defaults and round-trips non-defaults", () => {
    const defaultsDir = freshDir();
    new SettingsStore(defaultsDir).update({
      agentMemoryInjectionCharacterBudget: 6000,
      agentMemorySubagentsEnabled: true,
    });
    const defaults = JSON.parse(
      readFileSync(path.join(defaultsDir, "app-settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(defaults).not.toHaveProperty("agentMemoryInjectionCharacterBudget");
    expect(defaults).not.toHaveProperty("agentMemorySubagentsEnabled");

    const customDir = freshDir();
    new SettingsStore(customDir).update({
      agentMemoryInjectionCharacterBudget: 3500,
      agentMemorySubagentsEnabled: false,
    });
    expect(new SettingsStore(customDir).get()).toMatchObject({
      agentMemoryInjectionCharacterBudget: 3500,
      agentMemorySubagentsEnabled: false,
    });
  });
  it("defaults missing and malformed values to enabled", () => {
    expect(new SettingsStore(freshDir()).get().agentMemoryEnabled).toBe(true);

    const dir = freshDir();
    const file = path.join(dir, "app-settings.json");
    writeFileSync(file, JSON.stringify({ agentMemoryEnabled: "paused" }));
    expect(new SettingsStore(dir).get().agentMemoryEnabled).toBe(true);
  });

  it("omits enabled for byte stability and persists a pause across restart", () => {
    const enabledDir = freshDir();
    new SettingsStore(enabledDir).update({ agentMemoryEnabled: true });
    const enabled = JSON.parse(
      readFileSync(path.join(enabledDir, "app-settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(enabled).not.toHaveProperty("agentMemoryEnabled");

    const pausedDir = freshDir();
    new SettingsStore(pausedDir).update({ agentMemoryEnabled: false });
    expect(
      JSON.parse(readFileSync(path.join(pausedDir, "app-settings.json"), "utf8")),
    ).toMatchObject({ agentMemoryEnabled: false });
    expect(new SettingsStore(pausedDir).get().agentMemoryEnabled).toBe(false);
  });
});
