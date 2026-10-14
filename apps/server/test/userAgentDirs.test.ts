import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  USER_AGENT_LINK_DIRS,
  USER_AGENT_LINK_FILES,
  UserAgentDirs,
  ensureUserAgentDir,
  userAgentDir,
  userAgentDirEnv,
  userRoots,
} from "../src/userAgentDirs.ts";

// Windows without Developer Mode refuses symlinks (EPERM); the logic is path-only,
// so skip there rather than fail. Linux (the shared server) always runs these.
const canSymlink = (() => {
  const probe = mkdtempSync(path.join(tmpdir(), "deck-symlink-probe-"));
  try {
    symlinkSync(probe, path.join(probe, "link"), "dir");
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { recursive: true, force: true });
  }
})();
if (!canSymlink)
  console.warn("userAgentDirs.test: symlinks need privileges here; link tests skipped");

let dir: string;
let shared: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "deck-user-agent-dirs-"));
  shared = path.join(dir, "shared");
  mkdirSync(shared);
  writeFileSync(path.join(shared, "auth.json"), '{"anthropic":{"type":"oauth"}}');
  writeFileSync(path.join(shared, "oauth.json"), "{}");
  writeFileSync(path.join(shared, "settings.json"), "{}");
  mkdirSync(path.join(shared, "skills"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("userAgentDir", () => {
  it("is a stable, case-insensitive hash under <dataDir>/users with no identity in it", () => {
    const a = userAgentDir("/data", "Ale@Example.com");
    expect(a).toBe(userAgentDir("/data", "ale@example.com"));
    expect(a).not.toBe(userAgentDir("/data", "bob@example.com"));
    expect(a).toMatch(/[\\/]users[\\/][0-9a-f]{16}[\\/]agent$/);
    expect(a).not.toContain("ale");
  });
});

describe.skipIf(!canSymlink)("ensureUserAgentDir", () => {
  it("creates a private auth.json and links exactly the fixed shared entries", () => {
    const user = userAgentDir(dir, "ale@example.com");
    ensureUserAgentDir(shared, user);
    expect(readFileSync(path.join(user, "auth.json"), "utf8")).toBe("{}");
    expect(lstatSync(path.join(user, "auth.json")).isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") {
      expect(statSync(user).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(user, "auth.json")).mode & 0o777).toBe(0o600);
    }
    for (const name of [...USER_AGENT_LINK_DIRS, ...USER_AGENT_LINK_FILES]) {
      expect(readlinkSync(path.join(user, name))).toBe(path.join(shared, name));
    }
    // Missing shared dirs are pre-created; a missing shared file stays a dangling link.
    expect(statSync(path.join(shared, "agents")).isDirectory()).toBe(true);
    expect(existsSync(path.join(shared, "models.json"))).toBe(false);
    expect(existsSync(path.join(user, "oauth.json"))).toBe(false);
    // Writes through a link land in the shared file.
    writeFileSync(path.join(user, "settings.json"), '{"theme":"dark"}');
    expect(readFileSync(path.join(shared, "settings.json"), "utf8")).toBe('{"theme":"dark"}');
  });

  it("is idempotent, keeps the user's credentials, and repairs a wrong link", () => {
    const user = userAgentDir(dir, "ale@example.com");
    ensureUserAgentDir(shared, user);
    writeFileSync(path.join(user, "auth.json"), '{"openai":{"type":"api_key"}}');
    unlinkSync(path.join(user, "skills"));
    symlinkSync(path.join(dir, "gone"), path.join(user, "skills"), "dir");
    const before = lstatSync(path.join(user, "settings.json")).ino;
    ensureUserAgentDir(shared, user);
    expect(readFileSync(path.join(user, "auth.json"), "utf8")).toBe(
      '{"openai":{"type":"api_key"}}',
    );
    expect(readlinkSync(path.join(user, "skills"))).toBe(path.join(shared, "skills"));
    expect(lstatSync(path.join(user, "settings.json")).ino).toBe(before);
  });
});

describe.skipIf(!canSymlink)("ensureUserAgentDir refuses aliases (review3 R2)", () => {
  it("throws when a user dir component is a symlink, writing nothing through it", () => {
    const victim = path.join(dir, "victim");
    mkdirSync(victim);
    const dataDir = path.join(dir, "data");
    mkdirSync(dataDir);
    symlinkSync(victim, path.join(dataDir, "users"), "dir");
    expect(() => ensureUserAgentDir(shared, userAgentDir(dataDir, "ale@example.com"))).toThrow(
      /not a real directory/,
    );
    const hashDir = path.dirname(userAgentDir(dir, "bob@example.com"));
    mkdirSync(path.dirname(hashDir), { recursive: true });
    symlinkSync(victim, hashDir, "dir");
    expect(() => ensureUserAgentDir(shared, userAgentDir(dir, "bob@example.com"))).toThrow(
      /not a real directory/,
    );
    expect(readdirSync(victim)).toEqual([]);
  });

  it("throws when auth.json is a symlink, leaving its target untouched", () => {
    const user = userAgentDir(dir, "ale@example.com");
    mkdirSync(user, { recursive: true });
    symlinkSync(path.join(shared, "auth.json"), path.join(user, "auth.json"), "file");
    expect(() => ensureUserAgentDir(shared, user)).toThrow(/not a regular file/);
    expect(readFileSync(path.join(shared, "auth.json"), "utf8")).toBe(
      '{"anthropic":{"type":"oauth"}}',
    );
    expect(existsSync(path.join(user, "settings.json"))).toBe(false);
  });
});

describe.skipIf(!canSymlink)("UserAgentDirs", () => {
  it("gives the operator the shared dir and everyone else their own", () => {
    const dirs = new UserAgentDirs(dir, () => shared, "Op@Example.com");
    expect(dirs.resolve({ id: "op@example.com" })).toBe(shared);
    expect(existsSync(path.join(dir, "users"))).toBe(false);
    expect(userAgentDirEnv({ id: "ale@example.com" }, dirs)).toEqual({
      PI_CODING_AGENT_DIR: userAgentDir(dir, "ale@example.com"),
    });
    expect(userAgentDirEnv(undefined, dirs)).toEqual({});
    expect(userAgentDirEnv({ id: "ale@example.com" }, undefined)).toEqual({});
    expect(userRoots({ home: dir }, undefined, dirs)).toEqual({ home: dir });
  });
});
