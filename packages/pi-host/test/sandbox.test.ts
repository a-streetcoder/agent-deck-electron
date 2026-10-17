import {
  DEFAULT_SANDBOX_DENIED_ADDRESSES,
  DEFAULT_SANDBOX_DOMAINS,
  sandboxPolicy,
  type SandboxPolicy,
  type SandboxPolicyInput,
} from "@agent-deck/domain";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { PiProcess } from "../src/PiProcess.ts";
import {
  carveReadAroundWrites,
  createSrtProvider,
  MAX_CARVED_ENTRIES,
  noneProvider,
  OOM_FIRST_SCRIPT,
  PiSandboxError,
  prepareDenyWrite,
  sandboxProbeProblem,
  SRT_PACKAGE,
  srtDeniedAddressesProblem,
  srtProblem,
  type SandboxCommand,
  type SandboxFs,
  type SandboxProvider,
} from "../src/sandbox.ts";

/** An in-memory host: what exists, and what the provider created (kept off
 * the real disk; sandbox.srt.test.ts uses real folders on Linux). */
function fakeFs(existing: readonly string[] = []) {
  const paths = new Set(existing);
  const made: Array<{ path: string; kind: "dir" | "file"; content?: string }> = [];
  const fs: SandboxFs = {
    exists: (path) => paths.has(path),
    mkdir: (path) => {
      paths.add(path);
      made.push({ path, kind: "dir" });
    },
    createFile: (path, content) => {
      paths.add(path);
      made.push({ path, kind: "file", content });
    },
    children: (dir) => {
      if (!paths.has(dir)) return undefined;
      return [...paths]
        .filter((path) => path.startsWith(`${dir}/`) && !path.slice(dir.length + 1).includes("/"))
        .map((path) => path.slice(dir.length + 1));
    },
  };
  return { fs, made };
}

const POLICY: SandboxPolicy = sandboxPolicy(
  { id: "s1", workspace: { path: "/data/wt/s1" } },
  "local",
  {
    dataDir: "/srv/deck",
    projectPath: "/data/projects/app",
    piAgentDir: "/home/u/.pi/agent",
    agentDir: "/home/u/.pi/agent",
    sessionDir: "/home/u/.pi/agent/sessions/--app--",
  },
);

const plan = (): SandboxCommand => ({
  command: "/usr/bin/pi",
  args: ["--mode", "rpc", "--append-system-prompt", 'it\'s "quoted" $HOME'],
  env: { PATH: "/usr/bin", PI_CODING_AGENT_DIR: "/home/u/.pi/agent" },
  cwd: "/data/wt/s1",
});

const serverPolicy = (id: string, input: Partial<SandboxPolicyInput> = {}): SandboxPolicy =>
  sandboxPolicy({ id, location: { kind: "server" } }, "server", {
    dataDir: "/data",
    projectPath: `/data/projects/${id}`,
    piAgentDir: "/data/home/.pi/agent",
    agentDir: "/data/home/.pi/agent",
    sessionDir: `/data/home/.pi/agent/sessions/--${id}--`,
    ...input,
  });

type WrapCall = [string, unknown, Record<string, unknown>, unknown, string, { commandId: string }];

/** srt's violation store as far as the provider uses it; `encodedCommand`
 * is the command id itself here. */
function fakeViolationStore() {
  type Line = { line: string; encodedCommand?: string; timestamp: Date };
  const lines: Line[] = [];
  const listeners = new Set<(all: Line[]) => void>();
  return {
    add: (line: string, encodedCommand?: string) => {
      lines.push({ line, encodedCommand, timestamp: new Date() });
      for (const listener of listeners) listener([...lines]);
    },
    /** A notification with nothing new (srt notifies on clear() too). */
    notify: () => {
      for (const listener of listeners) listener([...lines]);
    },
    getTotalCount: () => lines.length,
    getViolationsForCommand: (id: string) => lines.filter((l) => l.encodedCommand === id),
    subscribe: (listener: (all: Line[]) => void) => {
      listeners.add(listener);
      listener([...lines]);
      return () => listeners.delete(listener);
    },
  };
}

function fakeSrt(argv: string[] = ["/bin/bash", "-c", "wrapped"]) {
  const store = fakeViolationStore();
  return {
    store,
    getSandboxViolationStore: vi.fn(() => store),
    initialize: vi.fn(async () => {}),
    updateConfig: vi.fn(),
    wrapWithSandboxArgv: vi.fn(async () => ({ argv, env: { IGNORED: "1" } })),
    registerCommandNetworkLists: vi.fn(),
    unregisterCommandNetworkLists: vi.fn(),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(async () => {}),
    // srt 0.0.80 with its mux: one socket for both protocols.
    getLinuxHttpSocketPath: vi.fn(() => "/tmp/claude-http-0123.sock"),
    getLinuxSocksSocketPath: vi.fn(() => "/tmp/claude-http-0123.sock"),
  };
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 50 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
  return !alive(pid);
}

