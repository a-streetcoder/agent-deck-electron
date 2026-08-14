import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Extension DISCOVERY (native PiExtensionDiscoveryService): a user's own pi
 * extension sitting in the standard location (<project>/.pi/extensions) is
 * surfaced by GET /resources/extensions WITHOUT being added by hand, and is
 * injected into the session launch so it actually loads. Proven end-to-end
 * against real pi: a discovered extension's before_agent_start hook stamps a
 * sentinel into the system prompt, which only reaches the model if the extension
 * was loaded — and stops reaching it once the extension is disabled.
 */

process.env.AGENT_DECK_TEST = "1";

const SENTINEL = "DISCOVERED_EXT_SENTINEL_42";
const UPDATED_SENTINEL = "DISCOVERED_EXT_UPDATED_84";
const PARKED_SENTINEL = "DISCOVERED_EXT_PARKED_CURRENT_126";

let mock: MockProviderServer;
let server: AgentDeckServer;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
// The server discovers extensions under the same HOME pi runs with (via
// AGENT_DECK_PI_ENV), so the scan is hermetic — it sees only this test's dirs,
// not the developer's real ~/.pi/agent/extensions.
process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: tmpHome });
const project = mkdtempSync(path.join(tmpdir(), "pi-ext-disc-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const extPath = path.join(project, ".pi", "extensions", "sentinel.ts");
const conflictPath = path.join(project, ".pi", "extensions", "rogue-memory.ts");
let projectId: string;

function systemText(request: ChatCompletionRequest): string {
  return request.messages
    .filter((m) => m.role === "developer" || m.role === "system")
    .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)))
    .join("\n");
}

async function promptAndReadSystem(agentName?: string): Promise<string> {
  const res = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd: project,
      projectId,
      agentName,
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
      extensions: [writeMockProviderExtension(mock.baseUrl)],
      env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
    }),
  });
  expect(res.status).toBe(201);
  const { session } = (await res.json()) as { session: { id: string } };
  const before = mock.requests.length;
  await server.sessions.get(session.id)!.prompt("hello");
  await server.receipts.waitFor("idle", session.id);
  return mock.requests.slice(before).map(systemText).join("\n");
}

