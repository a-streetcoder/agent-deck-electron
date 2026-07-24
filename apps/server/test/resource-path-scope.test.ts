import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

const resourceHome = mkdtempSync(path.join(tmpdir(), "resource-scope-home-"));
const projectDir = mkdtempSync(path.join(tmpdir(), "resource-scope-project-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "resource-scope-data-"));
let server: AgentDeckServer;
let projectId: string;

async function put(url: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${url}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: resourceHome });
  server = await startServer({ dataDir });
  const response = await fetch(`http://127.0.0.1:${server.port}/projects`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ path: projectDir }),
  });
  projectId = ((await response.json()) as { project: { id: string } }).project.id;
}, 30_000);

afterAll(async () => {
  delete process.env.AGENT_DECK_PI_ENV;
  await server.close();
});

describe("resource write scope compatibility", () => {
  it("writes agent and prompt library resources to native library paths", async () => {
    expect(
      (
        await put("/resources/agents", {
          scope: "library",
          name: "library-agent",
          edit: { body: "A." },
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await put("/resources/prompts", {
          scope: "library",
          name: "library-prompt",
          edit: { body: "P." },
        })
      ).status,
    ).toBe(200);
    expect(
      existsSync(
        path.join(resourceHome, ".pi", "agent", "agent-library", "agents", "library-agent.md"),
      ),
    ).toBe(true);
    expect(
      existsSync(path.join(resourceHome, ".pi", "agent", "prompt-library", "library-prompt.md")),
    ).toBe(true);
  });

  it("rejects ambiguous legacy/modern agent edits", async () => {
    for (const dir of [
      path.join(resourceHome, ".agents"),
      path.join(resourceHome, ".pi", "agent", "agents"),
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "ambiguous.md"), "---\nname: ambiguous\n---\n\nBody.\n");
    }
    const response = await put("/resources/agents", {
      scope: "global",
      name: "ambiguous",
      edit: { body: "Changed." },
    });
    expect(response.status).toBe(409);
  });

  it.each([
    ["agent", "/resources/agents", { edit: { body: "No." } }],
    ["skill", "/resources/skills", { edit: { body: "No." } }],
    ["prompt", "/resources/prompts", { edit: { body: "No." } }],
  ])("rejects project %s creation without touching project files", async (name, url, extra) => {
    const response = await put(url, { projectId, scope: "project", name, ...extra });
    expect(response.status).toBe(400);
    expect(existsSync(path.join(projectDir, ".pi", "agents"))).toBe(false);
    expect(existsSync(path.join(projectDir, ".pi", "skills"))).toBe(false);
    expect(existsSync(path.join(projectDir, ".pi", "prompts"))).toBe(false);
    expect(existsSync(path.join(projectDir, ".agents"))).toBe(false);
  });
});
