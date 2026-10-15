import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { GitHubConnections, githubEnv, pushUsesGitHubToken } from "../src/githubConnections.ts";
import type { UserAgentDirs } from "../src/userAgentDirs.ts";
import { userAgentDir } from "../src/userAgentDirs.ts";

const scratch = mkdtempSync(path.join(tmpdir(), "deck-github-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const git = (args: string[], env: NodeJS.ProcessEnv, cwd?: string): string =>
  execFileSync("git", args, { env, cwd, encoding: "utf8" }).trim();

describe("githubEnv (SRV-06)", () => {
  const connections = {
    read: (user: { id: string }) =>
      user.id === "c@example.com" ? { token: "gho_ownerToken0123456789" } : undefined,
  } as unknown as GitHubConnections;

  it("is empty without an owner, a store or a connection", () => {
    expect(githubEnv(undefined, connections)).toEqual({});
    expect(githubEnv({ id: "c@example.com" }, undefined)).toEqual({});
    expect(githubEnv({ id: "u@example.com" }, connections)).toEqual({});
  });

  it("makes real git answer github.com with the owner's token, and only github.com", () => {
    const env = {
      ...process.env,
      ...githubEnv({ id: "c@example.com" }, connections),
      GIT_TERMINAL_PROMPT: "0",
    };
    const filled = execFileSync("git", ["credential", "fill"], {
      env,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    expect(filled).toContain("password=gho_ownerToken0123456789");
    // Other hosts keep their own helpers (a fill there could open the OS credential UI).
    const helpers = (url: string): string => {
      try {
        return execFileSync("git", ["config", "--get-urlmatch", "credential.helper", url], {
          env,
          encoding: "utf8",
        });
      } catch {
        return ""; // no helper configured at all
      }
    };
    expect(helpers("https://example.com")).not.toContain("GH_TOKEN");
    expect(helpers("https://github.com")).toContain("GH_TOKEN");
  });
});

describe("githubEnv composition and push URLs (SRV-06 review)", () => {
  const connections = {
    read: () => ({ token: "gho_ownerToken0123456789" }),
  } as unknown as GitHubConnections;
  const user = { id: "c@example.com" };

  it("appends after inherited GIT_CONFIG_* entries instead of replacing them", () => {
    const base = {
      ...process.env,
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "http.https://proxy-only.example.proxy",
      GIT_CONFIG_VALUE_0: "http://proxy.example:3128",
    };
    const added = githubEnv(user, connections, base);
    expect(added.GIT_CONFIG_COUNT).toBe("5");
    expect(added).not.toHaveProperty("GIT_CONFIG_KEY_0");
    expect(added.GIT_CONFIG_KEY_1).toBe("credential.https://github.com.helper");
    const env = { ...base, ...added, GIT_TERMINAL_PROMPT: "0" };
    expect(
      git(["config", "--get-urlmatch", "http.proxy", "https://proxy-only.example/x"], env),
    ).toBe("http://proxy.example:3128");
    const filled = execFileSync("git", ["credential", "fill"], {
      env,
      input: "protocol=https\nhost=github.com\n\n",
      encoding: "utf8",
    });
    expect(filled).toContain("password=gho_ownerToken0123456789");
  });

  it("sends github.com SSH remotes, explicit pushurls included, over HTTPS", () => {
    const repo = path.join(scratch, "repo");
    mkdirSync(repo);
    const plain = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
    git(["init", "-q"], plain, repo);
    git(["remote", "add", "origin", "git@github.com:o/r.git"], plain, repo);
    git(["remote", "add", "explicit", "https://github.com/o/r.git"], plain, repo);
    git(["config", "remote.explicit.pushurl", "ssh://git@github.com/o/r.git"], plain, repo);
    git(["remote", "add", "alias", "github-work:o/r.git"], plain, repo);
    const env = { ...plain, ...githubEnv(user, connections, plain) };
    const pushUrl = (remote: string) => git(["remote", "get-url", "--push", remote], env, repo);
    expect(pushUrl("origin")).toBe("https://github.com/o/r.git");
    expect(pushUrl("explicit")).toBe("https://github.com/o/r.git");
    expect(pushUrl("alias")).toBe("github-work:o/r.git");
    expect(pushUsesGitHubToken("git@github.com:o/r.git")).toBe(true);
    expect(pushUsesGitHubToken("ssh://git@github.com/o/r.git")).toBe(true);
    expect(pushUsesGitHubToken("github-work:o/r.git")).toBe(false);
    expect(pushUsesGitHubToken("https://x:tok@github.com/o/r.git")).toBe(false);
  });
});

describe("GitHubConnections.read refuses aliases (SRV-06 review)", () => {
  const dirs = { isOperator: () => false } as unknown as UserAgentDirs;
  const user = { id: "c@example.com" };

  it("reads a regular file, and fails closed on a non-regular github.json", () => {
    const dataDir = mkdtempSync(path.join(scratch, "data-"));
    const store = new GitHubConnections(dataDir, dirs, () => undefined);
    expect(store.read(user)).toBeUndefined();
    const file = path.join(path.dirname(userAgentDir(dataDir, user.id)), "github.json");
    writeFileSync(file, JSON.stringify({ token: "gho_x", login: "c" }));
    expect(store.read(user)?.token).toBe("gho_x");
    rmSync(file);
    mkdirSync(file);
    expect(() => store.read(user)).toThrow(/not a regular file/);
    rmSync(file, { recursive: true });
    const target = path.join(scratch, "someone-elses-github.json");
    writeFileSync(target, JSON.stringify({ token: "gho_other" }));
    try {
      symlinkSync(target, file, "file");
    } catch {
      return; // file symlinks need privileges on Windows; runs on Linux
    }
    expect(() => store.read(user)).toThrow(/not a regular file/);
  });

  it("fails closed on an aliased user dir instead of reporting no connection", () => {
    const dataDir = mkdtempSync(path.join(scratch, "data-"));
    const elsewhere = mkdtempSync(path.join(scratch, "elsewhere-"));
    // A junction needs no privilege on Windows; a dir symlink elsewhere.
    symlinkSync(elsewhere, path.join(dataDir, "users"), "junction");
    const store = new GitHubConnections(dataDir, dirs, () => undefined);
    expect(() => store.read(user)).toThrow(/refusing/);
    expect(() => githubEnv(user, store)).toThrow(/refusing/);
  });
});
