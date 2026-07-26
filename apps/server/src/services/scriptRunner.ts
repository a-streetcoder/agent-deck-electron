import { spawn as nodeSpawn } from "node:child_process";
import { lstatSync, readFileSync, statSync } from "node:fs";
import { connect as netConnect } from "node:net";
import nodePath from "node:path";
import {
  SCRIPT_COMMAND_MAX,
  SCRIPT_MAX_OUTPUT_CHUNK,
  SCRIPT_MAX_SCRIPTS,
  SCRIPT_NAME_MAX,
  SCRIPT_MAX_SCROLLBACK_CHARS,
  type DiscoveredServer,
  type ProjectServerCommand,
} from "@agent-deck/contracts";
import { Context, Data, Deferred, Duration, Effect, Layer, Option, type Scope } from "effect";
import { TERMINAL_ENV_BLOCKLIST } from "./terminal.ts";

/**
 * ScriptRunner as a scoped Effect service (Slice 15a): run a session project's
 * DECLARED scripts as managed child processes, stream their merged output, and
 * detect the loopback dev-server URL they start listening on. Ported from
 * t3code's `apps/server/src/{preview,project,environment}/` (MIT) — the donor's
 * PortScanner + ProjectSetupScriptRunner — and re-expressed in this repo's
 * service idioms. services/terminal.ts is the direct template: where TerminalHost
 * owns a shell PTY, ScriptRunner owns a plain child process; both are PiHost
 * siblings (a factory handing out Scope-owned process handles).
 *
 * File anatomy (the terminal.ts template):
 *   1. adapter seam + data types + handle interface
 *   2. `listProjectScripts` / `resolveScriptCommand` — the declared-script source
 *   3. port detection (loopback URL scan + loopback TCP probe)
 *   4. `spawnScript` — the scoped acquire/release implementation
 *   5. `Context.Tag` service class + `ScriptRunnerLive` Layer
 *
 * ## Script source + the security boundary (donor's allowed set)
 *
 * A run's command is NEVER supplied by the client — only an opaque command id.
 * The server re-detects that id from the authoritative session cwd immediately
 * before launch; an unknown or stale id fails typed. Package command text keeps
 * compatibility with existing shell syntax and gets the project-local bin path,
 * but this is not `npm run`: npm lifecycle hooks and npm-injected environment
 * variables are deliberately not synthesized. The Node spawn option remains
 * `shell:false`; package text is passed as argv to a server-selected platform
 * shell executable.
 *
 * ## Port detection + loopback validation (donor: PortScanner, re-attributed)
 *
 * The donor scans ALL listening sockets (`lsof` / `Get-NetTCPConnection`) and
 * maps them to a terminal's process TREE — a strong "this port belongs to this
 * run" guarantee. We use a lighter heuristic: detect the port from a loopback
 * URL the run prints on its OWN stdout ({@link extractLoopbackPorts}), then
 * CONFIRM something is listening with a TCP connect to `127.0.0.1:port`.
 *
 * What this DOES guarantee: the embedded origin is always loopback. A printed
 * non-loopback origin (a LAN IP, a domain) never matches, and the confirm probe
 * only connects to loopback — a script can never make the UI embed an arbitrary
 * external origin (the client also re-validates loopback at the iframe boundary).
 *
 * What it does NOT guarantee: that the confirmed listener is THIS run's own
 * process. If the script prints a loopback URL for a *different* already-running
 * service (a proxy target `→ http://localhost:8080`, a DB `localhost:5432`), the
 * blind connect confirms it and we'd report that unrelated loopback port. Bounded
 * to loopback and visible to the user, but a real limitation. TODO: adopt the
 * donor's socket→process-tree mapping (Get-NetTCPConnection OwningProcess on
 * win32) to bind the port to this run's own PID tree — deferred from Slice 15.
 *
 * ## Scope-owned child (acquireRelease), streaming, tree-kill
 *
 * `spawnScript` is a SCOPED resource, exactly like `spawnTerminal`: acquire spawns
 * through the adapter and wires onData/onExit before returning; release tree-kills
 * the child (SIGTERM → grace → SIGKILL, bounded so scope close never hangs). A
 * dev server forks children (esbuild, workers); the adapter kills the whole tree
 * (POSIX process group / Windows `taskkill /T`) so nothing is orphaned. Output is
 * accumulated into a bounded scrollback (capped by characters) replayed on
 * reattach, and oversized reads are split into wire-valid chunks before dispatch.
 */

