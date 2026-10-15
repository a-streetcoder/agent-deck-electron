import { randomUUID } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect, Layer, ManagedRuntime, Scope } from "effect";
import { describe, expect, it, vi } from "vitest";
import { BridgeRegistry } from "../src/bridge.ts";
import { registerDeckBridgeTools } from "../src/bridgeTools.ts";
import { ReceiptBus } from "../src/receipts.ts";
import type { ServerRuntime } from "../src/runtime.ts";
import { ManagedSession, MAX_DETACHED_SUBAGENTS, SessionManager } from "../src/SessionManager.ts";
import { makeSessionPushBusHandle } from "../src/services/pushBus.ts";
import type { ChildRunOptions, ManagedSessionRuntime } from "../src/services/sessionManager.ts";
import { SubagentRunStore } from "../src/subagentRunStore.ts";

/**
 * A4 spawn bookkeeping on a real ManagedSession with a scripted child runtime: each
 * child commits its run (onAccepted) when the test says so and ends when the test
 * says so, or rejects when its delegation signal aborts.
 */
function harness() {
  const runtime = ManagedRuntime.make(Layer.empty) as unknown as ServerRuntime;
  const scope = Effect.runSync(Scope.make());
  const state = { eligible: false, parked: 0 };
  const children: {
    options: ChildRunOptions;
    accept: () => void;
    finish: () => void;
  }[] = [];
  const parentId = randomUUID();
  const rt = {
    meta: { id: parentId, cwd: process.cwd(), createdAt: new Date().toISOString() },
    bus: Effect.runSync(makeSessionPushBusHandle()),
    parkingEligible: Effect.sync(() => state.eligible),
    expectParking: Effect.void,
    cancelParkingExpectation: Effect.void,
    isRunning: Effect.succeed(true),
    onExit: () => () => {},
    ensureExitHandled: Effect.void,
    abort: Effect.void,
    runChildAgent: (
      _task: string,
      _agent: unknown,
      _policy: unknown,
      _overrides: unknown,
      options: ChildRunOptions,
    ) =>
      Effect.tryPromise(
        () =>
          new Promise((resolve, reject) => {
            const runId = randomUUID();
            options.signal?.addEventListener("abort", () => reject(new Error("aborted")));
            children.push({
              options,
              accept: () => options.onAccepted?.(runId),
              finish: () => resolve({ runId, text: "done" }),
            });
          }),
      ),
  } as unknown as ManagedSessionRuntime;
  const session = new ManagedSession(rt, runtime, scope);
  const manager = new SessionManager(undefined as unknown as ServerRuntime, new ReceiptBus(false));
  const store = new SubagentRunStore(
    mkdtempSync(path.join(tmpdir(), "spawn-subagent-unit-")),
    vi.fn(),
  );
  (manager as unknown as { subagentRuns: SubagentRunStore }).subagentRuns = store;
  (manager as unknown as { sessions: Map<string, ManagedSession> }).sessions.set(parentId, session);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
  return { runtime, session, manager, store, parentId, state, children, settle };
}

describe("SessionManager.spawnSubagent", () => {
  it("cancels a child a Stop catches before its run record is committed", async () => {
    const { session, manager, parentId, children, settle, runtime } = harness();
    const spawning = manager.spawnSubagent(parentId, "task", { detached: true });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    await session.abort();
    expect(children[0]!.options.signal?.aborted).toBe(true);
    await expect(spawning).rejects.toThrow();
    await settle();
    expect(session.launchingSubagents.size).toBe(0);
    expect(session.detachedSubagents).toBe(0);
    await runtime.dispose();
  });

  it("caps detached spawns per parent and answers not_found across sessions", async () => {
    const { manager, store, parentId, children, runtime } = harness();
    const spawns = Array.from({ length: MAX_DETACHED_SUBAGENTS }, () =>
      manager.spawnSubagent(parentId, "task", { detached: true }),
    );
    await expect(manager.spawnSubagent(parentId, "ninth", { detached: true })).rejects.toThrow(
      `at most ${MAX_DETACHED_SUBAGENTS}`,
    );
    await vi.waitFor(() => expect(children).toHaveLength(MAX_DETACHED_SUBAGENTS));
    children.forEach((child) => child.accept());
    await Promise.all(spawns);

    const otherParent = randomUUID();
    const foreign = randomUUID();
    const now = new Date().toISOString();
    store.create({
      id: foreign,
      parentSessionId: otherParent,
      task: "theirs",
      status: "completed",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
      summary: "secret",
    });
    const bridge = new BridgeRegistry();
    registerDeckBridgeTools(bridge, manager);
    const response = await bridge.dispatch(
      {
        tool: "await_subagents",
        params: { runIds: [foreign], timeoutMs: 999_999 },
        sessionId: parentId,
        toolCallId: "await-call",
        token: "t",
      },
      { token: "t" },
    );
    expect(JSON.parse(response.content)).toEqual({
      results: [{ id: foreign, status: "not_found" }],
      timedOut: false,
    });
    const cancel = await bridge.dispatch(
      {
        tool: "cancel_subagent",
        params: { runId: foreign },
        sessionId: parentId,
        toolCallId: "cancel-call",
        token: "t",
      },
      { token: "t" },
    );
    expect(cancel.isError).toBe(true);
    expect(JSON.parse(cancel.content)).toMatchObject({ ok: false });
    children.forEach((child) => child.finish());
    await runtime.dispose();
  });

  it("re-arms idle parking when the last spawned child of an idle parent ends", async () => {
    const { session, manager, parentId, state, children, settle, runtime } = harness();
    session.configureIdleParking(
      10,
      async () => session,
      () => (state.parked += 1),
    );
    const spawned = manager.spawnSubagent(parentId, "task", { detached: true });
    await vi.waitFor(() => expect(children).toHaveLength(1));
    children[0]!.accept();
    const { done } = await spawned;
    // The deadline passes while the child runs: the parent is not eligible.
    await settle();
    expect(state.parked).toBe(0);
    state.eligible = true;
    children[0]!.finish();
    await done;
    await vi.waitFor(() => expect(state.parked).toBe(1), { timeout: 2_000 });
    await runtime.dispose();
  });
});