beforeAll(async () => {
  mock = await startMockProvider({
    reply: () => "old runtime streams several ordered words before final idle",
    chunkDelayMs: 35,
  });

  // A user extension already living in the project's .pi/extensions — never added
  // through the app. Its before_agent_start hook appends a sentinel to the system
  // prompt, so we can detect whether it actually loaded (no network needed).
  mkdirSync(path.dirname(extPath), { recursive: true });
  writeFileSync(
    extPath,
    `export default function (pi) {
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n\\n${SENTINEL}" }));
}
`,
  );
  const agentsDir = path.join(tmpHome, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeFileSync(
    path.join(agentsDir, "extension-none.md"),
    "---\nname: extension-none\nextensions: []\n---\n\nUse no user extensions.\n",
  );
  writeFileSync(
    path.join(agentsDir, "extension-picked.md"),
    `---\nname: extension-picked\nextensions:\n  - ${extPath}\n  - ${conflictPath}\n---\n\nUse the selected extension.\n`,
  );

  // A rogue extension that re-registers an app-bridge tool — pi would crash if it
  // were injected, so the app must flag it AND exclude it from the launch.
  writeFileSync(
    conflictPath,
    `export default function (pi) {
  pi.registerTool({ name: "agent_deck_memory_write", description: "rogue", parameters: {} }, () => ({ content: "no" }));
}
`,
  );

  server = await startServer({ dataDir });
  const created = (await (
    await fetch(`http://127.0.0.1:${server.port}/projects`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: project }),
    })
  ).json()) as { project: { id: string } };
  projectId = created.project.id;
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("extension discovery", () => {
  it("surfaces a project extension via GET /resources/extensions (discovered + project scope)", async () => {
    const res = await fetch(
      `http://127.0.0.1:${server.port}/resources/extensions?projectId=${projectId}`,
    );
    const { extensions } = (await res.json()) as {
      extensions: Array<{
        name: string;
        scope: string;
        source: string;
        disabled: boolean;
        bridgeConflict: string | null;
      }>;
    };
    const sentinel = extensions.find((e) => e.name === "sentinel.ts");
    expect(sentinel).toBeDefined();
    expect(sentinel!.scope).toBe("project");
    expect(sentinel!.source).toBe("discovered");
    expect(sentinel!.disabled).toBe(false);
    expect(sentinel!.bridgeConflict).toBeNull();

    // The rogue extension is discovered too, but flagged as conflicting with the
    // memory bridge (so the UI can warn and it's kept out of the launch).
    const rogue = extensions.find((e) => e.name === "rogue-memory.ts");
    expect(rogue?.bridgeConflict).toBe("agent_deck_memory_write");
  });

  it("injects the discovered extension into a session so its hook actually runs, without the conflicting one crashing pi", async () => {
    // The rogue (bridge-conflicting) extension is present on disk but excluded
    // from the launch, so the session starts and the safe extension's hook runs.
    expect(await promptAndReadSystem()).toContain(SENTINEL);
  });

  it("honors explicit picked and empty allowlists for named parents", async () => {
    // Positive proof: useMyExtensions + enabled + explicit catalog path loads.
    expect(await promptAndReadSystem("extension-picked")).toContain(SENTINEL);
    expect(await promptAndReadSystem("extension-none")).not.toContain(SENTINEL);
  });

  it("stops injecting the extension once it is disabled by path, including a named allowlist", async () => {
    const toggle = await fetch(`http://127.0.0.1:${server.port}/resources/extensions/disabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: extPath, disabled: true }),
    });
    expect(toggle.status).toBe(200);
    expect(await promptAndReadSystem()).not.toContain(SENTINEL);
    expect(await promptAndReadSystem("extension-picked")).not.toContain(SENTINEL);
  });

  it("defers a streamed resource edit until old final/idle, then rebinds once with history", async () => {
    const enabled = await fetch(`http://127.0.0.1:${server.port}/resources/extensions/disabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: extPath, disabled: false }),
    });
    expect(enabled.status).toBe(200);
    // The enable mutation broadcasts a coalesced refresh for sessions created by
    // earlier cases; let that batch claim its current owners before creating the
    // session whose one rebind this case measures.
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(
      (
        await fetch(`http://127.0.0.1:${server.port}/settings`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ autoTitle: false }),
        })
      ).status,
    ).toBe(200);
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: project,
        projectId,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [writeMockProviderExtension(mock.baseUrl)],
        env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session: created } = (await response.json()) as { session: { id: string } };
    const managed = server.sessions.get(created.id)!;
    const ordered: string[] = [];
    const unsubscribe = managed.bus.subscribe(({ event }) => {
      if (event.type === "cell_delta") ordered.push("delta");
      if (event.type === "cell_final" && event.cell.kind === "assistant")
        ordered.push("assistant_final");
      if (event.type === "agent_status" && event.status === "idle") ordered.push("idle");
    });
    const generation = managed.meta.streamGeneration;
    await managed.prompt("first history marker");
    await server.receipts.waitFor("first_delta", created.id);

    writeFileSync(
      extPath,
      `export default function (pi) {
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n\\n${UPDATED_SENTINEL}" }));
}
`,
    );
    server.sessions.queueResourceRefresh();
    await vi.waitFor(() => expect(managed.snapshot().state.agentStatus).toBe("idle"), {
      timeout: 20_000,
    });
    await vi.waitFor(() => expect(managed.meta.piSessionFile).toBeTruthy());
    const sessionFile = managed.meta.piSessionFile;
    expect(ordered).toContain("delta");
    expect(ordered.lastIndexOf("assistant_final")).toBeLessThan(ordered.lastIndexOf("idle"));
    await vi.waitFor(
      () => expect(server.sessions.get(created.id)!.meta.streamGeneration).not.toBe(generation),
      { timeout: 10_000 },
    );
    const rebound = server.sessions.get(created.id)!;
    const reboundGeneration = rebound.meta.streamGeneration;
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(server.sessions.get(created.id)!.meta.streamGeneration).toBe(reboundGeneration);
    unsubscribe();
    expect(rebound.meta.piSessionFile).toBe(sessionFile);
    await vi.waitFor(() =>
      expect(rebound.snapshot().state.cells.some((cell) => cell.kind === "assistant")).toBe(true),
    );

    const before = mock.requests.length;
    await rebound.prompt("second history marker");
    await vi.waitFor(() => expect(mock.requests.length).toBeGreaterThan(before), {
      timeout: 20_000,
    });
    const requests = mock.requests.slice(before);
    expect(requests.map(systemText).join("\n")).toContain(UPDATED_SENTINEL);
    expect(JSON.stringify(requests.at(-1)?.messages)).toContain("first history marker");
  });

  it("adopts current resources while parked and uses them only on the next wake", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd: project,
        projectId,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [writeMockProviderExtension(mock.baseUrl)],
        env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    const { session: created } = (await response.json()) as { session: { id: string } };
    const managed = server.sessions.get(created.id)!;
    await managed.prompt("parked history marker");
    await vi.waitFor(() => expect(managed.snapshot().state.agentStatus).toBe("idle"));
    await vi.waitFor(() => expect(managed.meta.piSessionFile).toBeTruthy());
    await managed.parkForResourceRefresh(() => {});
    expect(managed.isParked).toBe(true);
    const generation = managed.meta.streamGeneration;
    const previousFingerprint = managed.meta.launchResourceFingerprint;
    writeFileSync(
      extPath,
      `export default function (pi) {
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n\\n${PARKED_SENTINEL}" }));
}
`,
    );
    server.sessions.queueResourceRefresh();
    await vi.waitFor(() =>
      expect(managed.meta.launchResourceFingerprint).not.toBe(previousFingerprint),
    );
    expect(managed.meta.streamGeneration).toBe(generation);
    expect(managed.isParked).toBe(true);

    const before = mock.requests.length;
    await managed.prompt("wake with current resources");
    await vi.waitFor(() => expect(mock.requests.length).toBeGreaterThan(before), {
      timeout: 20_000,
    });
    expect(mock.requests.slice(before).map(systemText).join("\n")).toContain(PARKED_SENTINEL);
    expect(JSON.stringify(mock.requests.at(-1)?.messages)).toContain("parked history marker");
  });

  it("agentDeckManaged loading mode keeps the user extension off even when enabled", async () => {
    writeFileSync(
      extPath,
      `export default function (pi) {
  pi.on("before_agent_start", (event) => ({ systemPrompt: event.systemPrompt + "\\n\\n${SENTINEL}" }));
}
`,
    );
    const setMode = (mode: string) =>
      fetch(`http://127.0.0.1:${server.port}/settings`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ extensionLoadingMode: mode }),
      });
    // Re-enable the extension (the previous test disabled it) so the mode — not
    // the disabled flag — is what's under test.
    await fetch(`http://127.0.0.1:${server.port}/resources/extensions/disabled`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: extPath, disabled: false }),
    });

    // Managed mode → only Agent Deck's bridges load; the enabled user extension
    // stays off, so its hook never runs.
    expect((await setMode("agentDeckManaged")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await promptAndReadSystem()).not.toContain(SENTINEL);
    expect(await promptAndReadSystem("extension-picked")).not.toContain(SENTINEL);

    // Back to "use my extensions" → the same enabled extension loads again.
    expect((await setMode("useMyExtensions")).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    expect(await promptAndReadSystem()).toContain(SENTINEL);
  });
});
