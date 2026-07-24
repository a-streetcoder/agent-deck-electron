import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createLoopCatalogFile,
  LoopCatalogCapabilityError,
  scanLoopCatalog,
} from "../src/index.ts";

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
