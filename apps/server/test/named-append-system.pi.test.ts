import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const root = mkdtempSync(path.join(tmpdir(), "named-append-pi-"));
const home = path.join(root, "home");
const project = path.join(root, "project");
const globalMarker = "NAMED_GLOBAL_APPEND_MARKER";
const projectMarker = "NAMED_PROJECT_APPEND_MARKER";
let mock: MockProviderServer;
let server: AgentDeckServer;
let projectId: string;
let extension: string;

function systemText(request: ChatCompletionRequest): string {
  return request.messages
    .filter((message) => message.role === "system" || message.role === "developer")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    )
    .join("\n");
}

beforeAll(async () => {
  vi.stubEnv("AGENT_DECK_TEST", "1");
  vi.stubEnv(
    "AGENT_DECK_PI_ENV",
    JSON.stringify({ HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" }),
  );
  const agentsDir = path.join(home, ".pi", "agent", "agents");
  mkdirSync(agentsDir, { recursive: true });
  mkdirSync(path.join(project, ".pi"), { recursive: true });
  writeFileSync(path.join(home, ".pi", "agent", "APPEND_SYSTEM.md"), globalMarker);
  for (const mode of ["replace", "append"]) {
    writeFileSync(
      path.join(agentsDir, `${mode}-bot.md`),
      `---\nname: ${mode}-bot\nsystemPromptMode: ${mode}\ntools: []\n---\n\nNAMED_PERSONA_${mode}\n`,
    );
  }
  mock = await startMockProvider({ reply: () => "ok" });
  extension = writeMockProviderExtension(mock.baseUrl);
  server = await startServer({ dataDir: path.join(root, "data") });
  const response = await server.fastify.inject({
    method: "POST",
    url: "/projects",
    payload: { path: project },
  });
  expect(response.statusCode).toBe(201);
  projectId = response.json().project.id;
});

afterAll(async () => {
  await server?.close();
  await mock?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

describe("named 1:1 APPEND_SYSTEM prompt inspection with pinned Pi", () => {
  it.each([
    ["replace", true],
    ["append", true],
    ["replace", false],
    ["append", false],
  ] as const)("preserves precedence exactly once in %s mode (memory=%s)", async (mode, memory) => {
    const settings = await server.fastify.inject({
      method: "PATCH",
      url: "/settings",
      payload: { agentMemoryEnabled: memory },
    });
    expect(settings.statusCode).toBe(200);
    for (const scope of ["project", "global", "none"] as const) {
      const projectAppend = path.join(project, ".pi", "APPEND_SYSTEM.md");
      const globalAppend = path.join(home, ".pi", "agent", "APPEND_SYSTEM.md");
      writeFileSync(globalAppend, globalMarker);
      if (scope === "project") writeFileSync(projectAppend, projectMarker);
      else rmSync(projectAppend, { force: true });
      if (scope === "none") rmSync(globalAppend);
      const response = await server.fastify.inject({
        method: "POST",
        url: "/sessions",
        payload: {
          projectId,
          agentName: `${mode}-bot`,
          provider: MOCK_PROVIDER_ID,
          model: MOCK_MODEL_ID,
          extensions: [extension],
        },
      });
      expect(response.statusCode).toBe(201);
      const id = response.json().session.id as string;
      try {
        const session = server.sessions.get(id)!;
        const start = mock.requests.length;
        const prompt = `inspect-${mode}-${memory}-${scope}`;
        await session.prompt(prompt);
        await server.receipts.waitFor("idle", id);
        const request = mock.requests
          .slice(start)
          .find((item) => JSON.stringify(item.messages).includes(prompt));
        expect(request).toBeDefined();
        const text = systemText(request!);
        expect(text.split(`NAMED_PERSONA_${mode}`).length - 1).toBe(1);
        expect(text.split(projectMarker).length - 1).toBe(scope === "project" ? 1 : 0);
        expect(text.split(globalMarker).length - 1).toBe(scope === "global" ? 1 : 0);
      } finally {
        await server.sessions.destroy(id);
      }
    }
  });
});
