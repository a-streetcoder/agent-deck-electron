import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emptyTranscript, type DomainEvent, type SessionMeta } from "@agent-deck/domain";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option, Scope } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionCreationError, SessionManager } from "../src/SessionManager.ts";
import { ReceiptBus, type ReceiptName } from "../src/receipts.ts";
import type { ServerRuntime } from "../src/runtime.ts";
import { SubagentRunStore } from "../src/subagentRunStore.ts";
import { PiHostLive, spawnPiProcess, type PiHostShape } from "../src/services/piHost.ts";
import {
  makeSessionPushBusHandle,
  SessionPushBusesLive,
  type SessionPushBusHandle,
  type SessionPushBusesShape,
} from "../src/services/pushBus.ts";
import {
  ChildRunError,
  makeManagedSessionRuntime,
  resolveChildTools,
  SessionManagerService,
  type ManagedSessionRuntime,
  type SpawnSessionParams,
} from "../src/services/sessionManager.ts";

/**
 * SessionManager service unit tests (Slice 5) against the scripted fake pi
 * (fixtures/fake-pi.cjs). These cover the concurrency-critical new code the
 * real-pi e2e tests do not assert: the ingestion fiber lifecycle + stdout
 * ordering, per-session Scope teardown killing pi and running exit handling
 * exactly once, the title fiber being tied to the session Scope (no orphaned
 * helper pi on stop), the ingestion fiber surviving a throwing bus subscriber,
 * and the facade destroying a half-built session when history seeding fails.
 */

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.cjs");

const buses: SessionPushBusesShape = { make: (capacity) => makeSessionPushBusHandle(capacity) };

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function expectProcessGone(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (processAlive(pid) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  expect(processAlive(pid)).toBe(false);
}

/**
 * A PiHost that redirects EVERY spawn — the main pi AND the internal title /
 * subagent helpers, which all flow through `piHost.spawn` — to the scripted
 * fake-pi, capturing each child's pid in spawn order. `options.env` is preserved
 * (so a helper launched with FAKE_PI_HANG hangs); `binPath`/`args` are ignored.
 */
function makeFakePiHost(): { piHost: PiHostShape; pids: number[] } {
  const pids: number[] = [];
  const piHost: PiHostShape = {
    spawn: (options) =>
      spawnPiProcess({
        binPath: process.execPath,
        args: [FIXTURE],
        cwd: options.cwd,
        env: options.env,
        requestTimeoutMs: options.requestTimeoutMs,
      }).pipe(
        Effect.tap((handle) =>
          Effect.map(handle.pid, (pid) => {
            if (Option.isSome(pid)) pids.push(pid.value);
          }),
        ),
      ),
  };
  return { piHost, pids };
}

const tempDirsToClean: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "agent-deck-sm-test-"));
  tempDirsToClean.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirsToClean.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function makeParams(overrides: Partial<SpawnSessionParams> = {}): SpawnSessionParams {
  const meta: SessionMeta = {
    id: randomUUID(),
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
  };
  return {
    meta,
    spawn: { binPath: process.execPath, args: [FIXTURE], cwd: process.cwd() },
    receipts: new ReceiptBus(false),
    onMetaChange: () => {},
    helperContext: {},
    tempDirs: [],
    autoTitle: () => false,
    ...overrides,
  };
}

const waitUntil = (pred: () => boolean, ms = 5_000): Effect.Effect<void> =>
  Effect.gen(function* () {
    const deadline = Date.now() + ms;
    while (!pred() && Date.now() < deadline) yield* Effect.sleep("25 millis");
    if (!pred()) yield* Effect.die(new Error("waitUntil: condition not met in time"));
  });

