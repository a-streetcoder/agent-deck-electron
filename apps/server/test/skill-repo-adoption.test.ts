import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";
import { sanitizedRepositoryFolder } from "../src/skillRepositories.ts";

vi.setConfig({ testTimeout: 20_000 });
process.env.AGENT_DECK_TEST = "1";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function createSource(root: string, body = "Original body."): string {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Test"]);
  git(root, ["config", "core.autocrlf", "false"]);
  writeFileSync(
    path.join(root, "SKILL.md"),
    `---\nname: adopted-skill\ndescription: Adopted\n---\n\n${body}\n`,
  );
  writeFileSync(path.join(root, "native-marker.txt"), "must remain untouched\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  return root;
}

function cloneSource(source: string, destination: string): void {
  execFileSync("git", ["clone", "--config", "core.autocrlf=false", source, destination]);
}

async function startIsolatedServer(skillRepositoriesRoot: string): Promise<AgentDeckServer> {
  const home = mkdtempSync(path.join(tmpdir(), "adoption-home-"));
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: home });
  return startServer({
    dataDir: mkdtempSync(path.join(tmpdir(), "adoption-data-")),
    skillRepositoriesRoot,
  });
}

async function importRepository(server: AgentDeckServer, source: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${server.port}/resources/skills/import-git`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "global", url: source }),
  });
}

describe("existing native-style skill repository adoption", () => {
  it("registers a matching existing clone without modifying its files or Git state", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "adoption-matching-"));
    const source = pathToFileURL(
      realpathSync(createSource(path.join(parent, "acme", "skills"))),
    ).href;
    const collectionRoot = path.join(parent, "SkillRepositories");
    const clonePath = path.join(collectionRoot, sanitizedRepositoryFolder(source));
    mkdirSync(collectionRoot, { recursive: true });
    cloneSource(source, clonePath);
    git(clonePath, ["remote", "set-url", "origin", source]);
    const marker = path.join(clonePath, "native-marker.txt");
    const before = {
      head: git(clonePath, ["rev-parse", "HEAD"]),
      origin: git(clonePath, ["remote", "get-url", "origin"]),
      status: git(clonePath, ["status", "--porcelain=v1"]),
      skill: readFileSync(path.join(clonePath, "SKILL.md"), "utf8"),
      marker: readFileSync(marker, "utf8"),
    };

    expect(before.status).toBe("");

    const server = await startIsolatedServer(collectionRoot);
    try {
      const response = await importRepository(server, source);
      const responseBody = await response.text();
      expect(response.status, responseBody).toBe(200);
      expect(JSON.parse(responseBody)).toMatchObject({ imported: ["adopted-skill"] });
      expect(git(clonePath, ["rev-parse", "HEAD"])).toBe(before.head);
      expect(git(clonePath, ["remote", "get-url", "origin"])).toBe(before.origin);
      expect(git(clonePath, ["status", "--porcelain=v1"])).toBe(before.status);
      expect(readFileSync(path.join(clonePath, "SKILL.md"), "utf8")).toBe(before.skill);
      expect(readFileSync(marker, "utf8")).toBe(before.marker);

      const repositories = (await (
        await fetch(`http://127.0.0.1:${server.port}/resources/skill-repos`)
      ).json()) as {
        repos: Array<{ storageMode?: string; clonePath?: string; skillNames: string[] }>;
      };
      expect(repositories.repos).toContainEqual(
        expect.objectContaining({ storageMode: "collection-v1", skillNames: ["adopted-skill"] }),
      );
    } finally {
      await server.close();
      delete process.env.AGENT_DECK_PI_ENV;
    }
  });

  it("adopts an SSH-origin clone when requested through the equivalent HTTPS URL", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "adoption-transport-"));
    const localSource = createSource(path.join(parent, "source"));
    const requested = "https://github.com/owner/repo.git";
    const collectionRoot = path.join(parent, "SkillRepositories");
    const clonePath = path.join(collectionRoot, sanitizedRepositoryFolder(requested));
    mkdirSync(collectionRoot, { recursive: true });
    cloneSource(localSource, clonePath);
    git(clonePath, ["remote", "set-url", "origin", "git@github.com:owner/repo.git"]);
    const beforeHead = git(clonePath, ["rev-parse", "HEAD"]);

    const server = await startIsolatedServer(collectionRoot);
    try {
      const response = await importRepository(server, requested);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ imported: ["adopted-skill"] });
      expect(git(clonePath, ["rev-parse", "HEAD"])).toBe(beforeHead);
      expect(git(clonePath, ["remote", "get-url", "origin"])).toBe("git@github.com:owner/repo.git");
    } finally {
      await server.close();
      delete process.env.AGENT_DECK_PI_ENV;
    }
  });

  it("rejects an existing non-Git directory without deleting it", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "adoption-invalid-"));
    const source = createSource(path.join(parent, "acme", "skills"));
    const collectionRoot = path.join(parent, "SkillRepositories");
    const clonePath = path.join(collectionRoot, sanitizedRepositoryFolder(source));
    mkdirSync(clonePath, { recursive: true });
    const marker = path.join(clonePath, "native-marker.txt");
    writeFileSync(marker, "do not delete\n");

    const server = await startIsolatedServer(collectionRoot);
    try {
      const response = await importRepository(server, source);
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("not a valid Git clone");
      expect(readFileSync(marker, "utf8")).toBe("do not delete\n");
    } finally {
      await server.close();
      delete process.env.AGENT_DECK_PI_ENV;
    }
  });

  it("rejects an existing clone whose origin belongs to a different repository", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "adoption-mismatch-"));
    const requested = createSource(path.join(parent, "requested", "acme", "skills"), "Requested");
    const different = createSource(path.join(parent, "different", "acme", "skills"), "Different");
    const collectionRoot = path.join(parent, "SkillRepositories");
    const clonePath = path.join(collectionRoot, sanitizedRepositoryFolder(requested));
    mkdirSync(collectionRoot, { recursive: true });
    cloneSource(different, clonePath);
    const beforeHead = git(clonePath, ["rev-parse", "HEAD"]);
    const beforeSkill = readFileSync(path.join(clonePath, "SKILL.md"), "utf8");

    const server = await startIsolatedServer(collectionRoot);
    try {
      const response = await importRepository(server, requested);
      expect(response.status).toBe(409);
      expect(await response.text()).toContain("different origin remote");
      expect(existsSync(clonePath)).toBe(true);
      expect(git(clonePath, ["rev-parse", "HEAD"])).toBe(beforeHead);
      expect(readFileSync(path.join(clonePath, "SKILL.md"), "utf8")).toBe(beforeSkill);
      const repositories = await (
        await fetch(`http://127.0.0.1:${server.port}/resources/skill-repos`)
      ).text();
      expect(repositories).not.toContain("adopted-skill");
    } finally {
      await server.close();
      delete process.env.AGENT_DECK_PI_ENV;
    }
  });
});
