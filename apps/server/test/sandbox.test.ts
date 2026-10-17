import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import { noneProvider, type SandboxProvider } from "@agent-deck/pi-host";
import { afterEach, describe, expect, it } from "vitest";
import {
  chooseSandboxProvider,
  piSessionDir,
  cwdInsideProjects,
  launchDirOf,
  readProjectSandboxConfig,
  serverWriteRootProblem,
  sessionSandbox,
  sessionSandboxPolicy,
  type SessionSandboxDeps,
} from "../src/sandbox.ts";

const srt: SandboxProvider = { name: "srt", wrap: async (command) => command };
const choose = (
  env: NodeJS.ProcessEnv,
  sharedServer: boolean,
  problem?: string,
  platform: NodeJS.Platform = "linux",
) => chooseSandboxProvider({ env, sharedServer, platform, srt, problem: async () => problem });

describe("chooseSandboxProvider (ADR 0007)", () => {
  it("defaults to srt on the shared server when it can run, none on a desktop", async () => {
    expect((await choose({}, true)).provider.name).toBe("srt");
    expect(await choose({}, false)).toEqual({ provider: noneProvider });
  });

  it("falls back to none with one warning when srt cannot run on the shared server", async () => {
    const choice = await choose({}, true, "bubblewrap (bwrap) not installed");
    expect(choice.provider.name).toBe("none");
    expect(choice.warning).toContain("bubblewrap (bwrap) not installed");
  });

  it("honours an explicit choice, keeps an explicit srt that cannot run, refuses others", async () => {
    expect((await choose({ AGENT_DECK_SANDBOX: "none" }, true)).provider.name).toBe("none");
    expect((await choose({ AGENT_DECK_SANDBOX: "srt" }, false)).provider.name).toBe("srt");
    const broken = await choose({ AGENT_DECK_SANDBOX: "srt" }, true, "socat not installed");
    expect(broken.provider.name).toBe("srt");
    expect(broken.warning).toContain("socat not installed");
    await expect(choose({ AGENT_DECK_SANDBOX: "docker" }, true)).rejects.toThrow(
      'use "srt" or "none"',
    );
  });

  it("is always none on Windows", async () => {
    expect((await choose({}, true, undefined, "win32")).provider.name).toBe("none");
    const asked = await choose({ AGENT_DECK_SANDBOX: "srt" }, true, undefined, "win32");
    expect(asked.provider.name).toBe("none");
    expect(asked.warning).toContain("Windows");
  });
});

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("sessionSandboxPolicy: the server's real inputs", () => {
  it("uses the user's agent dir and the resolved folder Pi writes the session into", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sandbox-policy-")));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const shared = path.join(root, "home", ".pi", "agent");
    const project = path.join(root, "project");
    const userAgent = path.join(dataDir, "users", "abcd", "agent");
    mkdirSync(path.join(shared, "sessions"), { recursive: true });
    mkdirSync(userAgent, { recursive: true });
    mkdirSync(project, { recursive: true });
    // As ensureUserAgentDir links it: the user's sessions are the shared tree.
    symlinkSync(path.join(shared, "sessions"), path.join(userAgent, "sessions"), "junction");

    const deps: SessionSandboxDeps = {
      dataDir,
      side: "server",
      provider: srt,
      sharedAgentDir: () => shared,
      operator: { id: "ops@example.com" },
      projectPath: () => project,
      ownerDir: () => path.join(dataDir, "users", "abcd"),
    };
    const meta: SessionMeta = {
      id: "s-1",
      cwd: project,
      createdAt: "2026-10-17T00:00:00Z",
      location: { kind: "server", owner: { id: "alice@example.com" } },
    };
    const launch = { cwd: project, env: { PI_CODING_AGENT_DIR: userAgent } };
    const policy = sessionSandboxPolicy(deps, meta, launch);

    const linked = piSessionDir({ agentDir: userAgent, cwd: project });
    const real = path.join(shared, "sessions", path.basename(linked));
    expect(linked.startsWith(userAgent)).toBe(true);
    expect(policy.allowWrite).toContain(real);
    expect(policy.allowWrite).not.toContain(linked);
    expect(policy.allowWrite).toContain(userAgent);
    expect(policy.createDirs).toContain(real);
    // Not the operator: the operator's credentials stay unreadable.
    expect(policy.denyRead).toContain(`${shared}/auth.json`);
    expect(policy.allowRead).toContain(path.join(dataDir, "users", "abcd"));

    // A child in its own worktree writes that worktree; none derives nothing.
    const worktree = path.join(dataDir, "worktrees", "c1");
    expect(sessionSandboxPolicy(deps, meta, { ...launch, cwd: worktree }).allowWrite).toContain(
      worktree,
    );
    expect(sessionSandbox({ ...deps, provider: noneProvider }, meta, launch)).toBeUndefined();
  });

  it("derives Pi's own session folders: --session-dir, a resumed file's folder, the cwd's", () => {
    const agentDir = path.resolve("/agent");
    expect(piSessionDir({ agentDir, cwd: "/w", sessionDir: "/runs/r1" })).toBe(
      path.resolve("/runs/r1"),
    );
    expect(piSessionDir({ agentDir, cwd: "/w", resumeSessionPath: "/s/x/file.jsonl" })).toBe(
      path.resolve("/s/x"),
    );
    const derived = piSessionDir({ agentDir, cwd: "/data/projects/app" });
    expect(path.dirname(derived)).toBe(path.join(agentDir, "sessions"));
    expect(path.basename(derived)).toMatch(/^--.*data-projects-app--$/);
  });
});