describe("Loop synthetic transcript restoration", () => {
  it("seeds ordered durable role cards exactly once", async () => {
    const { piHost } = makeFakePiHost();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(piHost, buses, makeParams());
          const cells = [
            {
              kind: "subagent" as const,
              id: "maker",
              task: "Make",
              status: "done" as const,
              text: "maker output",
              progress: [],
            },
            {
              kind: "subagent" as const,
              id: "evaluator",
              task: "Evaluate",
              status: "done" as const,
              text: "SUCCESS",
              progress: [],
            },
          ];
          yield* rt.seedSyntheticCells(cells);
          yield* rt.seedSyntheticCells(cells);
          const snapshot = yield* rt.snapshot;
          expect(
            snapshot.state.cells
              .filter((cell) => cell.kind === "subagent")
              .map((cell) => [cell.id, cell.text]),
          ).toEqual([
            ["maker", "maker output"],
            ["evaluator", "SUCCESS"],
          ]);
        }),
      ),
    );
  });
});

describe("child transcript reconstruction ownership", () => {
  it("returns no transcript when parent deletion wins during canonical reconstruction", async () => {
    const dataDir = makeTempDir();
    const store = new SubagentRunStore(dataDir, () => {});
    const parentSessionId = randomUUID();
    const now = new Date().toISOString();
    const run = {
      id: randomUUID(),
      parentSessionId,
      task: "race reconstruction",
      status: "starting" as const,
      createdAt: now,
      updatedAt: now,
      source: "single" as const,
    };
    const allocation = store.prepareTurn(run, "system");
    const sessionFile = path.join(allocation.sessionsDirectory, "child.jsonl");
    writeFileSync(sessionFile, "{}\n");
    store.create({
      ...run,
      artifactRootId: allocation.artifactRootId,
      artifactRootToken: allocation.identityToken,
      currentTurnId: allocation.turnId,
      sessionFile,
    });
    store.markOwnedSession(run.id, sessionFile);
    store.update(run.id, {
      status: "completed",
      completedAt: now,
      updatedAt: now,
      summary: "done",
    });

    let release!: (value: ReturnType<typeof emptyTranscript>) => void;
    const blocked = new Promise<ReturnType<typeof emptyTranscript>>((resolve) => {
      release = resolve;
    });
    const runtime = {
      runPromise: vi.fn(() => blocked),
    } as unknown as ServerRuntime;
    const manager = new SessionManager(
      runtime,
      new ReceiptBus(false),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      store,
    );

    const reading = manager.subagentTranscript(parentSessionId, run.id, dataDir);
    await vi.waitFor(() => expect(runtime.runPromise).toHaveBeenCalledOnce());
    store.removeParent(parentSessionId);
    release(emptyTranscript());
    await expect(reading).resolves.toBeUndefined();
  });
});

