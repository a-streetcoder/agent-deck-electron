import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildLaunchArgs, PiSession, resolvePiBinary } from "@agent-deck/pi-host";
import { startServer, type AgentDeckServer } from "../src/index.ts";

const root = mkdtempSync(path.join(tmpdir(), "named-prompts-pi-"));
const home = path.join(root, "home");
const project = path.join(root, "project");
let mock: MockProviderServer;
let server: AgentDeckServer;
let projectId: string;
let extension: string;
const external = path.join(root, "external-proof.md");

beforeAll(async () => {
  vi.stubEnv("AGENT_DECK_TEST", "1");
  vi.stubEnv(
    "AGENT_DECK_PI_ENV",
    JSON.stringify({ HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" }),
  );
  const agents = path.join(home, ".pi", "agent", "agents");
  const globalPrompts = path.join(home, ".pi", "agent", "prompts");
  const projectPrompts = path.join(project, ".pi", "prompts");
  for (const dir of [agents, globalPrompts, projectPrompts]) mkdirSync(dir, { recursive: true });
  for (const mode of ["replace", "append"])
    writeFileSync(
      path.join(agents, `${mode}-bot.md`),
      `---\nname: ${mode}-bot\nsystemPromptMode: ${mode}\ntools: []\n---\n\nPERSONA_${mode}\n`,
    );
  for (const [file, body] of [
    [path.join(globalPrompts, "default-proof.md"), "DEFAULT_EXPANDED $1"],
    [path.join(projectPrompts, "project-proof.md"), "PROJECT_EXPANDED $1"],
    [path.join(globalPrompts, "plan-a-feature.md"), "USER_COPY_EXPANDED $1"],
    [path.join(projectPrompts, "unassigned-proof.md"), "MUST_NOT_LOAD"],
    [external, "EXTERNAL_EXPANDED $1"],
  ])
    writeFileSync(file!, `---\ndescription: proof\n---\n\n${body}\n`);
  writeFileSync(path.join(project, ".pi", "APPEND_SYSTEM.md"), "NAMED_APPEND_COEXISTS");
  mock = await startMockProvider({ reply: () => "ok" });
  extension = writeMockProviderExtension(mock.baseUrl);
  const dataDir = path.join(root, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(
    path.join(dataDir, "app-settings.json"),
    JSON.stringify({
      disabledBuiltinPromptNames: ["plan-a-feature", "review-my-changes"],
      externalPromptPaths: [external],
    }),
  );
  server = await startServer({ dataDir });
  const created = await server.fastify.inject({
    method: "POST",
    url: "/projects",
    payload: { path: project },
  });
  expect(created.statusCode).toBe(201);
  projectId = created.json().project.id;
  expect(
    (
      await server.fastify.inject({
        method: "PATCH",
        url: `/projects/${projectId}`,
        payload: { assignedPrompts: ["project-proof", "external-proof", "default-proof"] },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await server.fastify.inject({
        method: "PATCH",
        url: "/settings",
        payload: {
          autoTitle: false,
          piAgentIdleParkingEnabled: false,
          defaultPromptTemplates: ["default-proof", "plan-a-feature", "review-my-changes"],
        },
      })
    ).statusCode,
  ).toBe(200);
});

afterAll(async () => {
  await server?.close();
  await mock?.close();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function commands(id: string) {
  const response = await server.fastify.inject({ method: "GET", url: `/sessions/${id}/commands` });
  expect(response.statusCode).toBe(200);
  return response.json().commands as Array<{ name: string; source: string }>;
}

describe("named user chat assigned templates with pinned Pi", () => {
  it("keeps an isolated child-shaped launch template-free in the same cwd and home", async () => {
    const child = new PiSession({
      binPath: resolvePiBinary().path,
      args: buildLaunchArgs({
        kind: "agent",
        systemPrompt: { mode: "replace", text: "Isolated child" },
        tools: [],
        sessionDir: path.join(root, "child-sessions"),
        extensions: [extension],
        provider: MOCK_PROVIDER_ID,
        model: MOCK_MODEL_ID,
      }),
      cwd: project,
      env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
    });
    try {
      child.start();
      expect((await child.getCommands()).filter((command) => command.source === "prompt")).toEqual(
        [],
      );
    } finally {
      await child.stop();
      expect(child.isRunning).toBe(false);
    }
  });
  it.each(["replace", "append"])(
    "lists and expands assigned templates in %s mode alongside APPEND_SYSTEM",
    async (mode) => {
      const created = await server.fastify.inject({
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
      expect(created.statusCode).toBe(201);
      const id = created.json().session.id as string;
      try {
        const names = (await commands(id)).map((command) => command.name);
        for (const name of ["default-proof", "project-proof", "external-proof", "plan-a-feature"])
          expect(names.filter((item) => item === name)).toHaveLength(1);
        expect(names).not.toContain("unassigned-proof");
        expect(names).not.toContain("review-my-changes");
        for (const [name, marker] of [
          ["default-proof", "DEFAULT_EXPANDED"],
          ["project-proof", "PROJECT_EXPANDED"],
          ["external-proof", "EXTERNAL_EXPANDED"],
          ["plan-a-feature", "USER_COPY_EXPANDED"],
        ]) {
          const start = mock.requests.length;
          const session = server.sessions.get(id)!;
          let idle = false;
          // A provider request can arrive before ingestion publishes agent_start.
          // The snapshot may still say idle from the previous turn at that point.
          // Observe this turn's boundary instead of accepting that stale snapshot.
          const unsubscribe = session.bus.subscribe(({ event }) => {
            if (event.type === "agent_status" && event.status === "idle") idle = true;
          });
          try {
            await session.prompt(`/${name} argument-${mode}`);
            await vi.waitFor(() => expect(mock.requests.length).toBeGreaterThan(start), {
              timeout: 15_000,
            });
            await vi.waitFor(() => expect(idle).toBe(true), { timeout: 15_000 });
          } finally {
            unsubscribe();
          }
          const request = mock.requests.slice(start).at(-1)!;
          const users = JSON.stringify(request.messages.filter((m) => m.role === "user"));
          expect(users).toContain(`${marker} argument-${mode}`);
          const system = JSON.stringify(
            request.messages.filter((m) => m.role === "system" || m.role === "developer"),
          );
          expect(system.split("NAMED_APPEND_COEXISTS").length - 1).toBe(1);
        }
        // A route assignment mutation must rebind the live named session, not just
        // affect future launches. Restore it for the next persona-mode case.
        const generation = server.sessions.get(id)!.meta.streamGeneration;
        expect(
          (
            await server.fastify.inject({
              method: "PATCH",
              url: `/projects/${projectId}`,
              payload: { assignedPrompts: ["project-proof"] },
            })
          ).statusCode,
        ).toBe(200);
        await vi.waitFor(
          () => expect(server.sessions.get(id)!.meta.streamGeneration).not.toBe(generation),
          { timeout: 15_000 },
        );
        expect((await commands(id)).map((c) => c.name)).not.toContain("external-proof");
      } finally {
        await server.sessions.destroy(id);
        await server.fastify.inject({
          method: "PATCH",
          url: `/projects/${projectId}`,
          payload: { assignedPrompts: ["project-proof", "external-proof", "default-proof"] },
        });
      }
    },
  );
});
