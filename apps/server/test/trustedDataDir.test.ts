import { existsSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveTrustedDataDir } from "../src/trustedDataDir.ts";

describe("resolveTrustedDataDir", () => {
  it("creates a missing nested dir and returns its authoritative physical path", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "trusted-datadir-"));
    const target = path.join(parent, "missing", "app-data");
    const resolved = resolveTrustedDataDir(target);
    expect(existsSync(target)).toBe(true);
    expect(resolved).toBe(realpathSync(target));
  });

  it("REJECTS a symlinked data root (a link can't redirect all app data)", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "trusted-datadir-link-"));
    const outside = mkdtempSync(path.join(tmpdir(), "trusted-datadir-target-"));
    const sentinel = path.join(outside, "sentinel");
    writeFileSync(sentinel, "safe");
    const linked = path.join(parent, "app-data");
    symlinkSync(outside, linked, process.platform === "win32" ? "junction" : "dir");

    expect(() => resolveTrustedDataDir(linked)).toThrow(/trusted data directory/i);
    // The link's target is never touched.
    expect(existsSync(sentinel)).toBe(true);
  });

  it("rejects a relative path", () => {
    expect(() => resolveTrustedDataDir("relative/data")).toThrow(/absolute/i);
  });
});
