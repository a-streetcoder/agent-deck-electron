import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

it.each(["single", "parallel", "supervisor"] as const)(
  "Composer abort cancels %s delegation without later child generation or queued allocation",
  async (mode) => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-delegation-abort-"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mock = await startMockProvider({
      beforeResponse: async (_user, body) => {
        if (isChild(body) && mode !== "supervisor") await gate;
      },
      toolCall: (_user, body) => {
        if (body.messages.some((m) => m.role === "tool")) return null;
        if (isChild(body))
          return mode === "supervisor"
            ? {
                name: "contact_supervisor",
                arguments: {
                  method: "need_decision",
                  title: "Decision",
                  message: "Wait for approval.",
                },
              }
            : null;
        if (!JSON.stringify(body.tools ?? []).includes("managed_subagent")) return null;
        return mode === "parallel"
          ? {
              name: "managed_parallel",
              arguments: {
                concurrency: 1,
                tasks: [{ task: "first" }, { task: "must never start" }],
              },
            }
          : { name: "managed_subagent", arguments: { task: "first" } };
      },
      reply: (_user, body) => (isChild(body) ? "FORBIDDEN_AFTER_ABORT" : "parent finished"),
    });
    const previous = process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
    process.env.AGENT_DECK_PROVIDER_EXTENSIONS = writeMockProviderExtension(mock.baseUrl);
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
          extensions: [process.env.AGENT_DECK_PROVIDER_EXTENSIONS],
          env: { HOME: root, USERPROFILE: root, PI_SKIP_VERSION_CHECK: "1" },
        }),
      });
      expect(response.status).toBe(201);
      const { session } = (await response.json()) as { session: { id: string } };
      const managed = server.sessions.get(session.id)!;
      const deltas: string[] = [];
      const unsubscribe = managed.bus.subscribe(({ event }) => {
        if (event.type === "subagent_delta") deltas.push(event.delta);
      });
      try {
        await managed.prompt("Delegate now");
        await vi.waitFor(() => expect(mock.requests.filter(isChild)).toHaveLength(1), {
          timeout: 20_000,
        });
        if (mode === "supervisor") {
          await vi.waitFor(
            () =>
              expect(server.supervisor.list(session.id).some((r) => r.status === "pending")).toBe(
                true,
              ),
            { timeout: 20_000 },
          );
        }
        // Same backend method as the renderer/RPC abort command, not scope destroy.
        await managed.abort();
        const cards = () => managed.snapshot().state.cells.filter((c) => c.kind === "subagent");
        await vi.waitFor(() => expect(cards().map((c) => c.status)).toEqual(["stopped"]), {
          timeout: 20_000,
        });
        expect(managed.isRunning).toBe(true);
        if (mode === "supervisor") {
          expect(server.supervisor.list(session.id).map((r) => r.status)).toEqual(["cancelled"]);
        }
        const before = [...deltas];
        release();
        // Give the real provider enough time to deliver the forbidden response
        // if cancellation left a Pi process or its tool-result continuation alive.
        await new Promise((resolve) => setTimeout(resolve, 750));
        expect(deltas).toEqual(before);
        expect(mock.requests.filter(isChild)).toHaveLength(1);
        expect(
          mock.requests
            .filter((r) => !isChild(r))
            .flatMap((r) => r.messages.filter((m) => m.role === "tool")),
        ).toEqual([]);
        expect(cards()).toHaveLength(1);
        expect(cards()[0]?.text).not.toContain("FORBIDDEN_AFTER_ABORT");
        const persisted = JSON.parse(
          readFileSync(path.join(dataDir, "subagent-runs.json"), "utf8"),
        );
        const records: SubagentRunRecord[] = persisted.runs;
        expect(records.map((r) => r.status)).toEqual(["stopped"]);
      } finally {
        unsubscribe();
      }
    } finally {
      release();
      await server.close();
      await mock.close();
      if (previous === undefined) delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
      else process.env.AGENT_DECK_PROVIDER_EXTENSIONS = previous;
      rmSync(root, { recursive: true, force: true });
    }
  },
);
