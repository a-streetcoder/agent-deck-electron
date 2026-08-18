import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import { Effect, Either, Exit, Scope } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeServerRuntime } from "../src/runtime.ts";
import {
  defaultReadProcessTable,
  defaultResolvePortOwners,
  retryUndeterminable,
  extractLoopbackPorts,
  listProjectScripts,
  pidWithinTree,
  resolveProjectServerLaunch,
  ScriptRunner,
  spawnScript,
  type PortProber,
  type ScriptAdapter,
  type ScriptEvent,
  type ScriptExit,
  type ScriptProcessLike,
  type ScriptSpawnInput,
} from "../src/services/scriptRunner.ts";

/**
 * ScriptRunner service unit tests against a scripted fake child-process adapter
 * (the terminal.ts PtyAdapter seam, for a plain child), following the
 * terminal.test.ts conventions — declared-script listing/resolution, loopback
 * port extraction, output streaming + port detection + confirm probe, scope-close
 * tree-kill — plus one real child-process smoke test against a scratch project
 * (a node one-liner that prints a listening URL then serves; stop kills it,
 * verified by kill(pid,0) polling).
 */

// --- Scripted fake adapter -------------------------------------------------

class FakeScript implements ScriptProcessLike {
  readonly pid = 4321;
  readonly kills: Array<"SIGTERM" | "SIGKILL"> = [];
  /** When set, kill() immediately emits this exit (a well-behaved child). */
  exitOnKill: ScriptExit | null = { exitCode: 0, signal: "SIGTERM" };
  private dataCallback: ((data: string) => void) | null = null;
  private exitCallback: ((event: ScriptExit) => void) | null = null;

  kill(signal: "SIGTERM" | "SIGKILL"): void {
    this.kills.push(signal);
    if (this.exitOnKill) this.emitExit(this.exitOnKill);
  }
  onData(callback: (data: string) => void): () => void {
    this.dataCallback = callback;
    return () => {
      this.dataCallback = null;
    };
  }
  onExit(callback: (event: ScriptExit) => void): () => void {
    this.exitCallback = callback;
    return () => {
      this.exitCallback = null;
    };
  }
  emitData(data: string): void {
    this.dataCallback?.(data);
  }
  emitExit(event: ScriptExit): void {
    this.exitCallback?.(event);
  }
}

function fakeAdapter(): {
  adapter: ScriptAdapter;
  spawns: ScriptSpawnInput[];
  procs: FakeScript[];
} {
  const spawns: ScriptSpawnInput[] = [];
  const procs: FakeScript[] = [];
  return {
    adapter: {
      spawn: (input) => {
        spawns.push(input);
        const proc = new FakeScript();
        procs.push(proc);
        return proc;
      },
    },
    spawns,
    procs,
  };
}

/** Base spawn options: a command override (bypasses package.json) + always-true probe.
 * Ownership is pinned "unknown" so choreographed tests never shell out to
 * netstat/ps — and never flake on whatever really listens on the fake port. */
const okProbe: PortProber = async () => true;
const baseOpts = {
  commandId: "test",
  cwd: process.cwd(),
  launch: { executable: "noop", argv: [], command: "noop" },
  probePort: okProbe,
  resolvePortOwners: async () => null,
};

// Let the microtask that the confirm probe schedules run.
const flush = async (): Promise<void> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
};

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 8_000;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(processAlive(pid)).toBe(false);
}

// --- Pure helpers ----------------------------------------------------------

