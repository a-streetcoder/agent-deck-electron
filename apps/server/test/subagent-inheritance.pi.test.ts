import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
} from "@agent-deck/testkit";
import { expect, it } from "vitest";
import { startServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

it.each([false, true])(
  "inherits live parent selections and preserves overrides (explicit launch: %s)",
  async (explicitLaunch) => {
    const root = mkdtempSync(path.join(tmpdir(), "deck-child-inheritance-"));
    const home = path.join(root, "home");
    const cwd = path.join(root, "project");
    const dataDir = path.join(root, "data");
    const agentDir = path.join(home, ".pi", "agent");
    mkdirSync(path.join(agentDir, "agents"), { recursive: true });
    mkdirSync(cwd);
    writeFileSync(
      path.join(agentDir, "settings.json"),
      JSON.stringify({
        defaultProvider: MOCK_PROVIDER_ID,
        defaultModel: MOCK_MODEL_ID,
        defaultThinkingLevel: explicitLaunch ? "off" : "high",
      }),
    );
    for (const [name, settings] of [
      ["inherit", ""],
      ["explicit", `model: ${MOCK_PROVIDER_ID}/${MOCK_MODEL_ID}:low\n`],
      ["thinking-only", "thinking: off\n"],
    ]) {
      writeFileSync(
        path.join(agentDir, "agents", `${name}.md`),
        `---\nname: ${name}\n${settings}tools: read\n---\nReport your result.\n`,
      );
    }
    const mock = await startMockProvider({ reply: () => "Child result delivered incrementally." });
    const extension = writeMockProviderExtension(mock.baseUrl);
    const secondExtension = path.join(root, "second-provider.ts");
    writeFileSync(
      secondExtension,
      readFileSync(extension, "utf8")
        .replaceAll('"mock"', '"second"')
        .replaceAll('"mock-model"', '"second-model"'),
    );
    const env = { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" };
    const previousExtensions = process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
    process.env.AGENT_DECK_PROVIDER_EXTENSIONS = [extension, secondExtension].join(path.delimiter);
    const previousEnv = process.env.AGENT_DECK_PI_ENV;
    process.env.AGENT_DECK_PI_ENV = JSON.stringify(env);
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      server = await startServer({ dataDir });
      if (explicitLaunch) {
        const settingsResponse = await fetch(`http://127.0.0.1:${server.port}/settings`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ defaultThinking: "high" }),
        });
        expect(settingsResponse.ok).toBe(true);
      }
      const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Exercise both a frozen explicit launch and Pi-selected defaults.
        body: JSON.stringify({
          cwd,
          extensions: [extension, secondExtension],
          env,
          ...(explicitLaunch ? { provider: MOCK_PROVIDER_ID, model: MOCK_MODEL_ID } : {}),
        }),
      });
      expect(response.ok).toBe(true);
      const { session } = (await response.json()) as { session: { id: string } };
      const parent = server.sessions.get(session.id)!;
      expect(await parent.getState()).toMatchObject({
        model: { provider: "mock", id: MOCK_MODEL_ID },
        thinkingLevel: "high",
      });

      function expectSelection(
        runId: string,
        provider: string,
        model: string,
        thinkingLevel: string,
      ) {
        const { runs } = JSON.parse(
          readFileSync(path.join(dataDir, "subagent-runs.json"), "utf8"),
        ) as { runs: Array<{ id: string; sessionFile: string }> };
        const run = runs.find((run) => run.id === runId)!;
        const entries = readFileSync(run.sessionFile, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        // Pi does not append a model_change for CLI overrides on resume; the
        // persisted assistant message records the model actually used for this turn.
        expect(
          entries
            .filter((entry) => entry.type === "message" && entry.message.role === "assistant")
            .at(-1)?.message,
        ).toMatchObject({ provider, model });
        expect(mock.requests.at(-1)?.reasoning_effort).toBe(
          thinkingLevel === "off" ? undefined : thinkingLevel,
        );
        expect(mock.requests.at(-1)?.model).toBe(model);
      }

      const initial = await server.sessions.runManagedSubagent(
        session.id,
        "Initial task",
        "inherit",
      );
      expectSelection(initial.runId, "mock", MOCK_MODEL_ID, "high");
      await parent.setModel("second", "second-model");
      await parent.setThinkingLevel("medium");
      const fresh = await server.sessions.runManagedSubagent(
        session.id,
        "Changed model task",
        "inherit",
      );
      expectSelection(fresh.runId, "second", "second-model", "medium");
      const continued = await server.sessions.runManagedSubagent(
        session.id,
        "Continue task",
        undefined,
        initial.runId,
      );
      expect(continued.runId).toBe(initial.runId);
      expectSelection(continued.runId, "second", "second-model", "medium");
      const explicit = await server.sessions.runManagedSubagent(
        session.id,
        "Explicit model task",
        "explicit",
      );
      expectSelection(explicit.runId, "mock", MOCK_MODEL_ID, "low");
      const thinking = await server.sessions.runManagedSubagent(
        session.id,
        "Thinking task",
        "thinking-only",
      );
      expectSelection(thinking.runId, "second", "second-model", "off");
      const overridden = await parent.runChildAgent("Tool overrides", "thinking-only", undefined, {
        provider: "mock",
        model: MOCK_MODEL_ID,
        thinking: "high",
      });
      expectSelection(overridden.runId, "mock", MOCK_MODEL_ID, "high");
      const modelOverride = await parent.runChildAgent(
        "Override agent model",
        "explicit",
        undefined,
        {
          provider: "second",
          model: "second-model",
          thinking: "high",
        },
      );
      expectSelection(modelOverride.runId, "second", "second-model", "high");
    } finally {
      await server?.close();
      await mock.close();
      if (previousExtensions === undefined) delete process.env.AGENT_DECK_PROVIDER_EXTENSIONS;
      else process.env.AGENT_DECK_PROVIDER_EXTENSIONS = previousExtensions;
      if (previousEnv === undefined) delete process.env.AGENT_DECK_PI_ENV;
      else process.env.AGENT_DECK_PI_ENV = previousEnv;
      rmSync(root, { recursive: true, force: true });
      rmSync(path.dirname(extension), { recursive: true, force: true });
    }
  },
);
