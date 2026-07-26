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
const home = mkdtempSync(path.join(tmpdir(), "ask-user-home-"));
const cwd = mkdtempSync(path.join(tmpdir(), "ask-user-cwd-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "ask-user-data-"));

beforeAll(async () => {
  mock = await startMockProvider({
    toolCall: (lastUser, body) => {
      if (body.messages.some((message) => message.role === "tool")) return null;
      return {
        name: "ask_user",
        arguments: {
          question: `Decision for ${lastUser}`,
          options: [{ title: "Ship", description: "Proceed now" }, "Wait"],
          allowComment: true,
          ...(lastUser.includes("timeout") ? { timeout: 1 } : {}),
        },
      };
    },
    reply: () => "Decision received and handled.",
  });
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
  await mock.close();
});

async function createSession() {
  const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd,
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
      extensions: [writeMockProviderExtension(mock.baseUrl)],
      env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
    }),
  });
  expect(response.status).toBe(201);
  const { session } = (await response.json()) as { session: { id: string } };
  return server.sessions.get(session.id)!;
}

async function pendingAsk(session: Awaited<ReturnType<typeof createSession>>) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const cell = session.snapshot().state.cells.find((candidate) => candidate.kind === "ask_user");
    if (cell?.kind === "ask_user") return cell;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("ask_user cell did not open");
}

describe("real Pi parent ask_user bridge", () => {
  it("returns answer and cancel as structured non-error tool results", async () => {
    for (const action of ["answer", "cancel"] as const) {
      const session = await createSession();
      await session.prompt(action);
      const cell = await pendingAsk(session);
      const response = await fetch(
        `http://127.0.0.1:${server.port}/sessions/${session.meta.id}/asks/${cell.requestId}/${action}`,
        {
          method: "POST",
          ...(action === "answer"
            ? {
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ selections: ["Ship"], comment: "Approved" }),
              }
            : {}),
        },
      );
      expect(response.status).toBe(200);
      await server.receipts.waitFor("idle", session.meta.id);
      const toolPayload = JSON.stringify(mock.requests.at(-1)?.messages ?? []);
      expect(toolPayload).toContain(action === "answer" ? "answered" : "cancelled");
    }
  });

  it("returns timeout as structured non-error and closes the audit card", async () => {
    const session = await createSession();
    await session.prompt("timeout");
    const cell = await pendingAsk(session);
    await server.receipts.waitFor("idle", session.meta.id, 5_000);
    const resolved = session.snapshot().state.cells.find((candidate) => candidate.id === cell.id);
    expect(resolved).toMatchObject({ kind: "ask_user", status: "timed_out" });
    expect(JSON.stringify(mock.requests.at(-1)?.messages ?? [])).toContain("timed_out");
  });
});