describe("durable generic child lifecycle", () => {
  it("stops a running child with its parent scope and durably restores partial output + metadata", async () => {
    const { piHost, pids } = makeFakePiHost();
    const dataDir = makeTempDir();
    const store = new SubagentRunStore(dataDir, () => {});
    const params = makeParams({
      childRuns: {
        create: (record) => store.create(record),
        update: (id, patch) => store.update(id, patch),
      },
    });
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(piHost, buses, params);
          yield* Effect.fork(rt.runChildAgent("stream-with-metadata-forever"));
          yield* waitUntil(() => {
            const cell = Effect.runSync(rt.snapshot).state.cells.find(
              (item) => item.kind === "subagent",
            );
            return cell?.kind === "subagent" && cell.text.includes("chunk-");
          });
          expect(pids).toHaveLength(2);
        }),
      ),
    );
    await expectProcessGone(pids[1]!);

    const reloadedStore = new SubagentRunStore(dataDir, () => {});
    const restored = reloadedStore.cells(params.meta.id)[0];
    expect(reloadedStore.list(params.meta.id)[0]).toEqual(
      expect.objectContaining({ source: "single", sessionFile: FIXTURE }),
    );
    expect(restored).toEqual(
      expect.objectContaining({
        status: "stopped",
        text: expect.stringContaining("chunk-"),
        model: "fake-child-model",
        inputTokens: 7,
        outputTokens: 3,
        durationMs: expect.any(Number),
      }),
    );
    expect(restored!.durationMs).toBeGreaterThan(0);
  });

  it("persists parallel source and Pi's early session handle for a completed generic run", async () => {
    const { piHost } = makeFakePiHost();
    const dataDir = makeTempDir();
    const store = new SubagentRunStore(dataDir, () => {});
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(
            piHost,
            buses,
            makeParams({
              childRuns: {
                create: (record) => store.create(record),
                update: (id, patch) => store.update(id, patch),
              },
            }),
          );
          return yield* rt.runChildAgent("finish normally", undefined, undefined, undefined, {
            source: "parallel",
          });
        }),
      ),
    );

    expect(store.get(result.runId)).toEqual(
      expect.objectContaining({
        source: "parallel",
        sessionFile: FIXTURE,
        status: "completed",
      }),
    );
  });

  it("replaces the live continuation card exactly once when startup fails before cell_open", async () => {
    const { piHost } = makeFakePiHost();
    const dataDir = makeTempDir();
    const store = new SubagentRunStore(dataDir, () => {});
    const params = makeParams();
    const runId = randomUUID();
    const now = new Date().toISOString();
    store.create({
      id: runId,
      parentSessionId: params.meta.id,
      task: "old completed task",
      status: "completed",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      summary: "old completed output",
      source: "single",
      sessionFile: FIXTURE,
    });
    const events: DomainEvent[] = [];

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(piHost, buses, {
            ...params,
            childRuns: {
              create: (record) => store.create(record),
              update: (id, patch) => {
                if (patch.status === "running") throw new Error("running persistence failed");
                store.update(id, patch);
              },
            },
          });
          yield* rt.seedSyntheticCells(store.cells(params.meta.id));
          yield* rt.bus.subscribe((event) => events.push(event.event));
          const exit = yield* Effect.exit(
            rt.runChildAgent("new continuation task", undefined, undefined, undefined, {
              source: "single",
              runId,
              resumeSessionPath: FIXTURE,
            }),
          );
          expect(exit._tag).toBe("Failure");
          return yield* rt.snapshot;
        }),
      ),
    );

    const live = result.state.cells.filter((cell) => cell.kind === "subagent");
    const persisted = store.cells(params.meta.id);
    expect(live).toHaveLength(1);
    expect(persisted).toHaveLength(1);
    expect(live[0]).toEqual(
      expect.objectContaining({
        id: runId,
        task: "new continuation task",
        status: "error",
        text: "",
        error: expect.stringContaining("running persistence failed"),
      }),
    );
    expect(persisted[0]).toEqual(
      expect.objectContaining({
        id: runId,
        task: "new continuation task",
        status: "error",
        text: "",
        error: expect.stringContaining("running persistence failed"),
      }),
    );
    expect(events.filter((event) => event.type === "cell_open")).toHaveLength(0);
    expect(
      events.filter((event) => event.type === "cell_final" && event.cell.id === runId),
    ).toHaveLength(1);
  });

  it("cleans up without prompting when the running transition cannot be persisted", async () => {
    const { piHost, pids } = makeFakePiHost();
    const statuses: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(
            piHost,
            buses,
            makeParams({
              childRuns: {
                create: (record) => statuses.push(record.status),
                update: (_id, patch) => {
                  if (patch.status) statuses.push(patch.status);
                  if (patch.status === "running") throw new Error("running write failed");
                },
              },
            }),
          );
          expect((yield* Effect.exit(rt.runChildAgent("must not prompt")))._tag).toBe("Failure");
        }),
      ),
    );
    expect(statuses).toEqual(["starting", "running", "failed"]);
    await expectProcessGone(pids[1]!);
  });

  it("reports completion persistence failure as a failed card without overwriting it as stopped", async () => {
    const { piHost } = makeFakePiHost();
    const statuses: string[] = [];
    const outcome = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(
            piHost,
            buses,
            makeParams({
              childRuns: {
                create: (record) => statuses.push(record.status),
                update: (_id, patch) => {
                  if (patch.status) statuses.push(patch.status);
                  if (patch.status === "completed") throw new Error("completion fsync failed");
                },
              },
            }),
          );
          const exit = yield* Effect.exit(rt.runChildAgent("finish normally"));
          expect(exit._tag).toBe("Failure");
          return {
            error: exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined,
            cell: (yield* rt.snapshot).state.cells.find((item) => item.kind === "subagent"),
          };
        }),
      ),
    );
    expect(statuses).toEqual(["starting", "running", "completed", "failed"]);
    expect(outcome.error).toBeInstanceOf(ChildRunError);
    expect((outcome.error as ChildRunError).runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(outcome.cell).toEqual(
      expect.objectContaining({
        status: "error",
        text: "hello",
        error: expect.stringContaining("could not be persisted"),
      }),
    );
  });

  it("surfaces a failed-transition write error and retries durable failed during cleanup", async () => {
    const { piHost, pids } = makeFakePiHost();
    const statuses: string[] = [];
    let failedWrites = 0;
    const cell = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(
            piHost,
            buses,
            makeParams({
              childRuns: {
                create: (record) => statuses.push(record.status),
                update: (_id, patch) => {
                  if (patch.status) statuses.push(patch.status);
                  if (patch.status === "failed" && failedWrites++ === 0) {
                    throw new Error("failed write failed");
                  }
                },
              },
            }),
          );
          expect((yield* Effect.exit(rt.runChildAgent("exit-before-end")))._tag).toBe("Failure");
          return (yield* rt.snapshot).state.cells.find((item) => item.kind === "subagent");
        }),
      ),
    );
    expect(statuses).toEqual(["starting", "running", "failed", "failed"]);
    expect(cell).toEqual(
      expect.objectContaining({
        status: "error",
        error: expect.stringContaining("could not persist failed run"),
      }),
    );
    await expectProcessGone(pids[1]!);
  });

  it("still reaps the child when persisting the stopped transition fails", async () => {
    const { piHost, pids } = makeFakePiHost();
    const statuses: string[] = [];
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(
            piHost,
            buses,
            makeParams({
              childRuns: {
                create: (record) => statuses.push(record.status),
                update: (_id, patch) => {
                  if (patch.status) statuses.push(patch.status);
                  if (patch.status === "stopped") throw new Error("stopped write failed");
                },
              },
            }),
          );
          yield* Effect.fork(rt.runChildAgent("stream-forever"));
          yield* waitUntil(() => statuses.includes("running"));
        }),
      ),
    );
    expect(statuses).toEqual(["starting", "running", "stopped"]);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("failed to persist stopped run"),
      expect.any(Error),
    );
    warning.mockRestore();
    await expectProcessGone(pids[1]!);
  });

  it("does not spawn a child when the required initial record cannot be persisted", async () => {
    const { piHost, pids } = makeFakePiHost();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(
            piHost,
            buses,
            makeParams({
              childRuns: {
                create: () => {
                  throw new Error("disk full");
                },
                update: () => {},
              },
            }),
          );
          const exit = yield* Effect.exit(rt.runChildAgent("must not launch"));
          expect(exit._tag).toBe("Failure");
          expect(pids).toHaveLength(1);
        }),
      ),
    );
  });
});

