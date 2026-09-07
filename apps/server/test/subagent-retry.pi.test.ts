import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type ChatCompletionRequest,
} from "@agent-deck/testkit";
import { expect, it, vi } from "vitest";
import { startServer } from "../src/index.ts";
import type { SubagentRunRecord } from "../src/subagentRunStore.ts";

process.env.AGENT_DECK_TEST = "1";
const isChild = (body: ChatCompletionRequest): boolean =>
  JSON.stringify(
    body.messages.filter((m) => m.role === "system" || m.role === "developer"),
  ).includes("focused subagent launched by Agent Deck");

it.each(["recover", "exhaust", "nonretryable", "partial", "abort"] as const)(
  "pinned Pi child provider lifecycle: %s",
  async (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-child-retry-"));
    const settingsDir = path.join(root, ".pi", "agent");
    mkdirSync(settingsDir, { recursive: true });
    writeFileSync(
      path.join(settingsDir, "settings.json"),
      JSON.stringify({
        retry: {
          enabled: true,
          maxRetries: 2,
          baseDelayMs: mode === "abort" ? 60_000 : 5,
          provider: { maxRetries: 0 },
        },
        compaction: { enabled: false },
        enableInstallTelemetry: false,
      }),
    );
    let childRequests = 0;
    const mock = await startMockProvider({
      failure: (body) => {
        if (!isChild(body)) return;
        childRequests++;
        if (mode === "recover" && childRequests > 1) return;
        return {
          status: mode === "nonretryable" || mode === "partial" ? 400 : 500,
          message:
            mode === "nonretryable" || mode === "partial"
              ? "invalid request sentinel"
              : "500 provider outage sentinel",
          afterText: mode === "partial",
        };
      },
      toolCall: (_user, body) =>
        isChild(body) || body.messages.some((m) => m.role === "tool")
          ? null
          : { name: "managed_subagent", arguments: { task: "retry fixture task" } },
      reply: (_user, body) => (isChild(body) ? "REAL final child output" : "parent done"),
      chunkDelayMs: 5,
    });
    const previous = process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
    const extension = writeMockProviderExtension(mock.baseUrl);
    process.env.AGENT_DECK_PROVIDER_EXTENSIONS = extension;
    const dataDir = path.join(root, "data");
    const server = await startServer({ dataDir });
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cwd: root,
          provider: MOCK_PROVIDER_ID,
          model: MOCK_MODEL_ID,
          extensions: [extension],
          env: { HOME: root, USERPROFILE: root, PI_SKIP_VERSION_CHECK: "1" },
        }),
      });
      expect(response.status).toBe(201);
      const { session } = (await response.json()) as { session: { id: string } };
      const managed = server.sessions.get(session.id)!;
      const cards = () => managed.snapshot().state.cells.filter((c) => c.kind === "subagent");
      const deltas: Array<{ seq: number; text: string }> = [];
      const unsubscribe = managed.bus.subscribe(({ seq, event }) => {
        if (event.type === "subagent_delta") {
          expect(cards()[0]?.status).toBe("running");
          deltas.push({ seq, text: event.delta });
        }
      });
      try {
        await managed.prompt("Delegate now");
        if (mode === "abort") {
          // Observe Pi's actual retry pause; no sleep/backoff race or second request.
          await vi.waitFor(
            async () => {
              expect(cards()).toHaveLength(1);
              const live = await server.sessions.subagentTranscript(
                session.id,
                cards()[0]!.id,
                root,
              );
              expect(
                live?.cells.some((c) => c.kind === "provider_retry" && c.status === "retrying"),
              ).toBe(true);
            },
            { timeout: 20_000 },
          );
          await managed.abort();
        }
        const expectedStatus = mode === "recover" ? "done" : mode === "abort" ? "stopped" : "error";
        await vi.waitFor(() => expect(cards().map((c) => c.status)).toEqual([expectedStatus]), {
          timeout: 20_000,
        });
        const records = (): SubagentRunRecord[] =>
          JSON.parse(readFileSync(path.join(dataDir, "subagent-runs.json"), "utf8")).runs;
        expect(records()[0]?.status).toBe(
          mode === "recover" ? "completed" : mode === "abort" ? "stopped" : "failed",
        );
        expect(childRequests).toBe(mode === "recover" ? 2 : mode === "exhaust" ? 3 : 1);
        expect(managed.isRunning).toBe(true);
        if (mode === "abort") return;
        await vi.waitFor(
          () => {
            const tool = managed
              .snapshot()
              .state.cells.find((c) => c.kind === "tool" && c.toolName === "managed_subagent");
            expect(tool?.kind === "tool" ? tool.status : undefined).toBe(
              mode === "recover" ? "done" : "error",
            );
          },
          { timeout: 20_000 },
        );
        // Pi's canonical parent toolResult carries the real bridge isError bit.
        const parentEntries = (await managed.getEntries()).entries;
        const toolEntry = parentEntries.find(
          (entry) =>
            entry.type === "message" &&
            entry.message.role === "toolResult" &&
            entry.message.toolName === "managed_subagent",
        );
        const toolResult =
          toolEntry?.type === "message" && toolEntry.message.role === "toolResult"
            ? toolEntry.message
            : undefined;
        expect(toolResult?.isError).toBe(mode !== "recover");
        const canonical = await server.sessions.subagentTranscript(
          session.id,
          cards()[0]!.id,
          root,
        );
        expect(canonical?.source).toBe("canonical");
        expect(canonical?.status).toBe(expectedStatus);
        const finalAssistant = canonical?.cells.findLast((cell) => cell.kind === "assistant");
        expect(finalAssistant?.stopReason).toBe(mode === "recover" ? "stop" : "error");
        if (mode === "recover" || mode === "partial") {
          expect(deltas.length).toBeGreaterThan(1);
          expect(deltas.map((d) => d.seq)).toEqual(deltas.map((d) => d.seq).sort((a, b) => a - b));
          expect(deltas.map((d) => d.text).join("")).toBe("REAL final child output");
          expect(cards()[0]?.text).toBe("REAL final child output");
        }
        if (mode === "recover") {
          expect(records()[0]?.model).toBe(MOCK_MODEL_ID);
          expect(records()[0]?.outputTokens).toBeGreaterThan(0);
          const sessionFile = records()[0]!.sessionFile;
          const result = await server.sessions.runManagedSubagent(
            session.id,
            "continue recovered task",
            undefined,
            cards()[0]!.id,
          );
          expect(result.text).toBe("REAL final child output");
          expect(records()[0]?.sessionFile).toBe(sessionFile);
          expect(
            mock.requests
              .filter(isChild)
              .at(-1)
              ?.messages.some(
                (m) =>
                  m.role === "assistant" &&
                  JSON.stringify(m.content).includes("REAL final child output"),
              ),
          ).toBe(true);
        } else {
          expect(cards()[0]?.error).toContain("sentinel");
          expect(JSON.stringify(toolResult?.content)).toContain("sentinel");
          expect(records()[0]?.error).toContain("sentinel");
        }
      } finally {
        unsubscribe();
      }
    } finally {
      await server.close();
      await mock.close();
      if (previous === undefined) delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
      else process.env.AGENT_DECK_PROVIDER_EXTENSIONS = previous;
      rmSync(path.dirname(extension), { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  },
);
