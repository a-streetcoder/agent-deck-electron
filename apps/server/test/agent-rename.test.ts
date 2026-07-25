import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

/**
 * Agent rename route: the writable native catalog is global. Global renames
 * update project defaults, while the removed project catalog is rejected
 * without changing defaults or global resources.
 */

const resourceHome = mkdtempSync(path.join(tmpdir(), "agent-rename-home-"));
const projectDir = mkdtempSync(path.join(tmpdir(), "agent-rename-proj-"));
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

async function defaultAgentOf(): Promise<string | undefined> {
  const { projects } = (await (await api("GET", "/projects")).json()) as {
    projects: Array<{ id: string; defaultAgentName?: string }>;
  };
  return projects.find((p) => p.id === projectId)!.defaultAgentName;
}

async function globalAgentNames(): Promise<string[]> {
  const { agents } = (await (
    await api("GET", `/resources/agents?projectId=${projectId}`)
  ).json()) as { agents: Array<{ name: string; scope: string }> };
  return agents
    .filter((agent) => agent.scope === "global")
    .map((agent) => agent.name)
    .sort();
}

beforeAll(async () => {
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: resourceHome });
  server = await startServer({ dataDir });
  projectId = (
    (await (await api("POST", "/projects", { path: projectDir })).json()) as {
      project: { id: string };
    }
  ).project.id;
  for (const name of ["helper", "other"]) {
    const res = await api("PUT", "/resources/agents", {
      scope: "global",
      name,
      edit: { description: name, body: `You are ${name}.` },
    });
    if (!res.ok) throw new Error(await res.text());
  }
  await api("PATCH", `/projects/${projectId}`, { defaultAgentName: "helper" });
});

afterAll(async () => {
  delete process.env.AGENT_DECK_PI_ENV;
  await server.close();
});

describe("POST /resources/agents/rename", () => {
  it("renames a global agent and re-points the project default", async () => {
    expect(await defaultAgentOf()).toBe("helper");

    const res = await api("POST", "/resources/agents/rename", {
      scope: "global",
      name: "helper",
      newName: "helper2",
    });
    expect(res.status).toBe(200);

    expect(await globalAgentNames()).toEqual(["helper2", "other"]);
    expect(await defaultAgentOf()).toBe("helper2");
  });

  it("returns 409 on a global name clash, leaving the default untouched", async () => {
    const res = await api("POST", "/resources/agents/rename", {
      scope: "global",
      name: "helper2",
      newName: "other",
    });
    expect(res.status).toBe(409);
    expect(await defaultAgentOf()).toBe("helper2");
  });

  it("returns 404 when the global source agent does not exist", async () => {
    const res = await api("POST", "/resources/agents/rename", {
      scope: "global",
      name: "ghost",
      newName: "x",
    });
    expect(res.status).toBe(404);
  });

  it("rejects project scope without changing the default or global catalog", async () => {
    const namesBefore = await globalAgentNames();
    const defaultBefore = await defaultAgentOf();

    const res = await api("POST", "/resources/agents/rename", {
      projectId,
      scope: "project",
      name: "helper2",
      newName: "project-helper",
    });

    expect(res.status).toBe(400);
    expect(await res.text()).toContain("project resource catalogs are not supported");
    expect(await globalAgentNames()).toEqual(namesBefore);
    expect(await defaultAgentOf()).toBe(defaultBefore);
  });

  it("re-points a default that resolved to a renamed global agent", async () => {
    await api("PUT", "/resources/agents", {
      scope: "global",
      name: "lonely",
      edit: { body: "g" },
    });
    await api("PATCH", `/projects/${projectId}`, { defaultAgentName: "lonely" });

    const res = await api("POST", "/resources/agents/rename", {
      scope: "global",
      name: "lonely",
      newName: "lonely2",
    });
    expect(res.status).toBe(200);
    expect(await defaultAgentOf()).toBe("lonely2");
  });
});
