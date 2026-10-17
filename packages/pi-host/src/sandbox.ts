import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_SANDBOX_DENIED_ADDRESSES,
  DEFAULT_SANDBOX_DOMAINS,
  type SandboxPolicy,
} from "@agent-deck/domain";
import type {
  NetworkConfigSchema as NetworkConfig,
  SandboxManager,
  SandboxRuntimeConfig,
  SandboxViolationStore,
} from "@anthropic-ai/sandbox-runtime";
// Deep imports (no exports map; srt is pinned): the carve must read deny globs
// exactly as srt does.
import { denyGlobRegex } from "@anthropic-ai/sandbox-runtime/dist/sandbox/glob-pattern.js";
import { containsGlobChars } from "@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js";

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
 *   `.json` file, which Pi reads as no settings, `{"providers":{}}` for
 *   `models.json`, whose schema needs the key) and passes it to srt, which
 *   binds it read-only. Deny paths outside every writable root cannot be
 *   created by the session; the absent ones are not passed (no placeholder
 *   lands in, say, a `.git` the server uses). `denyRead` entries are passed
 *   only when they exist; globs are kept, srt expands them.
 * - srt writes `TMPDIR=/tmp/claude` into the wrapped command, and
 *   `/tmp/claude` is writable to every sandbox, shared between sessions. The
 *   provider creates it and sets `TMPDIR` to the policy's per-session `tmpDir`
 *   in front of the command itself, which wins over srt's.
 * - On Linux a `privateTmp` policy (the server's) gives the sandbox its own
 *   `/tmp`: a read-deny of `/tmp`, which srt turns into an empty writable
 *   tmpfs, with `/tmp/claude` (still shared) and, by their exact paths, this
 *   srt's proxy sockets and its write monitor's socket folder bound back. It
 *   lives as long as the wrap, so Pi and the commands it starts share it,
 *   while the session's terminal or a validation command (other wraps) each
 *   get their own; TMPDIR stays the session's folder on disk. The tmpfs has no
 *   size of its own (srt passes none): it counts against the container's
 *   memory limit, so on Linux every wrapped command first raises its OOM score
 *   to 1000 (OOM_FIRST_SCRIPT).
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
/** The folder srt's Linux write monitor makes for its socket (0.0.80:
 * `mkdtemp(<tmpdir>/srt-obs-)`; no accessor, sandbox.srtContract.test pins it). */
export const SRT_MONITOR_DIR_PREFIX = "srt-obs-";

/**
 * Raises the sandboxed tree's OOM score to the maximum before srt's wrapper
 * runs (raising needs no privilege; bubblewrap and everything under it
 * inherit it), so a session that fills its in-memory `/tmp` is killed before
 * the server. The argv is `[/bin/sh, -c, <this>, sh, <srt's argv>...]`.
 */
export const OOM_FIRST_SCRIPT = 'echo 1000 > /proc/self/oom_score_adj 2>/dev/null; exec "$@"';

type SrtManager = Pick<
  typeof SandboxManager,
  | "initialize"
  | "updateConfig"
  | "wrapWithSandboxArgv"
  | "registerCommandNetworkLists"
  | "unregisterCommandNetworkLists"
  | "cleanupAfterCommand"
  | "reset"
  | "getLinuxHttpSocketPath"
  | "getLinuxSocksSocketPath"
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
  /** The entry names of a directory (not of a link to one); undefined for
   * anything else or an unreadable one. */
  children(path: string): string[] | undefined;
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
  children: (path) => {
    try {
      return lstatSync(path).isDirectory() ? readdirSync(path) : undefined;
    } catch {
      return undefined;
    }
  },
};

/** The most children one carved folder may have (each becomes a bwrap argument). */
export const MAX_CARVED_ENTRIES = 200;

/**
 * srt (0.0.80) restores the write roots a read-denied tmpfs wiped and only
 * then binds the `allowRead` entries back read-only, so an `allowRead` entry
 * that holds a write root makes that root read-only (a worktree session's
 * project holding `.git/objects`, a user's folder holding their agent dir).
 * Such an entry is replaced by its children, recursively along the write
 * roots only. Never emitted: a write root (its own bind makes it readable),
 * anything at or under a write root (an entry there is dropped for the same
 * reason; srt skips it too), and anything at or under a `denyRead` entry that
 * lies inside the entry being carved: srt
 * would re-expose it (an `allowRead` inside a denied folder is restored, and
 * one naming an exact file drops that file's mask). An entry that cannot be
 * listed is kept as it is (reads stay, those writes are lost). A carved
 * folder with more than MAX_CARVED_ENTRIES children fails the wrap.
 * ponytail: the children are listed at wrap time; an entry created later next
 * to a write root stays hidden from that sandbox, and a file the server
 * replaces by rename stays the old one there, until the next wrap.
 */