// ---------------------------------------------------------------------------
// 1. Adapter seam + data types
// ---------------------------------------------------------------------------

/** Exit record delivered by the child process (`ChildProcess` 'exit' shape). */
export interface ScriptExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

/**
 * The process primitives the script runner needs, without binding to
 * `node:child_process` — the terminal.ts PtyAdapter seam, for a plain child.
 */
export interface ScriptProcessLike {
  readonly pid: number;
  /** Tree-kill the child (its whole process group). Safe to call repeatedly. */
  kill(signal: "SIGTERM" | "SIGKILL"): void;
  /** Register a merged-stdout+stderr data callback; returns the disposer. */
  onData(callback: (data: string) => void): () => void;
  /** Register an exit callback; returns the disposer. */
  onExit(callback: (event: ScriptExit) => void): () => void;
}

export interface ScriptSpawnInput {
  readonly executable: string;
  readonly argv: readonly string[];
  /** Informational command text used in diagnostics and shown by detection. */
  readonly command: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  /** Always false: launch structure is selected server-side, never parsed from the wire. */
  readonly shell: false;
}

/** The spawn seam: `spawn` may THROW (adapter contract); callers wrap it. */
export interface ScriptAdapter {
  spawn(input: ScriptSpawnInput): ScriptProcessLike;
}

/** kill → this grace → SIGKILL, and the release-wait bound (terminal parity). */
const KILL_GRACE_MS = 1_000;
/** How long a loopback confirm probe waits before giving up (per attempt). */
const PROBE_TIMEOUT_MS = 1_000;

/** The child spawn failed (bad shell / spawn throw). */
export class ScriptSpawnFailed extends Data.TaggedError("ScriptSpawnFailed")<{
  readonly command: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `failed to spawn script process (${this.command})`;
  }
}

/** The requested script name is not declared in the project's package.json. */
export class ScriptNotDeclared extends Data.TaggedError("ScriptNotDeclared")<{
  readonly commandId: string;
}> {
  override get message(): string {
    return "server command is no longer available; refresh the detected commands";
  }
}

export class ScriptExecutableMissing extends Data.TaggedError("ScriptExecutableMissing")<{
  readonly executable: string;
}> {
  override get message(): string {
    return `required executable '${this.executable}' was not found`;
  }
}

/** One event delivered to an attached listener. */
export type ScriptEvent =
  | { readonly _tag: "Output"; readonly data: string }
  | { readonly _tag: "Server"; readonly server: DiscoveredServer }
  | { readonly _tag: "Exit"; readonly exit: ScriptExit };

/** The atomic result of `attach`: buffer snapshot + current server + subscription. */
export interface ScriptAttachment {
  /** Merged output accumulated BEFORE this attach (capped — see module doc). */
  readonly scrollback: string;
  readonly running: boolean;
  /** The discovered dev server, if one has been detected+confirmed yet. */
  readonly server: DiscoveredServer | null;
  readonly unsubscribe: () => void;
}

