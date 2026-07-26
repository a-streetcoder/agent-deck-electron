import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";
import { ManagedSkillRepositories } from "../src/skillRepositories.ts";

process.env.AGENT_DECK_TEST = "1";
let server: AgentDeckServer | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
});

function record(clonePath: string, skillRoot: string, id = "repo") {
  return {
    id,
    remoteUrl: "https://example.invalid/skills.git",
    scope: "global" as const,
    clonePath,
    skillNames: ["managed-skill"],
    storageMode: "collection-v1" as const,
    collectionId: `${id}-collection`,
    selectedSkillRelativePaths: ["skill"],
    syncedSkillRelativePaths: ["skill"],
    skillRootPaths: [skillRoot],
    lastSyncedCommit: "deadbeef",
    importedAt: new Date().toISOString(),
  };
}

function writeSettings(dataDir: string, repository: ReturnType<typeof record>): void {
  writeFileSync(
    path.join(dataDir, "app-settings.json"),
    JSON.stringify({
      importedSkillRepositories: [repository],
      skillCollections: [
        {
          id: repository.collectionId,
          name: "Managed",
          repositoryId: repository.id,
          skillRootPaths: repository.skillRootPaths,
        },
      ],
    }),
  );
}

describe("collection-v1 managed root security", () => {
  it("refuses a linked SkillRepositories trust anchor without touching outside", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "managed-root-link-"));
    const outside = mkdtempSync(path.join(tmpdir(), "managed-root-victim-"));
    const sentinel = path.join(outside, "sentinel");
    writeFileSync(sentinel, "safe");
    symlinkSync(
      outside,
      path.join(dataDir, "SkillRepositories"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(startServer({ dataDir })).rejects.toThrow(/real directory/);
    expect(readFileSync(sentinel, "utf8")).toBe("safe");
  });

  it("lists but quarantines an external persisted collection from scan, update, and delete", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "managed-external-data-"));
    const outside = mkdtempSync(path.join(tmpdir(), "managed-external-victim-"));
    const skillRoot = path.join(outside, "skill");
    mkdirSync(path.join(outside, ".git"));
    mkdirSync(skillRoot);
    writeFileSync(path.join(skillRoot, "SKILL.md"), "---\nname: managed-skill\n---\nunsafe");
    const sentinel = path.join(outside, "sentinel");
    writeFileSync(sentinel, "safe");
    writeSettings(dataDir, record(outside, skillRoot));
    server = await startServer({ dataDir });

    const base = `http://127.0.0.1:${server.port}`;
    const listed = (await (await fetch(`${base}/resources/skill-repos`)).json()) as {
      repos: Array<{ available: boolean; unavailable?: { code: string } }>;
    };
    expect(listed.repos[0]).toMatchObject({
      available: false,
      unavailable: { code: "MANAGED_SKILL_REPOSITORY_UNAVAILABLE" },
    });
    const skills = (await (await fetch(`${base}/resources/skills`)).json()) as {
      skills: Array<{ name: string }>;
    };
    expect(skills.skills.some((skill) => skill.name === "managed-skill")).toBe(false);
    expect(
      (await fetch(`${base}/resources/skill-repos/repo/check`, { method: "POST" })).status,
    ).toBe(409);
    expect(
      (await fetch(`${base}/resources/skill-repos/repo/update`, { method: "POST" })).status,
    ).toBe(409);
    expect((await fetch(`${base}/resources/skill-repos/repo`, { method: "DELETE" })).status).toBe(
      409,
    );
    const removed = await fetch(`${base}/resources/skill-repos/repo/record`, {
      method: "DELETE",
    });
    expect(removed.status, await removed.text()).toBe(200);
    expect(readFileSync(sentinel, "utf8")).toBe("safe");
    expect(
      ((await (await fetch(`${base}/resources/skill-repos`)).json()) as { repos: unknown[] }).repos,
    ).toEqual([]);
    const persisted = JSON.parse(readFileSync(path.join(dataDir, "app-settings.json"), "utf8")) as {
      importedSkillRepositories: unknown[];
    };
    expect(persisted.importedSkillRepositories).toEqual([]);
  });

  it("quarantines across restart and recovers after the managed skill is restored", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "managed-restart-data-"));
    const clone = path.join(dataDir, "SkillRepositories", "owner-repo");
    const skillRoot = path.join(clone, "skill");
    const manifest = path.join(skillRoot, "SKILL.md");
    mkdirSync(path.join(clone, ".git"), { recursive: true });
    mkdirSync(skillRoot);
    writeFileSync(manifest, "---\nname: managed-skill\n---\nsafe");
    writeSettings(dataDir, record(clone, skillRoot));
    server = await startServer({ dataDir });
    await server.close();
    server = undefined;

    const outside = mkdtempSync(path.join(tmpdir(), "managed-restart-victim-"));
    const outsideManifest = path.join(outside, "SKILL.md");
    writeFileSync(outsideManifest, "---\nname: outside\n---\nnever read");
    const capturedSkill = `${skillRoot}-captured`;
    renameSync(skillRoot, capturedSkill);
    symlinkSync(outside, skillRoot, process.platform === "win32" ? "junction" : "dir");
    server = await startServer({ dataDir });
    let listed = (await (
      await fetch(`http://127.0.0.1:${server.port}/resources/skill-repos`)
    ).json()) as { repos: Array<{ available: boolean }> };
    expect(listed.repos).toHaveLength(1);
    expect(listed.repos[0]?.available).toBe(false);
    await server.close();
    server = undefined;

    rmSync(skillRoot, { recursive: true });
    renameSync(capturedSkill, skillRoot);
    writeFileSync(manifest, "---\nname: managed-skill\n---\nrestored");
    server = await startServer({ dataDir });
    listed = (await (
      await fetch(`http://127.0.0.1:${server.port}/resources/skill-repos`)
    ).json()) as { repos: Array<{ available: boolean }> };
    expect(listed.repos[0]?.available).toBe(true);
    expect(readFileSync(outsideManifest, "utf8")).toContain("never read");
  });

  it("rebuilds snapshots from watcher notifications and quarantines an unsafe swap", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "managed-watch-data-"));
    const clone = path.join(dataDir, "SkillRepositories", "owner-repo");
    const skillRoot = path.join(clone, "skill");
    const manifest = path.join(skillRoot, "SKILL.md");
    mkdirSync(path.join(clone, ".git"), { recursive: true });
    mkdirSync(skillRoot);
    writeFileSync(
      manifest,
      "---\nname: watch-snapshot-skill\ndescription: Watch snapshot\n---\nfirst",
    );
    writeSettings(dataDir, record(clone, skillRoot));
    server = await startServer({ dataDir });
    const base = `http://127.0.0.1:${server.port}`;
    const waitFor = async (predicate: () => Promise<boolean>): Promise<void> => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        if (await predicate()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("watcher condition timed out");
    };

    const initialRepos = (await (await fetch(`${base}/resources/skill-repos`)).json()) as {
      repos: Array<{ available: boolean }>;
    };
    expect(initialRepos.repos[0]?.available).toBe(true);
    const initialSkills = (await (await fetch(`${base}/resources/skills`)).json()) as {
      skills: Array<{ name: string }>;
    };
    expect(initialSkills.skills.some((skill) => skill.name === "watch-snapshot-skill")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    writeFileSync(
      manifest,
      "---\nname: watch-snapshot-skill\ndescription: Watch snapshot\n---\nsecond",
    );
    await waitFor(async () => {
      const snapshots = path.join(dataDir, "SkillRepositorySnapshots");
      return readdirSync(snapshots, { recursive: true }).some((entry) => {
        if (!String(entry).endsWith("SKILL.md")) return false;
        return readFileSync(path.join(snapshots, String(entry)), "utf8").includes("second");
      });
    });
    await waitFor(async () => {
      const refreshedSkills = (await (await fetch(`${base}/resources/skills`)).json()) as {
        skills: Array<{ name: string; baseDir: string }>;
      };
      const skill = refreshedSkills.skills.find(
        (candidate) => candidate.name === "watch-snapshot-skill",
      );
      return skill
        ? readFileSync(path.join(skill.baseDir, "SKILL.md"), "utf8").includes("second")
        : false;
    });

    const outside = mkdtempSync(path.join(tmpdir(), "managed-watch-victim-"));
    const outsideManifest = path.join(outside, "SKILL.md");
    writeFileSync(outsideManifest, "---\nname: outside-skill\n---\noutside sentinel");
    const capturedSkillRoot = `${skillRoot}-captured`;
    renameSync(skillRoot, capturedSkillRoot);
    symlinkSync(outside, skillRoot, process.platform === "win32" ? "junction" : "dir");
    // Some watcher backends keep following the renamed inode rather than its old
    // parent entry. Trigger that held watch too; the callback must re-resolve via
    // native clone authority and quarantine the replacement junction.
    writeFileSync(path.join(capturedSkillRoot, "SKILL.md"), "watch trigger");
    await waitFor(async () => {
      const listed = (await (await fetch(`${base}/resources/skill-repos`)).json()) as {
        repos: Array<{ available: boolean }>;
      };
      return listed.repos[0]?.available === false;
    });
    const skills = (await (await fetch(`${base}/resources/skills`)).json()) as {
      skills: Array<{ name: string }>;
    };
    expect(skills.skills.some((skill) => skill.name === "watch-snapshot-skill")).toBe(false);
    expect(skills.skills.some((skill) => skill.name === "outside-skill")).toBe(false);
    expect(readFileSync(outsideManifest, "utf8")).toContain("outside sentinel");
  }, 15_000);

  it("quarantines an active snapshot leaf swap before scanning external content", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "managed-snapshot-leaf-data-"));
    const clone = path.join(dataDir, "SkillRepositories", "owner-repo");
    const skillRoot = path.join(clone, "skill");
    mkdirSync(path.join(clone, ".git"), { recursive: true });
    mkdirSync(skillRoot);
    writeFileSync(
      path.join(skillRoot, "SKILL.md"),
      "---\nname: managed-skill\ndescription: Safe\n---\nsafe",
    );
    writeSettings(dataDir, record(clone, skillRoot));
    server = await startServer({ dataDir });
    const base = `http://127.0.0.1:${server.port}`;
    const initialSkills = (await (await fetch(`${base}/resources/skills`)).json()) as {
      skills: Array<{ name: string; baseDir: string }>;
    };
    const activeRoot = initialSkills.skills.find(
      (skill) => skill.name === "managed-skill",
    )!.baseDir;
    const leaf = path.dirname(path.dirname(activeRoot));
    renameSync(leaf, `${leaf}-captured`);
    const outside = mkdtempSync(path.join(tmpdir(), "managed-snapshot-leaf-victim-"));
    mkdirSync(path.join(outside, "skills", "0"), { recursive: true });
    const sentinel = path.join(outside, "skills", "0", "SKILL.md");
    writeFileSync(
      sentinel,
      "---\nname: outside-snapshot\ndescription: Never scan\n---\nexternal sentinel",
    );
    symlinkSync(outside, leaf, process.platform === "win32" ? "junction" : "dir");

    const skills = (await (await fetch(`${base}/resources/skills`)).json()) as {
      skills: Array<{ name: string }>;
    };
    expect(skills.skills.some((skill) => skill.name === "outside-snapshot")).toBe(false);
    const after = (await (await fetch(`${base}/resources/skill-repos`)).json()) as {
      repos: Array<{ available: boolean }>;
    };
    expect(after.repos[0]?.available).toBe(false);
    expect(readFileSync(sentinel, "utf8")).toContain("external sentinel");
  });

  it("fails closed after root identity replacement", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "managed-replace-data-"));
    const root = path.join(dataDir, "SkillRepositories");
    const clone = path.join(root, "owner-repo");
    const skillRoot = path.join(clone, "skill");
    mkdirSync(path.join(clone, ".git"), { recursive: true });
    mkdirSync(skillRoot);
    writeFileSync(path.join(skillRoot, "SKILL.md"), "---\nname: managed-skill\n---\nsafe");
    writeSettings(dataDir, record(clone, skillRoot));
    server = await startServer({ dataDir });
    const base = `http://127.0.0.1:${server.port}`;

    renameSync(root, `${root}-held`);
    mkdirSync(root);
    expect((await fetch(`${base}/resources/skill-repos/repo`, { method: "DELETE" })).status).toBe(
      409,
    );
    expect(existsSync(path.join(`${root}-held`, "owner-repo", "skill", "SKILL.md"))).toBe(true);
  });

  it("capability-deletes a safe direct child", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "managed-delete-data-"));
    const clone = path.join(dataDir, "SkillRepositories", "owner-repo");
    const skillRoot = path.join(clone, "skill");
    mkdirSync(path.join(clone, ".git"), { recursive: true });
    mkdirSync(skillRoot);
    writeFileSync(path.join(skillRoot, "SKILL.md"), "---\nname: managed-skill\n---\nsafe");
    const repository = record(clone, skillRoot);
    writeSettings(dataDir, repository);
    const directGate = new ManagedSkillRepositories(dataDir);
    expect(directGate.deriveSkillRoots(repository)).toEqual([skillRoot]);
    server = await startServer({ dataDir });

    const response = await fetch(`http://127.0.0.1:${server.port}/resources/skill-repos/repo`, {
      method: "DELETE",
    });
    expect(response.status, await response.text()).toBe(200);
    expect(existsSync(clone)).toBe(false);
  });
});