describe("readProjectSandboxConfig: from the server-recorded base, never the worktree", () => {
  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const commitFile = (repo: string, body: string): string => {
    mkdirSync(path.join(repo, ".agent-deck"), { recursive: true });
    writeFileSync(path.join(repo, ".agent-deck", "sandbox.json"), body);
    git(repo, "add", "-A");
    git(repo, "-c", "user.email=t@example.com", "-c", "user.name=T", "commit", "-qm", "sandbox");
    return git(repo, "rev-parse", "HEAD");
  };
  const repo = (): string => {
    const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "sandbox-config-")));
    roots.push(dir);
    git(dir, "init", "-q", "-b", "main");
    return dir;
  };

  it("reads the base commit of a worktree session, not what the worktree commits later", () => {
    const project = repo();
    const base = commitFile(project, JSON.stringify({ allowedDomains: ["api.example.com"] }));
    const worktree = path.join(roots[roots.length - 1]!, "wt");
    git(project, "worktree", "add", "-q", "-b", "agent-deck/session-x", worktree);
    // The session edits and commits its own copy, and even moves main.
    commitFile(worktree, JSON.stringify({ allowedDomains: ["evil.example.com"] }));
    git(project, "update-ref", "refs/heads/main", git(worktree, "rev-parse", "HEAD"));

    const record = { workspace: { path: worktree, baseCommit: base } };
    expect(readProjectSandboxConfig(project, record)).toEqual({
      config: { allowedDomains: ["api.example.com"] },
    });
    // No recorded base: the defaults, never a ref.
    expect(readProjectSandboxConfig(project, { workspace: { path: worktree } })).toEqual({});
  });

  it("reads HEAD without a worktree; refuses an invalid file as a whole; an absent one is fine", () => {
    const project = repo();
    expect(readProjectSandboxConfig(project, {})).toEqual({}); // no commit yet
    commitFile(project, "{ not json");
    expect(readProjectSandboxConfig(project, {}).problems?.[0]).toMatch(/^not JSON/);
    commitFile(project, JSON.stringify({ allowedDomains: ["localhost"], extra: 1 }));
    const refused = readProjectSandboxConfig(project, {});
    expect(refused.config).toBeUndefined();
    expect(refused.problems?.length).toBeGreaterThanOrEqual(2);
    expect(readProjectSandboxConfig(path.join(project, "missing"), {})).toEqual({});
  });

  it("only grants reach the policy; sandbox.json hosts are proposals", () => {
    const deps: SessionSandboxDeps = {
      dataDir: "/data",
      side: "server",
      provider: srt,
      sharedAgentDir: () => "/data/home/.pi/agent",
      projectPath: () => "/data/projects/app",
      showFile: (_cwd, rev) =>
        rev === "HEAD"
          ? JSON.stringify({ allowedDomains: ["api.example.com", "granted.example.com"] })
          : "[]",
    };
    const meta: SessionMeta = {
      id: "s-2",
      cwd: "/data/projects/app",
      createdAt: "2026-10-17T00:00:00Z",
    };
    const proposed = sessionSandbox(deps, meta, { cwd: meta.cwd, report: true });
    expect(proposed?.sandbox.policy.allowedDomains).not.toContain("api.example.com");
    expect(proposed?.proposals).toEqual(["api.example.com", "granted.example.com"]);
    expect(proposed?.configProblems).toBeUndefined();
    // A launch that does not report (a helper, a child) does not read the file.
    expect(sessionSandbox(deps, meta, { cwd: meta.cwd })?.proposals).toBeUndefined();
    const refused = sessionSandbox(
      deps,
      { ...meta, workspace: { path: "/data/wt/s-2", baseCommit: "a".repeat(40) } },
      { cwd: meta.cwd, report: true },
    );
    expect(refused?.configProblems?.length).toBeGreaterThan(0);
    // The owner's grant is what the policy holds; a granted host is no proposal.
    const granted = sessionSandbox({ ...deps, grantedHosts: () => ["Granted.example.com"] }, meta, {
      cwd: meta.cwd,
      report: true,
    });
    expect(granted?.sandbox.policy.allowedDomains).toContain("Granted.example.com");
    expect(granted?.sandbox.policy.allowedDomains).not.toContain("api.example.com");
    expect(granted?.proposals).toEqual(["api.example.com"]);
  });

  it("a --no-session helper gets no folder under the agent dir", () => {
    const deps: SessionSandboxDeps = {
      dataDir: "/data",
      side: "server",
      provider: srt,
      sharedAgentDir: () => "/data/home/.pi/agent",
      projectPath: () => "/data/projects/app",
    };
    const meta: SessionMeta = { id: "helper-1", cwd: "/data/projects/app", createdAt: "x" };
    const policy = sessionSandboxPolicy(deps, meta, { cwd: meta.cwd, noSession: true });
    expect(policy.createDirs.some((dir) => dir.replace(/\\/g, "/").includes("/sessions/"))).toBe(
      false,
    );
    expect(policy.createDirs).toContain(path.join("/data", "sandbox", "helper-1", "tmp"));
  });
});