/** One live script run as a scoped resource. */
export interface ScriptHandle {
  readonly pid: number;
  /** The detected command id that was started (diagnostics/labeling). */
  readonly commandId: string;
  /**
   * Snapshot scrollback + current server and subscribe to subsequent events,
   * atomically (single sync op — nothing can slip between snapshot and
   * subscription). Multiple listeners may attach; each gets every later event.
   */
  readonly attach: (listener: (event: ScriptEvent) => void) => Effect.Effect<ScriptAttachment>;
  readonly isRunning: Effect.Effect<boolean>;
  /** The exit record once the child has exited (None while running). */
  readonly exit: Effect.Effect<Option.Option<ScriptExit>>;
  /** Resolves when the child exits (immediately if it already has). */
  readonly awaitExit: Effect.Effect<ScriptExit>;
}

/** A loopback TCP confirm probe: does something accept a connection on `port`? */
export type PortProber = (port: number) => Promise<boolean>;

export interface ScriptSpawnOptions {
  readonly commandId: string;
  /** Working directory — the owning session's cwd (worktree-aware `meta.cwd`). */
  readonly cwd: string;
  readonly env?: Record<string, string | undefined>;
  /** Cross-platform PATH lookup seam. */
  readonly resolveExecutable?: ExecutableResolver;
  /** Full server-owned launch override for process-behavior tests. */
  readonly launch?: ScriptLaunch;
  readonly probePort?: PortProber;
  readonly maxScrollbackChars?: number;
}

export interface ScriptLaunch {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly command: string;
}

export type ExecutableResolver = (
  names: readonly string[],
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
) => string | null;

// ---------------------------------------------------------------------------
// 2. Declared-script source (donor: the project's allowed script set)
// ---------------------------------------------------------------------------

function regularFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function rootRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function packageCommandId(name: string): string {
  return `package:${Buffer.from(name, "utf8").toString("base64url")}`;
}

/** Detect runnable server commands from regular files in the project root. */
export function listProjectServerCommands(cwd: string): ProjectServerCommand[] {
  const packagePath = nodePath.join(cwd, "package.json");
  const cargoPath = nodePath.join(cwd, "Cargo.toml");
  const djangoPath = nodePath.join(cwd, "manage.py");
  const indexPath = nodePath.join(cwd, "index.html");
  const hasPackage = rootRegularFile(packagePath);
  const hasCargo = rootRegularFile(cargoPath);
  const hasDjango = rootRegularFile(djangoPath);
  const out: ProjectServerCommand[] = [];

  if (hasPackage) {
    try {
      const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as { scripts?: unknown };
      if (typeof parsed.scripts === "object" && parsed.scripts !== null) {
        for (const [name, command] of Object.entries(parsed.scripts as Record<string, unknown>)) {
          if (
            typeof command !== "string" ||
            name.length === 0 ||
            name.length > SCRIPT_NAME_MAX ||
            command.length === 0 ||
            command.length > SCRIPT_COMMAND_MAX
          )
            continue;
          out.push({
            id: packageCommandId(name),
            label: name,
            command,
            source: "package",
            defaultPort: null,
          });
          if (out.length >= SCRIPT_MAX_SCRIPTS) return out;
        }
      }
    } catch {
      // A malformed package file contributes no proposals, but remains a marker
      // and therefore does not silently turn the project into a static site.
    }
  }
  if (hasCargo && out.length < SCRIPT_MAX_SCRIPTS) {
    out.push({
      id: "cargo:run",
      label: "Cargo server",
      command: "cargo run",
      source: "cargo",
      defaultPort: null,
    });
  }
  if (hasDjango && out.length < SCRIPT_MAX_SCRIPTS) {
    out.push({
      id: "django:runserver",
      label: "Django server",
      command: "python manage.py runserver 127.0.0.1:8000",
      source: "django",
      defaultPort: 8000,
    });
  }
  if (!hasPackage && !hasCargo && !hasDjango && rootRegularFile(indexPath)) {
    out.push({
      id: "static:http-server",
      label: "Static site",
      command: "python -m http.server 8000 --bind 127.0.0.1",
      source: "static",
      defaultPort: 8000,
    });
  }
  return out;
}

/** Compatibility alias for callers that still use the Slice-15 naming. */
export const listProjectScripts = listProjectServerCommands;

