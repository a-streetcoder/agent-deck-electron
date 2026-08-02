import { Effect, Exit, Option, Scope, Stream } from "effect";
import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionMeta } from "@agent-deck/contracts";
import { normalizeSessionError } from "../src/sessionFailure.ts";
import { SessionIndex } from "../src/persistence.ts";
import { ReceiptBus } from "../src/receipts.ts";
import { makeManagedSessionRuntime } from "../src/services/sessionManager.ts";
import { makeSessionPushBusHandle } from "../src/services/pushBus.ts";
import {
  spawnPiProcess,
  type PiHostHandle,
  type PiHostShape,
  type PiStreamItem,
} from "../src/services/piHost.ts";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "fake-pi.cjs");
const piHost: PiHostShape = {
  spawn: (options) =>
    spawnPiProcess({
      binPath: process.execPath,
      args: [FIXTURE],
      cwd: options.cwd,
      env: options.env,
      requestTimeoutMs: options.requestTimeoutMs,
    }),
};
const buses = { make: (capacity?: number) => makeSessionPushBusHandle(capacity) };
function meta(): SessionMeta {
  return { id: randomUUID(), cwd: process.cwd(), createdAt: new Date().toISOString() };
}

function params(session: SessionMeta, requestTimeoutMs?: number) {
  return {
    meta: session,
    spawn: {
      binPath: process.execPath,
      args: [FIXTURE],
      cwd: process.cwd(),
      requestTimeoutMs,
    },
    receipts: new ReceiptBus(false),
    onMetaChange: () => {},
    helperContext: {},
    tempDirs: [],
    autoTitle: () => false,
  };
}

async function ingestScriptedItems(
  items: PiStreamItem[],
  scheduling: "inline" | "fork-before-ensure" = "inline",
): Promise<SessionMeta> {
  const session = meta();
  const exit = [...items].reverse().find((item) => item._tag === "ProcessExit");
  const handle = {
    events: Stream.fromIterable(items),
    exit: Effect.succeed(exit?._tag === "ProcessExit" ? Option.some(exit.exit) : Option.none()),
    isRunning: Effect.succeed(false),
    compact: Effect.void,
    abort: Effect.void,
    getState: Effect.succeed({}),
    getForkMessages: Effect.succeed({}),
    getEntries: Effect.succeed({ leafId: null, entries: [] }),
    getSessionStats: Effect.succeed({}),
    getAvailableModels: Effect.succeed([]),
    getCommands: Effect.succeed([]),
  } as unknown as PiHostHandle;
  const scriptedHost: PiHostShape = { spawn: () => Effect.succeed(handle) };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const rt = yield* makeManagedSessionRuntime(scriptedHost, buses, params(session));
        if (scheduling === "fork-before-ensure") {
          yield* Effect.fork(rt.ingest);
          yield* rt.ensureExitHandled;
        } else {
          yield* rt.ingest;
        }
      }),
    ),
  );
  return session;
}

const assistantError = (detail: string): PiStreamItem => ({
  _tag: "PiEvent",
  event: {
    type: "message_end",
    message: { role: "assistant", stopReason: "error", errorMessage: detail, content: [] },
  } as never,
});

const processExit = (code: number | null, signal: NodeJS.Signals | null = null): PiStreamItem => ({
  _tag: "ProcessExit",
  exit: { code, signal },
});

