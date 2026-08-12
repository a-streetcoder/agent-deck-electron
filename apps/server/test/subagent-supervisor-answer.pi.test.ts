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
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

let mock: MockProviderServer;
let server: AgentDeckServer;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-supervisor-answer-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (_lastUser, body) =>
      body.messages.some((message) => message.role === "tool")
        ? null
        : {
            name: "answer_supervisor_request",
            arguments: { requestID: "stale-real-pi-request", response: "  approved  " },
          },
    reply: () => "Checked the supervisor answer flow.",
  });
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
  await mock.close();
});

describe("answer_supervisor_request with pinned real Pi", () => {
  it("invokes the parent-only tool and returns the portable stale result", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        cwd,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [writeMockProviderExtension(mock.baseUrl)],
        env: { HOME: tmpHome, USERPROFILE: tmpHome, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    expect(response.status).toBe(201);
    const { session } = (await response.json()) as { session: { id: string } };

    await server.sessions.get(session.id)!.prompt("Answer the pending child request.");
    await server.receipts.waitFor("idle", session.id);

    const followUp = mock.requests.find((request) =>
      request.messages.some((message) => message.role === "tool"),
    );
    expect(followUp).toBeDefined();
    expect(
      JSON.stringify(followUp!.messages.filter((message) => message.role === "tool")),
    ).toContain("No pending supervisor request found for id `stale-real-pi-request`.");
  });
});