function executableOnPath(
  name: string,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
): string | null {
  if (nodePath.isAbsolute(name)) return regularFile(name) ? name : null;
  const pathValue = env.PATH ?? env.Path ?? env.path ?? "";
  const extensions =
    platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
  const delimiter = platform === "win32" ? ";" : ":";
  const pathApi = platform === "win32" ? nodePath.win32 : nodePath.posix;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = pathApi.join(
        directory,
        platform === "win32" ? `${name}${extension.toLowerCase()}` : name,
      );
      if (regularFile(candidate)) return candidate;
      if (platform === "win32") {
        const upper = pathApi.join(directory, `${name}${extension.toUpperCase()}`);
        if (regularFile(upper)) return upper;
      }
    }
  }
  return null;
}

export const defaultExecutableResolver: ExecutableResolver = (names, env, platform) => {
  for (const name of names) {
    const resolved = executableOnPath(name, env, platform);
    if (resolved) return resolved;
  }
  return null;
};

export function resolveProjectServerLaunch(
  candidate: ProjectServerCommand,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform,
  resolveExecutable: ExecutableResolver = defaultExecutableResolver,
): ScriptLaunch | null {
  if (candidate.source === "package") {
    const executable =
      platform === "win32"
        ? (env.ComSpec ?? env.COMSPEC ?? "C:\\Windows\\System32\\cmd.exe")
        : "/bin/sh";
    const pathApi = platform === "win32" ? nodePath.win32 : nodePath.posix;
    if (
      !pathApi.isAbsolute(executable) ||
      (platform === process.platform && !regularFile(executable))
    )
      return null;
    return platform === "win32"
      ? { executable, argv: ["/d", "/s", "/c", candidate.command], command: candidate.command }
      : { executable, argv: ["-c", candidate.command], command: candidate.command };
  }
  if (candidate.source === "cargo") {
    const executable = resolveExecutable(["cargo"], env, platform);
    return executable ? { executable, argv: ["run"], command: candidate.command } : null;
  }
  const pythonNames = platform === "win32" ? ["python", "py"] : ["python3", "python"];
  const executable = resolveExecutable(pythonNames, env, platform);
  if (!executable) return null;
  const basename = (platform === "win32" ? nodePath.win32 : nodePath.posix)
    .basename(executable)
    .toLowerCase();
  const pyPrefix = platform === "win32" && /^py(?:\.exe)?$/.test(basename) ? ["-3"] : [];
  return candidate.source === "django"
    ? {
        executable,
        argv: [...pyPrefix, "manage.py", "runserver", "127.0.0.1:8000"],
        command: candidate.command,
      }
    : {
        executable,
        argv: [...pyPrefix, "-m", "http.server", "8000", "--bind", "127.0.0.1"],
        command: candidate.command,
      };
}

/** Inheritable spawn env: base minus blocklist minus undefined, with the
 * project-local executable directory prepended for package command compatibility. */
function buildScriptEnv(
  base: Record<string, string | undefined>,
  cwd: string,
): Record<string, string> {
  const env: Record<string, string> = {};
  let pathKey = "PATH";
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (TERMINAL_ENV_BLOCKLIST.has(key.toUpperCase())) continue;
    if (key.toUpperCase() === "PATH") pathKey = key; // preserve original casing (Windows: Path)
    env[key] = value;
  }
  const localBin = nodePath.join(cwd, "node_modules", ".bin");
  env[pathKey] = env[pathKey] ? `${localBin}${nodePath.delimiter}${env[pathKey]}` : localBin;
  return env;
}

// ---------------------------------------------------------------------------
// 3. Port detection: loopback URL scan + loopback TCP confirm probe
// ---------------------------------------------------------------------------

/** Host tokens that resolve to the local machine — reported uniformly as `localhost`. */
const LOOPBACK_HOST_TOKENS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "[::1]",
  "::",
  "[::]",
]);