describe("noneProvider", () => {
  it("returns the command unchanged, byte for byte", async () => {
    const original = plan();
    const before = JSON.stringify(original);
    const wrapped = await noneProvider.wrap(original, POLICY);
    expect(wrapped).toBe(original);
    expect(JSON.stringify(wrapped)).toBe(before);
  });

  it("PiProcess with none spawns synchronously, as without a sandbox", async () => {
    const proc = new PiProcess({
      binPath: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      sandbox: { provider: noneProvider, policy: POLICY },
    });
    proc.start();
    expect(proc.pid).toBeTypeOf("number");
    await proc.stop();
  });
});

describe("sandboxProbeProblem (startup probe)", () => {
  /** A provider whose wrap runs node with `script` instead of /bin/true. */
  const running = (script: string, release = vi.fn()): SandboxProvider => ({
    name: "srt",
    wrap: async (cmd) => ({ ...cmd, command: process.execPath, args: ["-e", script], release }),
  });

  it("passes when the wrapped command succeeds, and releases the wrap", async () => {
    const release = vi.fn();
    expect(await sandboxProbeProblem(running("process.exit(0)", release))).toBeUndefined();
    expect(release).toHaveBeenCalledOnce();
  });

  it("reports the exit and stderr of a failing sandbox", async () => {
    const why = await sandboxProbeProblem(
      running(`console.error("bwrap: Can't mount proc"); process.exit(1)`),
    );
    expect(why).toContain("exited 1");
    expect(why).toContain("Can't mount proc");
  });

  it("reports a wrap that throws and a sandbox that hangs", async () => {
    const throwing: SandboxProvider = {
      name: "srt",
      wrap: async () => {
        throw new PiSandboxError("srt could not start");
      },
    };
    expect(await sandboxProbeProblem(throwing)).toBe("srt could not start");
    expect(await sandboxProbeProblem(running("setInterval(() => {}, 1000)"), 300)).toContain(
      "did not finish within 300 ms",
    );
  });

  it("fails when the wrap itself never settles (srt's initialize hangs)", async () => {
    const hung: SandboxProvider = { name: "srt", wrap: () => new Promise(() => {}) };
    expect(await sandboxProbeProblem(hung, 200)).toContain("did not finish within 200 ms");
  });

  it("srt's own schema checks the denied addresses", async () => {
    expect(await srtDeniedAddressesProblem([])).toBeUndefined();
    expect(await srtDeniedAddressesProblem(["203.0.113.7", "10.1.0.0/16"])).toBeUndefined();
    const why = await srtDeniedAddressesProblem(["203.0.113.7", "example.com"]);
    expect(why).toContain('"example.com"');
    expect(await srtDeniedAddressesProblem(["::ffff:192.0.2.1/64"])).toContain("Invalid IP");
  });
});

