import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
} from "@agent-deck/testkit";
import { WebSocket } from "ws";
import { afterAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-session-failure-pi-"));
const cwd = mkdtempSync(path.join(tmpdir(), "agent-deck-session-failure-cwd-"));
const home = mkdtempSync(path.join(tmpdir(), "agent-deck-session-failure-home-"));
let server: AgentDeckServer | undefined;
let providerFailure = true;

async function sessions(): Promise<SessionMeta[]> {
  const response = await fetch(`http://127.0.0.1:${server!.port}/sessions`);
  return ((await response.json()) as { sessions: SessionMeta[] }).sessions;
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("condition timed out");
}

async function prompt(sessionId: string, message: string): Promise<WebSocket> {
  const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/rpc`);
  await new Promise<void>((resolve) => socket.once("open", resolve));
  socket.send(JSON.stringify({ id: 1, request: { type: "subscribe_session", sessionId } }));
  socket.send(JSON.stringify({ id: 2, request: { type: "prompt", sessionId, message } }));
  return socket;
}

afterAll(async () => {
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

describe("real Pi durable provider failure", () => {
  it("survives server restart and clears after deterministic recovery", async () => {
    const mock = await startMockProvider({
      beforeResponse: () => {
        if (providerFailure) throw new Error("deterministic provider outage");
      },
      reply: () => "provider recovered successfully",
    });
    try {
      const extension = writeMockProviderExtension(mock.baseUrl);
      server = await startServer({ dataDir });
      const createdResponse = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd,
          provider: MOCK_PROVIDER_ID,
          model: MOCK_MODEL_ID,
          extensions: [extension],
          env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
        }),
      });
      expect(createdResponse.status).toBe(201);
      const created = (await createdResponse.json()) as { session: SessionMeta };
      const failedSocket = await prompt(created.session.id, "fail with provider outage");
      await waitFor(async () => (await sessions())[0]?.providerRetries?.[0]?.status === "retrying");
      const retrying = (await sessions())[0]!;
      expect(retrying.status).toBeUndefined();
      expect(retrying.lastError).toBeUndefined();
      expect(
        server.sessions
          .get(created.session.id)!
          .snapshot()
          .state.cells.find((cell) => cell.kind === "provider_retry"),
      ).toMatchObject({ status: "retrying", attempt: 1, maxAttempts: 3, delayMs: 2_000 });

      await waitFor(async () => (await sessions())[0]?.status === "failed");
      const failed = (await sessions())[0]!;
      expect(failed.lastError).toMatch(/500|internal server error/i);
      expect(failed.lastError).not.toContain("undefined");
      expect(failed.lastError).not.toContain("\u001b");
      expect(Array.from(failed.lastError!).length).toBeLessThanOrEqual(2_048);
      // This is a real Pi retry loop, not a synthetic final-output assertion:
      // the deterministic provider sees the initial request plus Pi's retries,
      // and the authoritative live transcript retains one collapsed outcome.
      expect(mock.requests.length).toBeGreaterThanOrEqual(4);
      const liveCells = server.sessions.get(created.session.id)!.snapshot().state.cells;
      const liveRetry = liveCells.filter((cell) => cell.kind === "provider_retry");
      expect(liveRetry).toHaveLength(1);
      expect(
        liveCells.filter((cell) => cell.kind === "assistant" && cell.stopReason === "error"),
      ).toHaveLength(0);
      expect(liveRetry[0]).toMatchObject({
        status: "gave_up",
        attempt: 3,
        maxAttempts: 3,
        collapsedMessageCounts: expect.arrayContaining([2]),
      });
      expect(failed.providerRetries?.[0]).toMatchObject({ status: "gave_up", attempt: 3 });
      failedSocket.close();

      await server.close();
      server = await startServer({ dataDir });
      expect((await sessions())[0]).toMatchObject({
        id: created.session.id,
        status: "failed",
        lastError: failed.lastError,
      });

      providerFailure = false;
      const resume = await fetch(
        `http://127.0.0.1:${server.port}/sessions/${created.session.id}/resume`,
        { method: "POST" },
      );
      expect(resume.status).toBe(200);
      const hydratedCells = server.sessions.get(created.session.id)!.snapshot().state.cells;
      const hydratedRetry = hydratedCells.find((cell) => cell.kind === "provider_retry");
      expect(hydratedRetry).toMatchObject({ status: "gave_up", attempt: 3 });
      expect(
        hydratedCells.filter((cell) => cell.kind === "assistant" && cell.stopReason === "error"),
      ).toHaveLength(0);
      const recoveredSocket = await prompt(created.session.id, "recover now");
      await waitFor(async () => {
        const current = (await sessions())[0];
        return current?.status === undefined && current?.lastError === undefined;
      });
      await waitFor(async () => mock.events.some((event) => event.kind === "done"));
      recoveredSocket.close();
    } finally {
      await server?.close();
      server = undefined;
      await mock.close();
    }
  }, 90_000);
});