/** `http(s)://HOST[:PORT]` — HOST is a bracketed IPv6 or a bare host/IPv4 label. */
const LOOPBACK_URL_RE = /\bhttps?:\/\/(\[[0-9a-fA-F:]+\]|[0-9a-zA-Z.-]+)(?::(\d{1,5}))?/g;

/**
 * Every DISTINCT loopback dev-server port printed in `text`, in first-seen
 * order. A non-loopback host (a LAN IP, a domain) is skipped; a URL with no
 * port is skipped (a dev server always advertises one). Exported for unit tests.
 */
export function extractLoopbackPorts(text: string): number[] {
  const ports: number[] = [];
  const seen = new Set<number>();
  LOOPBACK_URL_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = LOOPBACK_URL_RE.exec(text)) !== null) {
    const host = match[1]!.toLowerCase();
    const portStr = match[2];
    if (!LOOPBACK_HOST_TOKENS.has(host)) continue;
    if (portStr === undefined) continue;
    const port = Number.parseInt(portStr, 10);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) continue;
    if (seen.has(port)) continue;
    seen.add(port);
    ports.push(port);
  }
  return ports;
}

/** Build the normalized (loopback-only) server record for a confirmed port. */
function loopbackServer(port: number): DiscoveredServer {
  return { host: "localhost", port, url: `http://localhost:${port}` };
}

/** The default confirm prober: connect to `127.0.0.1:port`, bounded by a timeout. */
const defaultProbePort: PortProber = (port) =>
  new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    const socket = netConnect({ host: "127.0.0.1", port });
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

/**
 * Cap the scrollback buffer by characters, trimming the oldest output, rounded
 * to a code-point boundary (terminal.ts parity: a raw UTF-16 slice opening on a
 * low surrogate would render as U+FFFD in every future replay).
 */
function capScrollback(buffer: string, maxChars: number): string {
  if (buffer.length <= maxChars) return buffer;
  let start = buffer.length - maxChars;
  const first = buffer.charCodeAt(start);
  if (first >= 0xdc00 && first <= 0xdfff) start += 1; // lone low surrogate
  return buffer.slice(start);
}

// ---------------------------------------------------------------------------
// Default adapter: node:child_process, shell-run + cross-platform tree-kill
// ---------------------------------------------------------------------------

/** The production adapter: a shell child process with process-tree kill. */
export const nodeScriptAdapter: ScriptAdapter = {
  spawn(input) {
    const isWindows = process.platform === "win32";
    const child = nodeSpawn(input.executable, [...input.argv], {
      cwd: input.cwd,
      env: input.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      // POSIX: lead a fresh process group so kill can signal the whole tree via
      // the negative pid (Windows tree-kill goes through taskkill /T instead).
      detached: !isWindows,
    });
    if (child.pid === undefined) {
      // Synchronous spawn failure surfaces as a thrown ENOENT via the 'error'
      // event; a missing pid means the process never started.
      throw new Error(`spawn produced no pid for command: ${input.command}`);
    }
    const pid = child.pid;
    return {
      pid,
      kill: (signal) => {
        if (isWindows) {
          try {
            nodeSpawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }).on(
              "error",
              () => child.kill("SIGKILL"),
            );
          } catch {
            child.kill("SIGKILL");
          }
          return;
        }
        try {
          // Negative pid → the detached process group (see detached above).
          process.kill(-pid, signal);
        } catch {
          child.kill(signal);
        }
      },
      onData: (callback) => {
        const onChunk = (chunk: Buffer): void => callback(chunk.toString("utf8"));
        child.stdout?.on("data", onChunk);
        child.stderr?.on("data", onChunk);
        return () => {
          child.stdout?.off("data", onChunk);
          child.stderr?.off("data", onChunk);
        };
      },
      onExit: (callback) => {
        const onExit = (code: number | null, signal: NodeJS.Signals | null): void =>
          callback({ exitCode: code, signal });
        const onError = (): void => callback({ exitCode: null, signal: null });
        child.once("exit", onExit);
        child.once("error", onError);
        return () => {
          child.off("exit", onExit);
          child.off("error", onError);
        };
      },
    };
  },
};