describe("child tool capability policy", () => {
  const dangerous = [
    "read",
    "grep",
    "find",
    "ls",
    "bash",
    "edit",
    "write",
    "managed_subagent",
    "set_session_plan",
  ];

  it("keeps default behavior while enforcing report-only and no-tool children", () => {
    expect(resolveChildTools(dangerous, undefined, true)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
      "contact_supervisor",
    ]);
    expect(resolveChildTools(dangerous, "configured", false)).toEqual([
      "read",
      "grep",
      "find",
      "ls",
      "bash",
      "edit",
      "write",
    ]);
    expect(resolveChildTools(dangerous, "readOnly", false)).toEqual(["read", "grep", "find", "ls"]);
    expect(resolveChildTools(dangerous, "none", false)).toEqual([]);
  });
});

describe("SessionManager Effect service (services/sessionManager.ts)", () => {
  it("ingestion fiber folds pi stdout into ordered domain events on the bus", async () => {
    const { piHost } = makeFakePiHost();
    const out = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(piHost, buses, makeParams());
          const seen: DomainEvent[] = [];
          yield* rt.bus.subscribe((s) => seen.push(s.event));
          yield* Effect.forkDaemon(rt.ingest);
          yield* rt.prompt("say-hello");
          yield* waitUntil(() =>
            seen.some((e) => e.type === "cell_final" && e.cell.kind === "assistant"),
          );
          return { seen, snap: yield* rt.snapshot };
        }),
      ),
    );
    // fake-pi streams "he" + "llo" (with a malformed line in between, ignored).
    const assistant = out.snap.state.cells.find((c) => c.kind === "assistant");
    const text =
      assistant?.kind === "assistant" ? assistant.blocks.map((b) => b.text).join("") : "";
    expect(text).toContain("hello");
    // Deltas were stamped onto the bus BEFORE the assistant's cell_final — the
    // pi-stdout order the single synchronous `emit` seam preserves.
    const firstDelta = out.seen.findIndex((e) => e.type === "cell_delta");
    const finalIdx = out.seen.findIndex(
      (e) => e.type === "cell_final" && e.cell.kind === "assistant",
    );
    expect(firstDelta).toBeGreaterThanOrEqual(0);
    expect(firstDelta).toBeLessThan(finalIdx);
  }, 15_000);

  it("closing the session Scope kills pi and runs exit handling once (endedAt, temp cleanup, listeners)", async () => {
    const { piHost, pids } = makeFakePiHost();
    const tempDir = makeTempDir();
    const meta: SessionMeta = {
      id: randomUUID(),
      cwd: process.cwd(),
      createdAt: new Date().toISOString(),
    };
    let exitCount = 0;
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const rt = yield* Scope.extend(
          makeManagedSessionRuntime(piHost, buses, makeParams({ meta, tempDirs: [tempDir] })),
          scope,
        );
        rt.onExit(() => {
          exitCount += 1;
        });
        yield* Effect.forkDaemon(rt.ingest);
        yield* Effect.sleep("50 millis"); // let the ingestion fiber claim the feed
        const aliveBefore = processAlive(pids[0]!);
        // Scope close == pi killed; the ingestion fiber then processes the
        // terminating ProcessExit item and runs the idempotent exit handling.
        yield* Scope.close(scope, Exit.void);
        yield* waitUntil(() => rt.meta.endedAt !== undefined);
        return { aliveBefore, endedAt: rt.meta.endedAt, mainPid: pids[0]! };
      }),
    );
    expect(out.aliveBefore).toBe(true);
    await expectProcessGone(out.mainPid);
    expect(out.endedAt).toBeDefined();
    expect(exitCount).toBe(1); // runExitHandling is guarded — fires exactly once
    expect(existsSync(tempDir)).toBe(false); // temp dirs cleaned on exit
  }, 15_000);

  it("receipt cardinality: first_delta once EVER, assistant_final/idle once PER TURN", async () => {
    const { piHost } = makeFakePiHost();
    const emitted: string[] = [];
    class RecordingReceipts extends ReceiptBus {
      override emit(name: ReceiptName, sessionId: string): void {
        emitted.push(name);
        super.emit(name, sessionId);
      }
    }
    const count = (name: string): number => emitted.filter((n) => n === name).length;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(
            piHost,
            buses,
            makeParams({ receipts: new RecordingReceipts(true) }),
          );
          yield* Effect.forkDaemon(rt.ingest);
          yield* rt.prompt("say-hello");
          yield* waitUntil(() => count("idle") >= 1);
          // Turn 1: exactly one of each.
          expect(count("first_delta")).toBe(1);
          expect(count("assistant_final")).toBe(1);
          expect(count("idle")).toBe(1);
          yield* rt.prompt("say-hello");
          yield* waitUntil(() => count("idle") >= 2);
          // Turn 2: per-turn receipts fire again; first_delta stays one-shot,
          // and no title receipt (autoTitle() => false in makeParams).
          expect(count("first_delta")).toBe(1);
          expect(count("assistant_final")).toBe(2);
          expect(count("idle")).toBe(2);
          expect(count("title")).toBe(0);
        }),
      ),
    );
  }, 15_000);

  it("a throwing bus subscriber cannot kill the ingestion fiber (per-item defect swallow)", async () => {
    const { piHost } = makeFakePiHost();
    const seen = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(piHost, buses, makeParams());
          const recorded: DomainEvent[] = [];
          // recorder FIRST, thrower SECOND: every event reaches the recorder,
          // then the thrower turns `emit` into a DEFECT (not a typed failure).
          yield* rt.bus.subscribe((s) => recorded.push(s.event));
          yield* rt.bus.subscribe(() => {
            throw new Error("boom subscriber");
          });
          yield* Effect.forkDaemon(rt.ingest);
          yield* rt.prompt("say-hello");
          // If defects killed the fiber, only the FIRST event would ever arrive
          // and no assistant cell_final would be recorded (session frozen).
          yield* waitUntil(() =>
            recorded.some((e) => e.type === "cell_final" && e.cell.kind === "assistant"),
          );
          return recorded;
        }),
      ),
    );
    expect(seen.some((e) => e.type === "cell_final" && e.cell.kind === "assistant")).toBe(true);
    expect(seen.filter((e) => e.type === "cell_delta").length).toBeGreaterThanOrEqual(1);
  }, 15_000);

  it("forks the onIdle hook at each turn boundary without disturbing receipt timing (Slice 9)", async () => {
    const { piHost } = makeFakePiHost();
    const emitted: string[] = [];
    class RecordingReceipts extends ReceiptBus {
      override emit(name: ReceiptName, sessionId: string): void {
        emitted.push(name);
        super.emit(name, sessionId);
      }
    }
    let idleRuns = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(
            piHost,
            buses,
            makeParams({
              receipts: new RecordingReceipts(true),
              onIdle: Effect.sync(() => {
                idleRuns += 1;
              }),
            }),
          );
          yield* Effect.forkDaemon(rt.ingest);
          yield* rt.prompt("say-hello");
          yield* waitUntil(() => idleRuns >= 1);
          // The idle receipt still fired, and BEFORE the forked hook ran (the
          // hook is fire-and-forget — it must never delay receipt emission).
          expect(emitted.filter((n) => n === "idle")).toHaveLength(1);
          yield* rt.prompt("say-hello");
          yield* waitUntil(() => idleRuns >= 2);
          // One hook run per turn boundary.
          expect(idleRuns).toBe(2);
          expect(emitted.filter((n) => n === "idle")).toHaveLength(2);
        }),
      ),
    );
  }, 15_000);

  it("forks the checkpoint hook once per turn without disturbing receipt timing (Slice 18a)", async () => {
    const { piHost } = makeFakePiHost();
    const emitted: string[] = [];
    class RecordingReceipts extends ReceiptBus {
      override emit(name: ReceiptName, sessionId: string): void {
        emitted.push(name);
        super.emit(name, sessionId);
      }
    }
    // The checkpoint hook is chained AFTER captureSessionFile in the SAME fiber
    // (so it sees a resolved session-file handle); assert both effects ran, in
    // that order, without the idle receipt waiting on either. The label is empty
    // under the fake pi (which emits no user cell — the real-pi test asserts the
    // populated label); here the label's TYPE and the hook cardinality matter.
    const labels: string[] = [];
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(
            piHost,
            buses,
            makeParams({
              receipts: new RecordingReceipts(true),
              captureCheckpoint: (label) =>
                Effect.sync(() => {
                  labels.push(label);
                }),
            }),
          );
          yield* Effect.forkDaemon(rt.ingest);
          yield* rt.prompt("say-hello");
          yield* waitUntil(() => labels.length >= 1);
          // The idle receipt fired BEFORE the fire-and-forget checkpoint hook —
          // capture must never delay receipt emission (the e2e suite pins it).
          expect(emitted.filter((n) => n === "idle")).toHaveLength(1);
          expect(typeof labels[0]).toBe("string");
          yield* rt.prompt("say-hello");
          yield* waitUntil(() => labels.length >= 2);
          // Exactly one capture per turn boundary.
          expect(labels).toHaveLength(2);
          expect(emitted.filter((n) => n === "idle")).toHaveLength(2);
        }),
      ),
    );
  }, 15_000);

  it("forks the title fiber into the session Scope: scope close reaps an in-flight title helper pi", async () => {
    const { piHost, pids } = makeFakePiHost();
    const out = await Effect.runPromise(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const rt = yield* Scope.extend(
          makeManagedSessionRuntime(
            piHost,
            buses,
            makeParams({ autoTitle: () => true, helperContext: { env: { FAKE_PI_HANG: "1" } } }),
          ),
          scope,
        );
        // Seed a first user cell (fake-pi get_messages), then start ingestion
        // (resume ordering), then a turn that reaches idle → the title helper is
        // forked into the session Scope. Its prompt hangs (FAKE_PI_HANG), so the
        // helper pi stays alive until the scope closes.
        yield* rt.seedFromHistory;
        yield* Effect.forkDaemon(rt.ingest);
        yield* rt.prompt("hi");
        yield* waitUntil(() => pids.length >= 2); // [0] main pi, [1] title helper
        const helperPid = pids[1]!;
        const aliveBefore = processAlive(helperPid);
        yield* Scope.close(scope, Exit.void);
        return { helperPid, mainPid: pids[0]!, aliveBefore };
      }),
    );
    expect(out.aliveBefore).toBe(true);
    // With the old `forkDaemon` onto the global runtime the helper would survive
    // scope close (orphaned); forked into the session Scope it is interrupted and
    // its pi reaped.
    await expectProcessGone(out.helperPid);
    await expectProcessGone(out.mainPid);
  }, 20_000);
});