describe("srt provider (fake SandboxManager)", () => {
  it("gives a server session its own /tmp on Linux, with this srt's sockets bound back", async () => {
    const root = tmpdir().replace(/\/+$/, "");
    const settingsOn = async (
      platform: NodeJS.Platform,
      policy: SandboxPolicy,
      monitor = false,
      sockets: [string, string] = ["/tmp/claude-http-0123.sock", "/tmp/claude-http-0123.sock"],
    ) => {
      const srt = fakeSrt();
      srt.getLinuxHttpSocketPath.mockReturnValue(sockets[0]);
      srt.getLinuxSocksSocketPath.mockReturnValue(sockets[1]);
      // Another srt's monitor folder was there before; this initialize makes one.
      const host = fakeFs([root, `${root}/srt-obs-other`]);
      srt.initialize.mockImplementation(async () => host.fs.mkdir(`${root}/srt-obs-mine`));
      const provider = createSrtProvider(async () => srt, platform, host.fs, monitor);
      await provider.wrap(plan(), policy);
      await provider.dispose?.();
      const call = srt.wrapWithSandboxArgv.mock.calls[0] as unknown as WrapCall;
      return call[2].filesystem as { denyRead: string[]; allowRead: string[] };
    };
    const server = serverPolicy("s1");
    expect(server.privateTmp).toBe(true);
    const linux = await settingsOn("linux", server);
    expect(linux.denyRead).toContain("/tmp");
    // The exact paths, the mux's one socket once, never a glob.
    expect(linux.allowRead.filter((entry) => entry.startsWith("/tmp/"))).toEqual([
      "/tmp/claude-http-0123.sock",
    ]);
    expect(linux.allowRead.some((entry) => entry.includes("*"))).toBe(false);
    const split = await settingsOn("linux", server, false, ["/tmp/h.sock", "/tmp/s.sock"]);
    expect(split.allowRead).toEqual(expect.arrayContaining(["/tmp/h.sock", "/tmp/s.sock"]));
    // With the monitor: only the folder this initialize made, not another srt's.
    const monitored = await settingsOn("linux", server, true);
    expect(monitored.allowRead).toContain(`${root}/srt-obs-mine`);
    expect(monitored.allowRead).not.toContain(`${root}/srt-obs-other`);
    // macOS (Seatbelt has no tmpfs: a deny would only refuse /tmp) and a
    // desktop's policy keep the host's /tmp.
    for (const [platform, policy] of [
      ["darwin", server],
      ["linux", POLICY],
    ] as const) {
      const fs = await settingsOn(platform, policy, true);
      expect(fs.denyRead).not.toContain("/tmp");
      expect(fs.allowRead.some((entry) => entry.endsWith(".sock"))).toBe(false);
      expect(fs.allowRead.some((entry) => entry.includes("srt-obs-"))).toBe(false);
    }
  });

  it("fails closed when the monitor is asked for and its folder is not one new srt-obs- folder", async () => {
    const root = tmpdir().replace(/\/+$/, "");
    const attempt = async (monitor: boolean) => {
      const srt = fakeSrt();
      const host = fakeFs([root]);
      const children = vi.spyOn(host.fs, "children");
      // Another srt initializing at the same moment: two new folders.
      srt.initialize.mockImplementation(async () => {
        host.fs.mkdir(`${root}/srt-obs-a`);
        host.fs.mkdir(`${root}/srt-obs-b`);
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const provider = createSrtProvider(async () => srt, "linux", host.fs, monitor);
      try {
        return { result: await provider.wrap(plan(), serverPolicy("s1")).catch((e) => e), srt };
      } finally {
        await provider.dispose?.();
        warn.mockRestore();
        expect(children.mock.calls.some(([dir]) => dir === root)).toBe(monitor);
      }
    };
    const on = await attempt(true);
    expect(on.result).toBeInstanceOf(PiSandboxError);
    expect(String(on.result.message)).toMatch(/2 new srt-obs-\* folders/);
    expect(on.srt.reset).toHaveBeenCalled();
    expect(on.srt.wrapWithSandboxArgv).not.toHaveBeenCalled();
    // Not asked for: no detection, no failure.
    const off = await attempt(false);
    expect(off.result).not.toBeInstanceOf(Error);
    expect(off.srt.wrapWithSandboxArgv).toHaveBeenCalledTimes(1);
  });

  it("on Linux runs srt's argv behind an OOM score of 1000; elsewhere as srt returns it", async () => {
    for (const platform of ["linux", "darwin"] as const) {
      const srt = fakeSrt(["/bin/bash", "-c", "wrapped"]);
      const provider = createSrtProvider(async () => srt, platform, fakeFs().fs);
      const wrapped = await provider.wrap(plan(), POLICY);
      await provider.dispose?.();
      expect([wrapped.command, ...wrapped.args]).toEqual(
        platform === "linux"
          ? ["/bin/sh", "-c", OOM_FIRST_SCRIPT, "sh", "/bin/bash", "-c", "wrapped"]
          : ["/bin/bash", "-c", "wrapped"],
      );
    }
    expect(OOM_FIRST_SCRIPT).toBe('echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$@"');
  });

  it("starts srt's log monitor only when asked (AGENT_DECK_SANDBOX_MONITOR=1)", async () => {
    const srt = fakeSrt();
    const root = tmpdir().replace(/\/+$/, "");
    const host = fakeFs([root]);
    // srt's monitor makes its socket folder during initialize.
    srt.initialize.mockImplementation(async () => host.fs.mkdir(`${root}/srt-obs-x`));
    const provider = createSrtProvider(async () => srt, "linux", host.fs, true);
    await provider.wrap(plan(), POLICY);
    expect((srt.initialize.mock.calls[0] as unknown[])[2]).toBe(true);
    await provider.dispose?.();
  });

  it("initialises once, prepares the folders, maps the policy and spawns srt's argv", async () => {
    const srt = fakeSrt();
    const host = fakeFs();
    const provider = createSrtProvider(async () => srt, "linux", host.fs);
    const wrapped = await provider.wrap(plan(), POLICY);
    await provider.wrap(plan(), POLICY);

    expect(host.made.slice(0, POLICY.createDirs.length + 1)).toEqual(
      ["/tmp/claude", ...POLICY.createDirs].map((path) => ({ path, kind: "dir" })),
    );
    expect(POLICY.createDirs).toContain("/home/u/.pi/agent/sessions/--app--");
    expect(srt.initialize).toHaveBeenCalledTimes(1);
    // No ask callback, the log monitor off by default; the defaults are the global list, no strictAllowlist.
    expect(srt.initialize.mock.calls[0]).toEqual([
      {
        network: {
          allowedDomains: [...DEFAULT_SANDBOX_DOMAINS],
          deniedDomains: [],
          deniedResolvedAddresses: [...DEFAULT_SANDBOX_DENIED_ADDRESSES],
        },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      },
      undefined,
      false,
    ]);
    expect(srt.updateConfig).not.toHaveBeenCalled();
    const [command, binShell, settings, , cwd, options] = srt.wrapWithSandboxArgv.mock
      .calls[0] as unknown as WrapCall;
    // srt writes TMPDIR=/tmp/claude into its wrapper; the assignment in front
    // of the command itself is the one the command sees.
    expect(command).toBe(
      `TMPDIR='/srv/deck/sandbox/s1/tmp' '/usr/bin/pi' '--mode' 'rpc' '--append-system-prompt' 'it'\\''s "quoted" $HOME'`,
    );
    expect(binShell).toBeUndefined();
    expect(cwd).toBe("/data/wt/s1");
    expect(settings).toEqual({
      filesystem: {
        allowWrite: POLICY.allowWrite,
        // Only the created folders exist here: the one deny path under them is
        // the server's launch folder (created read-only, never by the session).
        denyWrite: ["/srv/deck/sandbox/s1/launch"],
        denyRead: [],
        // The session folder is a write root: its write bind makes it readable.
        allowRead: [],
      },
      network: {
        allowedDomains: POLICY.allowedDomains,
        deniedDomains: [],
        deniedResolvedAddresses: [...DEFAULT_SANDBOX_DENIED_ADDRESSES],
      },
    });
    const writes = (settings.filesystem as { allowWrite: string[] }).allowWrite;
    expect(writes.filter((dir) => dir.startsWith("/data/"))).toEqual([
      "/data/wt/s1",
      "/data/projects/app/.git/objects",
      "/data/projects/app/.git/refs",
      "/data/projects/app/.git/logs",
      "/data/projects/app/.git/worktrees/s1",
    ]);

    expect(options.commandId).toMatch(/^[0-9a-f]{64}$/);
    // No project hosts: the per-command list is empty, the defaults are global.
    expect(srt.registerCommandNetworkLists).toHaveBeenCalledWith(options.commandId, {
      allowedDomains: [],
    });
    expect(wrapped).toEqual({
      command: "/bin/sh",
      args: ["-c", OOM_FIRST_SCRIPT, "sh", "/bin/bash", "-c", "wrapped"],
      env: { ...plan().env, TMPDIR: "/srv/deck/sandbox/s1/tmp", NODE_USE_ENV_PROXY: "1" },
      cwd: "/data/wt/s1",
      release: expect.any(Function),
    });

    expect(srt.cleanupAfterCommand).not.toHaveBeenCalled();
    wrapped.release?.();
    wrapped.release?.();
    expect(srt.cleanupAfterCommand).toHaveBeenCalledTimes(1);
    expect(srt.unregisterCommandNetworkLists).toHaveBeenCalledTimes(1);
    expect(srt.unregisterCommandNetworkLists).toHaveBeenCalledWith(options.commandId);
    expect(srt.cleanupAfterCommand.mock.invocationCallOrder[0]).toBeLessThan(
      srt.unregisterCommandNetworkLists.mock.invocationCallOrder[0]!,
    );

    await provider.dispose?.();
    expect(srt.reset).toHaveBeenCalledTimes(1);
  });

  describe("deny paths (prepareDenyWrite)", () => {
    const G = "/data/projects/s1/.git";
    const worktree = serverPolicy("s1", { projectPath: "/data/projects/s1" });
    const policy = sandboxPolicy({ id: "s1", workspace: { path: "/data/wt/s1" } }, "server", {
      dataDir: "/data",
      projectPath: "/data/projects/s1",
      piAgentDir: "/data/home/.pi/agent",
      agentDir: "/data/home/.pi/agent",
      sessionDir: "/data/home/.pi/agent/sessions/--s1--",
    });
    // A worktree session's writable git folders exist; nothing under them does.
    const existing = ["/data/wt/s1", "/data/wt/s1/.git", `${G}/objects`, `${G}/worktrees/s1`];

    it("an absent objects/info under a writable root is created as a folder and denied", () => {
      const host = fakeFs(existing);
      const denies = prepareDenyWrite(policy, host.fs);
      expect(host.made).toContainEqual({ path: `${G}/objects/info`, kind: "dir" });
      expect(denies).toContain(`${G}/objects/info`);
    });

    it("an absent config.worktree is created as an empty file and denied", () => {
      const host = fakeFs(existing);
      const denies = prepareDenyWrite(policy, host.fs);
      expect(host.made).toContainEqual({
        path: `${G}/worktrees/s1/config.worktree`,
        kind: "file",
        content: "",
      });
      expect(denies).toContain(`${G}/worktrees/s1/config.worktree`);
    });

    it("an absent .json under the writable agent dir is created as {} (Pi reads it as empty)", () => {
      const host = fakeFs(["/data/home/.pi/agent"]);
      const denies = prepareDenyWrite(worktree, host.fs);
      expect(host.made).toContainEqual({
        path: "/data/home/.pi/agent/trust.json",
        kind: "file",
        content: "{}",
      });
      // Pi's models.json schema requires `providers` (it warns on every launch otherwise).
      expect(host.made).toContainEqual({
        path: "/data/home/.pi/agent/models.json",
        kind: "file",
        content: '{"providers":{}}',
      });
      expect(host.made).toContainEqual({ path: "/data/home/.pi/agent/extensions", kind: "dir" });
      expect(denies).toContain("/data/home/.pi/agent/settings.json");
    });

    it("an absent deny path outside every writable root is neither created nor passed", () => {
      const host = fakeFs(existing);
      const denies = prepareDenyWrite(policy, host.fs);
      for (const path of [`${G}/config`, `${G}/hooks`, "/data/home/.gitconfig"]) {
        expect(denies).not.toContain(path);
        expect(host.made.map((entry) => entry.path)).not.toContain(path);
      }
    });

    it("existing deny paths are passed untouched, an existing file is never rewritten", () => {
      const host = fakeFs([...existing, `${G}/config`, `${G}/worktrees/s1/commondir`]);
      const denies = prepareDenyWrite(policy, host.fs);
      expect(denies).toEqual(expect.arrayContaining([`${G}/config`, "/data/wt/s1/.git"]));
      expect(host.made.map((entry) => entry.path)).not.toContain(`${G}/worktrees/s1/commondir`);
    });
  });

  describe("carveReadAroundWrites (srt binds allowRead entries over the write roots inside)", () => {
    const G = "/data/projects/app/.git";
    const A = "/data/home/.pi/agent";

    it("emits the other .git entries only, never a write root", () => {
      const host = fakeFs([
        "/data/projects/app",
        "/data/projects/app/src",
        G,
        `${G}/HEAD`,
        `${G}/config`,
        `${G}/objects`,
        `${G}/refs`,
        `${G}/logs`,
        `${G}/worktrees`,
        `${G}/worktrees/s1`,
        `${G}/worktrees/other`,
      ]);
      const writes = ["/data/wt/s1", `${G}/objects`, `${G}/refs`, `${G}/logs`, `${G}/worktrees/s1`];
      expect(
        carveReadAroundWrites(
          ["/data/wt/s1", "/data/projects/app"],
          writes,
          ["/data"],
          host.fs,
        ).sort(),
      ).toEqual(
        ["/data/projects/app/src", `${G}/HEAD`, `${G}/config`, `${G}/worktrees/other`].sort(),
      );
    });

    it("an agent dir with denied sessions emits no other session and no auth file", () => {
      const sessionDir = `${A}/sessions/--app--`;
      const host = fakeFs([
        A,
        `${A}/auth.json`,
        `${A}/mcp-auth.json`,
        `${A}/settings.json`,
        `${A}/sessions`,
        sessionDir,
        `${A}/sessions/--other--`,
        "/data/home",
        "/data/home/.pi",
      ]);
      const denyRead = ["/data", `${A}/sessions`, `${A}/auth.json`, `${A}/mcp-auth.json`];
      // The agent dir is not writable here (a user session reading the shared entries).
      const carved = carveReadAroundWrites(["/data/home/.pi"], [sessionDir], denyRead, host.fs);
      expect(carved).toEqual([`${A}/settings.json`]);
      // Writable agent dir: every entry at or under a write root is dropped.
      expect(carveReadAroundWrites([A, sessionDir], [A, sessionDir], denyRead, host.fs)).toEqual(
        [],
      );
    });

    it("reads deny globs as srt does: ** crosses folders (an exact entry would cancel srt's mask)", () => {
      const host = fakeFs([
        "/tree",
        "/tree/a",
        "/tree/a/b",
        "/tree/a/b/w",
        "/tree/a/b/auth.json",
        "/tree/a/b/keep.txt",
        "/tree/a/secret",
        "/tree/a/other",
      ]);
      expect(
        carveReadAroundWrites(
          ["/tree"],
          ["/tree/a/b/w"],
          ["/tree/**/auth.json", "/tree/*/secret"],
          host.fs,
        ).sort(),
      ).toEqual(["/tree/a/b/keep.txt", "/tree/a/other"]);
    });

    it("leaves globbed denials out, keeps an unlistable entry, refuses an overlong level", () => {
      const host = fakeFs(["/tmp/x", "/tmp/x/w", "/tmp/x/agent-deck-bridge-ext-1", "/tmp/x/keep"]);
      expect(
        carveReadAroundWrites(["/tmp/x"], ["/tmp/x/w"], ["/tmp/x/agent-deck-*"], host.fs),
      ).toEqual(["/tmp/x/keep"]);
      expect(carveReadAroundWrites(["/data/nope"], ["/data/nope/w"], [], host.fs)).toEqual([
        "/data/nope",
      ]);
      const many = fakeFs([
        "/big",
        "/big/w",
        ...Array.from({ length: MAX_CARVED_ENTRIES }, (_, n) => `/big/f${n}`),
      ]);
      expect(() => carveReadAroundWrites(["/big"], ["/big/w"], [], many.fs)).toThrow(
        PiSandboxError,
      );
    });
  });

  it("a missing package fails the wrap naming the package and the provider", async () => {
    const provider = createSrtProvider(async () => {
      throw new Error("Cannot find package");
    }, "linux");
    const error = await provider.wrap(plan(), POLICY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiSandboxError);
    expect((error as Error).message).toContain(SRT_PACKAGE);
    expect((error as Error).message).toContain('"srt"');
  });

  it("attributes each new violation line to the policy of its live wrap, until released", async () => {
    const srt = fakeSrt();
    const provider = createSrtProvider(async () => srt, "linux", fakeFs().fs);
    const seen: Array<{ policy: unknown; line: string }> = [];
    provider.onViolation!((violation) => seen.push(violation));
    const other = { ...POLICY, tmpDir: "/other" };
    const first = await provider.wrap(plan(), POLICY);
    await provider.wrap(plan(), other);
    const [firstId, secondId] = srt.registerCommandNetworkLists.mock.calls.map(
      (call) => (call as unknown as [string])[0],
    );
    srt.store.add("deny network-outbound a.example:443 (not allowed)", firstId);
    srt.store.add("deny openat /etc/x", secondId);
    srt.store.add("deny network-outbound b.example:443 (not allowed)"); // unattributed
    expect(seen).toEqual([
      { policy: POLICY, line: "deny network-outbound a.example:443 (not allowed)" },
      { policy: other, line: "deny openat /etc/x" },
    ]);
    // A notification with nothing new replays nothing (slice(-0) is everything).
    srt.store.notify();
    expect(seen).toHaveLength(2);
    first.release!();
    srt.store.add("deny network-outbound c.example:443 (late)", firstId);
    expect(seen).toHaveLength(2);
  });

  it("dispose() lets a wrap in flight settle before reset, rejects it, and refuses wraps after it", async () => {
    const srt = fakeSrt();
    let finishWrap: () => void = () => {};
    srt.wrapWithSandboxArgv.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishWrap = () => resolve({ argv: ["/bin/bash", "-c", "x"], env: { IGNORED: "1" } });
        }),
    );
    const provider = createSrtProvider(async () => srt, "linux", fakeFs().fs);
    const wrapping = provider.wrap(plan(), POLICY);
    await vi.waitFor(() => expect(srt.wrapWithSandboxArgv).toHaveBeenCalled());
    const disposing = provider.dispose!();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(srt.reset).not.toHaveBeenCalled();
    finishWrap();
    // Its argv would run after srt's reset: never handed out.
    await expect(wrapping).rejects.toThrow(PiSandboxError);
    await disposing;
    expect(srt.reset).toHaveBeenCalledTimes(1);
    await expect(provider.wrap(plan(), POLICY)).rejects.toThrow(/disposed/);
    expect(srt.initialize).toHaveBeenCalledTimes(1);
  });

  it("dispose() past its deadline still resets a loaded manager whose initialize hangs, without waiting on it", async () => {
    const srt = fakeSrt();
    srt.initialize.mockImplementation(() => new Promise<void>(() => {}));
    // reset itself never settles either: dispose must not wait past its bound.
    srt.reset.mockImplementation(() => new Promise<void>(() => {}));
    const provider = createSrtProvider(async () => srt, "linux", fakeFs().fs, false, 50);
    const wrapping = provider.wrap(plan(), POLICY);
    await vi.waitFor(() => expect(srt.initialize).toHaveBeenCalled());
    const started = Date.now();
    await provider.dispose!();
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(srt.reset).toHaveBeenCalledTimes(1);
    expect(srt.wrapWithSandboxArgv).not.toHaveBeenCalled();
    void wrapping.catch(() => {});
  });

  it("an initialize that finishes after dispose() rejects its wrap and resets that manager once", async () => {
    const srt = fakeSrt();
    let finishInit: () => void = () => {};
    srt.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishInit = resolve;
        }),
    );
    const provider = createSrtProvider(async () => srt, "linux", fakeFs().fs, false, 50);
    const wrapping = provider.wrap(plan(), POLICY);
    await vi.waitFor(() => expect(srt.initialize).toHaveBeenCalled());
    await provider.dispose!(); // past the deadline: reset before the proxies exist
    finishInit();
    await expect(wrapping).rejects.toThrow(PiSandboxError);
    expect(srt.wrapWithSandboxArgv).not.toHaveBeenCalled();
    // The late initialize created proxies after that reset: cleaned up once more.
    expect(srt.reset).toHaveBeenCalledTimes(2);

    // Finishing within dispose()'s wait: one reset in all, no argv either.
    const srt2 = fakeSrt();
    let finishInit2: () => void = () => {};
    srt2.initialize.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishInit2 = resolve;
        }),
    );
    const provider2 = createSrtProvider(async () => srt2, "linux", fakeFs().fs, false, 5_000);
    const wrapping2 = provider2.wrap(plan(), POLICY);
    await vi.waitFor(() => expect(srt2.initialize).toHaveBeenCalled());
    const disposing2 = provider2.dispose!();
    finishInit2();
    await expect(wrapping2).rejects.toThrow(PiSandboxError);
    await disposing2;
    expect(srt2.wrapWithSandboxArgv).not.toHaveBeenCalled();
    expect(srt2.reset).toHaveBeenCalledTimes(1);
  });

  it("drops the SIGINT/SIGTERM resets srt registers, so the host disposes it last", async () => {
    const srt = fakeSrt();
    const reset = (): void => {};
    const own = (): void => {};
    process.on("SIGTERM", own);
    srt.initialize.mockImplementation(async () => {
      process.once("SIGINT", reset);
      process.once("SIGTERM", reset);
    });
    try {
      await createSrtProvider(async () => srt, "linux", fakeFs().fs).wrap(plan(), POLICY);
      expect(process.listeners("SIGINT")).not.toContain(reset);
      expect(process.listeners("SIGTERM")).not.toContain(reset);
      expect(process.listeners("SIGTERM")).toContain(own);
    } finally {
      process.removeListener("SIGTERM", own);
    }
  });

  it("srtProblem names what is missing, and nothing when srt can run", async () => {
    const manager =
      (errors: string[], supported = true) =>
      async () => ({
        isSupportedPlatform: () => supported,
        checkDependencies: () => ({ errors, warnings: [] }),
      });
    expect(await srtProblem(manager([]), "linux")).toBeUndefined();
    expect(await srtProblem(manager(["bubblewrap (bwrap) not installed"]), "linux")).toBe(
      "bubblewrap (bwrap) not installed",
    );
    expect(await srtProblem(manager([], false), "freebsd")).toContain("does not support");
    expect(await srtProblem(manager([]), "win32")).toContain("Windows");
    const missing = await srtProblem(async () => {
      throw new Error("Cannot find package");
    }, "linux");
    expect(missing).toContain(SRT_PACKAGE);
  });

  it("refuses Windows", async () => {
    const srt = fakeSrt();
    const provider = createSrtProvider(async () => srt, "win32");
    await expect(provider.wrap(plan(), POLICY)).rejects.toThrow(/Linux and macOS only/);
    expect(srt.initialize).not.toHaveBeenCalled();
  });

  it("a failed wrap drops the network registration and never cleans up a sandbox", async () => {
    const srt = fakeSrt();
    srt.wrapWithSandboxArgv.mockRejectedValueOnce(new Error("bwrap missing"));
    const provider = createSrtProvider(async () => srt, "linux", fakeFs().fs);
    await expect(provider.wrap(plan(), POLICY)).rejects.toThrow(
      /could not wrap \/usr\/bin\/pi: Error: bwrap missing/,
    );
    expect(srt.unregisterCommandNetworkLists).toHaveBeenCalledTimes(1);
    expect(srt.cleanupAfterCommand).not.toHaveBeenCalled();
  });

  it("a refused network list is the wrap's error, naming the entry, with nothing left registered", async () => {
    const srt = fakeSrt();
    srt.registerCommandNetworkLists.mockImplementationOnce(() => {
      throw new Error('registerCommandNetworkLists: invalid allowedDomains entry "bad"');
    });
    const provider = createSrtProvider(async () => srt, "linux", fakeFs().fs);
    const error = await provider
      .wrap(plan(), serverPolicy("a", { project: { allowedDomains: ["x.example"] } }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiSandboxError);
    expect((error as Error).message).toContain('"bad"');
    expect(srt.wrapWithSandboxArgv).not.toHaveBeenCalled();
    expect(srt.unregisterCommandNetworkLists).not.toHaveBeenCalled();
  });

  it("two sessions with different project hosts get two lists under two ids", async () => {
    const srt = fakeSrt();
    const provider = createSrtProvider(async () => srt, "linux", fakeFs().fs);
    const first = serverPolicy("a", { project: { allowedDomains: ["one.example", "github.com"] } });
    const second = serverPolicy("b", { project: { allowedDomains: ["two.example"] } });
    await provider.wrap(plan(), first);
    await provider.wrap(plan(), second);

    const [[idA, listA], [idB, listB]] = srt.registerCommandNetworkLists.mock.calls as unknown as [
      [string, { allowedDomains: string[] }],
      [string, { allowedDomains: string[] }],
    ];
    expect(idA).not.toBe(idB);
    expect(listA.allowedDomains).toEqual(["one.example"]);
    expect(listB.allowedDomains).toEqual(["two.example"]);
    expect(listB.allowedDomains).not.toContain("one.example");
    const ids = (srt.wrapWithSandboxArgv.mock.calls as unknown as WrapCall[]).map(
      (call) => call[5].commandId,
    );
    expect(ids).toEqual([idA, idB]);
  });

  it("unions denied addresses into srt's configuration, keeping it only once srt took it", async () => {
    const srt = fakeSrt();
    const provider = createSrtProvider(async () => srt, "linux", fakeFs().fs);
    const extra = serverPolicy("b", { extraDeniedAddresses: ["172.17.0.1"] });
    srt.updateConfig.mockImplementationOnce(() => {
      throw new Error("malformed range");
    });
    await expect(provider.wrap(plan(), extra)).rejects.toThrow(/could not prepare the sandbox/);
    expect(srt.registerCommandNetworkLists).not.toHaveBeenCalled();

    await provider.wrap(plan(), serverPolicy("a"));
    expect(srt.updateConfig).toHaveBeenCalledTimes(1); // the defaults need no update
    await provider.wrap(plan(), extra);
    expect(srt.updateConfig).toHaveBeenCalledTimes(2); // retried: the failed one was not kept
    const network = (srt.updateConfig.mock.calls[1] as unknown as [SandboxRuntimeConfig])[0]
      .network;
    expect(network.deniedResolvedAddresses).toEqual([
      ...DEFAULT_SANDBOX_DENIED_ADDRESSES,
      "172.17.0.1",
    ]);
    expect(network.allowedDomains).toEqual([...DEFAULT_SANDBOX_DOMAINS]);
    await provider.wrap(plan(), extra);
    expect(srt.updateConfig).toHaveBeenCalledTimes(2);
  });
});

