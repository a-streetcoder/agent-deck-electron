import { EventEmitter } from "node:events";
import { spawn as nodeSpawn, type ChildProcess } from "node:child_process";
import spawn from "cross-spawn";
import { createJsonlReader, type JsonlReader } from "./jsonl.ts";
import { resolvePiSpawnPlan, type PiSpawnPlan } from "./resolve.ts";
import type { PiSandbox } from "./sandbox.ts";

const STDERR_CAP_BYTES = 64 * 1024;
const KILL_GRACE_MS = 3_000;
/** Absolute stop() deadline: SIGTERM grace + SIGKILL, then give up waiting. */
const STOP_DEADLINE_MS = 10_000;
/**
 * After the OS-level exit is observed, how long to wait for stdout to drain
 * before force-closing it. Normally 'close' follows 'exit' near-instantly (the
 * pipe's writers are dead); this backstop only fires when a leaked descendant
 * still holds the write end open, so exit publication can never stall forever.
 */
const STDOUT_DRAIN_GRACE_MS = 1_500;

export interface PiProcessOptions {
  binPath: string;
  args: string[];
  cwd: string;
  env?: Record<string, string | undefined>;
  /** ADR 0007: the provider and policy to wrap the spawn in. Absent: the
   * `none` provider (the plan is spawned unchanged). */
  sandbox?: PiSandbox;
}

export interface PiProcessExit {
  code: number | null;
  signal: NodeJS.Signals | null;
}

export interface PiProcessEvents {
  line: [string];
  exit: [PiProcessExit];
}

/**
 * A single `pi --mode rpc` subprocess: spawn, LF-only line events from stdout,
 * capped stderr capture, graceful stop (SIGTERM, then SIGKILL after a grace period).
 *
 * ## Exit is drain-gated
 *
 * `exit` is emitted only once BOTH the OS-level exit has been observed AND
 * stdout has closed (all buffered pipe data delivered). Node's child 'exit'
 * event does not guarantee stdio is drained — a crashing pi's final writes
 * (agent_end, error events explaining the death) can arrive after 'exit'.
 * Gating on stdout 'close' guarantees every 'line' event fires before 'exit',
 * so consumers that treat 'exit' as terminal (the server's Effect stream ends
 * on its ProcessExit item) never lose the tail of the final turn. A leaked
 * pipe holder cannot stall this forever: see STDOUT_DRAIN_GRACE_MS.
 *
 * ## stop() kills the process TREE
 *
 * pi spawns children of its own (stdio MCP servers, subagents). `child.kill`
 * signals only the direct child, orphaning those. On POSIX the child is
 * spawned detached (its own process group) and stop() signals the whole group
 * via `process.kill(-pid)`; on Windows stop() uses `taskkill /T /F`, which
 * walks and kills the tree (including the cmd shim cross-spawn may introduce
 * for .cmd entry points). Windows has no graceful path regardless — libuv maps
 * SIGTERM to an unconditional TerminateProcess.
 *
 * ## Sandboxed start
 *
 * With a sandbox provider other than `none` (see sandbox.ts) the plan is
 * wrapped before the spawn, which is asynchronous: start() returns at once,
 * the process counts as running, lines written meanwhile are queued and sent
 * after the spawn, and a wrap failure (the provider's PiSandboxError) surfaces
 * like a spawn failure: an exit with the message in stderr. With `none` (the
 * default) start() spawns synchronously, exactly as without a sandbox. A
 * sandboxed stop() ends stdin instead of signalling (a signal kills the
 * sandbox and Pi with SIGKILL), and kills the tree only after the grace.
 */
export class PiProcess extends EventEmitter<PiProcessEvents> {
  private child: ChildProcess | null = null;
  private reader: JsonlReader | null = null;
  private stderrBuf = "";
  /** OS-level exit, as observed from the child 'exit'/'error' event. */
  private exitRecord: PiProcessExit | null = null;
  /** True once stdout has closed (all buffered lines delivered). */
  private stdoutDone = false;
  private drainTimer: NodeJS.Timeout | null = null;
  /** The PUBLISHED exit — set (and 'exit' emitted) only after stdout drained. */
  private exited: PiProcessExit | null = null;
  /** Sandboxed start: the wrap is in flight; lines written meanwhile. */
  private wrapping: string[] | null = null;
  private releaseSandbox: (() => void) | undefined;