export function carveReadAroundWrites(
  allowRead: readonly string[],
  allowWrite: readonly string[],
  denyRead: readonly string[],
  fs: SandboxFs = hostFs,
): string[] {
  const within = (root: string, path: string): boolean =>
    path === root || path.startsWith(`${root}/`);
  // srt's own glob reading of a deny entry (`**` crosses separators, a match
  // covers its subtree), so the carve never emits what srt would mask.
  const globs = denyRead
    .filter(containsGlobChars)
    .map((entry) => new RegExp(denyGlobRegex(entry.replace(/\/\*\*$/, "") || "/")));
  // Only denials at or inside the entry being carved: the one it re-allows
  // from (`<dataDir>` around a project) is above it.
  const denied = (top: string, path: string): boolean =>
    denyRead.some(
      (entry) => !containsGlobChars(entry) && within(top, entry) && within(entry, path),
    ) || globs.some((glob) => !glob.test(top) && glob.test(path));
  const underWrite = (path: string): boolean => allowWrite.some((root) => within(root, path));
  const carve = (top: string, entry: string): string[] => {
    if (!allowWrite.some((root) => root !== entry && within(entry, root))) return [entry];
    const names = fs.children(entry);
    if (!names) return [entry];
    if (names.length > MAX_CARVED_ENTRIES) {
      throw new PiSandboxError(
        `pi-host: sandbox: ${entry} holds a writable folder and ${names.length} other entries; at most ${MAX_CARVED_ENTRIES} can be bound one by one`,
      );
    }
    return names
      .map((name) => `${entry}/${name}`)
      .filter((child) => !underWrite(child) && !denied(top, child))
      .flatMap((child) => carve(top, child));
  };
  return [
    ...new Set(
      allowRead.filter((entry) => !underWrite(entry)).flatMap((entry) => carve(entry, entry)),
    ),
  ];
}

/** What an absent denied file is created as: Pi reads each as empty. */
const emptyFileFor = (path: string): string =>
  path.endsWith("/models.json") ? '{"providers":{}}' : path.endsWith(".json") ? "{}" : "";

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
      else fs.createFile(path, emptyFileFor(path));
    }
    out.push(path);
  }
  return out;
}

/** srt's per-wrap settings for one session; `deniedDomains` must be present or
 * srt refuses. `denyWrite` comes from prepareDenyWrite; `denyRead` keeps the
 * entries that exist and every glob (srt expands those). On Linux a
 * `privateTmp` policy read-denies `/tmp`: srt mounts an empty, writable tmpfs
 * there and restores its own `/tmp/claude`; `tmpBinds` (this srt's proxy
 * sockets and its monitor's socket folder, which srt bound before the tmpfs)
 * are bound back into it, or the sandbox has no network and no monitor. */
