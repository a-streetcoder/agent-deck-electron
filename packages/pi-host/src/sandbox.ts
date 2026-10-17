import { randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  DEFAULT_SANDBOX_DENIED_ADDRESSES,
  DEFAULT_SANDBOX_DOMAINS,
  type SandboxPolicy,
} from "@agent-deck/domain";
import type {
  SandboxManager,
  SandboxRuntimeConfig,
  SandboxViolationStore,
} from "@anthropic-ai/sandbox-runtime";

/**
 * The process sandbox around a spawn (ADR 0007). A provider turns a command
 * into the command that runs it inside the sandbox; the session never sees
 * it. PiProcess wraps Pi with it; SBX-03 wraps the loop engine's validation
 * commands, the script runner and the terminal with the same provider.
 *
 * - `none`: the command unchanged. The default everywhere and the only
 *   provider on Windows.
 * - `srt`: Anthropic's `@anthropic-ai/sandbox-runtime` (bubblewrap on Linux,
 *   Seatbelt on macOS). Loaded on first use; when it cannot be loaded the wrap
 *   fails with a PiSandboxError and the spawn with it, never falling back to
 *   `none`.
 *
 * ## How srt maps (0.0.80)
 *
 * srt wraps a shell command string, not an argv. `wrapWithSandboxArgv` returns
 * `[/bin/bash, -c, <wrapped>]` on Linux and macOS, so the command and args are
 * shell-quoted into that string and the argv is spawned as is. The proxy
 * settings are baked into the string; the command's env is kept (srt's
 * returned env is only `process.env`) with `NODE_USE_ENV_PROXY=1` added so
 * Node's own `fetch` goes through srt's proxy.
 *
 * srt's SandboxManager is one per process and its proxy decides from the
 * global configuration. It is initialised once with the default host list
 * (`DEFAULT_SANDBOX_DOMAINS`) and the private address ranges; each wrap
 * registers the project's extra hosts under a random 256-bit command id
 * (`registerCommandNetworkLists`). No `strictAllowlist`, no ask callback.
 * Filesystem rules go in the per-wrap configuration. `deniedResolvedAddresses`
 * is global-only in srt, so the addresses sessions bring are unioned into the
 * global configuration (`updateConfig`, live); the union only widens a deny.
 *
 * Each successful wrap's `release()` (PiProcess calls it on exit) runs srt's
 * `cleanupAfterCommand()` once, which drops the bwrap mount placeholders and
 * the active-sandbox count, and then unregisters the network list.
 *
 * ## Host-side effects of srt
 *
 * - `initialize` registers `SIGINT`, `SIGTERM` and `exit` handlers in this
 *   (the server's) process that reset srt; the provider removes the two signal
 *   handlers again, so the host disposes the provider last in its own shutdown.
 * - For a deny path that does not exist, srt creates an empty placeholder
 *   file on the host to mount over, of whatever type it guesses. An absent
 *   deny path under a writable root is also one the session could create
 *   itself (an `objects/info/alternates`, a `config.worktree`, an extension)
 *   for the server's unwrapped git or Pi to read later. So the provider
 *   creates every absent `denyWrite` entry under an existing writable root as
 *   the kind the policy names (an empty folder, an empty file, `{}` for a
 *   `.json` file, which Pi reads as no settings) and passes it to srt, which
 *   binds it read-only. Deny paths outside every writable root cannot be
 *   created by the session; the absent ones are not passed (no placeholder
 *   lands in, say, a `.git` the server uses). `denyRead` entries are passed
 *   only when they exist; globs are kept, srt expands them.
 * - srt writes `TMPDIR=/tmp/claude` into the wrapped command, and
 *   `/tmp/claude` is writable to every sandbox, shared between sessions. The
 *   provider creates it and sets `TMPDIR` to the policy's per-session `tmpDir`
 *   in front of the command itself, which wins over srt's.
 * - srt skips write roots that do not exist, so the provider creates the
 *   policy's `createDirs` (scratch, tmpDir, session folder, home toolchain
 *   folders) first. The toolchain folders are one home on the server, shared
 *   by every user's sessions (owner decision pending).
 *
 * ## Process group
 *
 * PiProcess spawns detached, so the outer `bash -c` is the process group
 * leader as before. bubblewrap runs the sandboxed command with
 * `--new-session --die-with-parent` in its own pid namespace: Pi is not in the
 * leader's group, but signalling the group kills bubblewrap, and its death
 * SIGKILLs the whole namespace (Pi and every process Pi started). So stop()
 * under a sandbox ends Pi's stdin first (Pi exits cleanly on it) and kills the
 * tree only after the grace period.
 */
