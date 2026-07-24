import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startServer, type AgentDeckServer } from "../src/index.ts";

vi.setConfig({ testTimeout: 20_000 });
process.env.AGENT_DECK_TEST = "1";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function skill(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: Legacy\n---\n\n${body}\n`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

interface LegacyFixture {
  server: AgentDeckServer;
  clonePath: string;
  copiedSkill: string;
  close(): Promise<void>;
}

async function legacyFixture(options: { localEdit?: boolean } = {}): Promise<LegacyFixture> {
  const dataDir = mkdtempSync(path.join(tmpdir(), "legacy-repo-data-"));
  const home = mkdtempSync(path.join(tmpdir(), "legacy-repo-home-"));
  const upstream = mkdtempSync(path.join(tmpdir(), "legacy-repo-upstream-"));
  const clonePath = path.join(dataDir, "historical-skill-repos", "legacy-id");
  const copiedSkill = path.join(home, ".pi", "agent", "skills", "legacy-skill", "SKILL.md");
  const original = skill("legacy-skill", "Original body.");

  git(upstream, ["init", "-b", "main"]);
  git(upstream, ["config", "user.email", "test@example.com"]);
  git(upstream, ["config", "user.name", "Test"]);
  writeFileSync(path.join(upstream, "SKILL.md"), original);
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "-m", "initial"]);
  const initialCommit = git(upstream, ["rev-parse", "HEAD"]);
  mkdirSync(path.dirname(clonePath), { recursive: true });
  execFileSync("git", ["clone", upstream, clonePath]);

  mkdirSync(path.dirname(copiedSkill), { recursive: true });
  writeFileSync(copiedSkill, options.localEdit ? skill("legacy-skill", "Local edit.") : original);

  writeFileSync(path.join(upstream, "SKILL.md"), skill("legacy-skill", "Upstream body."));
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "-m", "update"]);

  writeFileSync(
    path.join(dataDir, "app-settings.json"),
    JSON.stringify({
      importedSkillRepositories: [
        {
          id: "legacy-id",
          remoteUrl: upstream,
          ref: "main",
          scope: "global",
          clonePath,
          skillNames: ["legacy-skill"],
          skillHashes: { "legacy-skill": sha256(original) },
          lastSyncedCommit: initialCommit,
          importedAt: "2026-01-01T00:00:00.000Z",
        },
      ],
    }),
  );
  process.env.AGENT_DECK_PI_ENV = JSON.stringify({ HOME: home });
  const server = await startServer({
    dataDir,
    // Deliberately different: this record predates collection-v1 fixed-root storage.
    skillRepositoriesRoot: path.join(dataDir, "new-collections"),
  });
  return {
    server,
    clonePath,
    copiedSkill,
    close: async () => {
      await server.close();
      delete process.env.AGENT_DECK_PI_ENV;
    },
  };
}

describe("legacy copied skill repository compatibility", () => {
  it("updates from its historical clone root outside SkillRepositories", async () => {
    const fixture = await legacyFixture();
    try {
      const response = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ updated: true, conflicts: [] });
      expect(readFileSync(fixture.copiedSkill, "utf8")).toContain("Upstream body.");
    } finally {
      await fixture.close();
    }
  });

  it("resolves a legacy conflict from its historical clone root", async () => {
    const fixture = await legacyFixture({ localEdit: true });
    try {
      const update = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(update.status).toBe(200);
      expect(await update.json()).toMatchObject({ conflicts: ["legacy-skill"] });
      expect(readFileSync(fixture.copiedSkill, "utf8")).toContain("Local edit.");

      const resolve = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "legacy-skill", resolution: "remote" }),
        },
      );
      expect(resolve.status).toBe(200);
      expect(readFileSync(fixture.copiedSkill, "utf8")).toContain("Upstream body.");
    } finally {
      await fixture.close();
    }
  });

  it("forgets metadata and clone while retaining the copied catalog skill", async () => {
    const fixture = await legacyFixture();
    try {
      const response = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id`,
        { method: "DELETE" },
      );
      expect(response.status).toBe(200);
      expect(existsSync(fixture.clonePath)).toBe(false);
      expect(existsSync(fixture.copiedSkill)).toBe(true);
    } finally {
      await fixture.close();
    }
  });
});
