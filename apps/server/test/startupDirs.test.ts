import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ensureStartupDirs } from "../src/startupDirs.ts";

describe("ensureStartupDirs", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("creates a missing home and AGENT_DECK_PROJECT_ROOT", () => {
    dir = mkdtempSync(path.join(tmpdir(), "startup-dirs-"));
    const home = path.join(dir, "data", "home");
    const projects = path.join(dir, "data", "projects");
    ensureStartupDirs(home, { AGENT_DECK_PROJECT_ROOT: ` ${projects} ` });
    expect(statSync(home).isDirectory()).toBe(true);
    expect(statSync(projects).isDirectory()).toBe(true);
  });

  it("leaves the project root alone when unset and warns instead of throwing", () => {
    dir = mkdtempSync(path.join(tmpdir(), "startup-dirs-"));
    const blocker = path.join(dir, "file");
    writeFileSync(blocker, "");
    const warn = vi.fn();
    ensureStartupDirs(path.join(blocker, "home"), {}, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("home directory"), expect.anything());
    expect(existsSync(path.join(dir, "projects"))).toBe(false);
  });
});