export interface SandboxProvider {
  readonly name: "none" | "srt";
  wrap(command: SandboxCommand, policy: SandboxPolicy): Promise<SandboxedCommand>;
  dispose?(): Promise<void>;
  /** Each violation the sandbox records for a live wrap, with the policy that
   * wrap was given (the caller maps it to its session). Returns the
   * unsubscribe. */
  onViolation?(listener: (violation: SandboxViolationLine) => void): () => void;
}

/** One violation line of srt, attributed to the policy of its wrap. */
export interface SandboxViolationLine {
  policy: SandboxPolicy;
  line: string;
}

/** What to spawn: an argv, its env and its working directory. */
export interface SandboxCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
}

/** A wrapped command; `release` undoes per-spawn provider state once the
 * process is gone (idempotent). */
export interface SandboxedCommand extends SandboxCommand {
  release?(): void;
}

/** A provider is chosen together with the policy it applies. */
export interface PiSandbox {
  provider: SandboxProvider;
  policy: SandboxPolicy;
}

export class PiSandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PiSandboxError";
  }
}

export const noneProvider: SandboxProvider = {
  name: "none",
  wrap: async (command) => command,
};

export const SRT_PACKAGE = "@anthropic-ai/sandbox-runtime";
/** srt points TMPDIR here inside the sandbox but does not create it. */
const SRT_TMPDIR = "/tmp/claude";

type SrtManager = Pick<
  typeof SandboxManager,
  | "initialize"
  | "updateConfig"
  | "wrapWithSandboxArgv"
  | "registerCommandNetworkLists"
  | "unregisterCommandNetworkLists"
  | "cleanupAfterCommand"
  | "reset"
> & {
  getSandboxViolationStore(): Pick<
    SandboxViolationStore,
    "getTotalCount" | "getViolationsForCommand" | "subscribe"
  >;
};

const baseConfig = (): SandboxRuntimeConfig => ({
  network: {
    allowedDomains: [...DEFAULT_SANDBOX_DOMAINS],
    deniedDomains: [],
    deniedResolvedAddresses: [...DEFAULT_SANDBOX_DENIED_ADDRESSES],
  },
  filesystem: { denyRead: [], allowWrite: [], denyWrite: [] },
});

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
const DEFAULT_HOSTS = new Set(DEFAULT_SANDBOX_DOMAINS.map((domain) => domain.toLowerCase()));

/** The host file operations the provider needs (tests inject fakes). */
export interface SandboxFs {
  /** Anything at the path, a dangling link included. */
  exists(path: string): boolean;
  mkdir(path: string): void;
  /** Create a new file (never overwrites, never follows a link). */
  createFile(path: string, content: string): void;
}

export const hostFs: SandboxFs = {
  exists: (path) => {
    try {
      lstatSync(path);
      return true;
    } catch {
      return false;
    }
  },
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  createFile: (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, { flag: "wx" });
  },
};

/**
 * The `denyWrite` paths to give srt: those that exist, and the absent ones
 * under an existing writable root, created first as their kind so the session
 * cannot create them (see the module doc). Absent ones elsewhere are dropped.
 */
export function prepareDenyWrite(policy: SandboxPolicy, fs: SandboxFs = hostFs): string[] {
  const roots = policy.allowWrite.filter((root) => fs.exists(root));
  const out: string[] = [];
  for (const { path, kind } of policy.denyWrite) {
    if (!fs.exists(path)) {
      if (!roots.some((root) => path === root || path.startsWith(`${root}/`))) continue;
      if (kind === "dir") fs.mkdir(path);
      else fs.createFile(path, path.endsWith(".json") ? "{}" : "");
    }
    out.push(path);
  }
  return out;
}

/** srt's per-wrap settings for one session; `deniedDomains` must be present or
 * srt refuses. `denyWrite` comes from prepareDenyWrite; `denyRead` keeps the
 * entries that exist and every glob (srt expands those). */
export function srtSettings(
  policy: SandboxPolicy,
  denyWrite: string[],
  fs: SandboxFs = hostFs,
): Partial<SandboxRuntimeConfig> {
  return {
    filesystem: {
      allowWrite: policy.allowWrite,
      denyWrite,
      denyRead: policy.denyRead.filter((entry) => entry.includes("*") || fs.exists(entry)),
      allowRead: policy.allowRead,
    },
    network: {
      allowedDomains: policy.allowedDomains,
      deniedDomains: [],
      deniedResolvedAddresses: policy.deniedResolvedAddresses,
    },
  };
}