describe("cwdInsideProjects (ADR 0007: a sandboxed session's cwd)", () => {
  it("accepts a registered project folder or a folder inside it, nothing else", () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sandbox-cwd-")));
    roots.push(root);
    const project = path.join(root, "project");
    mkdirSync(path.join(project, "src"), { recursive: true });
    mkdirSync(path.join(root, "elsewhere"));
    // A link inside the project that leads out of it does not count as inside.
    symlinkSync(path.join(root, "elsewhere"), path.join(project, "out"), "junction");
    expect(cwdInsideProjects(project, [project])).toBe(true);
    expect(cwdInsideProjects(path.join(project, "src"), [project])).toBe(true);
    expect(cwdInsideProjects(path.join(root, "elsewhere"), [project])).toBe(false);
    expect(cwdInsideProjects(path.join(project, "out"), [project])).toBe(false);
    expect(cwdInsideProjects(path.join(project, "..", "elsewhere"), [project])).toBe(false);
    expect(cwdInsideProjects(path.parse(root).root, [project])).toBe(false);
  });
});

describe("launchDirOf (ADR 0007: launch files per session)", () => {
  it("places them under the session, and never throws for a legacy id under none", () => {
    expect(launchDirOf("/d/sandbox", "s-1", true)).toBe(path.join("/d/sandbox", "s-1", "launch"));
    expect(launchDirOf("/d/sandbox", "legacy/../id", false)).toBeUndefined();
    expect(launchDirOf("/d/sandbox", "..", false)).toBeUndefined();
    expect(() => launchDirOf("/d/sandbox", "legacy/../id", true)).toThrow("path segment");
  });
});

describe("serverWriteRootProblem (ADR 0007: reserved folders, canonical paths)", () => {
  const layout = () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sandbox-reserved-")));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const piAgentDir = path.join(dataDir, "home", ".pi", "agent");
    for (const dir of [
      path.join(dataDir, "users", "abcd", "agent"),
      path.join(dataDir, "sandbox", "other-session", "launch"),
      path.join(dataDir, "session-worktrees", "ab12cd34"),
      path.join(dataDir, "projects", "app"),
      piAgentDir,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    return { root, dataDir, piAgentDir };
  };

  it("refuses the users and sandbox folders, accepts a project folder", () => {
    const { dataDir, piAgentDir } = layout();
    const problem = (dir: string) => serverWriteRootProblem(dir, { dataDir, piAgentDir });
    expect(problem(path.join(dataDir, "users"))).toBeDefined();
    expect(problem(path.join(dataDir, "users", "abcd", "agent"))).toBeDefined();
    expect(problem(path.join(dataDir, "sandbox", "other-session"))).toBeDefined();
    expect(problem(path.join(dataDir, "projects", "app"))).toBeUndefined();
  });

  it("sees through a link to the agent dir", () => {
    const { root, dataDir, piAgentDir } = layout();
    const alias = path.join(root, "alias-of-agent");
    symlinkSync(piAgentDir, alias, "junction");
    expect(serverWriteRootProblem(alias, { dataDir, piAgentDir })).toBeDefined();
    // The agent dir named through the alias is the same folder.
    expect(
      serverWriteRootProblem(path.join(dataDir, "projects", "app"), {
        dataDir,
        piAgentDir: alias,
      }),
    ).toBeUndefined();
    expect(serverWriteRootProblem(alias, { dataDir, piAgentDir: alias })).toBeDefined();
  });

  it.skipIf(process.platform === "linux")(
    "refuses a differently cased reserved folder on a case-folding filesystem",
    () => {
      const { dataDir, piAgentDir } = layout();
      expect(
        serverWriteRootProblem(path.join(dataDir, "USERS", "ABCD"), { dataDir, piAgentDir }),
      ).toBeDefined();
    },
  );
});
