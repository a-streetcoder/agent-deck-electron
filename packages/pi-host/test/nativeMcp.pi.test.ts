import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  mockMcpServerLaunch,
  startMockHttpMcpServer,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
  type MockHttpMcpServer,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeBridgeExtension } from "../src/bridge.ts";
import { buildLaunchArgs } from "../src/launchPlan.ts";
import { PiSession } from "../src/PiSession.ts";
import { resolvePiBinary } from "../src/resolve.ts";

/**
 * SPIKE (ade-cdd5, PI-03a go/no-go): Pi's native MCP hosted by the generated
 * bridge extension through createMcpExtension({ loadConfig, updateConfig }),
 * under the production launch flags (--no-extensions plus -e of our files).
 * Proves: mcp__<server>__<tool> names, a stdio and an HTTP call succeed, a
 * tool_call block refuses a call, a tool_result hook keeps a result from the
 * model, and <agentDir>/mcp.json (and project .pi/mcp.json) are not read.
 */

// The pinned pi bin is dist/bundle/cli.js (bundled Node build), so extension
// imports of @earendil-works/pi-coding-agent go through VIRTUAL_MODULES.
const piBundleIndex = realpathSync(
  fileURLToPath(
    new URL(
      "../node_modules/@earendil-works/pi-coding-agent/dist/bundle/index.js",
      import.meta.url,
    ),
  ),
);

const stdio = (name: string, label: string) => {
  const launch = mockMcpServerLaunch(name);
  return {
    name,
    id: `id-${name}`,
    config: {
      command: launch.command,
      args: launch.args,
      env: { AGENT_DECK_MOCK_MCP_LABEL: label },
      exposure: "direct",
    },
  };
};

function toolNames(body: ChatCompletionRequest): string[] {
  const tools = (body.tools ?? []) as Array<{ function?: { name?: string } }>;
  return tools.map((t) => t.function?.name ?? "");
}

function toolMessages(body: ChatCompletionRequest): string {
  return JSON.stringify(body.messages.filter((m) => m.role === "tool"));
}

interface Harness {
  mock: MockProviderServer;
  session: PiSession;
  probeOut: string;
}

let http: MockHttpMcpServer;
// Stands in for Agent Deck's /bridge: allows every __mcp_authorize__, except
// that alpha__x is allowed at tool_call and refused at tool_result.
let bridge: Server;
let bridgeUrl: string;
const authorizeCalls: Array<Record<string, unknown>> = [];