// A stand-in for srt's `bash -c <bwrap ...>`: an intermediate process that
// runs the real command as its child.
const WRAPPER =
  "const [c, ...a] = process.argv.slice(1); require('child_process').spawn(c, a, { stdio: 'inherit' });";
const wrappingProvider = (
  release = vi.fn(),
  extraArgs: string[] = [],
): SandboxProvider & { release: typeof release } => ({
  name: "srt",
  release,
  wrap: async (p) => ({
    command: process.execPath,
    args: ["-e", WRAPPER, p.command, ...p.args, ...extraArgs],
    env: p.env,
    cwd: p.cwd,
    release,
  }),
});
// The "Pi": starts a long-lived grandchild, reports its pid, echoes stdin,
// and (like Pi) exits when stdin ends unless told to ignore it.
const pi = (exitOnStdinEnd: boolean): string =>
  "const g = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });" +
  "process.stdout.write(JSON.stringify({ grandchild: g.pid }) + '\\n');" +
  "process.stdin.on('data', (d) => process.stdout.write(d));" +
  (exitOnStdinEnd
    ? "process.stdin.on('end', () => { g.kill(); process.exit(0); });"
    : "process.stdin.on('end', () => {}); setInterval(() => {}, 1000);");

async function startWrapped(exitOnStdinEnd: boolean) {
  const provider = wrappingProvider();
  const proc = new PiProcess({
    binPath: process.execPath,
    args: ["-e", pi(exitOnStdinEnd)],
    cwd: process.cwd(),
    sandbox: { provider, policy: POLICY },
  });
  const lines: string[] = [];
  const seen = new Promise<void>((resolve) =>
    proc.on("line", (line) => {
      lines.push(line);
      if (lines.length === 2) resolve();
    }),
  );
  proc.start();
  expect(proc.isRunning).toBe(true);
  proc.writeLine('{"type":"ping"}\n');
  await seen;
  const grandchild = (
    JSON.parse(lines.find((l) => l.includes("grandchild"))!) as { grandchild: number }
  ).grandchild;
  expect(lines).toContain('{"type":"ping"}');
  return { proc, provider, grandchild, wrapperPid: proc.pid! };
}

