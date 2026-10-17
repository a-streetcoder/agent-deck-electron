import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { noneProvider, type SandboxProvider } from "@agent-deck/pi-host";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  parseSandboxRunArgs,
  sandboxRun,
  sandboxRunSession,
  SandboxRunUsageError,
} from "../src/cli/sandboxRun.ts";
import { userAgentDir } from "../src/userAgentDirs.ts";

const srt: SandboxProvider = { name: "srt", wrap: async (command) => command };
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("sandboxRun fails closed (SBX-06)", () => {
  const setup = () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sandbox-run-cli-")));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const project = path.join(dataDir, "projects", "p");
    mkdirSync(project, { recursive: true });
    const argv = ["--data-dir", dataDir, "--project", project, "--session", "s-1", "--", "true"];
    const env = { HOME: path.join(dataDir, "home") };
    // A child that exits 7 once the CLI listens.
    const spawnChild = vi.fn(() => {
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", 7, null));
      return child;
    }) as unknown as typeof spawn & ReturnType<typeof vi.fn>;
    return { dataDir, argv, env, spawnChild };
  };
  const chose = (provider: SandboxProvider, warning?: string) => async () => ({
    provider,
    ...(warning ? { warning } : {}),
  });

  it("refuses to run unsandboxed unless none was asked for", async () => {
    const { argv, env, spawnChild } = setup();
    const code = await sandboxRun(argv, env, {
      choose: chose(noneProvider, "srt cannot run"),
      spawn: spawnChild,
    });
    expect(code).toBe(3);
    expect(spawnChild).not.toHaveBeenCalled();
    // Asked for: the baseline runs the command as is.
    expect(
      await sandboxRun(
        argv,
        { ...env, AGENT_DECK_SANDBOX: "none" },
        {
          choose: chose(noneProvider),
          spawn: spawnChild,
        },
      ),
    ).toBe(7);
    expect(spawnChild).toHaveBeenCalledWith("/bin/sh", ["-c", "true"], expect.anything());
  });

  it("spawns nothing when the wrap fails", async () => {
    const { argv, env, spawnChild } = setup();
    const failing: SandboxProvider = {
      name: "srt",
      wrap: async () => {
        throw new Error("bwrap refused");
      },
    };
    expect(await sandboxRun(argv, env, { choose: chose(failing), spawn: spawnChild })).toBe(1);
    expect(spawnChild).not.toHaveBeenCalled();
  });

  it("spawns the wrapped command and exits with its status", async () => {
    const { argv, env, spawnChild } = setup();
    const wrapping: SandboxProvider = {
      name: "srt",
      wrap: async (command) => ({ ...command, command: "/usr/bin/bwrap", args: ["--", "x"] }),
    };
    expect(await sandboxRun(argv, env, { choose: chose(wrapping), spawn: spawnChild })).toBe(7);
    expect(spawnChild).toHaveBeenCalledWith("/usr/bin/bwrap", ["--", "x"], expect.anything());
  });

  it("probes: 0 with srt, 1 without", async () => {
    const { dataDir } = setup();
    const probe = ["--probe", "--data-dir", dataDir];
    expect(await sandboxRun(probe, {}, { choose: chose(srt) })).toBe(0);
    expect(await sandboxRun(probe, {}, { choose: chose(noneProvider, "no userns") })).toBe(1);
  });

  it("never runs in, or removes, a session folder that already exists", async () => {
    const { dataDir, argv, env, spawnChild } = setup();
    const live = path.join(dataDir, "sandbox", "s-1");
    mkdirSync(live, { recursive: true });
    const choose = vi.fn(chose(srt));
    expect(await sandboxRun(argv, env, { choose, spawn: spawnChild })).toBe(2);
    expect(choose).not.toHaveBeenCalled();
    expect(spawnChild).not.toHaveBeenCalled();
    expect(existsSync(live)).toBe(true);
  });
});