describe("SessionManager facade cleanup on create/resume/fork failures", () => {
  /**
   * A ServerRuntime whose SessionManagerService hands out a session runtime that
   * FAILS history seeding as a defect (exactly like the real `seedFromHistory`,
   * which does `getMessages.pipe(Effect.orDie)`), with a spy on `ensureExitHandled`
   * so the test can assert the facade tore the half-built session down.
   */
  function makeFakeRuntime(): { runtime: ServerRuntime; exitHandledCalls: () => number } {
    let calls = 0;
    const fakeBus: SessionPushBusHandle = {
      lastSeq: Effect.succeed(0),
      append: () => Effect.succeed({ seq: 0, event: {} as DomainEvent }),
      replayFrom: () => Effect.succeed(null),
      subscribe: () => Effect.succeed(Effect.void),
      unsafeAppend: () => ({ seq: 0, event: {} as DomainEvent }),
      unsafeLastSeq: () => 0,
    };
    const fakeSpawn = (
      params: SpawnSessionParams,
    ): Effect.Effect<ManagedSessionRuntime, never, Scope.Scope> =>
      Effect.succeed({
        meta: params.meta,
        bus: fakeBus,
        ingest: Effect.void,
        seedFromHistory: Effect.die(new Error("seed failed: pi exited")),
        ensureExitHandled: Effect.sync(() => {
          calls += 1;
        }),
      } as unknown as ManagedSessionRuntime);
    const layers = Layer.mergeAll(
      Layer.succeed(SessionManagerService, { spawn: fakeSpawn }),
      SessionPushBusesLive,
      PiHostLive,
    );
    const runtime = ManagedRuntime.make(layers) as ServerRuntime;
    return { runtime, exitHandledCalls: () => calls };
  }

  it("exposes cleanup completion after a post-spawn create failure", async () => {
    let released = false;
    let exitHandled = 0;
    const fakeBus: SessionPushBusHandle = {
      lastSeq: Effect.succeed(0),
      append: () => Effect.succeed({ seq: 0, event: {} as DomainEvent }),
      replayFrom: () => Effect.succeed(null),
      subscribe: () => Effect.succeed(Effect.void),
      unsafeAppend: () => ({ seq: 0, event: {} as DomainEvent }),
      unsafeLastSeq: () => 0,
    };
    const fakeSpawn = (
      params: SpawnSessionParams,
    ): Effect.Effect<ManagedSessionRuntime, never, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.succeed({
          meta: params.meta,
          bus: fakeBus,
          ingest: Effect.void,
          ensureExitHandled: Effect.sync(() => {
            exitHandled += 1;
          }),
        } as unknown as ManagedSessionRuntime),
        () =>
          Effect.promise(async () => {
            await new Promise((resolve) => setTimeout(resolve, 25));
            released = true;
          }),
      );
    const runtime = ManagedRuntime.make(
      Layer.mergeAll(
        Layer.succeed(SessionManagerService, { spawn: fakeSpawn }),
        SessionPushBusesLive,
        PiHostLive,
      ),
    ) as ServerRuntime;
    try {
      const ordering: string[] = [];
      class OrderingReceipts extends ReceiptBus {
        override emit(name: ReceiptName, sessionId: string): void {
          ordering.push("receipt");
          super.emit(name, sessionId);
        }
      }
      const sm = new SessionManager(runtime, new OrderingReceipts(false), () => {
        ordering.push("meta");
        throw new Error("persistence failed");
      });
      let failure: SessionCreationError | undefined;
      try {
        sm.create({ cwd: process.cwd(), plan: { kind: "parent" } });
      } catch (error) {
        expect(error).toBeInstanceOf(SessionCreationError);
        failure = error as SessionCreationError;
      }
      expect(released).toBe(false);
      await failure?.cleanup;
      expect(released).toBe(true);
      expect(exitHandled).toBe(1);
      expect(ordering).toEqual(["receipt", "meta"]);
      expect(sm.list()).toEqual([]);
    } finally {
      await runtime.dispose();
    }
  });

  it("resume() destroys the half-built session when history seeding fails", async () => {
    const { runtime, exitHandledCalls } = makeFakeRuntime();
    try {
      const sm = new SessionManager(runtime, new ReceiptBus(false));
      const meta: SessionMeta = {
        id: randomUUID(),
        cwd: process.cwd(),
        createdAt: new Date().toISOString(),
        launchPlan: { kind: "parent" },
      };
      await expect(sm.resume(meta, { kind: "parent" })).rejects.toThrow();
      // launch() spawned + registered the session; the seed failure must tear it
      // back down rather than leak a dead session with an orphaned pi.
      expect(sm.get(meta.id)).toBeUndefined();
      expect(exitHandledCalls()).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });

  it("fork() destroys the half-built session when history seeding fails", async () => {
    const { runtime, exitHandledCalls } = makeFakeRuntime();
    const dir = makeTempDir();
    const srcFile = path.join(dir, "src.jsonl");
    writeFileSync(srcFile, "{}\n");
    const copyTo = path.join(dir, "copy.jsonl");
    try {
      const sm = new SessionManager(runtime, new ReceiptBus(false));
      const source: SessionMeta = {
        id: randomUUID(),
        cwd: process.cwd(),
        createdAt: new Date().toISOString(),
        launchPlan: { kind: "parent" },
        piSessionFile: srcFile,
      };
      await expect(sm.fork(source, srcFile, copyTo)).rejects.toThrow();
      // The freshly-forked session (its own id) must be gone, not leaked.
      expect(sm.list()).toHaveLength(0);
      expect(exitHandledCalls()).toBe(1);
    } finally {
      await runtime.dispose();
    }
  });
});