  constructor(private readonly options: PiProcessOptions) {
    super();
  }

  private get sandboxed(): boolean {
    const name = this.options.sandbox?.provider.name;
    return name !== undefined && name !== "none";
  }

  start(): void {
    if (this.child || this.wrapping || this.exitRecord)
      throw new Error("PiProcess already started");
    const env = { ...process.env, ...this.options.env };
    const plan = resolvePiSpawnPlan(this.options.binPath, this.options.args, env);
    const sandbox = this.options.sandbox;
    if (!sandbox || !this.sandboxed) {
      this.spawnPlan(plan, this.options.cwd);
      return;
    }
    const queued: string[] = [];
    this.wrapping = queued;
    const fail = (error: unknown): void => {
      if (this.exitRecord) return;
      this.appendStderr(error instanceof Error ? error.message : String(error));
      this.stdoutDone = true;
      this.recordExit({ code: null, signal: null }); // publishes and releases
    };
    sandbox.provider.wrap({ ...plan, cwd: this.options.cwd }, sandbox.policy).then(
      (wrapped) => {
        this.wrapping = null;
        if (this.exitRecord) {
          wrapped.release?.(); // stopped while wrapping
          return;
        }
        this.releaseSandbox = wrapped.release;
        try {
          // spawn can throw synchronously (a NUL byte in an argument).
          this.spawnPlan(wrapped, wrapped.cwd);
          for (const line of queued) this.child?.stdin?.write(line);
        } catch (error) {
          fail(error);
        }
      },
      (error: unknown) => {
        this.wrapping = null;
        fail(error);
      },
    );
  }

  private spawnPlan(plan: PiSpawnPlan, cwd: string): void {
    const child = spawn(plan.command, plan.args, {
      cwd,
      env: plan.env,
      stdio: ["pipe", "pipe", "pipe"],
      // POSIX: lead a fresh process group so stop() can signal pi AND its
      // children via the negative pid (Windows tree-kill goes through
      // taskkill /T instead — see killTree).
      detached: process.platform !== "win32",
    });
    this.child = child;

    // A write racing process death surfaces asynchronously as an 'error' on
    // the stdin socket (EPIPE et al.). Without a listener that is an uncaught
    // exception that takes down the host process; with one it is just a
    // diagnostic — pending work is settled by the exit path.
    child.stdin?.on("error", (error) => {
      this.appendStderr(`[stdin] ${String(error)}`);
    });

    this.reader = createJsonlReader((line) => this.emit("line", line));
    const stdout = child.stdout;
    if (stdout) {
      stdout.on("data", (chunk: Buffer) => this.reader?.push(chunk));
      stdout.on("end", () => this.reader?.end());
      // 'close' is the drained signal: it fires after 'end' (all buffered
      // data delivered, trailing partial line flushed above) or after a
      // destroy. It gates exit publication — see the module doc.
      stdout.on("close", () => {
        // Node can queue the final `data` callback and stream `close` in the
        // same libuv turn. Cross one check-phase barrier before publishing the
        // process exit so every already-produced stdout chunk has reached the
        // JSONL reader and, in turn, PiHost's ordered event queue. Without this
        // barrier a loaded process can expose ProcessExit before its final
        // provider message, losing the specific failure to a generic exit.
        setImmediate(() => {
          this.stdoutDone = true;
          this.maybePublishExit();
        });
      });
    } else {
      this.stdoutDone = true;
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      this.appendStderr(chunk.toString("utf8"));
    });

    child.on("error", (error) => {
      // Spawn failures (ENOENT etc.) surface as an exit with the message in stderr.
      this.appendStderr(String(error));
      this.recordExit({ code: null, signal: null });
    });