describe("PiProcess with a wrapping provider", () => {
  it("queues lines written during the wrap; stop() ends stdin first and Pi exits on it", async () => {
    const { proc, provider, grandchild, wrapperPid } = await startWrapped(true);
    const started = Date.now();
    const exit = await proc.stop();
    // Exited by itself on stdin end, well inside the 3 s grace: never killed.
    expect(Date.now() - started).toBeLessThan(2_500);
    expect(exit).toEqual({ code: 0, signal: null });
    expect(await gone(wrapperPid)).toBe(true);
    expect(await gone(grandchild)).toBe(true);
    expect(provider.release).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("a Pi that ignores stdin end is killed with its tree after the grace", async () => {
    const { proc, provider, grandchild, wrapperPid } = await startWrapped(false);
    const started = Date.now();
    await proc.stop();
    expect(Date.now() - started).toBeGreaterThanOrEqual(2_900);
    expect(await gone(wrapperPid)).toBe(true);
    expect(await gone(grandchild)).toBe(true);
    expect(provider.release).toHaveBeenCalledTimes(1);
  }, 15_000);

  it("a spawn that throws after the wrap is a diagnostic exit, and the wrap is released", async () => {
    const provider = wrappingProvider(vi.fn(), ["nul\0byte"]);
    const proc = new PiProcess({
      binPath: process.execPath,
      args: ["-e", pi(true)],
      cwd: process.cwd(),
      sandbox: { provider, policy: POLICY },
    });
    const exit = new Promise((resolve) => proc.once("exit", resolve));
    proc.start();
    expect(await exit).toEqual({ code: null, signal: null });
    expect(proc.stderr).toMatch(/null bytes|\\0|ERR_INVALID_ARG_VALUE/i);
    expect(provider.release).toHaveBeenCalledTimes(1);
  });

  it("a failed wrap is an exit with the error in stderr, never an unsandboxed spawn", async () => {
    const proc = new PiProcess({
      binPath: process.execPath,
      args: ["-e", pi(true)],
      cwd: process.cwd(),
      sandbox: {
        provider: createSrtProvider(async () => {
          throw new Error("Cannot find package");
        }, "linux"),
        policy: POLICY,
      },
    });
    const exit = new Promise((resolve) => proc.once("exit", resolve));
    proc.start();
    expect(await exit).toEqual({ code: null, signal: null });
    expect(proc.pid).toBeUndefined();
    expect(proc.stderr).toContain(SRT_PACKAGE);
  });

  it("stop() during the wrap exits without spawning and releases the wrap", async () => {
    const provider = wrappingProvider();
    const proc = new PiProcess({
      binPath: process.execPath,
      args: ["-e", pi(true)],
      cwd: process.cwd(),
      sandbox: { provider, policy: POLICY },
    });
    proc.start();
    expect(await proc.stop()).toEqual({ code: null, signal: null });
    await new Promise((r) => setTimeout(r, 50));
    expect(proc.pid).toBeUndefined();
    expect(proc.isRunning).toBe(false);
    expect(provider.release).toHaveBeenCalledTimes(1);
  });
});
