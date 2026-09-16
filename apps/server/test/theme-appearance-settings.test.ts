import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SettingsStore } from "../src/persistence.ts";

const freshDir = (): string => mkdtempSync(path.join(tmpdir(), "agent-deck-appearance-"));

describe("theme appearance settings", () => {
  it("defaults to auto without persisting the default", () => {
    const dir = freshDir();
    const store = new SettingsStore(dir);

    expect(store.get().appearance).toBe("auto");
    store.update({});
    expect(
      JSON.parse(readFileSync(path.join(dir, "app-settings.json"), "utf8")),
    ).not.toHaveProperty("appearance");
  });

  it("persists explicit light and dark overrides", () => {
    const dir = freshDir();
    new SettingsStore(dir).update({ appearance: "dark" });
    expect(new SettingsStore(dir).get().appearance).toBe("dark");

    new SettingsStore(dir).update({ appearance: "light" });
    expect(new SettingsStore(dir).get().appearance).toBe("light");
  });

  it("coerces an invalid persisted value back to auto", () => {
    const dir = freshDir();
    new SettingsStore(dir).update({ appearance: "dark" });
    const file = path.join(dir, "app-settings.json");
    const persisted = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    persisted.appearance = "sepia";
    writeFileSync(file, JSON.stringify(persisted));

    expect(new SettingsStore(dir).get().appearance).toBe("auto");
  });
});
