import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyResourceTree,
  createLoopCatalogFile,
  LoopCatalogCapabilityError,
  readResourceCatalogFile,
  scanLoopCatalog,
  writeResourceCatalogFile,
} from "../src/index.ts";
import type { ResourceCatalogCapabilityError } from "../src/index.ts";

describe("native Loop catalog binding", () => {
  it("round-trips UTF-8 and returns stable basename errors", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-native-ts-"));
    createLoopCatalogFile(home, "safe.loop.md", "héllo");
    expect(scanLoopCatalog(home)).toEqual([{ basename: "safe.loop.md", content: "héllo" }]);
    expect(() => createLoopCatalogFile(home, "../bad.loop.md", "bad")).toThrow(
      expect.objectContaining<Partial<LoopCatalogCapabilityError>>({
        code: "LOOP_CATALOG_INVALID_BASENAME",
      }),
    );
  });

  it("exposes resource operations through stable typed errors", () => {
    const home = mkdtempSync(path.join(tmpdir(), "resource-native-ts-"));
    writeResourceCatalogFile(home, "global-prompts", ["safe.md"], "héllo");
    expect(readResourceCatalogFile(home, "global-prompts", ["safe.md"])).toBe("héllo");
    expect(() => writeResourceCatalogFile(home, "global-prompts", ["..", "bad.md"], "bad")).toThrow(
      expect.objectContaining<Partial<ResourceCatalogCapabilityError>>({
        code: "RESOURCE_INVALID_PATH",
      }),
    );
  });

  it("replaces an existing resource directory exactly", () => {
    const home = mkdtempSync(path.join(tmpdir(), "resource-replace-ts-"));
    const source = path.join(home, "source");
    mkdirSync(path.join(source, "asset"), { recursive: true });
    writeFileSync(path.join(source, "SKILL.md"), "one");
    writeFileSync(path.join(source, "asset", "stale"), "stale");
    copyResourceTree(home, "global-skills", ["replace-me"], source);
    rmSync(path.join(source, "asset"), { recursive: true });
    writeFileSync(path.join(source, "asset"), "now-file");
    writeFileSync(path.join(source, "SKILL.md"), "two");
    copyResourceTree(home, "global-skills", ["replace-me"], source, true);
    expect(readResourceCatalogFile(home, "global-skills", ["replace-me", "asset"])).toBe(
      "now-file",
    );
    expect(readResourceCatalogFile(home, "global-skills", ["replace-me", "SKILL.md"])).toBe("two");
  });

  it("never exposes native path details through typed wrapper errors", () => {
    const home = mkdtempSync(path.join(tmpdir(), "loop-native-error-"));
    const secret = path.join(home, "secret");
    writeFileSync(secret, "safe");
    let captured: unknown;
    try {
      createLoopCatalogFile(home, "NUL.loop.md", "bad");
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(LoopCatalogCapabilityError);
    expect(String(captured)).not.toContain(home);
    expect(readFileSync(secret, "utf8")).toBe("safe");
  });
});