describe("extractLoopbackPorts", () => {
  it("extracts loopback dev-server ports, ignoring non-loopback hosts", () => {
    expect(extractLoopbackPorts("Local: http://localhost:5173/")).toEqual([5173]);
    expect(extractLoopbackPorts("http://127.0.0.1:3000")).toEqual([3000]);
    expect(extractLoopbackPorts("bound http://0.0.0.0:8080 all ifaces")).toEqual([8080]);
    expect(extractLoopbackPorts("ipv6 http://[::1]:4321/")).toEqual([4321]);
    // A LAN IP / a domain is never a candidate.
    expect(extractLoopbackPorts("Network: http://192.168.1.5:3000/")).toEqual([]);
    expect(extractLoopbackPorts("prod https://example.com:443/")).toEqual([]);
    // A URL with no port is skipped (a dev server always advertises one).
    expect(extractLoopbackPorts("http://localhost/")).toEqual([]);
  });

  it("reports the Local URL from a mixed Vite-style banner, distinct ports in order", () => {
    const banner = [
      "  ➜  Local:   http://localhost:5173/",
      "  ➜  Network: http://192.168.1.5:5173/",
      "  ➜  Alt:     http://127.0.0.1:5174/",
    ].join("\n");
    expect(extractLoopbackPorts(banner)).toEqual([5173, 5174]);
  });
});

describe("project server command detection", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-deck-scripts-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("lists package scripts first, then Cargo and Django in stable order", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite", build: "vite build", bad: 42 } }),
    );
    writeFileSync(join(dir, "Cargo.toml"), "[package]\nname='x'\n");
    writeFileSync(join(dir, "manage.py"), "");
    writeFileSync(join(dir, "index.html"), "static must not be proposed");
    expect(listProjectScripts(dir)).toEqual([
      { id: "package:ZGV2", label: "dev", command: "vite", source: "package", defaultPort: null },
      {
        id: "package:YnVpbGQ",
        label: "build",
        command: "vite build",
        source: "package",
        defaultPort: null,
      },
      {
        id: "cargo:run",
        label: "Cargo server",
        command: "cargo run",
        source: "cargo",
        defaultPort: null,
      },
      {
        id: "django:runserver",
        label: "Django server",
        command: "python manage.py runserver 127.0.0.1:8000",
        source: "django",
        defaultPort: 8000,
      },
    ]);
  });

  it("uses static index.html only as a root regular-file fallback", () => {
    writeFileSync(join(dir, "index.html"), "ok");
    expect(listProjectScripts(dir)).toEqual([
      {
        id: "static:http-server",
        label: "Static site",
        command: "python -m http.server 8000 --bind 127.0.0.1",
        source: "static",
        defaultPort: 8000,
      },
    ]);
    rmSync(join(dir, "index.html"));
    mkdirSync(join(dir, "index.html"));
    expect(listProjectScripts(dir)).toEqual([]);
  });

  it("does not treat marker directories as files or static-fallback through a package marker", () => {
    mkdirSync(join(dir, "Cargo.toml"));
    mkdirSync(join(dir, "manage.py"));
    writeFileSync(join(dir, "index.html"), "ok");
    expect(listProjectScripts(dir).map((item) => item.source)).toEqual(["static"]);
    writeFileSync(join(dir, "package.json"), "{ invalid");
    expect(listProjectScripts(dir)).toEqual([]);
  });
});

// --- Scoped spawn (fake adapter) -------------------------------------------

