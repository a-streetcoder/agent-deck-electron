import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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

  const unixIt = process.platform === "win32" ? it.skip : it;
  unixIt("maps linked catalog failures to 409 and leaves the outside file unchanged", async () => {
    const prompts = path.join(resourceHome, ".pi", "agent", "prompts");
    mkdirSync(prompts, { recursive: true });
    const sentinel = path.join(dataDir, "resource-sentinel");
    writeFileSync(sentinel, "outside-safe");
    symlinkSync(sentinel, path.join(prompts, "linked-route.md"));

    const response = await put("/resources/prompts", {
      scope: "global",
      name: "linked-route",
      edit: { body: "bad" },
    });
    expect(response.status).toBe(409);
    expect((await response.json()) as { error: string }).toEqual(
      expect.objectContaining({ error: expect.stringContaining("unsafe or linked") }),
    );
    expect(readFileSync(sentinel, "utf8")).toBe("outside-safe");
  });

  // Agents and prompts stay global-only for in-app writes — the shared skill engine
  // owns skills, not those. (Runs before the skill-success test below, so projectDir
  // is still clean of `.agents` when these assert it.)
  it.each([
    ["agent", "/resources/agents", { edit: { body: "No." } }],
    ["prompt", "/resources/prompts", { edit: { body: "No." } }],
  ])("rejects project %s creation without touching project files", async (name, url, extra) => {
    const response = await put(url, { projectId, scope: "project", name, ...extra });
    expect(response.status).toBe(400);
    expect(existsSync(path.join(projectDir, ".pi", "agents"))).toBe(false);
    expect(existsSync(path.join(projectDir, ".pi", "prompts"))).toBe(false);
    expect(existsSync(path.join(projectDir, ".agents"))).toBe(false);
  });

  // Project SKILL writes are supported now that the shared engine owns storage (P3):
  // the engine materializes them in the canonical `<project>/.agents/skills` catalog.
  it("creates a project skill through the shared engine", async () => {
    const response = await put("/resources/skills", {
      projectId,
      scope: "project",
      name: "proj-skill",
      edit: { description: "A project skill", body: "Do the thing." },
    });
    expect(response.status).toBe(200);
    expect(
      existsSync(path.join(projectDir, ".agents", "skills", "proj-skill", "SKILL.md")),
    ).toBe(true);
  });
});
