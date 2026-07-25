import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MISSING_SKILL_TREE_FINGERPRINT,
  SkillTreeFingerprintError,
  skillTreeFingerprint,
} from "../src/skillTreeFingerprint.ts";

const roots: string[] = [];
function tree(): string {
  const root = mkdtempSync(path.join(tmpdir(), "skill-tree-fingerprint-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(root, 0o700);
    } catch {
      // Best-effort cleanup after tests that deliberately alter permissions.
    }
    rmSync(root, { recursive: true, force: true });
  }
});

describe("skillTreeFingerprint", () => {
  it("is deterministic across creation order and uses portable relative entries", () => {
    const left = tree();
    const right = tree();
    mkdirSync(path.join(left, "assets"));
    writeFileSync(path.join(left, "assets", "é.txt"), Buffer.from([0, 1, 2]));
    writeFileSync(path.join(left, "SKILL.md"), "skill");
    writeFileSync(path.join(right, "SKILL.md"), "skill");
    mkdirSync(path.join(right, "assets"));
    writeFileSync(path.join(right, "assets", "é.txt"), Buffer.from([0, 1, 2]));

    expect(skillTreeFingerprint(left)).toMatch(/^tree-v1:[0-9a-f]{64}$/);
    expect(skillTreeFingerprint(left)).toBe(skillTreeFingerprint(right));
  });

  it("includes empty directories", () => {
    const left = tree();
    const right = tree();
    mkdirSync(path.join(left, "empty"));
    expect(skillTreeFingerprint(left)).not.toBe(skillTreeFingerprint(right));
  });

  it("length-frames paths, types, and bytes instead of hashing ambiguous concatenation", () => {
    const left = tree();
    const right = tree();
    writeFileSync(path.join(left, "a"), "bc");
    writeFileSync(path.join(right, "ab"), "c");
    expect(skillTreeFingerprint(left)).not.toBe(skillTreeFingerprint(right));
  });

  it("excludes source .git directories at every depth", () => {
    const left = tree();
    const right = tree();
    mkdirSync(path.join(left, ".git"));
    writeFileSync(path.join(left, ".git", "index"), "one");
    mkdirSync(path.join(left, "nested", ".git"), { recursive: true });
    writeFileSync(path.join(left, "nested", ".git", "index"), "two");
    mkdirSync(path.join(right, "nested"));
    expect(skillTreeFingerprint(left)).toBe(skillTreeFingerprint(right));
  });

  it("can mark reserved catalog .git presence/type without traversing internals", () => {
    const withGit = tree();
    const withoutGit = tree();
    mkdirSync(path.join(withGit, ".git"));
    writeFileSync(path.join(withGit, ".git", "index"), "first internal state");
    const first = skillTreeFingerprint(withGit, { reservedGit: "presence" });
    expect(first).not.toBe(skillTreeFingerprint(withoutGit, { reservedGit: "presence" }));
    writeFileSync(path.join(withGit, ".git", "index"), "different internal state");
    expect(skillTreeFingerprint(withGit, { reservedGit: "presence" })).toBe(first);
  });

  it("represents a missing whole root explicitly", () => {
    expect(skillTreeFingerprint(path.join(tree(), "missing"))).toBe(MISSING_SKILL_TREE_FINGERPRINT);
  });

  it("fails closed on symbolic links", () => {
    const root = tree();
    writeFileSync(path.join(root, "target"), "content");
    symlinkSync(path.join(root, "target"), path.join(root, "link"));
    expect(() => skillTreeFingerprint(root)).toThrow(SkillTreeFingerprintError);
  });

  const windowsIt = process.platform === "win32" ? it : it.skip;
  windowsIt("rejects a directory junction before reading outside the payload", () => {
    const root = tree();
    const outside = tree();
    writeFileSync(path.join(outside, "sentinel"), "outside bytes");
    const junction = path.join(root, "junction");
    execFileSync("cmd.exe", ["/d", "/s", "/c", `mklink /J "${junction}" "${outside}"`], {
      stdio: "ignore",
    });

    expect(() => skillTreeFingerprint(root)).toThrow(/symbolic link or junction/);
  });

  windowsIt("marks a reserved .git junction without traversing its target", () => {
    const root = tree();
    const outside = tree();
    writeFileSync(path.join(outside, "sentinel"), "first outside bytes");
    const junction = path.join(root, ".git");
    execFileSync("cmd.exe", ["/d", "/s", "/c", `mklink /J "${junction}" "${outside}"`], {
      stdio: "ignore",
    });

    const first = skillTreeFingerprint(root, { reservedGit: "presence" });
    writeFileSync(path.join(outside, "sentinel"), "changed outside bytes");
    expect(skillTreeFingerprint(root, { reservedGit: "presence" })).toBe(first);
  });

  const unixIt = process.platform === "win32" ? it.skip : it;
  unixIt("fails closed on special files", () => {
    const root = tree();
    execFileSync("mkfifo", [path.join(root, "pipe")]);
    expect(() => skillTreeFingerprint(root)).toThrow(/unsupported entry type/);
  });

  unixIt("fails closed when a directory cannot be read", () => {
    if (typeof process.getuid === "function" && process.getuid() === 0) return;
    const root = tree();
    const blocked = path.join(root, "blocked");
    mkdirSync(blocked);
    writeFileSync(path.join(blocked, "asset"), "private");
    chmodSync(blocked, 0o000);
    try {
      expect(() => skillTreeFingerprint(root)).toThrow(SkillTreeFingerprintError);
    } finally {
      chmodSync(blocked, 0o700);
    }
  });
});
