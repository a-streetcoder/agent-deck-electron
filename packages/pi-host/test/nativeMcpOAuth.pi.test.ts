import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_OAUTH_TOKEN,
  MOCK_PROVIDER_ID,
  startMockHttpMcpServer,
  startMockProvider,
  writeMockProviderExtension,
  type MockHttpMcpServer,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { createIngestState, ingestPiEvent, type PiInboundEvent } from "@agent-deck/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeBridgeExtension } from "../src/bridge.ts";
import { buildLaunchArgs } from "../src/launchPlan.ts";
import { PiSession } from "../src/PiSession.ts";
import { resolvePiBinary } from "../src/resolve.ts";

/**
 * PI-03d against real Pi: `/mcp login` over an RPC prompt runs Pi's native MCP
 * sign-in headless. Pi sends the authorization URL as a notify and asks for the
 * redirect URL with an input; the test plays the browser (follows /authorize to
 * its 127.0.0.1 redirect without loading it) and pastes that address, as a user
 * on the shared server does. Tokens land in <agentDir>/mcp-auth.json.
 */

interface UiRequest {
  id: string;
  method: string;
  message?: string;
  title?: string;
}

let oauthServer: MockHttpMcpServer;
let mock: MockProviderServer;
let session: PiSession;
let agentDir: string;
const ui: UiRequest[] = [];

const waitFor = async (pick: () => UiRequest | undefined, what: string): Promise<UiRequest> => {
  for (let i = 0; i < 300; i++) {
    const found = pick();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no ${what}; ui: ${JSON.stringify(ui)}; stderr: ${session.stderr}`);
};

beforeAll(async () => {
  oauthServer = await startMockHttpMcpServer({ oauth: true });
  mock = await startMockProvider({ reply: () => "unused" });
  const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
  agentDir = path.join(tmpHome, ".pi", "agent");
  const bridgeExt = writeBridgeExtension({
    endpoint: "http://127.0.0.1:9/unused",
    sessionId: "native-mcp-oauth",
    token: "test-token",
    tools: [],
    nativeMcp: {
      servers: [{ name: "secure", config: { url: oauthServer.url, exposure: "direct" } }],
      blockedTools: [],
    },
  });
  session = new PiSession({
    binPath: resolvePiBinary().path,
    args: buildLaunchArgs({
      kind: "parent",
      extensions: [writeMockProviderExtension(mock.baseUrl), bridgeExt],
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
    }),
    cwd: mkdtempSync(path.join(tmpdir(), "pi-native-mcp-oauth-")),
    env: {
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
    },
    requestTimeoutMs: 45_000,
  });
  session.on("event", (event) => {
    if (event.type === "extension_ui_request") ui.push(event as unknown as UiRequest);
  });
  session.start();
}, 60_000);

afterAll(async () => {
  await session?.stop();
  await mock?.close();
  await oauthServer?.close();
});

describe("native MCP OAuth through /mcp login (paste flow)", () => {
  it("signs in with the pasted redirect URL and stores the token in the agent dir", async () => {
    // Pi answers this prompt only when the command ends (after the paste).
    const login = session.prompt("/mcp login secure");

    const notify = await waitFor(
      () => ui.find((r) => r.method === "notify" && /https?:\/\//.test(r.message ?? "")),
      "sign-in URL notify",
    );
    const authUrl = /https?:\/\/\S+/.exec(notify.message!)![0];
    expect(new URL(authUrl).origin).toBe(new URL(oauthServer.url).origin);
    // Pi's real notify becomes a visible notice cell carrying the link.
    expect(
      ingestPiEvent(createIngestState(), notify as unknown as PiInboundEvent)[0],
    ).toMatchObject({ type: "cell_open", cell: { kind: "notice", message: notify.message } });

    // The "browser": the authorization server redirects to Pi's loopback
    // callback; on the shared server that page never loads, so only its address
    // is taken.
    const redirect = (await fetch(authUrl, { redirect: "manual" })).headers.get("location")!;
    expect(new URL(redirect).hostname).toBe("127.0.0.1");

    const input = await waitFor(() => ui.find((r) => r.method === "input"), "paste input");
    expect(input.title).toContain("paste the URL it was redirected to");
    session.respondToUiRequest({ type: "extension_ui_response", id: input.id, value: redirect });
    await login;

    const done = await waitFor(
      () =>
        ui.find((r) => r.method === "notify" && /Signed in to MCP server/.test(r.message ?? "")),
      "signed-in notify",
    );
    expect(done.message).toContain("(1 tools)");
    const file = path.join(agentDir, "mcp-auth.json");
    expect(readFileSync(file, "utf8")).toContain(MOCK_OAUTH_TOKEN);
    // Mode 0600 is not observable on Windows; the architect checks it on the VM.
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  }, 60_000);
});