describe("parseSandboxRunArgs (SBX-06)", () => {
  it("reads the session's inputs and joins the words after -- into one shell command", () => {
    const args = parseSandboxRunArgs(
      [
        "--project",
        "/data/projects/p",
        "--worktree",
        "/data/session-worktrees/ab12",
        "--user",
        "alice@example.com",
        "--session",
        "s-1",
        "--allow-host",
        "services.gradle.org",
        "--allow-host",
        "*.rubygems.org",
        "--",
        "npm",
        "test",
        "--",
        "-x",
      ],
      { AGENT_DECK_DATA_DIR: "/data" },
    );
    expect(args).toMatchObject({
      probe: false,
      session: "s-1",
      user: "alice@example.com",
      allowHosts: ["services.gradle.org", "*.rubygems.org"],
      command: "npm test -- -x",
    });
    expect(args.dataDir).toBe(path.resolve("/data"));
    expect(args.project).toBe(path.resolve("/data/projects/p"));
    expect(args.worktree).toBe(path.resolve("/data/session-worktrees/ab12"));
  });

  it("probes without a project or a command, and names a fresh session", () => {
    const args = parseSandboxRunArgs(["--probe", "--data-dir", "/d"], {});
    expect(args.probe).toBe(true);
    expect(args.session).toMatch(/^sandbox-run-[0-9a-f]{8}$/);
  });

  it.each([
    [["--project", "/p", "--", "true"], {}, "--data-dir"],
    [["--data-dir", "/d", "--", "true"], {}, "--project is required"],
    [["--data-dir", "/d", "--project", "/p"], {}, "a command after --"],
    [["--data-dir", "/d", "--project", "/p", "--session", "../x", "--", "true"], {}, "segment"],
    [
      ["--data-dir", "/d", "--project", "/p", "--allow-host", "localhost", "--", "true"],
      {},
      "--allow-host",
    ],
    [
      ["--data-dir", "/d", "--project", "/p", "--allow-host", "10.0.0.1", "--", "true"],
      {},
      "IP address",
    ],
    [["--data-dir", "/d", "--project", "/p", "--nope", "--", "true"], {}, "nope"],
    [
      ["--data-dir", "/other", "--project", "/p", "--", "true"],
      { AGENT_DECK_DATA_DIR: "/data" },
      "is not AGENT_DECK_DATA_DIR",
    ],
  ])("refuses %j", (argv, env, message) => {
    expect(() => parseSandboxRunArgs(argv, env)).toThrow(SandboxRunUsageError);
    expect(() => parseSandboxRunArgs(argv, env)).toThrow(message);
  });
});

describe("sandboxRunSession: the policy the server would derive", () => {
  const layout = () => {
    const root = realpathSync(mkdtempSync(path.join(tmpdir(), "sandbox-run-")));
    roots.push(root);
    const dataDir = path.join(root, "data");
    const home = path.join(dataDir, "home");
    const project = path.join(dataDir, "projects", "p");
    const worktree = path.join(dataDir, "session-worktrees", "ab12cd34");
    mkdirSync(path.join(project, ".git"), { recursive: true });
    mkdirSync(worktree, { recursive: true });
    mkdirSync(path.join(home, ".pi", "agent"), { recursive: true });
    return { dataDir, home, project, worktree, shared: path.join(home, ".pi", "agent") };
  };

  it("gives a worktree session its worktree, the project's git store and the granted hosts", () => {
    const { dataDir, home, project, worktree, shared } = layout();
    const run = sandboxRunSession(
      {
        probe: false,
        dataDir,
        project,
        worktree,
        user: "ops@example.com",
        session: "s-1",
        allowHosts: ["services.gradle.org"],
        command: "true",
      },
      { HOME: home, AGENT_DECK_OPERATOR_EMAIL: "ops@example.com", PI_CODING_AGENT_DIR: "/x" },
      srt,
    );
    expect(run.cwd).toBe(worktree);
    expect(run.record).toMatchObject({ id: "s-1", workspace: { path: worktree } });
    // The operator runs on the shared agent dir, which keeps its credentials readable.
    expect(run.env.PI_CODING_AGENT_DIR).toBe(shared);
    const policy = run.sandbox!.policy;
    expect(policy.allowWrite).toContain(worktree);
    expect(policy.allowWrite).toContain(`${project}/.git/objects`);
    expect(policy.denyWrite.map((entry) => entry.path)).toContain(`${project}/.git/config`);
    expect(policy.allowedDomains).toContain("services.gradle.org");
    expect(policy.denyRead).not.toContain(`${shared}/auth.json`);
    expect(policy.tmpDir).toBe(`${dataDir}/sandbox/s-1/tmp`);
  });

  // ensureUserAgentDir links folders, which Windows refuses without privileges.
  it.skipIf(process.platform === "win32")(
    "runs another user on their own agent dir, with the operator's credentials denied",
    () => {
      const { dataDir, home, project, shared } = layout();
      const run = sandboxRunSession(
        {
          probe: false,
          dataDir,
          project,
          user: "alice@example.com",
          session: "s-2",
          allowHosts: [],
          command: "true",
        },
        { HOME: home, AGENT_DECK_OPERATOR_EMAIL: "ops@example.com" },
        srt,
      );
      expect(run.cwd).toBe(project);
      expect(run.env.PI_CODING_AGENT_DIR).toBe(userAgentDir(dataDir, "alice@example.com"));
      const policy = run.sandbox!.policy;
      expect(policy.denyRead).toContain(`${shared}/auth.json`);
      // No worktree: the project is written, its .git never.
      expect(policy.allowWrite).toContain(project);
      expect(policy.denyWrite.map((entry) => entry.path)).toContain(`${project}/.git`);
    },
  );

  it("derives no policy under none (the command runs as is)", () => {
    const { dataDir, home, project } = layout();
    const run = sandboxRunSession(
      { probe: false, dataDir, project, session: "s-3", allowHosts: [], command: "true" },
      { HOME: home },
      noneProvider,
    );
    expect(run.sandbox).toBeUndefined();
    expect(run.cwd).toBe(project);
  });
});