/** The hosts a session adds to the global defaults: its per-command list. */
export const projectHosts = (policy: SandboxPolicy): string[] =>
  policy.allowedDomains.filter((domain) => !DEFAULT_HOSTS.has(domain.toLowerCase()));

const wrapError = (what: string, error: unknown): PiSandboxError =>
  error instanceof PiSandboxError
    ? error
    : new PiSandboxError(`pi-host: sandbox provider "srt" ${what}: ${String(error)}`, {
        cause: error,
      });

/**
 * Run srt's initialize without the SIGINT/SIGTERM handlers it registers in
 * this process: they reset srt (its proxies) the moment a signal arrives,
 * while the host is still stopping the sandboxed processes. The host calls
 * the provider's dispose() last in its own shutdown instead. srt's `exit`
 * handler stays, as the last-resort cleanup.
 */
async function withoutSignalCleanup(run: () => Promise<void>): Promise<void> {
  const signals = ["SIGINT", "SIGTERM"] as const;
  const before = new Map(signals.map((signal) => [signal, new Set(process.rawListeners(signal))]));
  try {
    await run();
  } finally {
    for (const signal of signals) {
      for (const listener of process.rawListeners(signal)) {
        if (!before.get(signal)!.has(listener)) {
          process.removeListener(signal, listener as (...args: unknown[]) => void);
        }
      }
    }
  }
}

/**
 * Why srt cannot run on this host, or undefined when it can: its package
 * loads, the platform is one it supports, and its dependency check
 * (bubblewrap and socat on Linux) reports no error.
 */
export async function srtProblem(
  load: () => Promise<
    Pick<typeof SandboxManager, "isSupportedPlatform" | "checkDependencies">
  > = async () => (await import(SRT_PACKAGE)).SandboxManager,
  platform: NodeJS.Platform = process.platform,
): Promise<string | undefined> {
  if (platform === "win32") return "srt does not run on Windows";
  let srt: Pick<typeof SandboxManager, "isSupportedPlatform" | "checkDependencies">;
  try {
    srt = await load();
  } catch (error) {
    return `${SRT_PACKAGE} could not be loaded: ${String(error)}`;
  }
  if (!srt.isSupportedPlatform()) return `srt does not support ${platform}`;
  const { errors } = srt.checkDependencies();
  return errors.length > 0 ? errors.join("; ") : undefined;
}