describe("spawnScript scoped child service (fake adapter)", () => {
  it("streams output to attached listeners and buffers scrollback", async () => {
    const { adapter, procs, spawns } = fakeAdapter();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnScript(adapter, baseOpts);
          expect(handle.pid).toBe(4321);
          expect(handle.commandId).toBe("test");
          expect(spawns[0]).toMatchObject({ command: "noop", cwd: process.cwd() });

          const events: ScriptEvent[] = [];
          yield* handle.attach((event) => events.push(event));
          procs[0]!.emitData("hello\n");
          expect(events).toEqual([{ _tag: "Output", data: "hello\n" }]);

          // Late attach replays the scrollback, not as events.
          const attachment = yield* handle.attach(() => {});
          expect(attachment.scrollback).toBe("hello\n");
          expect(attachment.running).toBe(true);
          expect(attachment.server).toBeNull();
        }),
      ),
    );
  });

  it("detects the dev-server port from stdout and confirms it via the probe", async () => {
    const probed: number[] = [];
    const probePort: PortProber = async (port) => {
      probed.push(port);
      return port === 5173;
    };
    const { adapter, procs } = fakeAdapter();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnScript(adapter, { ...baseOpts, probePort });
          const events: ScriptEvent[] = [];
          yield* handle.attach((event) => events.push(event));
          procs[0]!.emitData("  ➜  Local: http://localhost:5173/\n");
          yield* Effect.promise(flush);

          const serverEvents = events.filter((e) => e._tag === "Server");
          expect(serverEvents).toEqual([
            {
              _tag: "Server",
              server: { host: "localhost", port: 5173, url: "http://localhost:5173" },
            },
          ]);
          expect(probed).toEqual([5173]);
          // The current server rides a later attach so a reconnect can re-embed.
          const attachment = yield* handle.attach(() => {});
          expect(attachment.server).toEqual({
            host: "localhost",
            port: 5173,
            url: "http://localhost:5173",
          });
        }),
      ),
    );
  });

  it("never probes advisory defaultPort without matching child URL output", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-deck-default-port-"));
    const unrelated = createServer();
    try {
      writeFileSync(join(dir, "index.html"), "");
      await new Promise<void>((resolve, reject) => {
        unrelated.once("error", reject);
        unrelated.listen(8000, "127.0.0.1", resolve);
      });
      const { adapter, procs } = fakeAdapter();
      const probed: number[] = [];
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawnScript(adapter, {
              commandId: "static:http-server",
              cwd: dir,
              resolveExecutable: () => "/tools/python3",
              probePort: async (port) => {
                probed.push(port);
                return true;
              },
            });
            const events: ScriptEvent[] = [];
            yield* handle.attach((event) => events.push(event));
            procs[0]!.emitData("Serving HTTP on 127.0.0.1 port 8000\n");
            yield* Effect.promise(flush);
            expect(probed).toEqual([]);
            expect(events.filter((event) => event._tag === "Server")).toEqual([]);
          }),
        ),
      );
    } finally {
      await new Promise<void>((resolve) => unrelated.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("detects a URL split across two reads (carryover tail)", async () => {
    const { adapter, procs } = fakeAdapter();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnScript(adapter, baseOpts);
          const events: ScriptEvent[] = [];
          yield* handle.attach((event) => events.push(event));
          procs[0]!.emitData("serving on http://localh");
          procs[0]!.emitData("ost:4173/ now");
          yield* Effect.promise(flush);
          expect(events.filter((e) => e._tag === "Server")).toEqual([
            {
              _tag: "Server",
              server: { host: "localhost", port: 4173, url: "http://localhost:4173" },
            },
          ]);
        }),
      ),
    );
  });

  it("does not report a server when the confirm probe fails", async () => {
    const probePort: PortProber = async () => false;
    const { adapter, procs } = fakeAdapter();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnScript(adapter, { ...baseOpts, probePort });
          const events: ScriptEvent[] = [];
          yield* handle.attach((event) => events.push(event));
          procs[0]!.emitData("http://localhost:9999/\n");
          yield* Effect.promise(flush);
          expect(events.filter((e) => e._tag === "Server")).toEqual([]);
        }),
      ),
    );
  });

  it("never reports a non-loopback origin printed by the script", async () => {
    let probes = 0;
    const probePort: PortProber = async () => {
      probes += 1;
      return true;
    };
    const { adapter, procs } = fakeAdapter();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnScript(adapter, { ...baseOpts, probePort });
          const events: ScriptEvent[] = [];
          yield* handle.attach((event) => events.push(event));
          procs[0]!.emitData("open http://evil.example.com:3000/ and http://10.0.0.9:3000/\n");
          yield* Effect.promise(flush);
          expect(events.filter((e) => e._tag === "Server")).toEqual([]);
          expect(probes).toBe(0); // a non-loopback host is never even probed
        }),
      ),
    );
  });

  it("exit dispatches an Exit event, settles awaitExit, and marks not running", async () => {
    const { adapter, procs } = fakeAdapter();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnScript(adapter, baseOpts);
          const events: ScriptEvent[] = [];
          yield* handle.attach((event) => events.push(event));
          procs[0]!.emitExit({ exitCode: 1, signal: null });
          expect(events).toEqual([{ _tag: "Exit", exit: { exitCode: 1, signal: null } }]);
          expect(yield* handle.isRunning).toBe(false);
          expect(yield* handle.awaitExit).toEqual({ exitCode: 1, signal: null });

          const attachment = yield* handle.attach(() => {});
          expect(attachment.running).toBe(false);
        }),
      ),
    );
  });

  it("spawns detected Cargo and Python commands with exact argv and shell:false", async () => {
    const cases = [
      { marker: "Cargo.toml", commandId: "cargo:run", executable: "/tools/cargo", argv: ["run"] },
      {
        marker: "manage.py",
        commandId: "django:runserver",
        executable: "/tools/python3",
        argv: ["manage.py", "runserver", "127.0.0.1:8000"],
      },
      {
        marker: "index.html",
        commandId: "static:http-server",
        executable: "/tools/python3",
        argv: ["-m", "http.server", "8000", "--bind", "127.0.0.1"],
      },
    ] as const;
    for (const item of cases) {
      const dir = mkdtempSync(join(tmpdir(), "agent-deck-launch-"));
      try {
        writeFileSync(join(dir, item.marker), "");
        const { adapter, spawns } = fakeAdapter();
        await Effect.runPromise(
          Effect.scoped(
            spawnScript(adapter, {
              commandId: item.commandId,
              cwd: dir,
              resolveExecutable: (names) =>
                names[0] === "cargo" ? "/tools/cargo" : "/tools/python3",
            }),
          ),
        );
        expect(spawns[0]).toMatchObject({
          executable: item.executable,
          argv: item.argv,
          cwd: dir,
          shell: false,
        });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("keeps Python resolution order and py -3 behavior behind a cross-platform seam", () => {
    const django = {
      id: "django:runserver",
      label: "Django server",
      command: "python manage.py runserver 127.0.0.1:8000",
      source: "django" as const,
      defaultPort: 8000,
    };
    const calls: Array<{ names: readonly string[]; platform: NodeJS.Platform }> = [];
    const windows = resolveProjectServerLaunch(
      django,
      { ComSpec: "C:\\Windows\\cmd.exe" },
      "win32",
      (names, _env, platform) => {
        calls.push({ names, platform });
        return "C:\\Windows\\py.exe";
      },
    );
    expect(calls).toEqual([{ names: ["python", "py"], platform: "win32" }]);
    expect(windows?.argv).toEqual(["-3", "manage.py", "runserver", "127.0.0.1:8000"]);

    calls.length = 0;
    resolveProjectServerLaunch(django, {}, "darwin", (names, _env, platform) => {
      calls.push({ names, platform });
      return "/usr/bin/python3";
    });
    expect(calls).toEqual([{ names: ["python3", "python"], platform: "darwin" }]);
  });

  it("fails clearly before spawn when a detected runtime executable is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-deck-missing-exe-"));
    try {
      writeFileSync(join(dir, "manage.py"), "");
      const { adapter, spawns } = fakeAdapter();
      const result = await Effect.runPromise(
        Effect.scoped(
          Effect.either(
            spawnScript(adapter, {
              commandId: "django:runserver",
              cwd: dir,
              resolveExecutable: () => null,
            }),
          ),
        ),
      );
      expect(Either.isLeft(result) && result.left.message).toContain("python");
      expect(spawns).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails typed with ScriptNotDeclared for forged or stale command ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-deck-scripts-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "vite" } }));
      const { adapter, spawns } = fakeAdapter();
      const forged = await Effect.runPromise(
        Effect.scoped(Effect.either(spawnScript(adapter, { commandId: "missing", cwd: dir }))),
      );
      expect(Either.isLeft(forged)).toBe(true);
      if (Either.isLeft(forged)) {
        expect(forged.left._tag).toBe("ScriptNotDeclared");
        expect(forged.left.message).toContain("refresh");
      }
      const detectedId = listProjectScripts(dir)[0]!.id;
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { start: "vite" } }));
      const stale = await Effect.runPromise(
        Effect.scoped(Effect.either(spawnScript(adapter, { commandId: detectedId, cwd: dir }))),
      );
      expect(Either.isLeft(stale) && stale.left._tag).toBe("ScriptNotDeclared");
      expect(spawns).toEqual([]); // never spawned a forged or stale command
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocklisted env keys never reach the spawn env; node_modules/.bin is on PATH", async () => {
    const { adapter, spawns } = fakeAdapter();
    await Effect.runPromise(
      Effect.scoped(
        spawnScript(adapter, {
          ...baseOpts,
          cwd: "/proj",
          env: {
            KEEP: "yes",
            PORT: "3000",
            ELECTRON_RUN_AS_NODE: "1",
            PATH: "/usr/bin",
            GONE: undefined,
          },
        }),
      ),
    );
    const env = spawns[0]!.env;
    expect(env.KEEP).toBe("yes");
    expect(env.PORT).toBeUndefined();
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.GONE).toBeUndefined();
    // node_modules/.bin of the cwd is prepended to PATH (npm-run parity).
    const localBin = join("/proj", "node_modules", ".bin");
    expect(env.PATH!.startsWith(localBin)).toBe(true);
    expect(env.PATH!.endsWith("/usr/bin")).toBe(true);
  });

  it("scope close tree-kills the child (SIGTERM escalation) exactly once", async () => {
    const { adapter, procs } = fakeAdapter();
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const handle = yield* Scope.extend(spawnScript(adapter, baseOpts), scope);
        expect(yield* handle.isRunning).toBe(true);
        yield* Scope.close(scope, Exit.void);
        expect(procs[0]!.kills).toEqual(["SIGTERM"]);
        expect(yield* handle.isRunning).toBe(false);
      }),
    );
  });

  it("release escalates to SIGKILL when the child ignores the first kill", async () => {
    const { adapter, procs } = fakeAdapter();
    await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        yield* Scope.extend(spawnScript(adapter, baseOpts), scope);
        const proc = procs[0]!;
        proc.exitOnKill = null; // ignore SIGTERM
        const closing = yield* Effect.fork(Scope.close(scope, Exit.void));
        yield* Effect.sleep("50 millis");
        expect(proc.kills).toEqual(["SIGTERM"]);
        yield* Effect.sleep("1100 millis");
        expect(proc.kills).toEqual(["SIGTERM", "SIGKILL"]);
        proc.emitExit({ exitCode: null, signal: "SIGKILL" });
        yield* Effect.fromFiber(closing);
      }),
    );
  }, 10_000);
});