// ---------------------------------------------------------------------------
// 4. The scoped acquire/release implementation
// ---------------------------------------------------------------------------

/**
 * Spawn one script child tied to the caller's Scope: closing the scope tree-kills
 * the child (SIGTERM → grace → SIGKILL). Fails typed with `ScriptNotDeclared`
 * when the name is not a declared script, or `ScriptSpawnFailed` when the spawn
 * throws.
 */
export const spawnScript = (
  adapter: ScriptAdapter,
  options: ScriptSpawnOptions,
): Effect.Effect<
  ScriptHandle,
  ScriptSpawnFailed | ScriptNotDeclared | ScriptExecutableMissing,
  Scope.Scope
> =>
  Effect.map(
    Effect.acquireRelease(
      Effect.gen(function* () {
        const maxScrollbackChars = options.maxScrollbackChars ?? SCRIPT_MAX_SCROLLBACK_CHARS;
        const candidate = listProjectServerCommands(options.cwd).find(
          (item) => item.id === options.commandId,
        );
        if (!candidate && !options.launch) {
          return yield* Effect.fail(new ScriptNotDeclared({ commandId: options.commandId }));
        }
        const baseEnv = options.env ?? process.env;
        const launch =
          options.launch ??
          resolveProjectServerLaunch(
            candidate!,
            baseEnv,
            process.platform,
            options.resolveExecutable ?? defaultExecutableResolver,
          );
        if (launch === null) {
          const executable = candidate?.source === "cargo" ? "cargo" : "python";
          return yield* Effect.fail(new ScriptExecutableMissing({ executable }));
        }
        const env = buildScriptEnv(baseEnv, options.cwd);
        const probePort = options.probePort ?? defaultProbePort;

        const proc = yield* Effect.try({
          try: () =>
            adapter.spawn({
              executable: launch.executable,
              argv: launch.argv,
              command: launch.command,
              cwd: options.cwd,
              env,
              shell: false,
            }),
          catch: (cause) => new ScriptSpawnFailed({ command: launch.command, cause }),
        });

        const exitDeferred = yield* Deferred.make<ScriptExit>();

        // Closure-scoped mutable state — only touched inside single sync ops,
        // the synchronous child callbacks, or the (self-scheduled) probe
        // continuation (which re-checks these flags before dispatching).
        let scrollback = "";
        let exitState: Option.Option<ScriptExit> = Option.none();
        let server: DiscoveredServer | null = null;
        let abandoned = false;
        let portScanTail = "";
        const seenPorts = new Set<number>();
        const listeners = new Set<(event: ScriptEvent) => void>();

        const dispatch = (event: ScriptEvent): void => {
          for (const listener of listeners) listener(event);
        };

        const considerPort = (port: number): void => {
          if (seenPorts.has(port)) return;
          seenPorts.add(port);
          void probePort(port).then((listening) => {
            // A port is eligible only because this child printed its loopback
            // URL. defaultPort metadata is advisory and never triggers a probe.
            if (!listening || abandoned || server !== null || Option.isSome(exitState)) return;
            server = loopbackServer(port);
            dispatch({ _tag: "Server", server });
          });
        };

        const onData = proc.onData((data) => {
          scrollback = capScrollback(scrollback + data, maxScrollbackChars);
          // Detect the dev server port from THIS run's output. Prepend a short
          // tail so a URL split across two reads is still matched.
          if (server === null) {
            const combined = portScanTail + data;
            for (const port of extractLoopbackPorts(combined)) considerPort(port);
            portScanTail = combined.slice(-256);
          }
          // Split oversized reads so every dispatched chunk is wire-valid, never
          // cutting inside a surrogate pair (terminal.ts parity).
          for (let i = 0; i < data.length; ) {
            let end = Math.min(i + SCRIPT_MAX_OUTPUT_CHUNK, data.length);
            const last = data.charCodeAt(end - 1);
            if (end < data.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
            dispatch({ _tag: "Output", data: data.slice(i, end) });
            i = end;
          }
        });
        const onExit = proc.onExit((exit) => {
          if (Option.isSome(exitState)) return;
          exitState = Option.some(exit);
          Deferred.unsafeDone(exitDeferred, Effect.succeed(exit));
          dispatch({ _tag: "Exit", exit });
        });

        const handle: ScriptHandle = {
          pid: proc.pid,
          commandId: options.commandId,
          attach: (listener) =>
            Effect.sync(() => {
              listeners.add(listener);
              return {
                scrollback,
                running: Option.isNone(exitState),
                server,
                unsubscribe: () => {
                  listeners.delete(listener);
                },
              };
            }),
          isRunning: Effect.sync(() => Option.isNone(exitState)),
          exit: Effect.sync(() => exitState),
          awaitExit: Deferred.await(exitDeferred),
        };

        return {
          handle,
          proc,
          isExited: () => Option.isSome(exitState),
          cleanup: () => {
            abandoned = true;
            onData();
            onExit();
          },
        };
      }),
      // Release: tree-kill escalation, bounded so scope close can never hang
      // (terminal.ts parity). A ScriptNotDeclared acquire produces no handle, so
      // release only runs for a live child.
      (acquired) =>
        Effect.gen(function* () {
          const { handle, proc, isExited, cleanup } = acquired;
          const killed = (signal: "SIGTERM" | "SIGKILL"): boolean => {
            try {
              proc.kill(signal);
              return true;
            } catch {
              return false;
            }
          };
          const awaitExitBounded = Effect.interruptible(handle.awaitExit).pipe(
            Effect.timeout(Duration.millis(KILL_GRACE_MS)),
          );
          if (!isExited() && killed("SIGTERM")) {
            yield* awaitExitBounded.pipe(
              Effect.catchAll(() =>
                Effect.suspend(() => {
                  if (!isExited()) killed("SIGKILL");
                  return Effect.ignore(awaitExitBounded);
                }),
              ),
            );
          }
          if (!isExited()) {
            console.error(
              `scriptRunner: pid ${proc.pid} survived SIGTERM+SIGKILL escalation — ` +
                "abandoning to keep scope close bounded (process may be leaked)",
            );
          }
          cleanup();
        }),
    ),
    (acquired) => acquired.handle,
  );

// ---------------------------------------------------------------------------
// 5. Service tag + Live layer
// ---------------------------------------------------------------------------

export interface ScriptRunnerShape {
  /** List a project's declared runnable scripts (from `package.json`). */
  readonly listScripts: (cwd: string) => Effect.Effect<ProjectServerCommand[]>;
  /** Spawn a declared script as a resource of the caller's Scope. */
  readonly spawn: (
    options: ScriptSpawnOptions,
  ) => Effect.Effect<
    ScriptHandle,
    ScriptSpawnFailed | ScriptNotDeclared | ScriptExecutableMissing,
    Scope.Scope
  >;
}

/**
 * Factory service: runs are per-session, so the runtime-scoped service hands out
 * scoped handles rather than owning children itself (the TerminalHost/PiHost
 * pattern).
 */
export class ScriptRunner extends Context.Tag("agent-deck/server/services/ScriptRunner")<
  ScriptRunner,
  ScriptRunnerShape
>() {}

export const makeScriptRunner = (adapter: ScriptAdapter): ScriptRunnerShape => ({
  listScripts: (cwd) => Effect.sync(() => listProjectServerCommands(cwd)),
  spawn: (options) => spawnScript(adapter, options),
});

export const ScriptRunnerLive = Layer.succeed(ScriptRunner, makeScriptRunner(nodeScriptAdapter));