export function srtSettings(
  policy: SandboxPolicy,
  denyWrite: string[],
  fs: SandboxFs = hostFs,
  platform: NodeJS.Platform = process.platform,
  tmpBinds: readonly string[] = [],
): Partial<SandboxRuntimeConfig> {
  const privateTmp = policy.privateTmp === true && platform === "linux";
  return {
    filesystem: {
      allowWrite: policy.allowWrite,
      denyWrite,
      denyRead: [
        ...policy.denyRead.filter((entry) => entry.includes("*") || fs.exists(entry)),
        ...(privateTmp ? ["/tmp"] : []),
      ],
      allowRead: [
        ...carveReadAroundWrites(policy.allowRead, policy.allowWrite, policy.denyRead, fs),
        ...(privateTmp ? tmpBinds : []),
      ],
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

/**
 * Why `provider` cannot actually run a sandboxed command here, or undefined
 * when it can: wraps `/bin/true` under a minimal policy (a fresh scratch
 * folder writable, no hosts) and runs it, so a host whose binaries are present
 * but whose namespaces, mounts or /proc are refused (a container without the
 * deploy/ profiles) is caught at startup rather than on every spawn.
 */
export async function sandboxProbeProblem(
  provider: SandboxProvider,
  timeoutMs = 15_000,
): Promise<string | undefined> {
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), "agent-deck-sandbox-probe-")));
  const policy: SandboxPolicy = {
    allowWrite: [scratch],
    denyWrite: [],
    denyRead: [],
    allowRead: [],
    tmpDir: scratch,
    createDirs: [],
    allowedDomains: [],
    deniedResolvedAddresses: [],
  };
  // One deadline for the wrap (srt's initialize), the run and the release.
  let timer: NodeJS.Timeout | undefined;
  let child: ReturnType<typeof spawn> | undefined;
  let late = false;
  const deadline = new Promise<string>((resolve) => {
    timer = setTimeout(() => {
      late = true;
      child?.kill("SIGKILL");
      resolve(`the sandbox probe did not finish within ${timeoutMs} ms`);
    }, timeoutMs);
  });
  const run = async (): Promise<string | undefined> => {
    let wrapped: SandboxedCommand | undefined;
    try {
      wrapped = await provider.wrap(
        { command: "/bin/true", args: [], env: { PATH: process.env.PATH }, cwd: scratch },
        policy,
      );
      if (late) return undefined;
      const { command, args, env, cwd } = wrapped;
      return await new Promise<string | undefined>((resolve) => {
        let stderr = "";
        child = spawn(command, args, { cwd, env, stdio: ["ignore", "ignore", "pipe"] });
        child.stderr?.on("data", (chunk: Buffer) => {
          if (stderr.length < 2000) stderr += chunk.toString();
        });
        child.on("error", (error) => {
          resolve(`a sandboxed /bin/true could not start: ${String(error)}`);
        });
        child.on("close", (code, signal) => {
          resolve(
            code === 0
              ? undefined
              : `a sandboxed /bin/true exited ${code ?? signal}: ${stderr.trim() || "no output"}`,
          );
        });
      });
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    } finally {
      wrapped?.release?.();
    }
  };
  try {
    return await Promise.race([run(), deadline]);
  } finally {
    clearTimeout(timer);
    try {
      rmSync(scratch, { recursive: true, force: true });
    } catch {
      // A killed child may still hold it as its cwd: a temp folder, left behind.
    }
  }
}

/**
 * Why srt's own schema refuses `entries` as `deniedResolvedAddresses`, or
 * undefined: checked at startup so a value srt rejects does not fail every
 * wrap instead.
 */
export async function srtDeniedAddressesProblem(
  entries: readonly string[],
): Promise<string | undefined> {
  if (entries.length === 0) return undefined;
  const { NetworkConfigSchema } = (await import(SRT_PACKAGE)) as {
    NetworkConfigSchema: typeof NetworkConfig;
  };
  const parsed = NetworkConfigSchema.safeParse({
    allowedDomains: [],
    deniedDomains: [],
    deniedResolvedAddresses: [...entries],
  });
  if (parsed.success) return undefined;
  return parsed.error.issues
    .map((issue) => {
      const index = issue.path[1];
      return typeof index === "number" ? `"${entries[index]}": ${issue.message}` : issue.message;
    })
    .join("; ");
}

/**
 * An srt provider over `load` (tests inject a fake manager and file checks).
 * `monitor`: srt's log monitor, which reports refused writes (on Linux its
 * seccomp observer sees every write-intent syscall: 10k small writes took
 * about twice as long on the VM, SBX-04). Off unless
 * `AGENT_DECK_SANDBOX_MONITOR=1`; refused hosts are reported either way.
 */
