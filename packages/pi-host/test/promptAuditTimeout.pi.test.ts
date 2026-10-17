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
import { parseBridgeUiRequest, writeBridgeExtension } from "../src/bridge.ts";
import { buildLaunchArgs } from "../src/launchPlan.ts";
import { PiSession } from "../src/PiSession.ts";
import { resolvePiBinary } from "../src/resolve.ts";

let mock: MockProviderServer;
let session: PiSession;
let auditBody: Record<string, unknown> | undefined;
let auditTimeoutMs: number | undefined;
const cwd = mkdtempSync(path.join(tmpdir(), "pi-prompt-audit-timeout-"));
const home = mkdtempSync(path.join(tmpdir(), "pi-prompt-audit-timeout-home-"));

beforeAll(async () => {
  mock = await startMockProvider({ reply: () => "continued after audit timeout" });
  const bridgeExtension = writeBridgeExtension({
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
  session.on("event", (event) => {
    const request = parseBridgeUiRequest(event);
    if (!request) return;
    // Deliberately never answer. The generated extension bounds its own wait
    // (Pi resolves the dialog at its timeout) and continues to the provider.
    auditBody = request.call as unknown as Record<string, unknown>;
    auditTimeoutMs = request.timeoutMs;
  });
  session.start();
});

afterAll(async () => {
  await session.stop();
  await mock.close();
});

describe("generated prompt audit timeout", () => {
  it("sends sequence one and lets Pi continue after the bounded bridge timeout", async () => {
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
      tool: "__prompt_audit__",
      params: { sequence: 1 },
    });
    expect(auditTimeoutMs).toBe(2000);
  });
});
