import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
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

process.env.AGENT_DECK_TEST = "1";
const home = mkdtempSync(path.join(tmpdir(), "pi-command-home-"));
const project = mkdtempSync(path.join(tmpdir(), "pi-command-project-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "pi-command-data-"));
process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: home });

let mock: MockProviderServer;
let server: AgentDeckServer;
let projectId: string;

function requestText(request: ChatCompletionRequest): string {
  return request.messages
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    )
    .join("\n");
}

async function createSession(agentName?: string, includeProject = true) {
  const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd: project,
      ...(includeProject ? { projectId } : {}),
      agentName,
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
      extensions: [writeMockProviderExtension(mock.baseUrl)],
      env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { session: { id: string } };
  return server.sessions.get(body.session.id)!;
}

async function commandNames(sessionId: string): Promise<string[]> {
  const response = await fetch(`http://127.0.0.1:${server.port}/sessions/${sessionId}/commands`);
  expect(response.status).toBe(200);
  const body = (await response.json()) as { commands: Array<{ name: string }> };
  return body.commands.map((command) => command.name);
}

async function waitForRebind(sessionId: string, generation?: string): Promise<void> {
  try {
    await vi.waitFor(
      () => expect(server.sessions.get(sessionId)?.meta.streamGeneration).not.toBe(generation),
      { timeout: 15_000 },
    );
  } catch {
    const current = server.sessions.get(sessionId);
    throw new Error(
      `command refresh did not rebind: ${JSON.stringify({
        generation,
        currentGeneration: current?.meta.streamGeneration,
        fingerprint: current?.meta.launchResourceFingerprint,
        error: current?.meta.resourceRefreshError,
        status: current?.snapshot().state.agentStatus,
        parked: current?.isParked,
        hasConfig: Boolean(current?.meta.launchResourceConfig),
      })}`,
    );
  }
}

beforeAll(async () => {
  mock = await startMockProvider({
    reply: () => "command execution streams ordered response words before final idle",
    chunkDelayMs: 25,
  });
  mkdirSync(path.join(home, ".pi", "agent", "agents"), { recursive: true });
  writeFileSync(
    path.join(home, ".pi", "agent", "agents", "no-extensions.md"),
    "---\nname: no-extensions\nextensions: []\n---\n\nNamed parent.\n",
  );
  server = await startServer({ dataDir });
  const projectResponse = await fetch(`http://127.0.0.1:${server.port}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: project }),
  });
  projectId = ((await projectResponse.json()) as { project: { id: string } }).project.id;
  await fetch(`http://127.0.0.1:${server.port}/settings`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      autoTitle: false,
      piAgentIdleParkingEnabled: false,
      extensionLoadingMode: "agentDeckManaged",
    }),
  });
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("app-owned injected commands with real Pi", () => {
  it("executes bundled and imported workflows and rebinds toggles/deletion without buffering", async () => {
    const noProject = await createSession(undefined, false);
    expect(await commandNames(noProject.meta.id)).not.toContain("optimize-agents-md");

    const session = await createSession("no-extensions");
    expect(await commandNames(session.meta.id)).toContain("optimize-agents-md");

    const ordered: string[] = [];
    const unsubscribe = session.bus.subscribe(({ event }) => {
      if (event.type === "cell_delta") ordered.push("delta");
      if (event.type === "cell_final" && event.cell.kind === "assistant") ordered.push("final");
      if (event.type === "agent_status" && event.status === "idle") ordered.push("idle");
    });
    const beforeBundled = mock.requests.length;
    await session.prompt("/optimize-agents-md keep pnpm guidance");
    await server.receipts.waitFor("assistant_final", session.meta.id);
    await server.receipts.waitFor("idle", session.meta.id);
    const bundledRequest = mock.requests.slice(beforeBundled).map(requestText).join("\n");
    expect(bundledRequest).toContain("User guidance for this /optimize-agents-md run:");
    expect(bundledRequest).toContain("keep pnpm guidance");
    expect(ordered.filter((event) => event === "delta").length).toBeGreaterThan(1);
    expect(ordered.lastIndexOf("final")).toBeLessThan(ordered.lastIndexOf("idle"));

    let generation = session.meta.streamGeneration;
    const disabled = await fetch(`http://127.0.0.1:${server.port}/resources/commands/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "built-in:optimize-agents-md", enabled: false }),
    });
    expect(disabled.status).toBe(200);
    await waitForRebind(session.meta.id, generation);
    expect(await commandNames(session.meta.id)).not.toContain("optimize-agents-md");
    await new Promise((resolve) => setTimeout(resolve, 500));

    const source = `export default function (pi) {
  pi.registerCommand("library-proof", {
    description: "Run imported proof workflow",
    handler: async (args, ctx) => {
      await ctx.waitForIdle();
      const guidance = args?.trim();
      pi.sendUserMessage(guidance ? "IMPORTED_COMMAND_PROOF: " + guidance : "IMPORTED_COMMAND_PROOF");
    },
  });
}\n`;
    const importedResponse = await fetch(
      `http://127.0.0.1:${server.port}/resources/commands/import`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fileName: "library-proof.ts", content: source }),
      },
    );
    expect(importedResponse.status).toBe(201);
    const imported = (await importedResponse.json()) as {
      command: { id: string; status: string; path?: unknown; fileName?: unknown };
    };
    expect(imported.command.status).toBe("disabled");
    expect(imported.command.path).toBeUndefined();
    expect(imported.command.fileName).toBeUndefined();
    expect(await commandNames(session.meta.id)).not.toContain("library-proof");
    // Let the disabled import's no-op refresh settle before the enable mutation;
    // this test measures each route signal rather than deliberately racing two.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const enabled = await fetch(`http://127.0.0.1:${server.port}/resources/commands/toggle`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: imported.command.id, enabled: true }),
    });
    expect(enabled.status).toBe(200);
    const enabledCatalog = (await (
      await fetch(`http://127.0.0.1:${server.port}/resources/commands`)
    ).json()) as { commands: Array<{ id: string; status: string }> };
    expect(
      enabledCatalog.commands.find((command) => command.id === imported.command.id)?.status,
    ).toBe("enabled");
    const importedSession = await createSession("no-extensions");
    expect(await commandNames(importedSession.meta.id)).toContain("library-proof");

    const beforeImported = mock.requests.length;
    await importedSession.prompt("/library-proof live arguments");
    await server.receipts.waitFor("assistant_final", importedSession.meta.id);
    await server.receipts.waitFor("idle", importedSession.meta.id);
    expect(mock.requests.slice(beforeImported).map(requestText).join("\n")).toContain(
      "IMPORTED_COMMAND_PROOF: live arguments",
    );

    generation = importedSession.meta.streamGeneration;
    const deleted = await fetch(`http://127.0.0.1:${server.port}/resources/commands`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: imported.command.id }),
    });
    expect(deleted.status).toBe(200);
    await waitForRebind(importedSession.meta.id, generation);
    expect(await commandNames(importedSession.meta.id)).not.toContain("library-proof");
    const catalog = (await (
      await fetch(`http://127.0.0.1:${server.port}/resources/commands`)
    ).json()) as { commands: Array<{ id: string }> };
    expect(catalog.commands.some((command) => command.id === imported.command.id)).toBe(false);
    unsubscribe();
  }, 90_000);
});