export function createSrtProvider(
  load: () => Promise<SrtManager> = async () => (await import(SRT_PACKAGE)).SandboxManager,
  platform: NodeJS.Platform = process.platform,
  fs: SandboxFs = hostFs,
  monitor: boolean = process.env.AGENT_DECK_SANDBOX_MONITOR === "1",
  /** How long dispose() waits for a wrap or initialize in flight before it
   * resets srt anyway (a hung one would hold it forever). */
  disposeWaitMs = 2_000,
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
  /** The manager once loaded, kept apart from the promises dispose() races. */
  let loaded: SrtManager | undefined;
  /** dispose() has called reset on `loaded`. */
  let resetIssued = false;
  /** The one cleanup of an initialize that finished after that reset. */
  let lateReset: Promise<void> | undefined;
  const disposedError = (): PiSandboxError =>
    new PiSandboxError(`pi-host: sandbox provider "srt" was disposed`);
  /** Wraps in flight, which dispose() lets settle before it resets srt. */
  const pending = new Set<Promise<unknown>>();
  /** srt's write-monitor socket folder (Linux, monitor on), once initialized. */
  let monitorDir: string | undefined;
  const monitorDirs = (): string[] => {
    const root = tmpdir().replace(/\/+$/, "");
    return (fs.children(root) ?? [])
      .filter((name) => name.startsWith(SRT_MONITOR_DIR_PREFIX))
      .map((name) => `${root}/${name}`);
  };

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
    if (disposed) throw disposedError();
    manager ??= load().then(
      (srt) => (loaded = srt),
      (error: unknown) => {
        manager = undefined;
        throw new PiSandboxError(
          `pi-host: sandbox provider "srt" needs the package ${SRT_PACKAGE}, which could not be loaded: ${String(error)}`,
          { cause: error },
        );
      },
    );
    const srt = await manager;
    if (disposed) throw disposedError();
    // The log monitor: srt then observes refused writes (Linux seccomp,
    // macOS Seatbelt) besides the refused hosts its proxy always records.
    initialized ??= withoutSignalCleanup(async () => {
      const watchDir = monitor && platform === "linux";
      const before = new Set(watchDir ? monitorDirs() : []);
      await srt.initialize(global, undefined, monitor);
      if (!watchDir) return;
      // The monitor's folder is the one srt-obs- folder this initialize made
      // (srt keeps the monitor private). Not exactly one: fail closed rather
      // than run with the monitor asked for and silent under a private /tmp.
      const made = monitorDirs().filter((dir) => !before.has(dir));
      monitorDir = made.length === 1 ? made[0] : undefined;
      if (!monitorDir) {
        const why = `pi-host: sandbox: srt's write monitor folder not found (${made.length} new ${SRT_MONITOR_DIR_PREFIX}* folders, another srt initializing at the same time?); refused writes in sessions with a private /tmp would not be reported, so the monitor (AGENT_DECK_SANDBOX_MONITOR=1) cannot start`;
        console.warn(why);
        await srt.reset().catch(() => {});
        throw new PiSandboxError(why);
      }
    }).catch((error: unknown) => {
      initialized = undefined;
      throw wrapError(`could not start ${SRT_PACKAGE}`, error);
    });
    await initialized;
    if (disposed) {
      // Finished after dispose(): never hand out argv. dispose() resets it
      // unless it already did so before this initialize created its proxies.
      if (resetIssued) {
        lateReset ??= srt.reset();
        await lateReset.catch(() => {});
      }
      throw disposedError();
    }
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
      // Let an initialize and the wraps in flight finish before srt resets,
      // within one deadline; past it, reset whatever has loaded anyway (an
      // initialize that finishes later cleans up after itself, see ready()).
      let timer: NodeJS.Timeout | undefined;
      const deadline = new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), disposeWaitMs);
      });
      const settled = <T>(work: Promise<T>): Promise<T | undefined> =>
        Promise.race([work, deadline]);
      try {
        await settled(Promise.allSettled([...pending]));
        const started = initialized;
        if (started) await settled(started.catch(() => {}));
        initialized = undefined;
        unsubscribeStore?.();
        unsubscribeStore = undefined;
        active.clear();
        global = baseConfig();
        monitorDir = undefined;
        const srt = loaded;
        if (srt && started) {
          resetIssued = true;
          await settled(srt.reset().catch(() => {}));
        }
      } finally {
        clearTimeout(timer);
      }
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
        srtSettings(policy, denyWrite, fs, platform, [
          ...new Set(
            [srt.getLinuxHttpSocketPath(), srt.getLinuxSocksSocketPath(), monitorDir].filter(
              (entry): entry is string => !!entry,
            ),
          ),
        ]),
        undefined,
        cmd.cwd,
        { commandId },
      );
      // Disposed meanwhile: srt is (being) reset, the argv would run unfenced.
      if (disposed) throw disposedError();
      if (argv.length === 0) throw new Error("srt returned an empty argv");
      // Linux: the sandboxed tree is the OOM killer's first choice (its /tmp
      // is memory the container shares with the server).
      const [shell = "", ...args] =
        platform === "linux" ? ["/bin/sh", "-c", OOM_FIRST_SCRIPT, "sh", ...argv] : argv;
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
