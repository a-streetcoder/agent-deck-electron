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
const originalExaKey = process.env.EXA_API_KEY;

async function put(url: string, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}${url}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  delete process.env.EXA_API_KEY;
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
  if (originalExaKey === undefined) delete process.env.EXA_API_KEY;
  else process.env.EXA_API_KEY = originalExaKey;
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
  // the engine materializes them in the canonical `<project>/.agents/skills` catalog, and
  // agent-deck's scanner reads that catalog so the skill is immediately visible in-app.
  it("returns current-project warnings with ordered skill precedence", async () => {
    const agentsDir = path.join(resourceHome, ".pi", "agent", "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(
      path.join(agentsDir, "diagnostic-agent.md"),
      "---\nname: diagnostic-agent\ntools: web_search\nskills: missing-skill, duplicate-skill\n---\n\nDiagnose.\n",
    );
    for (const dir of [
      path.join(resourceHome, ".pi", "agent", "skills", "duplicate-skill"),
      path.join(projectDir, ".pi", "skills", "duplicate-skill"),
    ]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        path.join(dir, "SKILL.md"),
        "---\nname: duplicate-skill\ndescription: Duplicate\n---\n\nBody.\n",
      );
    }
    const agents = (await (
      await fetch(
        `http://127.0.0.1:${server.port}/resources/agents?projectId=${projectId}&includeUnassigned=true`,
      )
    ).json()) as { agents: Array<{ name: string; warnings: Array<{ id: string }> }> };
    const warnings = agents.agents.find((agent) => agent.name === "diagnostic-agent")?.warnings;
    expect(warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "skill-missing" }),
        expect.objectContaining({ id: "exa-key-missing" }),
      ]),
    );
    expect(warnings).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "skill-ambiguous" })]),
    );

    const visibility = (await (
      await fetch(
        `http://127.0.0.1:${server.port}/resources/skills/visibility?projectId=${projectId}`,
      )
    ).json()) as { skills: Array<{ name: string; scope: string }> };
    expect(visibility.skills.filter((skill) => skill.name === "duplicate-skill")).toEqual([
      expect.objectContaining({ scope: "project" }),
    ]);
  });

  it("creates a project skill through the engine AND reads it back (round-trip)", async () => {
    const response = await put("/resources/skills", {
      projectId,
      scope: "project",
      name: "proj-skill",
      edit: { description: "A project skill", body: "Do the thing." },
    });
    expect(response.status).toBe(200);
    expect(existsSync(path.join(projectDir, ".agents", "skills", "proj-skill", "SKILL.md"))).toBe(
      true,
    );

    // The regression this guards: the engine writes `.agents/skills` but the scanner used to
    // read only `.pi/skills`, so a created project skill was invisible. It must round-trip.
    const listed = (await (
      await fetch(`http://127.0.0.1:${server.port}/resources/skills?projectId=${projectId}`)
    ).json()) as { skills: Array<{ name: string; scope: string }> };
    expect(listed.skills).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "proj-skill", scope: "project" })]),
    );
  });
});
