import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  MOCK_MODEL_ID,
  MOCK_PROVIDER_ID,
  startMockProvider,
  writeMockProviderExtension,
  type MockProviderServer,
} from "@agent-deck/testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";
const home = mkdtempSync(path.join(tmpdir(), "collection-pi-home-"));
const dataDir = mkdtempSync(path.join(tmpdir(), "collection-pi-data-"));
const cwd = mkdtempSync(path.join(tmpdir(), "collection-pi-cwd-"));
const managedRoot = path.join(dataDir, "SkillRepositories");
const cloneRoot = path.join(managedRoot, "collection-repo");
const skillRoot = path.join(cloneRoot, "collection-skill");
const outsideSkillRoot = path.join(dataDir, "outside", "corrupt-skill");
let mock: MockProviderServer;
let server: AgentDeckServer;
let extension: string;

async function createSession(extra: { agentName?: string; skills?: string[] }): Promise<string> {
  const response = await fetch(`http://127.0.0.1:${server.port}/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cwd,
      provider: MOCK_PROVIDER_ID,
      model: MOCK_MODEL_ID,
      extensions: [extension],
      env: { HOME: home, USERPROFILE: home, PI_SKIP_VERSION_CHECK: "1" },
      ...extra,
    }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as { session: { id: string } }).session.id;
}

beforeAll(async () => {
  mkdirSync(path.join(cloneRoot, ".git"), { recursive: true });
  mkdirSync(skillRoot, { recursive: true });
  mkdirSync(outsideSkillRoot, { recursive: true });
  writeFileSync(
    path.join(outsideSkillRoot, "SKILL.md"),
    "---\nname: corrupt-skill\ndescription: Must not load\n---\n\nUnsafe.\n",
  );
  writeFileSync(
    path.join(skillRoot, "SKILL.md"),
    "---\nname: collection-skill\ndescription: Collection skill\n---\n\nUse this skill.\n",
  );
  const agentDir = path.join(home, ".pi", "agent", "agents");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    path.join(agentDir, "collector.md"),
    "---\nname: collector\nskills: collection-skill\n---\n\nUse the collection skill.\n",
  );
  writeFileSync(
    path.join(dataDir, "app-settings.json"),
    JSON.stringify({
      defaultSkills: ["collection-skill", "corrupt-skill"],
      importedSkillRepositories: [
        {
          id: "repo",
          remoteUrl: "https://example.invalid/collection.git",
          scope: "global",
          clonePath: cloneRoot,
          skillNames: ["collection-skill"],
          storageMode: "collection-v1",
          collectionId: "collection",
          selectedSkillRelativePaths: ["collection-skill"],
          syncedSkillRelativePaths: ["collection-skill"],
          skillRootPaths: [skillRoot],
          lastSyncedCommit: "deadbeef",
          importedAt: new Date().toISOString(),
        },
        {
          id: "corrupt-repo",
          remoteUrl: "https://example.invalid/corrupt.git",
          scope: "global",
          clonePath: path.join(dataDir, "outside"),
          skillNames: ["corrupt-skill"],
          storageMode: "collection-v1",
          collectionId: "corrupt-collection",
          lastSyncedCommit: "deadbeef",
          importedAt: new Date().toISOString(),
        },
      ],
      skillCollections: [
        { id: "collection", name: "Collection", repositoryId: "repo", skillRootPaths: [skillRoot] },
        {
          id: "corrupt-collection",
          name: "Corrupt",
          repositoryId: "corrupt-repo",
          skillRootPaths: [outsideSkillRoot],
        },
      ],
    }),
  );
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: home });
  mock = await startMockProvider({ reply: () => "done" });
  extension = writeMockProviderExtension(mock.baseUrl);
  server = await startServer({ dataDir, skillRepositoriesRoot: managedRoot });
}, 20_000);

afterAll(async () => {
  await server.close();
  await mock.close();
  delete process.env.AGENT_DECK_PI_ENV;
});

describe("in-place collection skill injection", () => {
  it("injects a collection skill declared by a named agent", async () => {
    const id = await createSession({ agentName: "collector" });
    const commands = await (
      await fetch(`http://127.0.0.1:${server.port}/sessions/${id}/commands`)
    ).text();
    expect(commands).toContain("collection-skill");
  });

  it("injects a collection skill assigned directly to a parent session", async () => {
    const id = await createSession({});
    const commands = await (
      await fetch(`http://127.0.0.1:${server.port}/sessions/${id}/commands`)
    ).text();
    expect(commands).toContain("collection-skill");
  });

  it("does not discover, inject, or update corrupt out-of-root persisted paths", async () => {
    const skills = await (await fetch(`http://127.0.0.1:${server.port}/resources/skills`)).text();
    expect(skills).not.toContain("corrupt-skill");

    const id = await createSession({});
    const commands = await (
      await fetch(`http://127.0.0.1:${server.port}/sessions/${id}/commands`)
    ).text();
    expect(commands).not.toContain("corrupt-skill");

    const update = await fetch(
      `http://127.0.0.1:${server.port}/resources/skill-repos/corrupt-repo/update`,
      { method: "POST" },
    );
    expect(update.status).toBe(409);
    expect(await update.text()).toContain("outside the trusted SkillRepositories directory");

    const forget = await fetch(
      `http://127.0.0.1:${server.port}/resources/skill-repos/corrupt-repo`,
      { method: "DELETE" },
    );
    expect(forget.status).toBe(409);
    expect(await forget.text()).toContain("outside the trusted SkillRepositories directory");
    const repositories = await (
      await fetch(`http://127.0.0.1:${server.port}/resources/skill-repos`)
    ).text();
    expect(repositories).toContain("corrupt-repo");
  });

  it("revalidates the active snapshot leaf before Pi skillDirs derivation", async () => {
    const inventory = (await (
      await fetch(`http://127.0.0.1:${server.port}/resources/skills`)
    ).json()) as { skills: Array<{ name: string; baseDir: string }> };
    const activeRoot = inventory.skills.find((skill) => skill.name === "collection-skill")!.baseDir;
    const leaf = path.dirname(path.dirname(activeRoot));
    renameSync(leaf, `${leaf}-captured`);
    const outside = path.join(dataDir, "snapshot-swap-victim");
    mkdirSync(path.join(outside, "skills", "0"), { recursive: true });
    writeFileSync(
      path.join(outside, "skills", "0", "SKILL.md"),
      "---\nname: collection-skill\ndescription: External sentinel\n---\nnever inject",
    );
    symlinkSync(outside, leaf, process.platform === "win32" ? "junction" : "dir");

    const id = await createSession({ agentName: "collector" });
    const commands = await (
      await fetch(`http://127.0.0.1:${server.port}/sessions/${id}/commands`)
    ).text();
    expect(commands).not.toContain("collection-skill");
    expect(commands).not.toContain("External sentinel");
  });
});
