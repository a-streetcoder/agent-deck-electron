import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  bundledClaudeBridgeExtension,
  ensureClaudeBridgeConfig,
  resolveClaudeCodeExecutable,
} from "../src/claudeBridge.ts";

const tmp = (): string => mkdtempSync(path.join(tmpdir(), "claude-bridge-"));
const readConfig = (dir: string): { provider?: Record<string, unknown>; askClaude?: unknown } =>
  JSON.parse(readFileSync(path.join(dir, "claude-bridge.json"), "utf8"));

describe("resolveClaudeCodeExecutable", () => {
  it("finds Claude Code on PATH and reports none when it is not installed", () => {
    const dir = tmp();
    const name = process.platform === "win32" ? "claude.exe" : "claude";
    expect(resolveClaudeCodeExecutable({ PATH: dir }, process.platform, tmp())).toBeUndefined();
    writeFileSync(path.join(dir, name), "");
    expect(resolveClaudeCodeExecutable({ PATH: dir }, process.platform, tmp())).toBe(
      path.join(dir, name),
    );
  });
});

describe("bundledClaudeBridgeExtension", () => {
  it("resolves the workspace dependency to a real file", () => {
    expect(bundledClaudeBridgeExtension({})).toMatch(/pi-claude-bridge[/\\]src[/\\]index\.ts$/);
  });
});

describe("ensureClaudeBridgeConfig", () => {
  it("writes the path, preserves other keys, and keeps a valid user path", () => {
    const dir = tmp();
    const claude = path.join(dir, "claude");
    const other = path.join(dir, "other-claude");
    writeFileSync(claude, "");
    writeFileSync(other, "");

    expect(ensureClaudeBridgeConfig(dir, claude)).toBe(true);
    expect(readConfig(dir).provider?.pathToClaudeCodeExecutable).toBe(claude);

    writeFileSync(
      path.join(dir, "claude-bridge.json"),
      JSON.stringify({
        askClaude: { enabled: true },
        provider: { plan: "max", pathToClaudeCodeExecutable: other },
      }),
    );
    expect(ensureClaudeBridgeConfig(dir, claude)).toBe(true);
    expect(readConfig(dir).provider?.pathToClaudeCodeExecutable).toBe(other);

    // A stale user path is replaced; unrelated keys survive.
    writeFileSync(
      path.join(dir, "claude-bridge.json"),
      JSON.stringify({
        askClaude: { enabled: true },
        provider: { plan: "max", pathToClaudeCodeExecutable: path.join(dir, "gone") },
      }),
    );
    expect(ensureClaudeBridgeConfig(dir, claude)).toBe(true);
    expect(readConfig(dir)).toEqual({
      askClaude: { enabled: true },
      provider: { plan: "max", pathToClaudeCodeExecutable: claude },
    });
  });

  it("leaves an unreadable config alone", () => {
    const dir = tmp();
    writeFileSync(path.join(dir, "claude-bridge.json"), "{ not json");
    expect(ensureClaudeBridgeConfig(dir, path.join(dir, "claude"))).toBe(false);
    expect(readFileSync(path.join(dir, "claude-bridge.json"), "utf8")).toBe("{ not json");
  });
});