// --- Port ownership (DEV-04, donor socket→process-tree mapping) -------------

describe("port ownership (DEV-04)", () => {
  it("pidWithinTree walks the ppid chain upward, bounded against cycles", () => {
    const table = new Map([
      [100, 1],
      [200, 100],
      [300, 200],
      [999, 999],
      [500, 501],
      [501, 500],
    ]);
    expect(pidWithinTree(100, 100, table)).toBe(true); // the root itself
    expect(pidWithinTree(300, 200, table)).toBe(true); // direct child
    expect(pidWithinTree(300, 100, table)).toBe(true); // grandchild chain
    expect(pidWithinTree(200, 300, table)).toBe(false); // wrong direction
    expect(pidWithinTree(999, 100, table)).toBe(false); // unrelated (self-parented)
    expect(pidWithinTree(500, 100, table)).toBe(false); // a ppid cycle terminates
    expect(pidWithinTree(42, 100, table)).toBe(false); // absent from the table
  });

  it("suppresses a confirmed port whose listener is provably outside this run's tree", async () => {
    const { adapter, procs } = fakeAdapter();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnScript(adapter, {
            ...baseOpts,
            // Something accepts on 5173, but it is pid 7777 under init — not
            // a descendant of the fake child (pid 4321).
            resolvePortOwners: async () => [7777],
            readProcessTable: async () => new Map([[7777, 1]]),
          });
          const events: ScriptEvent[] = [];
          yield* handle.attach((event) => events.push(event));
          procs[0]!.emitData("proxying to http://localhost:5173/\n");
          yield* Effect.promise(flush);
          expect(events.filter((e) => e._tag === "Server")).toEqual([]);
          const attachment = yield* handle.attach(() => {});
          expect(attachment.server).toBeNull();
        }),
      ),
    );
  });

  it("reports a confirmed port owned by a descendant of the spawned child", async () => {
    const { adapter, procs } = fakeAdapter();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnScript(adapter, {
            ...baseOpts,
            // The listener (300) is a grandchild of the fake child: 300 → 200 → 4321.
            resolvePortOwners: async () => [300],
            readProcessTable: async () =>
              new Map([
                [300, 200],
                [200, 4321],
                [4321, 1],
              ]),
          });
          const events: ScriptEvent[] = [];
          yield* handle.attach((event) => events.push(event));
          procs[0]!.emitData("ready at http://localhost:5173/\n");
          yield* Effect.promise(flush);
          expect(events.filter((e) => e._tag === "Server")).toEqual([
            {
              _tag: "Server",
              server: { host: "localhost", port: 5173, url: "http://localhost:5173" },
            },
          ]);
        }),
      ),
    );
  });

  it("treats an owner the process-table snapshot missed as unknown, not foreign", async () => {
    const { adapter, procs } = fakeAdapter();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* spawnScript(adapter, {
            ...baseOpts,
            // The listener pid is real, but the (racy/truncated) table snapshot
            // never captured it — that is NOT proof of a foreign owner.
            resolvePortOwners: async () => [300],
            readProcessTable: async () => new Map([[4321, 1]]),
          });
          const events: ScriptEvent[] = [];
          yield* handle.attach((event) => events.push(event));
          procs[0]!.emitData("ready at http://localhost:5173/\n");
          yield* Effect.promise(flush);
          expect(events.filter((e) => e._tag === "Server")).toHaveLength(1);
        }),
      ),
    );
  });

  it("falls back to confirmed-listening when ownership cannot be determined", async () => {
    const rejecting = async (): Promise<readonly number[] | null> => {
      throw new Error("no socket table on this platform");
    };
    for (const resolvePortOwners of [async () => null, async () => [], rejecting]) {
      const { adapter, procs } = fakeAdapter();
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawnScript(adapter, { ...baseOpts, resolvePortOwners });
            const events: ScriptEvent[] = [];
            yield* handle.attach((event) => events.push(event));
            procs[0]!.emitData("ready at http://localhost:5173/\n");
            yield* Effect.promise(flush);
            expect(events.filter((e) => e._tag === "Server")).toHaveLength(1);
          }),
        ),
      );
    }
  });

  it("asks a second time only when the owner lookup did not answer", async () => {
    // A stalled netstat/lsof reports null, and the caller then accepts a merely
    // confirmed listener WITHOUT pid-tree ownership verification — so a single
    // unlucky spawn quietly weakens a real check (Codex). An empty result is a
    // real answer and must NOT be retried, or every port with no visible owner
    // pays double.
    const calls: number[] = [];
    const answering = async (port: number): Promise<readonly number[] | null> => {
      calls.push(port);
      return calls.length === 1 ? null : [4242];
    };
    expect(await retryUndeterminable(answering, 5150)).toEqual([4242]);
    expect(calls).toHaveLength(2);

    const empty: number[] = [];
    let emptyCalls = 0;
    expect(
      await retryUndeterminable(async () => {
        emptyCalls += 1;
        return empty;
      }, 5150),
    ).toBe(empty);
    expect(emptyCalls).toBe(1);

    let nullCalls = 0;
    expect(
      await retryUndeterminable(async () => {
        nullCalls += 1;
        return null;
      }, 5150),
    ).toBeNull();
    expect(nullCalls).toBe(2);
  });

  it("real resolvers see this test process owning its own loopback listener", async () => {
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    try {
      const address = listener.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      expect(port).toBeGreaterThan(0);
      // One call, exactly as production makes it: the retry that absorbs a
      // stalled netstat/lsof lives in the resolver now, so this test proves the
      // behaviour users actually get rather than a test-only loop (Codex).
      const owners = await defaultResolvePortOwners(port);
      // A platform without the lookup tool (e.g. lsof-less minimal Linux) is a
      // SUPPORTED fallback configuration, not a failure — nothing to pin there.
      if (owners !== null) {
        expect(owners).toContain(process.pid);
      }
      const table = await defaultReadProcessTable();
      if (table !== null) {
        expect(table.has(process.pid)).toBe(true);
        expect(pidWithinTree(process.pid, process.pid, table)).toBe(true);
      }
      // On the platforms we actually develop/CI on, both must answer for real.
      if (process.platform === "win32" || process.platform === "darwin") {
        expect(owners).not.toBeNull();
        expect(table).not.toBeNull();
      }
    } finally {
      await new Promise<void>((resolve) => listener.close(() => resolve()));
    }
  }, 30_000);
});

