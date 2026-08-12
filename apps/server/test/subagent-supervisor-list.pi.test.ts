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
const cwd = mkdtempSync(path.join(tmpdir(), "pi-supervisor-list-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (_lastUser, body) =>
      body.messages.some((message) => message.role === "tool")
        ? null
        : { name: "list_supervisor_requests", arguments: {} },
    reply: () => "Reviewed pending supervisor requests.",
  });
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
  await mock.close();
});

describe("list_supervisor_requests with pinned real Pi", () => {
  it("calls the parent tool and sends only that parent's pending row to the model", async () => {
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

    server.supervisor.record({
      id: "scoped-pending",
      parentSessionId: session.id,
      cellId: "stable-run-id",
      method: "need_decision",
      message: "Choose the scoped option",
    });
    server.supervisor.record({
      id: "scoped-progress",
      parentSessionId: session.id,
      cellId: "progress-run",
      method: "progress_update",
      message: "Do not list progress",
    });
    server.supervisor.record({
      id: "foreign-pending",
      parentSessionId: "different-parent-session",
      cellId: "foreign-run",
      method: "interview_request",
      message: "Do not cross session boundaries",
    });

    const managed = server.sessions.get(session.id)!;
    await managed.prompt("Review your pending child requests.");
    await server.receipts.waitFor("idle", session.id);

    const followUp = mock.requests.find((request) =>
      request.messages.some((message) => message.role === "tool"),
    );
    expect(followUp).toBeDefined();
    const toolMessage = followUp!.messages.find((message) => message.role === "tool") as
      | { content: string }
      | undefined;
    expect(toolMessage).toBeDefined();
    expect(JSON.parse(toolMessage!.content)).toEqual([
      {
        requestID: "scoped-pending",
        kind: "need_decision",
        title: "Decision needed",
        message: "Choose the scoped option",
        runID: "stable-run-id",
      },
    ]);
  });
});
