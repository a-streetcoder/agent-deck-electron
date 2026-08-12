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

let bridge: Server;
let mock: MockProviderServer;
let session: PiSession;
let auditBody: Record<string, unknown> | undefined;
let auditAbortedAt = 0;
const cwd = mkdtempSync(path.join(tmpdir(), "pi-prompt-audit-timeout-"));
const home = mkdtempSync(path.join(tmpdir(), "pi-prompt-audit-timeout-home-"));

beforeAll(async () => {
  bridge = createServer((request) => {
    let raw = "";
    request.on("data", (chunk) => (raw += chunk));
    request.on("end", () => {
      auditBody = JSON.parse(raw) as Record<string, unknown>;
      // Deliberately never respond. The generated extension must abort its own
      // loopback request and continue to the provider within the bounded wait.
    });
    request.on("aborted", () => (auditAbortedAt = Date.now()));
    request.on("close", () => {
      if (!request.complete) auditAbortedAt = Date.now();
    });
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const endpoint = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}/bridge`;
  mock = await startMockProvider({ reply: () => "continued after audit timeout" });
  const bridgeExtension = writeBridgeExtension({
    endpoint,
    sessionId: "timeout-session",
    token: "timeout-token",
    tools: [],
    promptAudit: true,
  });
  session = new PiSession({
    binPath: resolvePiBinary().path,
    args: buildLaunchArgs({
      kind: "parent",
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
      extensions: [writeMockProviderExtension(mock.baseUrl), bridgeExtension],
    }),
    cwd,
    env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
    requestTimeoutMs: 15_000,
  });
  session.start();
});

afterAll(async () => {
  await session.stop();
  await mock.close();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

describe("generated prompt audit timeout", () => {
  it("sends sequence one and lets Pi continue after the bounded loopback failure", async () => {
    const startedAt = Date.now();
    await session.prompt("continue even if audit storage is unavailable");
    const deadline = startedAt + 8_000;
    while (mock.requests.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const providerAt = Date.now();
    expect(mock.requests).toHaveLength(1);
    expect(providerAt - startedAt).toBeGreaterThanOrEqual(1_700);
    expect(providerAt - startedAt).toBeLessThan(4_500);
    expect(auditBody).toMatchObject({
      sessionId: "timeout-session",
      tool: "__prompt_audit__",
      params: { sequence: 1 },
    });
    // No unhandled rejection or wedged handler: the provider request happened;
    // transport cancellation is best-effort across Node HTTP implementations.
    expect(auditAbortedAt === 0 || auditAbortedAt <= providerAt + 500).toBe(true);
  });
});
