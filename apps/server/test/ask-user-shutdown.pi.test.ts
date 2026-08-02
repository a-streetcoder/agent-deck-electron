import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
} from "@agent-deck/testkit";
import { describe, expect, it } from "vitest";
import { startServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

describe("real Pi ask_user shutdown", () => {
  it("settles an admitted blocking bridge request before HTTP drain", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "ask-user-shutdown-data-"));
    const cwd = mkdtempSync(path.join(tmpdir(), "ask-user-shutdown-cwd-"));
    const home = mkdtempSync(path.join(tmpdir(), "ask-user-shutdown-home-"));
    const mock = await startMockProvider({
      toolCall: (_lastUser, body) =>
        body.messages.some((message) => message.role === "tool")
          ? null
          : {
              name: "ask_user",
              arguments: { question: "May shutdown continue?", options: ["Yes", "No"] },
            },
      reply: () => "finished",
    });
    const server = await startServer({ dataDir });
    try {
      const created = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
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
      expect(created.status).toBe(201);
      const id = ((await created.json()) as { session: { id: string } }).session.id;
      const session = server.sessions.get(id)!;
      const prompt = session.prompt("ask before shutdown");
      void prompt.catch(() => {});

      let pending = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        pending = session
          .snapshot()
          .state.cells.some((cell) => cell.kind === "ask_user" && cell.status === "pending");
        if (pending) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      expect(pending).toBe(true);

      await expect(
        Promise.race([
          server.close(),
          new Promise<never>((_, reject) => {
            const timer = setTimeout(
              () => reject(new Error("shutdown did not settle ask_user")),
              5_000,
            );
            timer.unref();
          }),
        ]),
      ).resolves.toBeUndefined();
      await Promise.allSettled([prompt]);

      rmSync(path.join(dataDir, "session-worktrees"), { recursive: true });
      rmSync(path.join(dataDir, "Subagent Runs"), { recursive: true });
      rmSync(dataDir, { recursive: true });
    } finally {
      await server.close().catch(() => {});
      await mock.close();
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
