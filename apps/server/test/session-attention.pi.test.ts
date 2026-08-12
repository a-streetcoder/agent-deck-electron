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
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-attention-pi-"));
const cwd = mkdtempSync(path.join(tmpdir(), "agent-deck-attention-cwd-"));
const home = mkdtempSync(path.join(tmpdir(), "agent-deck-attention-home-"));
let server: AgentDeckServer | undefined;

afterAll(async () => {
  await server?.close();
  rmSync(dataDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error("condition timed out");
}

async function listed(id: string): Promise<SessionMeta> {
  const response = await fetch(`http://127.0.0.1:${server!.port}/sessions`);
  const body = (await response.json()) as { sessions: SessionMeta[] };
  return body.sessions.find((session) => session.id === id)!;
}

describe("real Pi attention turn outcomes", () => {
  it("marks a successful completion but not an explicitly aborted turn", async () => {
    const mock = await startMockProvider({
      reply: () => Array.from({ length: 80 }, (_, index) => `chunk-${index}`).join(" "),
      chunkDelayMs: 40,
    });
    try {
      const extension = writeMockProviderExtension(mock.baseUrl);
      server = await startServer({ dataDir });
      const create = async (): Promise<SessionMeta> => {
        const response = await fetch(`http://127.0.0.1:${server!.port}/sessions`, {
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
        return ((await response.json()) as { session: SessionMeta }).session;
      };
      const prompt = async (id: string, message: string): Promise<WebSocket> => {
        const socket = new WebSocket(`ws://127.0.0.1:${server!.port}/rpc`);
        await new Promise<void>((resolve) => socket.once("open", resolve));
        socket.send(
          JSON.stringify({ id: 1, request: { type: "subscribe_session", sessionId: id } }),
        );
        socket.send(JSON.stringify({ id: 2, request: { type: "prompt", sessionId: id, message } }));
        return socket;
      };

      const successful = await create();
      const successSocket = await prompt(successful.id, "finish this real Pi turn");
      await waitFor(async () => (await listed(successful.id)).needsAttention === true);
      successSocket.close();

      const aborted = await create();
      const abortSocket = await prompt(aborted.id, "stream until explicitly aborted");
      await waitFor(
        async () => server!.sessions.get(aborted.id)?.snapshot().state.agentStatus === "running",
      );
      await waitFor(async () => mock.requests.length >= 2);
      abortSocket.send(
        JSON.stringify({ id: 3, request: { type: "abort", sessionId: aborted.id } }),
      );
      await waitFor(
        async () => server!.sessions.get(aborted.id)?.snapshot().state.agentStatus === "idle",
      );
      expect((await listed(aborted.id)).needsAttention).not.toBe(true);
      abortSocket.close();
    } finally {
      await server?.close();
      server = undefined;
      await mock.close();
    }
  }, 60_000);
});