    child.on("exit", (code, signal) => {
      this.recordExit({ code, signal });
    });
  }

  private appendStderr(text: string): void {
    this.stderrBuf = (this.stderrBuf + text).slice(-STDERR_CAP_BYTES);
  }

  private recordExit(exit: PiProcessExit): void {
    if (this.exitRecord) return;
    this.exitRecord = exit;
    if (!this.stdoutDone && this.drainTimer === null) {
      // Backstop: force-close stdout if it has not drained shortly after the
      // OS exit (a leaked descendant holding the pipe's write end open).
      this.drainTimer = setTimeout(() => {
        this.child?.stdout?.destroy();
      }, STDOUT_DRAIN_GRACE_MS);
      this.drainTimer.unref();
    }
    this.maybePublishExit();
  }

  private maybePublishExit(): void {
    if (this.exited || !this.exitRecord || !this.stdoutDone) return;
    if (this.drainTimer) {
      clearTimeout(this.drainTimer);
      this.drainTimer = null;
    }
    this.exited = this.exitRecord;
    this.releaseSandbox?.();
    this.releaseSandbox = undefined;
    this.emit("exit", this.exited);
  }

  get isRunning(): boolean {
    return (this.child !== null || this.wrapping !== null) && this.exited === null;
  }

  /** OS process id of the spawned child, once started (undefined if spawn failed). */
  get pid(): number | undefined {
    return this.child?.pid;
  }

  get stderr(): string {
    return this.stderrBuf;
  }

  writeLine(line: string): void {
    if (this.wrapping && !this.exited) {
      this.wrapping.push(line);
      return;
    }
    if (!this.child || this.exited) {
      throw new Error("PiProcess is not running");
    }
    this.child.stdin?.write(line);
  }

  /**
   * Signal the whole process tree (pi plus any MCP servers / subagents it
   * spawned). Direct-child kill is kept as the fallback for every path.
   */
  private killTree(signal: "SIGTERM" | "SIGKILL"): void {
    const child = this.child;
    if (!child || child.pid === undefined) return;
    if (this.exitRecord) return; // already dead at the OS level
    if (process.platform === "win32") {
      // taskkill /T walks the tree; /F because a "graceful" Windows SIGTERM
      // is an unconditional TerminateProcess anyway (no cleanup either way).
      try {
        nodeSpawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" }).on(
          "error",
          () => child.kill("SIGKILL"),
        );
      } catch {
        child.kill("SIGKILL");
      }
      return;
    }
    try {
      // Negative pid → the detached process group (see start()).
      process.kill(-child.pid, signal);
    } catch {
      child.kill(signal);
    }
  }

  async stop(): Promise<PiProcessExit> {
    if (this.wrapping && !this.exited) {
      // Stopped before the sandboxed spawn: nothing runs yet; the wrap's
      // result is released when it arrives (see start()).
      this.stdoutDone = true;
      this.recordExit({ code: null, signal: null });
      return this.exited ?? { code: null, signal: null };
    }
    const child = this.child;
    if (!child || this.exited) {
      return this.exited ?? { code: null, signal: null };
    }
    return await new Promise<PiProcessExit>((resolve) => {
      const killTimer = setTimeout(() => this.killTree("SIGKILL"), KILL_GRACE_MS);
      killTimer.unref();
      // Last-resort deadline: kill() can fail (EPERM, a child wedged in
      // uninterruptible I/O) and then 'exit' never fires. Effect release
      // finalizers await this promise UNINTERRUPTIBLY, so an unbounded wait
      // would hang scope close — and server shutdown — forever. Resolve with
      // a synthetic exit and log the leaked pid instead.
      const deadline = setTimeout(() => {
        console.error(
          `pi-host: pid ${child.pid} survived SIGKILL after ${STOP_DEADLINE_MS}ms — ` +
            "abandoning the wait to keep shutdown live (process may be leaked)",
        );
        resolve({ code: null, signal: "SIGKILL" });
      }, STOP_DEADLINE_MS);
      deadline.unref();
      this.once("exit", (exit) => {
        clearTimeout(killTimer);
        clearTimeout(deadline);
        resolve(exit);
      });
      if (this.sandboxed) {
        // A signal to the group kills bubblewrap, which SIGKILLs Pi (see
        // sandbox.ts): end stdin instead, Pi disposes and exits on it, and
        // the tree is killed only after the grace period.
        child.stdin?.end();
      } else {
        this.killTree("SIGTERM");
      }
    });
  }
}
