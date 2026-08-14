import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/persistence.ts";

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-deck-memory-settings-"));
}

describe("agent memory pause preference persistence", () => {
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
