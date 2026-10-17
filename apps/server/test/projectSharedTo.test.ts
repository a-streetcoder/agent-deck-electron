import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { ProjectIndex } from "../src/persistence.ts";
import { githubRepoOfOrigin, registerProjectRoutes } from "../src/routes/projects.ts";

/** SRV-12b: the local project's shared-server link and the origin Make shared reads. */
const scratch = mkdtempSync(path.join(tmpdir(), "deck-shared-to-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd });

function harness(sharedServer = false, extra: Partial<ServerContext> = {}) {
  const fastify = Fastify({ logger: false });
  const projects = new ProjectIndex(mkdtempSync(path.join(scratch, "data-")));
  registerProjectRoutes({
    fastify,
    projects,
    sessions: { list: () => [] },
    watchProject: () => {},
    broadcast: () => {},
    forgetMcpProbes: () => {},
    sharedServer,
    projectHasEffectiveMcpGrant: () => false,
    rootsFor: () => ({ home: scratch }),
    mcpAssignments: { projectServerNames: () => [] },
    projectImages: { assignment: () => undefined },
    ...extra,
  } as unknown as ServerContext);
  const add = (name: string, folder: string) => {
    projects.upsert({ id: name, path: folder, name, createdAt: "now" });
  };
  return { fastify, projects, add };
}

describe("PATCH /projects/:id sharedTo", () => {
  it("stores a valid link, fills sharedAt and unlinks with null", async () => {
    const { fastify, projects, add } = harness();
    add("p", scratch);
    const patch = (sharedTo: unknown) =>
      fastify.inject({ method: "PATCH", url: "/projects/p", payload: { sharedTo } });

    const stored = await patch({
      serverOrigin: "https://deck.example.test",
      projectId: "srv-1",
      repoId: 42,
    });
    expect(stored.statusCode).toBe(200);
    const link = projects.find((p) => p.id === "p")?.sharedTo;
    expect(link).toMatchObject({
      serverOrigin: "https://deck.example.test",
      projectId: "srv-1",
      repoId: 42,
    });
    expect(Number.isNaN(Date.parse(link?.sharedAt ?? ""))).toBe(false);

    expect((await patch(null)).statusCode).toBe(200);
    expect(projects.find((p) => p.id === "p")?.sharedTo).toBeUndefined();
    await fastify.close();
  });

  it("is refused on a shared server: a server project never points at another server", async () => {
    const { fastify, projects, add } = harness(true);
    add("p", scratch);
    const response = await fastify.inject({
      method: "PATCH",
      url: "/projects/p",
      payload: { sharedTo: { serverOrigin: "https://deck.example.test", projectId: "x" } },
    });
    expect(response.statusCode).toBe(409);
    expect(projects.find((p) => p.id === "p")?.sharedTo).toBeUndefined();
    await fastify.close();
  });

  it("refuses a non-https or non-origin server and an empty project id", async () => {
    const { fastify, projects, add } = harness();
    add("p", scratch);
    for (const sharedTo of [
      { serverOrigin: "http://deck.example.test", projectId: "x" },
      { serverOrigin: "https://deck.example.test/path", projectId: "x" },
      { serverOrigin: "https://user:pw@deck.example.test", projectId: "x" },
      { serverOrigin: "https://deck.example.test", projectId: "" },
      { serverOrigin: "https://deck.example.test", projectId: "x", token: "extra" },
    ]) {
      const response = await fastify.inject({
        method: "PATCH",
        url: "/projects/p",
        payload: { sharedTo },
      });
      expect(response.statusCode, JSON.stringify(sharedTo)).toBe(400);
    }
    expect(projects.find((p) => p.id === "p")?.sharedTo).toBeUndefined();
    await fastify.close();
  });
});

describe("GET /projects/:id/origin", () => {
  it("reads the origin remote of a git project, null without one, 404 when unknown", async () => {
    const { fastify, add } = harness();
    const withOrigin = path.join(scratch, "with origin");
    const withoutOrigin = path.join(scratch, "without-origin");
    const plainFolder = mkdtempSync(path.join(tmpdir(), "deck-plain-"));
    for (const folder of [withOrigin, withoutOrigin]) {
      mkdirSync(folder);
      git(folder, "init", "-q");
    }
    // A credential in the remote URL must never come back (fake value).
    git(withOrigin, "remote", "add", "origin", "https://user:fake-secret@github.com/acme/app.git");
    const inside = path.join(withOrigin, "packages", "inner");
    mkdirSync(inside, { recursive: true });
    add("a", withOrigin);
    add("b", withoutOrigin);
    add("c", plainFolder);
    add("d", inside);

    const a = await fastify.inject({ method: "GET", url: "/projects/a/origin" });
    expect(a.json()).toEqual({ hasOrigin: true, github: null, topLevel: true });
    expect(a.body).not.toContain("fake-secret");
    git(withOrigin, "remote", "set-url", "origin", "git@github.com:acme/app.git");
    const a2 = await fastify.inject({ method: "GET", url: "/projects/a/origin" });
    expect(a2.json()).toEqual({
      hasOrigin: true,
      github: { owner: "acme", name: "app" },
      topLevel: true,
    });
    const b = await fastify.inject({ method: "GET", url: "/projects/b/origin" });
    expect(b.json()).toEqual({ hasOrigin: false, github: null, topLevel: true });
    const c = await fastify.inject({ method: "GET", url: "/projects/c/origin" });
    expect(c.json()).toEqual({ hasOrigin: false, github: null, topLevel: false });
    // A folder inside a larger repository is not its root.
    const d = await fastify.inject({ method: "GET", url: "/projects/d/origin" });
    expect(d.json()).toMatchObject({ hasOrigin: true, topLevel: false });
    rmSync(plainFolder, { recursive: true, force: true });
    const missing = await fastify.inject({ method: "GET", url: "/projects/nope/origin" });
    expect(missing.statusCode).toBe(404);
    await fastify.close();
  });

  it("parses GitHub origins only", () => {
    expect(githubRepoOfOrigin("https://github.com/acme/app.git")).toEqual({
      owner: "acme",
      name: "app",
    });
    expect(githubRepoOfOrigin("ssh://git@github.com/acme/app")).toEqual({
      owner: "acme",
      name: "app",
    });
    expect(githubRepoOfOrigin("https://gitlab.com/acme/app.git")).toBeNull();
    expect(githubRepoOfOrigin("https://github.com/acme/app is:open")).toBeNull();
  });
});

describe("POST /projects on a sandboxed server (ADR 0007)", () => {
  it("refuses a reserved folder with 400 and registers an ordinary one", async () => {
    const reserved = path.join(scratch, "data", "users");
    const ordinary = path.join(scratch, "ordinary");
    mkdirSync(reserved, { recursive: true });
    mkdirSync(ordinary, { recursive: true });
    const { fastify, projects } = harness(true, {
      sandboxRootProblem: (root: string) =>
        root === reserved ? "overlaps the server's users folder" : undefined,
    });
    const refused = await fastify.inject({
      method: "POST",
      url: "/projects",
      payload: { path: reserved },
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toMatchObject({ code: "project_path_reserved" });
    expect(projects.list()).toEqual([]);
    const ok = await fastify.inject({
      method: "POST",
      url: "/projects",
      payload: { path: ordinary },
    });
    expect(ok.statusCode).toBeLessThan(300);
    await fastify.close();
  });
});
