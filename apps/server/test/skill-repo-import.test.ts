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
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";
import { sanitizedRepositoryFolder } from "../src/skillRepositories.ts";

vi.setConfig({ testTimeout: 25_000 });
process.env.AGENT_DECK_TEST = "1";

let server: AgentDeckServer;
let repoId: string;
const tmpHome = mkdtempSync(path.join(tmpdir(), "pi-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "agent-deck-data-"));
const collectionRoot = mkdtempSync(path.join(tmpdir(), "skill-collections-"));
const repo = mkdtempSync(path.join(tmpdir(), "skillrepo-"));

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repo, stdio: "ignore" });
}

async function repos(): Promise<Array<Record<string, unknown>>> {
  return (
    (await (await fetch(`http://127.0.0.1:${server.port}/resources/skill-repos`)).json()) as {
      repos: Array<Record<string, unknown>>;
    }
  ).repos;
}

beforeAll(async () => {
  git(["init", "-b", "main"]);
  git(["config", "user.email", "t@example.com"]);
  git(["config", "user.name", "Test"]);
  mkdirSync(path.join(repo, "web-scraper"), { recursive: true });
  writeFileSync(
    path.join(repo, "web-scraper", "SKILL.md"),
    "---\nname: web-scraper\ndescription: Scrape web pages\n---\n\nScrape web pages.\n",
  );
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: tmpHome, USERPROFILE: tmpHome });
  server = await startServer({ dataDir, skillRepositoriesRoot: collectionRoot });
});

afterAll(async () => {
  await server.close();
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("in-place git skill collections", () => {
  it("imports into the deterministic fixed root without making a global copy", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/resources/skills/import-git`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "global", url: repo }),
    });
    expect(response.status).toBe(200);
    repoId = ((await response.json()) as { repoId: string }).repoId;

    const clone = path.join(collectionRoot, sanitizedRepositoryFolder(repo));
    const skillRoot = path.join(clone, "web-scraper");
    const canonicalSkillRoot = realpathSync(skillRoot);
    expect(existsSync(path.join(skillRoot, "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(tmpHome, ".pi", "agent", "skills", "web-scraper"))).toBe(false);

    const [record] = await repos();
    expect(record).toMatchObject({
      id: repoId,
      storageMode: "collection-v1",
      skillNames: ["web-scraper"],
      selectedSkillRelativePaths: ["web-scraper"],
      syncedSkillRelativePaths: ["web-scraper"],
      skillRootPaths: [canonicalSkillRoot],
    });
    const persisted = JSON.parse(readFileSync(path.join(dataDir, "app-settings.json"), "utf8")) as {
      importedSkillRepositories: Array<{ id: string }>;
      skillCollections: Array<{ repositoryId: string; skillRootPaths: string[] }>;
    };
    expect(persisted.importedSkillRepositories.some((item) => item.id === repoId)).toBe(true);
    expect(persisted.skillCollections).toContainEqual(
      expect.objectContaining({ repositoryId: repoId, skillRootPaths: [canonicalSkillRoot] }),
    );
    const skills = (await (
      await fetch(`http://127.0.0.1:${server.port}/resources/skills`)
    ).json()) as { skills: Array<{ name: string; scope: string; baseDir: string }> };
    expect(skills.skills).toContainEqual(
      expect.objectContaining({
        name: "web-scraper",
        scope: "library",
        baseDir: canonicalSkillRoot,
      }),
    );
    const edit = await fetch(`http://127.0.0.1:${server.port}/resources/skills`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope: "library", name: "web-scraper", edit: { body: "No." } }),
    });
    expect(edit.status).toBe(400);
    expect(readFileSync(path.join(skillRoot, "SKILL.md"), "utf8")).toContain("Scrape web pages.");
  });

  it("rejects an update when the managed clone is dirty", async () => {
    const clone = path.join(collectionRoot, sanitizedRepositoryFolder(repo));
    const file = path.join(clone, "web-scraper", "SKILL.md");
    writeFileSync(file, readFileSync(file, "utf8") + "\nlocal edit\n");
    const response = await fetch(
      `http://127.0.0.1:${server.port}/resources/skill-repos/${repoId}/update`,
      { method: "POST" },
    );
    expect(response.status).toBe(409);
    expect(readFileSync(file, "utf8")).toContain("local edit");
    execFileSync("git", ["checkout", "--", "web-scraper/SKILL.md"], { cwd: clone });
  });

  it("retains removed selected intent and never selects a new upstream skill", async () => {
    execFileSync("git", ["rm", "-r", "web-scraper"], { cwd: repo, stdio: "ignore" });
    mkdirSync(path.join(repo, "new-skill"));
    writeFileSync(
      path.join(repo, "new-skill", "SKILL.md"),
      "---\nname: new-skill\ndescription: New\n---\n\nNew.\n",
    );
    git(["add", "-A"]);
    git(["commit", "-m", "replace skill"]);

    const response = await fetch(
      `http://127.0.0.1:${server.port}/resources/skill-repos/${repoId}/update`,
      { method: "POST" },
    );
    expect(response.status).toBe(200);
    const record = (await repos())[0]!;
    expect(record.selectedSkillRelativePaths).toEqual(["web-scraper"]);
    expect(record.syncedSkillRelativePaths).toEqual([]);
    expect(record.skillNames).toEqual([]);
    expect(record.skillRootPaths).toEqual([]);
    const skills = (await (
      await fetch(`http://127.0.0.1:${server.port}/resources/skills`)
    ).json()) as { skills: Array<{ name: string }> };
    expect(skills.skills.some((skill) => skill.name === "new-skill")).toBe(false);
  });

  it("forget removes collection metadata and its managed clone", async () => {
    const clone = path.join(collectionRoot, sanitizedRepositoryFolder(repo));
    const response = await fetch(
      `http://127.0.0.1:${server.port}/resources/skill-repos/${repoId}`,
      { method: "DELETE" },
    );
    expect(response.status).toBe(200);
    expect(await repos()).toEqual([]);
    expect(existsSync(clone)).toBe(false);
  });
});
