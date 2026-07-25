import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Skill rename route (native RenameResourceSheet): POST
 * /resources/skills/rename moves a global skill directory (200 / 409 / 404)
 * and re-points app defaults and project assignments. Removed project catalogs
 * are rejected without changing global resources or references.
 */

const resourceHome = mkdtempSync(path.join(tmpdir(), "skill-rename-home-"));
const projectDir = mkdtempSync(path.join(tmpdir(), "skill-rename-proj-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
let server: AgentDeckServer;
let projectId: string;

async function api(method: string, url: string, body?: unknown): Promise<Response> {
  return await fetch(`http://127.0.0.1:${server.port}${url}`, {
    method,
    headers: body === undefined ? {} : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function assignedOf(): Promise<string[]> {
  const { projects } = (await (await api("GET", "/projects")).json()) as {
    projects: Array<{ id: string; assignedSkills?: string[] }>;
  };
  return projects.find((p) => p.id === projectId)!.assignedSkills ?? [];
}

async function defaultSkills(): Promise<string[]> {
  const { settings } = (await (await api("GET", "/settings")).json()) as {
    settings: { defaultSkills: string[] };
  };
  return settings.defaultSkills;
}

async function globalSkillNames(): Promise<string[]> {
  const { skills } = (await (
    await api("GET", `/resources/skills?projectId=${projectId}`)
  ).json()) as { skills: Array<{ name: string; scope: string }> };
  return skills
    .filter((skill) => skill.scope === "global")
    .map((skill) => skill.name)
    .sort();
}

async function writeGlobalSkill(name: string): Promise<void> {
  const res = await api("PUT", "/resources/skills", {
    scope: "global",
    name,
    edit: { description: name, body: `Skill ${name}` },
  });
  if (!res.ok) throw new Error(await res.text());
}

beforeAll(async () => {
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: resourceHome });
  server = await startServer({ dataDir });
  projectId = (
    (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    }
  ).project.id;
});

afterAll(async () => {
  delete process.env.AGENT_DECK_PI_ENV;
  await server.close();
});

describe("POST /resources/skills/rename", () => {
  it("renames the dir AND re-points the project assignment + default list", async () => {
    await writeGlobalSkill("linter");
    await api("PATCH", "/settings", { setDefaultSkill: { name: "linter", enabled: true } });
    await api("PATCH", `/projects/${projectId}`, { assignedSkills: ["linter"] });

    const res = await api("POST", "/resources/skills/rename", {
      scope: "global",
      name: "linter",
      newName: "formatter",
    });
    expect(res.status).toBe(200);

    expect(await assignedOf()).toEqual(["formatter"]);
    expect(await defaultSkills()).toContain("formatter");
    expect(await defaultSkills()).not.toContain("linter");
  });

  it("rejects project rename without changing assignments or global skills", async () => {
    await writeGlobalSkill("shared");
    await api("PATCH", `/projects/${projectId}`, { assignedSkills: ["formatter", "shared"] });
    const assignmentsBefore = await assignedOf();
    const globalsBefore = await globalSkillNames();

    const response = await api("POST", "/resources/skills/rename", {
      projectId,
      scope: "project",
      name: "shared",
      newName: "shared2",
    });

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("project resource catalogs are not supported");
    expect(await assignedOf()).toEqual(assignmentsBefore);
    expect(await globalSkillNames()).toEqual(globalsBefore);
  });

  it("rejects project rename without changing the flat default list", async () => {
    await writeGlobalSkill("dup");
    await api("PATCH", "/settings", { setDefaultSkill: { name: "dup", enabled: true } });
    const defaultsBefore = await defaultSkills();
    const globalsBefore = await globalSkillNames();

    const response = await api("POST", "/resources/skills/rename", {
      projectId,
      scope: "project",
      name: "dup",
      newName: "dup2",
    });

    expect(response.status).toBe(400);
    expect(await defaultSkills()).toEqual(defaultsBefore);
    expect(await globalSkillNames()).toEqual(globalsBefore);
  });

  it("rejects project rename without inventing a destination or re-pointing defaults", async () => {
    await writeGlobalSkill("solo");
    await api("PATCH", "/settings", { setDefaultSkill: { name: "solo", enabled: true } });
    const defaultsBefore = await defaultSkills();
    const globalsBefore = await globalSkillNames();

    const response = await api("POST", "/resources/skills/rename", {
      projectId,
      scope: "project",
      name: "solo",
      newName: "solo2",
    });

    expect(response.status).toBe(400);
    expect(await defaultSkills()).toEqual(defaultsBefore);
    expect(await globalSkillNames()).toEqual(globalsBefore);
    expect(await globalSkillNames()).not.toContain("solo2");
  });

  const unixIt = process.platform === "win32" ? it.skip : it;
  unixIt("does not persist reference changes when the SKILL.md update is unsafe", async () => {
    await writeGlobalSkill("unsafe-rename");
    await api("PATCH", "/settings", {
      setDefaultSkill: { name: "unsafe-rename", enabled: true },
    });
    await api("PATCH", `/projects/${projectId}`, {
      assignedSkills: ["formatter", "unsafe-rename"],
    });
    const skillFile = path.join(
      resourceHome,
      ".pi",
      "agent",
      "skills",
      "unsafe-rename",
      "SKILL.md",
    );
    const outside = path.join(resourceHome, "outside-skill.md");
    writeFileSync(outside, "outside-safe");
    rmSync(skillFile);
    symlinkSync(outside, skillFile);

    const response = await api("POST", "/resources/skills/rename", {
      scope: "global",
      name: "unsafe-rename",
      newName: "unsafe-renamed",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("unsafe") });
    expect(existsSync(path.join(resourceHome, ".pi", "agent", "skills", "unsafe-rename"))).toBe(
      true,
    );
    expect(existsSync(path.join(resourceHome, ".pi", "agent", "skills", "unsafe-renamed"))).toBe(
      false,
    );
    expect(await assignedOf()).toContain("unsafe-rename");
    expect(await assignedOf()).not.toContain("unsafe-renamed");
    expect(await defaultSkills()).toContain("unsafe-rename");
    expect(await defaultSkills()).not.toContain("unsafe-renamed");
  });

  it("409 on a name clash and 404 on a missing source", async () => {
    await writeGlobalSkill("clashme");
    expect(
      (
        await api("POST", "/resources/skills/rename", {
          scope: "global",
          name: "formatter",
          newName: "clashme",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await api("POST", "/resources/skills/rename", {
          scope: "global",
          name: "ghost",
          newName: "z",
        })
      ).status,
    ).toBe(404);
  });
});
