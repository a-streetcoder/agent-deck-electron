import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLaunchArgs } from "../src/launchPlan.ts";
import { PiSession, type PiInboundEvent } from "../src/PiSession.ts";
import { resolvePiBinary } from "../src/resolve.ts";

let session: PiSession;
let closeProvider: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const mock = await startMockProvider({
    reply: () => "one two three four five six seven eight nine ten eleven twelve",
    chunkDelayMs: 100,
  });
  closeProvider = mock.close;
  const home = mkdtempSync(path.join(tmpdir(), "pi-queue-home-"));
  session = new PiSession({
    binPath: resolvePiBinary().path,
    args: buildLaunchArgs({
      kind: "parent",
      extensions: [writeMockProviderExtension(mock.baseUrl)],
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
    }),
    cwd: mkdtempSync(path.join(tmpdir(), "pi-queue-cwd-")),
    env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
    requestTimeoutMs: 45_000,
  });
  session.start();
});

afterAll(async () => {
  await session.stop();
  await closeProvider?.();
});

describe("real pinned Pi prompt queues", () => {
  it("preserves queue order and reports additions/removals for prompt streaming behavior", async () => {
    const updates: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];
    const running = new Promise<void>((resolve) => {
      session.on("event", (event) => {
        if ((event as { type?: string }).type === "agent_start") resolve();
      });
    });
    session.on("event", (event: PiInboundEvent) => {
      const queue = event as unknown as {
        type?: string;
        steering?: readonly string[];
        followUp?: readonly string[];
      };
      if (queue.type === "queue_update" && queue.steering && queue.followUp) {
        updates.push({ steering: queue.steering, followUp: queue.followUp });
      }
    });

    await session.prompt("start a long response");
    await running;
    await session.prompt("guide-a", undefined, "steer");
    await session.prompt("guide-a", undefined, "steer");
    await session.prompt("later-b", undefined, "followUp");

    await expect
      .poll(() => updates.some((u) => u.steering.join("|") === "guide-a|guide-a"))
      .toBe(true);
    await expect.poll(() => updates.some((u) => u.followUp.includes("later-b"))).toBe(true);
    await expect
      .poll(() => updates.some((u) => u.steering.length === 0 && u.followUp.length === 0), {
        timeout: 45_000,
      })
      .toBe(true);
  }, 60_000);
});