async function launch(
  extraExtensions: string[],
  hostNativeMcp = true,
  endpoint = bridgeUrl,
): Promise<Harness> {
  const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
  const agentDir = path.join(tmpHome, ".pi", "agent");
  const cwd = mkdtempSync(path.join(tmpdir(), "pi-native-mcp-"));
  // Decoys: if Pi read either mcp.json, mcp__decoy__echo would be declared.
  const decoy = JSON.stringify({ mcpServers: { decoy: stdio("decoy", "DECOY").config } });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(path.join(agentDir, "mcp.json"), decoy);
  mkdirSync(path.join(cwd, ".pi"), { recursive: true });
  writeFileSync(path.join(cwd, ".pi", "mcp.json"), decoy);

  const plan = [
    { name: "mcp__alpha__echo", arguments: { message: "one" } },
    { name: "mcp__web__echo", arguments: { message: "two" } },
    { name: "mcp__beta__echo", arguments: { message: "three" } },
    { name: "mcp__gamma__echo", arguments: { message: "four" } },
    { name: "mcp__alpha__x__echo", arguments: { message: "five" } },
  ];
  const mock = await startMockProvider({
    toolCall: (_last, body) => plan[body.messages.filter((m) => m.role === "tool").length] ?? null,
    reply: () => "Done with the MCP tools.",
  });

  // Import-resolution probe: does the bare specifier inside an extension give
  // Pi's own module instance (same function object as Pi's bundle)?
  const probeDir = mkdtempSync(path.join(tmpdir(), "pi-import-probe-"));
  const probeOut = path.join(probeDir, "out.json");
  const probe = path.join(probeDir, "probe.ts");
  writeFileSync(
    probe,
    `import { createMcpExtension } from "@earendil-works/pi-coding-agent";
import { writeFileSync } from "node:fs";
export default function (pi) {
  pi.on("session_start", async () => {
    const own = await import(${JSON.stringify(pathToFileURL(piBundleIndex).href)});
    writeFileSync(${JSON.stringify(probeOut)}, JSON.stringify({
      imported: typeof createMcpExtension,
      sameInstance: own.createMcpExtension === createMcpExtension,
    }));
  });
}
`,
  );

  const bridgeExt = writeBridgeExtension({
    endpoint,
    sessionId: "native-mcp-spike",
    token: "test-token",
    tools: [],
    nativeMcp: hostNativeMcp
      ? {
          servers: [
            stdio("alpha", "ALPHA-OK"),
            stdio("beta", "BETA-RAN"),
            stdio("gamma", "GAMMA-SECRET"),
            // Shares alpha's `mcp__alpha__` prefix: ownership must come from Pi.
            stdio("alpha__x", "ALPHA-X-SECRET"),
            { name: "web", id: "id-web", config: { url: http.url, exposure: "direct" } },
          ],
          blockedTools: ["mcp__beta__echo"],
          suppressedTools: ["mcp__gamma__echo"],
        }
      : undefined,
  });

  const session = new PiSession({
    binPath: resolvePiBinary().path,
    args: buildLaunchArgs({
      kind: "parent",
      extensions: [writeMockProviderExtension(mock.baseUrl), probe, bridgeExt, ...extraExtensions],
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
    }),
    cwd,
    env: {
      HOME: tmpHome,
      USERPROFILE: tmpHome,
      PI_CODING_AGENT_DIR: agentDir,
      PI_SKIP_VERSION_CHECK: "1",
    },
    requestTimeoutMs: 45_000,
  });
  session.start();
  return { mock, session, probeOut };
}

async function runTurn(h: Harness): Promise<void> {
  const idle = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no idle. stderr: ${h.session.stderr}`)),
      55_000,
    );
    h.session.on("event", (piEvent) => {
      if (piEvent.type === "agent_end") {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  await h.session.prompt("use the mcp tools");
  await idle;
}

async function close(h: Harness | undefined): Promise<void> {
  await h?.session.stop();
  await h?.mock.close();
}

beforeAll(async () => {
  http = await startMockHttpMcpServer();
  bridge = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString()));
    req.on("end", () => {
      const call = JSON.parse(body) as { params: { server: string } };
      const refuse =
        call.params.server === "alpha__x" &&
        authorizeCalls.some((c) => (c.params as { server?: string }).server === "alpha__x");
      authorizeCalls.push(call);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(refuse ? { allow: false, reason: "revoked" } : { allow: true }));
    });
  });
  await new Promise<void>((resolve) => bridge.listen(0, "127.0.0.1", resolve));
  const address = bridge.address();
  bridgeUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/bridge`;
});

afterAll(async () => {
  await http.close();
  await new Promise<void>((resolve) => bridge.close(() => resolve()));
});

