import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  canonicalPath,
  normalizeGitRemote,
  resolveManagedPath,
  sanitizedRepositoryFolder,
  skillRepositoriesRoot,
} from "../src/skillRepositories.ts";

describe("skill repositories fixed root", () => {
  it("resolves macOS, Windows, and Linux native-compatible locations", () => {
    expect(skillRepositoriesRoot({ platform: "darwin", home: "/Users/test", env: {} })).toBe(
      path.join("/Users/test", "Library", "Application Support", "Agent Deck", "SkillRepositories"),
    );
    expect(
      skillRepositoriesRoot({
        platform: "win32",
        home: "C:\\Users\\test",
        env: { APPDATA: "D:\\Roaming" },
      }),
    ).toBe(path.win32.join("D:\\Roaming", "Agent Deck", "SkillRepositories"));
    expect(skillRepositoriesRoot({ platform: "win32", home: "C:\\Users\\test", env: {} })).toBe(
      path.win32.join("C:\\Users\\test", "AppData", "Roaming", "Agent Deck", "SkillRepositories"),
    );
    expect(
      skillRepositoriesRoot({
        platform: "linux",
        home: "/home/test",
        env: { XDG_DATA_HOME: "/data" },
      }),
    ).toBe(path.join("/data", "Agent Deck", "SkillRepositories"));
    expect(skillRepositoriesRoot({ platform: "linux", home: "/home/test", env: {} })).toBe(
      path.join("/home/test", ".local", "share", "Agent Deck", "SkillRepositories"),
    );
  });

  it("rejects lexical children that escape through a symlink", () => {
    const parent = mkdtempSync(path.join(tmpdir(), "skill-repositories-safe-"));
    const root = path.join(parent, "SkillRepositories");
    const outside = path.join(parent, "outside");
    mkdirSync(root);
    mkdirSync(outside);
    symlinkSync(
      outside,
      path.join(root, "escaped"),
      process.platform === "win32" ? "junction" : "dir",
    );

    expect(
      resolveManagedPath(root, path.join(root, "escaped", "skill"), { allowMissing: true }),
    ).toBeUndefined();
    expect(
      resolveManagedPath(root, path.join(root, "safe", "missing"), { allowMissing: true }),
    ).toBe(path.join(canonicalPath(root), "safe", "missing"));
  });

  it("normalizes common Git transports to the same repository identity", () => {
    const https = normalizeGitRemote("https://github.com/owner/repo.git");
    expect(normalizeGitRemote("git@github.com:owner/repo.git")).toBe(https);
    expect(normalizeGitRemote("ssh://git@github.com/owner/repo.git")).toBe(https);
    expect(normalizeGitRemote("https://gitlab.com/owner/repo.git")).not.toBe(https);
    expect(normalizeGitRemote("https://github.com/owner/other.git")).not.toBe(https);
  });

  it("uses deterministic sanitized owner-repo folders", () => {
    expect(sanitizedRepositoryFolder("https://github.com/acme/useful-skills.git")).toBe(
      "acme-useful-skills",
    );
    expect(sanitizedRepositoryFolder("git@github.com:acme/useful skills.git")).toBe(
      "acme-useful-skills",
    );
  });
});
