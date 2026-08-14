import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SettingsStore } from "../src/persistence.ts";

const originalSemanticEnv = process.env.AGENT_DECK_SEMANTIC_MEMORY;

function freshDir(): string {
  return mkdtempSync(path.join(tmpdir(), "agent-deck-semantic-settings-"));
}

function restoreEnv(): void {
  if (originalSemanticEnv === undefined) delete process.env.AGENT_DECK_SEMANTIC_MEMORY;
  else process.env.AGENT_DECK_SEMANTIC_MEMORY = originalSemanticEnv;
}

afterEach(restoreEnv);

describe("semantic memory preference persistence", () => {
  it("defaults false when the field and legacy environment seed are absent", () => {
    delete process.env.AGENT_DECK_SEMANTIC_MEMORY;
    expect(new SettingsStore(freshDir()).get().semanticMemoryEnabled).toBe(false);
  });

  it("eagerly persists the legacy environment seed and keeps it after env removal/restart", () => {
    process.env.AGENT_DECK_SEMANTIC_MEMORY = "1";
    const dir = freshDir();
    expect(new SettingsStore(dir).get().semanticMemoryEnabled).toBe(true);
    expect(JSON.parse(readFileSync(path.join(dir, "app-settings.json"), "utf8"))).toMatchObject({
      semanticMemoryEnabled: true,
    });

    delete process.env.AGENT_DECK_SEMANTIC_MEMORY;
    expect(new SettingsStore(dir).get().semanticMemoryEnabled).toBe(true);
  });

  it("eagerly seeds an existing settings file when only the preference is absent", () => {
    process.env.AGENT_DECK_SEMANTIC_MEMORY = "1";
    const dir = freshDir();
    writeFileSync(path.join(dir, "app-settings.json"), JSON.stringify({ autoTitle: false }));
    expect(new SettingsStore(dir).get()).toMatchObject({
      autoTitle: false,
      semanticMemoryEnabled: true,
    });
    expect(JSON.parse(readFileSync(path.join(dir, "app-settings.json"), "utf8"))).toMatchObject({
      autoTitle: false,
      semanticMemoryEnabled: true,
    });
  });

  it("retains explicit false across restart even while the legacy environment is 1", () => {
    process.env.AGENT_DECK_SEMANTIC_MEMORY = "1";
    const dir = freshDir();
    const store = new SettingsStore(dir);
    expect(store.get().semanticMemoryEnabled).toBe(true);
    store.update({ semanticMemoryEnabled: false });

    expect(JSON.parse(readFileSync(path.join(dir, "app-settings.json"), "utf8"))).toMatchObject({
      semanticMemoryEnabled: false,
    });
    expect(new SettingsStore(dir).get().semanticMemoryEnabled).toBe(false);
  });

  it("omits an untouched false default for byte stability", () => {
    delete process.env.AGENT_DECK_SEMANTIC_MEMORY;
    const dir = freshDir();
    new SettingsStore(dir).update({});
    const persisted = JSON.parse(
      readFileSync(path.join(dir, "app-settings.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(persisted).not.toHaveProperty("semanticMemoryEnabled");
  });

  it("preserves corrupt JSON byte-for-byte and fails closed under the legacy env", () => {
    process.env.AGENT_DECK_SEMANTIC_MEMORY = "1";
    const dir = freshDir();
    const file = path.join(dir, "app-settings.json");
    const corrupt = '{"autoTitle":false';
    writeFileSync(file, corrupt);

    expect(new SettingsStore(dir).get().semanticMemoryEnabled).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(corrupt);
  });

  it.each(["null", "[]", '"settings"'])(
    "preserves non-object settings %s byte-for-byte and fails closed under the legacy env",
    (nonObject) => {
      process.env.AGENT_DECK_SEMANTIC_MEMORY = "1";
      const dir = freshDir();
      const file = path.join(dir, "app-settings.json");
      writeFileSync(file, nonObject);

      expect(new SettingsStore(dir).get().semanticMemoryEnabled).toBe(false);
      expect(readFileSync(file, "utf8")).toBe(nonObject);
    },
  );

  it("fails a malformed persisted field closed and preserves it until explicit mutation", () => {
    process.env.AGENT_DECK_SEMANTIC_MEMORY = "1";
    const dir = freshDir();
    const file = path.join(dir, "app-settings.json");
    const malformed = JSON.stringify({ semanticMemoryEnabled: "yes" });
    writeFileSync(file, malformed);
    const store = new SettingsStore(dir);
    expect(store.get().semanticMemoryEnabled).toBe(false);
    expect(readFileSync(file, "utf8")).toBe(malformed);

    store.update({});
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({
      semanticMemoryEnabled: false,
    });
  });
});
