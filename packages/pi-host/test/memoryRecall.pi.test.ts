import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeBridgeExtension } from "../src/bridge.ts";
import { buildLaunchArgs } from "../src/launchPlan.ts";
import { PiSession } from "../src/PiSession.ts";
import { resolvePiBinary } from "../src/resolve.ts";

let mock: MockProviderServer;
let bridge: Server;
let session: PiSession;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-memory-recall-"));

beforeAll(async () => {
  bridge = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          content: "<recalled_memories>OAuth callback body</recalled_memories>",
          recalled: [{ id: "decision-oauth", title: "OAuth callback", type: "decision" }],
        }),
      );
    });
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  mock = await startMockProvider({ reply: () => "done" });
  const extension = writeBridgeExtension({
    endpoint: `http://127.0.0.1:${(bridge.address() as AddressInfo).port}/bridge`,
    sessionId: "recall-session",
    token: "token",
    tools: [],
    recall: true,
  });
  session = new PiSession({
    binPath: resolvePiBinary().path,
    args: buildLaunchArgs({
      kind: "parent",
      extensions: [writeMockProviderExtension(mock.baseUrl), extension],
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
    }),
    cwd,
    env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
    requestTimeoutMs: 45_000,
  });
  session.start();
});

afterAll(async () => {
  await session.stop();
  await mock.close();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

describe("real Pi memory recall entry", () => {
  it("persists the custom entry in active order and injects the recall once", async () => {
    const idle = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(session.stderr)), 50_000);
      session.on("event", (event) => {
        if (event.type === "agent_end") {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await session.prompt("How is OAuth handled?");
    await idle;

    const { entries } = await session.getEntries();
    const userIndex = entries.findIndex(
      (entry) => entry.type === "message" && entry.message.role === "user",
    );
    const recallEntries = entries.filter(
      (entry) => entry.type === "custom" && entry.customType === "agent-deck.memory-recall",
    );
    const recallIndex = entries.indexOf(recallEntries[0]!);
    const assistantIndex = entries.findIndex(
      (entry) => entry.type === "message" && entry.message.role === "assistant",
    );
    expect(recallEntries).toHaveLength(1);
    expect(userIndex).toBeGreaterThanOrEqual(0);
    expect(recallIndex).toBeGreaterThan(userIndex);
    expect(assistantIndex).toBeGreaterThan(recallIndex);
    const recall = entries[recallIndex];
    expect(recall).toMatchObject({
      type: "custom",
      data: {
        version: 1,
        memories: [{ id: "decision-oauth", title: "OAuth callback", type: "decision" }],
      },
    });
    expect(JSON.stringify(recall)).not.toMatch(/OAuth callback body|query|projectId|path/);

    const providerPayload = JSON.stringify(mock.requests[0]);
    expect(providerPayload.match(/<recalled_memories>/g)).toHaveLength(1);
  });
});
