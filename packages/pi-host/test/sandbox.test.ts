import {
  DEFAULT_SANDBOX_DENIED_ADDRESSES,
  DEFAULT_SANDBOX_DOMAINS,
  sandboxPolicy,
  type SandboxPolicy,
  type SandboxPolicyInput,
} from "@agent-deck/domain";
import type { SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { describe, expect, it, vi } from "vitest";
import { PiProcess } from "../src/PiProcess.ts";
import {
  createSrtProvider,
  noneProvider,
  PiSandboxError,
  prepareDenyWrite,
  SRT_PACKAGE,
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

function fakeSrt(argv: string[] = ["/bin/bash", "-c", "wrapped"]) {
  return {
    initialize: vi.fn(async () => {}),
    updateConfig: vi.fn(),
    wrapWithSandboxArgv: vi.fn(async () => ({ argv, env: { IGNORED: "1" } })),
    registerCommandNetworkLists: vi.fn(),
    unregisterCommandNetworkLists: vi.fn(),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(async () => {}),
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

describe("srt provider (fake SandboxManager)", () => {
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
    // One argument: no ask callback; the defaults are the global list, no strictAllowlist.
    expect(srt.initialize.mock.calls[0]).toEqual([
      {
        network: {
          allowedDomains: [...DEFAULT_SANDBOX_DOMAINS],
          deniedDomains: [],
          deniedResolvedAddresses: [...DEFAULT_SANDBOX_DENIED_ADDRESSES],
        },
        filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
      },
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
        // Only the created folders exist here, and no deny path is under them.
        denyWrite: [],
        denyRead: [],
        allowRead: ["/home/u/.pi/agent/sessions/--app--"],
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
      command: "/bin/bash",
      args: ["-c", "wrapped"],
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

  it("a missing package fails the wrap naming the package and the provider", async () => {
    const provider = createSrtProvider(async () => {
      throw new Error("Cannot find package");
    }, "linux");
    const error = await provider.wrap(plan(), POLICY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiSandboxError);
    expect((error as Error).message).toContain(SRT_PACKAGE);
    expect((error as Error).message).toContain('"srt"');
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