/** An srt provider over `load` (tests inject a fake manager and file checks). */
export function createSrtProvider(
  load: () => Promise<SrtManager> = async () => (await import(SRT_PACKAGE)).SandboxManager,
  platform: NodeJS.Platform = process.platform,
  fs: SandboxFs = hostFs,
): SandboxProvider {
  let manager: Promise<SrtManager> | undefined;
  let initialized: Promise<void> | undefined;
  let global = baseConfig();
  // The policy of every live wrap by its command id, for violation attribution.
  const active = new Map<string, SandboxPolicy>();
  const violationListeners = new Set<(violation: SandboxViolationLine) => void>();
  let unsubscribeStore: (() => void) | undefined;
  /** dispose() ran: no initialize and no wrap after it. */
  let disposed = false;
  /** Wraps in flight, which dispose() lets settle before it resets srt. */
  const pending = new Set<Promise<unknown>>();

  /** Attribute each new line of srt's store to the live wrap it belongs to. */
  const watchViolations = (srt: SrtManager): void => {
    if (unsubscribeStore || violationListeners.size === 0) return;
    const store = srt.getSandboxViolationStore();
    let seen = store.getTotalCount();
    unsubscribeStore = store.subscribe((all) => {
      const total = store.getTotalCount();
      const count = Math.min(total - seen, all.length);
      seen = total;
      // slice(-0) is the whole list: nothing new is nothing to do.
      if (count <= 0) return;
      const fresh = new Set(all.slice(-count));
      for (const [commandId, policy] of active) {
        for (const violation of store.getViolationsForCommand(commandId)) {
          if (!fresh.has(violation)) continue;
          for (const listener of violationListeners) listener({ policy, line: violation.line });
        }
      }
    });
  };

  const ready = async (): Promise<SrtManager> => {
    if (disposed) throw new PiSandboxError(`pi-host: sandbox provider "srt" was disposed`);
    manager ??= load().catch((error: unknown) => {
      manager = undefined;
      throw new PiSandboxError(
        `pi-host: sandbox provider "srt" needs the package ${SRT_PACKAGE}, which could not be loaded: ${String(error)}`,
        { cause: error },
      );
    });
    const srt = await manager;
    // The log monitor: srt then observes refused writes (Linux seccomp,
    // macOS Seatbelt) besides the refused hosts its proxy always records.
    initialized ??= withoutSignalCleanup(() => srt.initialize(global, undefined, true)).catch(
      (error: unknown) => {
        initialized = undefined;
        throw wrapError(`could not start ${SRT_PACKAGE}`, error);
      },
    );
    await initialized;
    watchViolations(srt);
    return srt;
  };

  /** Union the policy's denied addresses into srt's global configuration. */
  const widen = (srt: SrtManager, policy: SandboxPolicy): void => {
    const denied = global.network.deniedResolvedAddresses ?? [];
    const more = policy.deniedResolvedAddresses.filter((entry) => !denied.includes(entry));
    if (more.length === 0) return;
    const next = {
      ...global,
      network: { ...global.network, deniedResolvedAddresses: [...denied, ...more] },
    };
    srt.updateConfig(next); // throws on a malformed range: `global` stays as it was
    global = next;
  };

  return {
    name: "srt",
    wrap(cmd, policy) {
      const run = wrapOne(cmd, policy);
      pending.add(run);
      void run.then(
        () => pending.delete(run),
        () => pending.delete(run),
      );
      return run;
    },
    onViolation(listener) {
      violationListeners.add(listener);
      if (initialized) void manager?.then(watchViolations);
      return () => {
        violationListeners.delete(listener);
      };
    },
    async dispose() {
      disposed = true;
      // Let an initialize and the wraps in flight finish before srt resets.
      await Promise.allSettled([...pending]);
      const started = initialized;
      if (!started) return;
      await started.catch(() => {});
      const srt = await manager;
      initialized = undefined;
      unsubscribeStore?.();
      unsubscribeStore = undefined;
      active.clear();
      global = baseConfig();
      await srt?.reset();
    },
  };

  async function wrapOne(cmd: SandboxCommand, policy: SandboxPolicy): Promise<SandboxedCommand> {
    if (platform === "win32") {
      throw new PiSandboxError(
        'pi-host: sandbox provider "srt" runs on Linux and macOS only; use "none" on Windows',
      );
    }
    const srt = await ready();
    let denyWrite: string[];
    try {
      widen(srt, policy);
      // The roots first: a deny path is created only under a root that exists.
      for (const dir of [SRT_TMPDIR, ...policy.createDirs]) fs.mkdir(dir);
      denyWrite = prepareDenyWrite(policy, fs);
    } catch (error) {
      throw wrapError("could not prepare the sandbox", error);
    }
    // 256 random bits: the id is all that binds a connection to this list.
    const commandId = randomBytes(32).toString("hex");
    let registered = false;
    try {
      srt.registerCommandNetworkLists(commandId, { allowedDomains: projectHosts(policy) });
      registered = true;
      active.set(commandId, policy);
      const command = `TMPDIR=${shellQuote(policy.tmpDir)} ${[cmd.command, ...cmd.args]
        .map(shellQuote)
        .join(" ")}`;
      const { argv } = await srt.wrapWithSandboxArgv(
        command,
        undefined,
        srtSettings(policy, denyWrite, fs),
        undefined,
        cmd.cwd,
        { commandId },
      );
      const [shell, ...args] = argv;
      if (!shell) throw new Error("srt returned an empty argv");
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        try {
          srt.cleanupAfterCommand();
        } finally {
          active.delete(commandId);
          srt.unregisterCommandNetworkLists(commandId);
        }
      };
      return {
        command: shell,
        args,
        env: { ...cmd.env, TMPDIR: policy.tmpDir, NODE_USE_ENV_PROXY: "1" },
        cwd: cmd.cwd,
        release,
      };
    } catch (error) {
      active.delete(commandId);
      if (registered) srt.unregisterCommandNetworkLists(commandId);
      throw wrapError(`could not wrap ${cmd.command}`, error);
    }
  }
}

/** The process-wide srt provider (srt's SandboxManager is a singleton). */
export const srtProvider: SandboxProvider = createSrtProvider();
