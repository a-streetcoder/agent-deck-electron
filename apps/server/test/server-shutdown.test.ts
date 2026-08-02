import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import { WebSocket } from "ws";
import { describe, expect, it, vi } from "vitest";
import { startServer } from "../src/index.ts";
import type { ManagedSession } from "../src/SessionManager.ts";

process.env.AGENT_DECK_TEST = "1";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe("server shutdown admission", () => {
  it("drains an admitted resume, rejects later creation, and stops the published session", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "server-shutdown-data-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "server-shutdown-cwd-"));
    const id = randomUUID();
    const now = new Date().toISOString();
    const meta: SessionMeta = {
      id,
      cwd,
      createdAt: now,
      updatedAt: now,
      endedAt: now,
    };
    writeFileSync(path.join(dataDir, "sessions.json"), JSON.stringify([meta]));

    const server = await startServer({ dataDir });
    const resumeEntered = deferred();
    const releaseResume = deferred();
    const stopEntered = deferred();
    const releaseStop = deferred();
    const stop = vi.fn(async () => {
      stopEntered.resolve();
      await releaseStop.promise;
    });
    const resumedSession = {
      meta: { ...meta, endedAt: undefined },
      stop,
    } as unknown as ManagedSession;
    // The production resume path inserts the session before resolving. This
    // deterministic fake models that publication point without spawning Pi.
    const ownedSessions = (server.sessions as unknown as { sessions: Map<string, ManagedSession> })
      .sessions;
    vi.spyOn(server.sessions, "resume").mockImplementation(async () => {
      resumeEntered.resolve();
      await releaseResume.promise;
      ownedSessions.set(id, resumedSession);
      return resumedSession;
    });

    const resumeRequest = fetch(`http://127.0.0.1:${server.port}/sessions/${id}/resume`, {
      method: "POST",
    });
    await resumeEntered.promise;

    let closeSettled = false;
    const close = server.close();
    void close.then(
      () => {
        closeSettled = true;
      },
      () => {
        closeSettled = true;
      },
    );
    const rejected = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    expect(rejected.status).toBe(503);
    await expect(rejected.json()).resolves.toEqual({
      code: "server_shutting_down",
      error: "Agent Deck server is shutting down.",
    });
    expect(closeSettled).toBe(false);

    releaseResume.resolve();
    expect((await resumeRequest).status).toBe(200);
    await stopEntered.promise;
    expect(stop).toHaveBeenCalledOnce();
    expect(closeSettled).toBe(false);

    releaseStop.resolve();
    await close;
    expect(ownedSessions.size).toBe(0);

    // Keep `server` referenced while proving both native roots can be removed
    // immediately after close (the Windows EBUSY regression boundary).
    rmSync(path.join(dataDir, "session-worktrees"), { recursive: true });
    rmSync(path.join(dataDir, "Subagent Runs"), { recursive: true });
    rmSync(dataDir, { recursive: true });
    rmSync(cwd, { recursive: true });
  });

  it("closes WebSocket admission, drains a dispatched publication, and stops it in a second pass", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "server-ws-shutdown-data-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "server-ws-shutdown-cwd-"));
    const server = await startServer({ dataDir });
    const ownedSessions = (server.sessions as unknown as { sessions: Map<string, ManagedSession> })
      .sessions;
    const promptEntered = deferred();
    const releasePrompt = deferred();
    const lateStopEntered = deferred();
    const releaseLateStop = deferred();
    const initialId = randomUUID();
    const lateId = randomUUID();
    const initialStop = vi.fn(async () => {});
    const lateStop = vi.fn(async () => {
      lateStopEntered.resolve();
      await releaseLateStop.promise;
    });
    const lateSession = {
      meta: { id: lateId, cwd, createdAt: new Date().toISOString() },
      stop: lateStop,
    } as unknown as ManagedSession;
    const prompt = vi.fn(async () => {
      promptEntered.resolve();
      await releasePrompt.promise;
      ownedSessions.set(lateId, lateSession);
    });
    const initialSession = {
      meta: { id: initialId, cwd, createdAt: new Date().toISOString() },
      prompt,
      stop: initialStop,
    } as unknown as ManagedSession;
    ownedSessions.set(initialId, initialSession);
    const stopAll = vi.spyOn(server.sessions, "stopAll");

    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(
      JSON.stringify({
        id: 1,
        request: { type: "prompt", sessionId: initialId, message: "publish after shutdown" },
      }),
    );
    await promptEntered.promise;

    const socketClosed = new Promise<number>((resolve) =>
      socket.once("close", (code) => resolve(code)),
    );
    const close = server.close();
    // A frame sent after close() synchronously flips admission must not dispatch.
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(
        JSON.stringify({
          id: 2,
          request: { type: "prompt", sessionId: initialId, message: "late" },
        }),
      );
    }
    expect(await socketClosed).toBe(1012);

    const lateUpgrade = new WebSocket(`ws://127.0.0.1:${server.port}/rpc`);
    await new Promise<void>((resolve) => {
      lateUpgrade.once("error", () => resolve());
      lateUpgrade.once("close", () => resolve());
    });
    expect(prompt).toHaveBeenCalledOnce();

    while (stopAll.mock.calls.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    await (stopAll.mock.results[0]!.value as Promise<void>);
    expect(initialStop).toHaveBeenCalledOnce();

    releasePrompt.resolve();
    await lateStopEntered.promise;
    expect(stopAll).toHaveBeenCalledTimes(2);
    expect(lateStop).toHaveBeenCalledOnce();

    let closeSettled = false;
    void close.then(() => {
      closeSettled = true;
    });
    expect(closeSettled).toBe(false);
    releaseLateStop.resolve();
    await close;
    expect(server.close()).toBe(close);
    expect(ownedSessions.size).toBe(0);

    rmSync(path.join(dataDir, "session-worktrees"), { recursive: true });
    rmSync(path.join(dataDir, "Subagent Runs"), { recursive: true });
    rmSync(dataDir, { recursive: true });
    rmSync(cwd, { recursive: true });
  });
});
