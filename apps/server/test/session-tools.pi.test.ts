import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

// SRV-15c against real Pi: an agent lists the server's sessions and reads one a
// co-worker owns; the summary names the owner, the turn's final answer head and
// the Pi file refs to read more.
process.env.AGENT_DECK_TEST = "1";
const PROMPT = "look at what my co-workers are doing";
const OTHER = randomUUID();

let mock: MockProviderServer;
let server: AgentDeckServer;
const home = mkdtempSync(path.join(tmpdir(), "pi-home-session-tools-"));
const cwd = mkdtempSync(path.join(tmpdir(), "pi-session-tools-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "deck-session-tools-"));
const otherFile = path.join(dataDir, "andrea-session.jsonl");
const results: string[] = [];

const text = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? (content as { text?: string }[]).map((part) => part.text ?? "").join("")
      : JSON.stringify(content);
const toolTexts = (body: ChatCompletionRequest): string[] =>
  body.messages.filter((message) => message.role === "tool").map((m) => text(m.content));

async function waitUntil(predicate: () => boolean, what: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  if (!predicate()) throw new Error(`timed out waiting for ${what}`);
}

beforeAll(async () => {
  // Andrea's ended session: an index row and the Pi file it points at.
  const now = new Date().toISOString();
  const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
  writeFileSync(
    otherFile,
    [
      line({ type: "session", version: 3, id: "andrea", timestamp: now, cwd }),
      line({
        type: "message",
        id: "u1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "Refactor the billing module" }] },
      }),
      line({
        type: "message",
        id: "a1",
        parentId: "u1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "BILLING_DONE: split into three files." }],
        },
      }),
    ].join("\n"),
  );
  writeFileSync(
    path.join(dataDir, "sessions.json"),
    JSON.stringify([
      {
        id: OTHER,
        cwd,
        createdAt: now,
        updatedAt: now,
        endedAt: now,
        title: "Billing refactor",
        piSessionFile: otherFile,
        createdBy: { id: "andrea@example.com", name: "Andrea" },
      },
    ]),
  );
  mock = await startMockProvider({
    toolCall: (lastUser, body) => {
      if (lastUser !== PROMPT) return null;
      const seen = toolTexts(body);
      if (body.messages.at(-1)?.role === "tool") results.splice(0, results.length, ...seen);
      switch (seen.length) {
        case 0:
          return { name: "list_sessions", arguments: { member: "Andrea" } };
        case 1:
          return { name: "read_session", arguments: { sessionId: OTHER } };
        default:
          return null;
      }
    },
    reply: () => "Looked.",
  });
  process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({
    HOME: home,
    USERPROFILE: home,
    PI_SKIP_VERSION_CHECK: "1",
  });
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("list_sessions and read_session real-Pi", () => {
  it("an agent lists a co-worker's session and reads its summary with refs", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        startImmediately: true,
        cwd,
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
        env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
      }),
    });
    const { session } = (await response.json()) as { session: { id: string } };
    await server.sessions.get(session.id)!.prompt(PROMPT);
    await waitUntil(() => results.length === 2, "both tool results");
    await server.receipts.waitFor("idle", session.id);

    const [listed, read] = results as [string, string];
    expect(listed).toContain(`- session: ${OTHER}`);
    expect(listed).toContain('owner: "Andrea" <andrea@example.com>');
    expect(listed).toContain('title: "Billing refactor"');
    // The member filter leaves the caller's own (ownerless) session out.
    expect(listed).not.toContain(session.id);

    expect(read).toContain(`Session ${OTHER}.`);
    expect(read).toContain('owner: "Andrea" <andrea@example.com>');
    expect(read).toContain("status: idle");
    expect(read).toMatch(/uptoSeq: \d+/);
    expect(read).toContain('"Refactor the billing module"');
    expect(read).toContain(
      'final assistant message (head): "BILLING_DONE: split into three files."',
    );
    expect(read).toContain(`read more: Pi session file ${JSON.stringify(otherFile)}`);
    expect(read).toContain("refs: entries u1..a1 (2), final message a1");
  });
});
