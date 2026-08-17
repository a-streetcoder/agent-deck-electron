import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { FileMcpPolicyStore, McpPolicyStoreError } from "../src/mcpPolicy.ts";
import { SettingsStore } from "../src/persistence.ts";

const freshDir = (): string => mkdtempSync(path.join(tmpdir(), "mcp-policy-"));

describe("MCP master policy persistence", () => {
  it("defaults missing and malformed values on, without eagerly touching disk", () => {
    const missing = freshDir();
    const missingFile = path.join(missing, "app-settings.json");
    expect(new FileMcpPolicyStore(new SettingsStore(missing)).enabled()).toBe(true);
    expect(() => readFileSync(missingFile)).toThrow();

    const malformed = freshDir();
    const file = path.join(malformed, "app-settings.json");
    writeFileSync(file, JSON.stringify({ mcpEnabled: "paused", autoTitle: false }));
    const before = readFileSync(file, "utf8");
    expect(new FileMcpPolicyStore(new SettingsStore(malformed)).enabled()).toBe(true);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("persists explicit false across restart and omits the enabled default", () => {
    const dir = freshDir();
    const policy = new FileMcpPolicyStore(new SettingsStore(dir));
    expect(policy.setEnabled(false)).toBe(false);
    expect(JSON.parse(readFileSync(path.join(dir, "app-settings.json"), "utf8"))).toMatchObject({
      mcpEnabled: false,
    });
    expect(new FileMcpPolicyStore(new SettingsStore(dir)).enabled()).toBe(false);

    expect(policy.setEnabled(true)).toBe(true);
    expect(
      JSON.parse(readFileSync(path.join(dir, "app-settings.json"), "utf8")),
    ).not.toHaveProperty("mcpEnabled");
    expect(new FileMcpPolicyStore(new SettingsStore(dir)).enabled()).toBe(true);
  });

  it("keeps memory and durable truth unchanged when the atomic write fails", () => {
    const dir = freshDir();
    const settings = new SettingsStore(dir);
    const policy = new FileMcpPolicyStore(settings);
    settings.update({ autoTitle: false });
    const file = path.join(dir, "app-settings.json");
    const before = readFileSync(file, "utf8");
    rmSync(dir, { recursive: true });

    expect(() => policy.setEnabled(false)).toThrow(McpPolicyStoreError);
    expect(policy.enabled()).toBe(true);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, before);
    expect(new FileMcpPolicyStore(new SettingsStore(dir)).enabled()).toBe(true);
  });
});
