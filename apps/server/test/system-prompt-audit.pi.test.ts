import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { writeMemory, type MemoryStore } from "@agent-deck/memory";
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

process.env.AGENT_DECK_TEST = "1";

const LAUNCH_INSTRUCTION = "AUDIT_LAUNCH_INSTRUCTION: act as the named specialist.";
const REPLY = "one two three four five six seven eight nine ten";
const dataDir = mkdtempSync(path.join(tmpdir(), "prompt-audit-data-"));
const cwd = mkdtempSync(path.join(tmpdir(), "prompt-audit-cwd-"));
const home = mkdtempSync(path.join(tmpdir(), "prompt-audit-home-"));
let mock: MockProviderServer;
let server: AgentDeckServer;

function systemText(request: ChatCompletionRequest): string {
  return request.messages
    .filter((message) => message.role === "developer" || message.role === "system")
    .map((message) =>
      typeof message.content === "string" ? message.content : JSON.stringify(message.content),
    )
    .join("\n");
}

beforeAll(async () => {
  const memory: MemoryStore = { baseDir: path.join(dataDir, "memory"), projectPath: cwd };
  writeMemory(memory, {
    type: "runbook",
    title: "Alpha deployment",
    summary: "alpha deployment release procedure",
    body: "TURN_ALPHA_MEMORY: deploy alpha only after its audit passes.",
  });
  writeMemory(memory, {
    type: "runbook",
    title: "Beta rollback",
    summary: "beta rollback database procedure",
    body: "TURN_BETA_MEMORY: roll beta back with the down migration.",
  });
  mock = await startMockProvider({ reply: () => REPLY, chunkDelayMs: 12 });
  server = await startServer({ dataDir });
});

afterAll(async () => {
  await server.close();
  await mock.close();
});

describe("final system prompt audit against pinned real Pi", () => {
  it("captures the exact post-recall prompt without changing deltas/activity, replaces it next turn, and hydrates after restart", async () => {
    const session = server.sessions.create({
      cwd,
      agentName: "audit-specialist",
      plan: {
        kind: "agent",
        systemPrompt: { mode: "replace", text: LAUNCH_INSTRUCTION },
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
        extensions: [writeMockProviderExtension(mock.baseUrl)],
      },
      env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
    });
    const originalUpdatedAt = session.meta.updatedAt;
    const nonStrict = await fetch(`http://127.0.0.1:${server.port}/bridge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.meta.id,
        token: "forged",
        tool: "__prompt_audit__",
        toolCallId: "forged",
        params: { systemPrompt: "FORGED" },
        unexpected: true,
      }),
    });
    expect(nonStrict.status).toBe(400);

    const forged = await fetch(`http://127.0.0.1:${server.port}/bridge`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sessionId: session.meta.id,
        token: "another-session-or-local-caller-token",
        tool: "__prompt_audit__",
        toolCallId: "forged",
        params: { systemPrompt: "FORGED" },
      }),
    });
    expect(forged.status).toBe(403);
    expect(session.meta.finalSystemPromptAudit).toBeUndefined();

    const events: Array<{ seq: number; event: { type: string; delta?: string } }> = [];
    const unsubscribe = session.bus.subscribe((event) =>
      events.push(event as (typeof events)[number]),
    );

    await session.prompt("explain the alpha deployment procedure");
    const activityAtFirstPrompt = session.meta.updatedAt;
    await server.receipts.waitFor("idle", session.meta.id);
    const firstProviderPrompt = systemText(mock.requests.at(-1)!);
    const firstAudit = session.meta.finalSystemPromptAudit;
    expect(firstAudit?.text).toBe(firstProviderPrompt);
    expect(firstAudit?.text).toContain(LAUNCH_INSTRUCTION);
    expect(firstAudit?.text).toContain("TURN_ALPHA_MEMORY");
    expect(activityAtFirstPrompt).not.toBe(originalUpdatedAt); // the user prompt is activity

    const deltas = events.filter((item) => item.event.type === "cell_delta");
    expect(deltas.length).toBeGreaterThanOrEqual(2);
    expect(deltas.map((item) => item.event.delta ?? "").join("")).toBe(REPLY);
    expect(events.map((item) => item.seq)).toEqual(
      [...events.map((item) => item.seq)].sort((a, b) => a - b),
    );

    const activityAfterFirstTurn = session.meta.updatedAt;
    const firstCapturedAt = firstAudit!.capturedAt;
    const requestsAfterFirstTurn = mock.requests.length;
    await session.prompt("explain the beta rollback database procedure");
    const activityAtSecondPrompt = session.meta.updatedAt;
    // Each wait gets its OWN 30s budget. They used to share a single absolute
    // deadline computed before the first one, so a slow real-pi turn could
    // spend the whole budget waiting for the audit and leave the next wait
    // with none — it then fell straight through to "expected 1 to be greater
    // than 1" (Windows CI), which reads like a missing provider request but is
    // just an exhausted clock.
    const waitFor = async (settled: () => boolean | Promise<boolean>): Promise<void> => {
      const deadline = Date.now() + 30_000;
      while (!(await settled()) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    };

    await waitFor(() => session.meta.finalSystemPromptAudit?.capturedAt !== firstCapturedAt);
    expect(session.meta.finalSystemPromptAudit?.capturedAt).not.toBe(firstCapturedAt);
    await waitFor(() => mock.requests.length !== requestsAfterFirstTurn);
    expect(mock.requests.length).toBeGreaterThan(requestsAfterFirstTurn);
    const secondProviderPrompt = systemText(mock.requests.at(-1)!);
    expect(session.meta.finalSystemPromptAudit?.text).toBe(secondProviderPrompt);
    expect(session.meta.finalSystemPromptAudit?.text).toContain("TURN_BETA_MEMORY");
    // Audit itself does not introduce a second activity mutation; updatedAt is
    // still simply the timestamp assigned by the second user prompt.
    expect(activityAtSecondPrompt).not.toBe(activityAfterFirstTurn);
    const expected = { ...session.meta.finalSystemPromptAudit };
    await new Promise((resolve) => setTimeout(resolve, 25));
    await waitFor(async () => !(await session.getState()).isStreaming);
    unsubscribe();

    await server.close();
    server = await startServer({ dataDir });
    const hydrated = (await (await fetch(`http://127.0.0.1:${server.port}/sessions`)).json()) as {
      sessions: Array<{ id: string; finalSystemPromptAudit?: unknown }>;
    };
    expect(
      hydrated.sessions.find((item) => item.id === session.meta.id)?.finalSystemPromptAudit,
    ).toEqual(expected);
  });
});