// --- Real child-process smoke test -----------------------------------------

describe("ScriptRunner real child-process smoke test", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-deck-scriptrun-"));
    // A dev server: print a loopback listening URL, then serve until killed.
    writeFileSync(
      join(dir, "server.cjs"),
      [
        "const http = require('node:http');",
        "const server = http.createServer((req, res) => res.end('ok'));",
        "server.listen(0, '127.0.0.1', () => {",
        "  console.log('listening on http://localhost:' + server.address().port + '/');",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "scratch", scripts: { dev: "node server.cjs" } }),
    );
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists + starts the declared dev script, streams output, detects the port, and stop kills it", async () => {
    const runtime = makeServerRuntime();
    try {
      const scope = runtime.runSync(Scope.make());
      const { pid, sawServer, listed } = await runtime.runPromise(
        Effect.gen(function* () {
          const runner = yield* ScriptRunner;
          const listed = yield* runner.listScripts(dir);
          const handle = yield* Scope.extend(
            runner.spawn({ commandId: "package:ZGV2", cwd: dir }),
            scope,
          );
          expect(handle.pid).toBeGreaterThan(0);

          let server: ScriptEvent | null = null;
          let output = "";
          yield* handle.attach((event) => {
            if (event._tag === "Output") output += event.data;
            if (event._tag === "Server") server = event;
          });
          // Wait for the printed URL to be detected + confirmed by the probe.
          yield* Effect.promise(async () => {
            const deadline = Date.now() + 15_000;
            while (server === null && Date.now() < deadline) {
              await new Promise((resolve) => setTimeout(resolve, 50));
            }
          });
          return { pid: handle.pid, sawServer: server, listed, output };
        }),
      );
      expect(listed).toEqual([
        {
          id: "package:ZGV2",
          label: "dev",
          command: "node server.cjs",
          source: "package",
          defaultPort: null,
        },
      ]);
      expect(sawServer).not.toBeNull();
      const server = sawServer as unknown as { server: { host: string; url: string } };
      expect(server.server.host).toBe("localhost");
      expect(server.server.url).toMatch(/^http:\/\/localhost:\d+$/);
      expect(processAlive(pid)).toBe(true);

      // Stop (scope close) tree-kills the child — verified by kill(pid,0) polling.
      await runtime.runPromise(Scope.close(scope, Exit.void));
      await expectProcessGone(pid);
    } finally {
      await runtime.dispose();
    }
  }, 40_000);
});