describe("durable session failure metadata", () => {
  it("round-trips failure across restart and durably clears both fields", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-session-failure-"));
    try {
      const failed = {
        ...meta(),
        endedAt: new Date().toISOString(),
        status: "failed" as const,
        lastError: "Provider unavailable",
      };
      new SessionIndex(dataDir).upsert(failed);
      expect(new SessionIndex(dataDir).find((item) => item.id === failed.id)).toMatchObject({
        status: "failed",
        lastError: "Provider unavailable",
      });

      const { status: _status, lastError: _lastError, ...failedBase } = failed;
      new SessionIndex(dataDir).upsert({ ...failedBase, endedAt: undefined });
      expect(new SessionIndex(dataDir).find((item) => item.id === failed.id)).not.toHaveProperty(
        "status",
      );
      expect(new SessionIndex(dataDir).find((item) => item.id === failed.id)).not.toHaveProperty(
        "lastError",
      );
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("sanitizes controls, ANSI and secrets and truncates by Unicode code point", () => {
    const normalized = normalizeSessionError(
      `\u001b[31m failed\n Bearer abc.def token=secret-value ${"😀".repeat(3_000)}\u0000`,
    );
    expect(normalized).not.toContain("\u001b");
    expect(normalized).not.toContain("abc.def");
    expect(normalized).not.toContain("secret-value");
    expect(normalized).toContain("[REDACTED]");
    expect(Array.from(normalized)).toHaveLength(2_048);
    expect(normalized.endsWith("…")).toBe(true);
  });

  it("redacts quoted JSON secrets without corrupting surrounding diagnostics", () => {
    const normalized = normalizeSessionError(
      '\u001b[31mHTTP 401\u001b[0m {"api_key":"sec\\"ret-one","access_token":"secret-two","refresh-token":"secret-three"}\u0007',
    );
    expect(normalized).toBe(
      'HTTP 401 {"api_key":"[REDACTED]","access_token":"[REDACTED]","refresh-token":"[REDACTED]"}',
    );
  });

  it.each([
    ["message_end", assistantError("Specific provider message_end failure")],
    [
      "agent_end fallback",
      {
        _tag: "PiEvent" as const,
        event: {
          type: "agent_end",
          messages: [
            {
              role: "assistant",
              stopReason: "error",
              errorMessage: "Specific agent_end fallback failure",
            },
          ],
        } as never,
      },
    ],
  ])("lets queued %s provider detail win after ProcessExit observation", async (_label, event) => {
    const session = await ingestScriptedItems([processExit(17), event]);
    expect(session.endedAt).toBeDefined();
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain("Specific");
    expect(session.lastError).not.toContain("exit code");
  });

  it.each([
    [processExit(23), "exit code 23"],
    [processExit(null, "SIGTERM"), "signal SIGTERM"],
  ])("marks an independent unexpected process exit as failed", async (event, detail) => {
    const session = await ingestScriptedItems([event]);
    expect(session.endedAt).toBeDefined();
    expect(session.status).toBe("failed");
    expect(session.lastError).toContain(detail);
  });

  it("does not promote a recoverable tool error to session failure", async () => {
    const session = await ingestScriptedItems([
      {
        _tag: "PiEvent",
        event: {
          type: "tool_execution_end",
          toolCallId: "tool-1",
          toolName: "read",
          isError: true,
          result: "recoverable tool failure",
        } as never,
      },
      processExit(0),
    ]);
    expect(session.status).toBeUndefined();
    expect(session.lastError).toBeUndefined();
  });

  it("preserves a provider failure over its later nonzero process exit", async () => {
    const session = await ingestScriptedItems([
      assistantError("Provider failed: Bearer secret-token-value"),
      processExit(9),
    ]);
    expect(session.endedAt).toBeDefined();
    expect(session.status).toBe("failed");
    expect(session.lastError).toBe("Provider failed: Bearer [REDACTED]");
  });

  it("keeps provider detail deterministic across repeated process-exit races", async () => {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      // Prequeue both terminal items, then immediately await exit handling after
      // forking ingestion. This deterministically exercises the scheduler race:
      // ensureExitHandled must wait for the not-yet-scheduled ingestion fiber to
      // consume the provider detail and drain through ProcessExit.
      const session = await ingestScriptedItems(
        [assistantError("Provider failed: Bearer secret-token-value"), processExit(9)],
        "fork-before-ensure",
      );
      expect(session.endedAt, `attempt ${attempt}`).toBeDefined();
      expect(session.status, `attempt ${attempt}`).toBe("failed");
      expect(session.lastError, `attempt ${attempt}`).toBe("Provider failed: Bearer [REDACTED]");
    }
  });

  it("does not persist prompt, steer, or follow-up RPC timeouts", async () => {
    const session = meta();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(piHost, buses, params(session, 30));
          yield* Effect.fork(rt.ingest);
          yield* Effect.exit(rt.prompt("timeout-prompt"));
          yield* Effect.exit(rt.steer("timeout-steer"));
          yield* Effect.exit(rt.followUp("timeout-follow-up"));
          expect(session.status).toBeUndefined();
          expect(session.lastError).toBeUndefined();
          expect(yield* rt.isRunning).toBe(true);
        }),
      ),
    );
  });

  it("persists rejected prompt, steer, and follow-up commands and recovers", async () => {
    const session = meta();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const rt = yield* makeManagedSessionRuntime(piHost, buses, params(session));
          yield* Effect.fork(rt.ingest);
          yield* Effect.exit(rt.prompt("reject-prompt"));
          expect(session.status).toBe("failed");
          expect(session.lastError).toContain("[REDACTED]");
          yield* rt.prompt("say-hello");
          expect(session.status).toBeUndefined();
          expect(session.lastError).toBeUndefined();
          yield* Effect.exit(rt.steer("reject-steer"));
          expect(session.status).toBe("failed");
          expect(session.lastError).toContain("steer rejected");
          yield* rt.prompt("say-hello");
          yield* Effect.exit(rt.followUp("reject-follow-up"));
          expect(session.status).toBe("failed");
          expect(session.lastError).toContain("follow_up rejected");
          expect(session.lastError).not.toContain("command-secret");
        }),
      ),
    );
  });

  it("does not classify expected scope teardown as a failure", async () => {
    const session = meta();
    const scope = Effect.runSync(Scope.make());
    const rt = Effect.runSync(
      makeManagedSessionRuntime(piHost, buses, params(session)).pipe(
        Effect.provideService(Scope.Scope, scope),
      ),
    );
    Effect.runFork(rt.ingest);
    await Effect.runPromise(rt.expectTeardown);
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await Effect.runPromise(rt.ensureExitHandled);
    expect(session.status).toBeUndefined();
  });
});