describe("spike: Pi native MCP inside the generated bridge extension", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await launch([]);
    await runTurn(h);
  }, 70_000);
  afterAll(() => close(h));

  it("declares the listed servers' tools as mcp__<server>__<tool>, and only those", () => {
    const names = toolNames(h.mock.requests[0]!);
    for (const name of [
      "mcp__alpha__echo",
      "mcp__beta__echo",
      "mcp__gamma__echo",
      "mcp__web__echo",
    ]) {
      expect(names.filter((n) => n === name)).toHaveLength(1);
    }
    expect(names.some((n) => n.startsWith("mcp__decoy"))).toBe(false);
  });

  it("completes a stdio and a streamable HTTP call", () => {
    const last = toolMessages(h.mock.requests[h.mock.requests.length - 1]!);
    expect(last).toContain("ALPHA-OK: one");
    expect(last).toContain("mcp http echo: two");
  });

  it("refuses the call blocked in tool_call before the server runs it", () => {
    const last = toolMessages(h.mock.requests[h.mock.requests.length - 1]!);
    expect(last).toContain("Blocked by Agent Deck policy.");
    expect(last).not.toContain("BETA-RAN");
  });

  it("keeps the result suppressed in tool_result away from the model", () => {
    expect(JSON.stringify(h.mock.requests)).not.toContain("GAMMA-SECRET");
    const last = toolMessages(h.mock.requests[h.mock.requests.length - 1]!);
    expect(last).toContain("Result withheld by Agent Deck policy.");
  });

  it("asks the bridge before each unblocked call and on its result (PI-03c)", () => {
    const alpha = authorizeCalls.filter(
      (c) => (c.params as { toolName?: string }).toolName === "mcp__alpha__echo",
    );
    expect(alpha).toHaveLength(2);
    expect(alpha[0]).toMatchObject({
      sessionId: "native-mcp-spike",
      token: "test-token",
      tool: "__mcp_authorize__",
      params: { serverId: "id-alpha", server: "alpha", toolName: "mcp__alpha__echo" },
    });
    // The static block is the fast path: no round trip for beta.
    expect(authorizeCalls.some((c) => (c.params as { server?: string }).server === "beta")).toBe(
      false,
    );
  });

  it("resolves a shared prefix to the right server and withholds a result refused live", () => {
    const owned = authorizeCalls.filter(
      (c) => (c.params as { toolName?: string }).toolName === "mcp__alpha__x__echo",
    );
    expect(owned.map((c) => (c.params as { serverId?: string }).serverId)).toEqual([
      "id-alpha__x",
      "id-alpha__x",
    ]);
    // Allowed at tool_call (it ran), refused at tool_result: never shown.
    expect(JSON.stringify(h.mock.requests)).not.toContain("ALPHA-X-SECRET");
    const last = toolMessages(h.mock.requests[h.mock.requests.length - 1]!);
    expect(last.split("Result withheld by Agent Deck policy.").length - 1).toBe(2);
  });

  it("does not read <agentDir>/mcp.json or the project .pi/mcp.json", () => {
    expect(JSON.stringify(h.mock.requests)).not.toContain("decoy");
  });

  it("resolves the extension import to Pi's own module instance", () => {
    expect(JSON.parse(readFileSync(h.probeOut, "utf8"))).toEqual({
      imported: "function",
      sameInstance: true,
    });
  });
});

describe("fail closed: the bridge cannot be reached", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await launch([], true, "http://127.0.0.1:9/unused");
    await runTurn(h);
  }, 70_000);
  afterAll(() => close(h));

  it("blocks every MCP call before its server runs it", () => {
    const last = toolMessages(h.mock.requests[h.mock.requests.length - 1]!);
    expect(last).toContain("Agent Deck policy check failed");
    for (const ran of ["ALPHA-OK", "mcp http echo", "GAMMA-SECRET", "ALPHA-X-SECRET"]) {
      expect(last).not.toContain(ran);
    }
  });
});

describe("spike: adding -e builtin:mcp next to our extension", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await launch(["builtin:mcp"]);
    await runTurn(h);
  }, 70_000);
  afterAll(() => close(h));

  it("does not double-register: the built-in is replaced, mcp.json stays unread", () => {
    const names = toolNames(h.mock.requests[0]!);
    expect(names.filter((n) => n === "mcp__alpha__echo")).toHaveLength(1);
    expect(JSON.stringify(h.mock.requests)).not.toContain("decoy");
  });
});

describe("control: -e builtin:mcp alone", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await launch(["builtin:mcp"], false);
    await runTurn(h);
  }, 70_000);
  afterAll(() => close(h));

  it("reads <agentDir>/mcp.json, so the decoy assertions above are meaningful", () => {
    expect(toolNames(h.mock.requests[0]!)).toContain("mcp__decoy__echo");
  });
});

describe("control: --no-extensions without our MCP host", () => {
  let h: Harness;
  beforeAll(async () => {
    h = await launch([], false);
    await runTurn(h);
  }, 70_000);
  afterAll(() => close(h));

  it("keeps the built-in MCP off, so nothing is connected", () => {
    expect(toolNames(h.mock.requests[0]!).some((n) => n.startsWith("mcp__"))).toBe(false);
  });
});
