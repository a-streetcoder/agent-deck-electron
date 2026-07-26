import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  upstream: string;
  dataDir: string;
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
  writeFileSync(path.join(upstream, "was-file"), "old file");
  mkdirSync(path.join(upstream, "was-dir"));
  writeFileSync(path.join(upstream, "was-dir", "old"), "old nested file");
  git(upstream, ["add", "."]);
  git(upstream, ["commit", "-m", "initial"]);
  const initialCommit = git(upstream, ["rev-parse", "HEAD"]);
  mkdirSync(path.dirname(clonePath), { recursive: true });
  execFileSync("git", ["clone", upstream, clonePath]);

  mkdirSync(path.dirname(copiedSkill), { recursive: true });
  writeFileSync(copiedSkill, options.localEdit ? skill("legacy-skill", "Local edit.") : original);
  writeFileSync(path.join(path.dirname(copiedSkill), "was-file"), "old file");
  mkdirSync(path.join(path.dirname(copiedSkill), "was-dir"));
  writeFileSync(path.join(path.dirname(copiedSkill), "was-dir", "old"), "old nested file");
  writeFileSync(path.join(upstream, "SKILL.md"), skill("legacy-skill", "Upstream body."));
  rmSync(path.join(upstream, "was-file"));
  mkdirSync(path.join(upstream, "was-file"));
  writeFileSync(path.join(upstream, "was-file", "new"), "new nested file");
  rmSync(path.join(upstream, "was-dir"), { recursive: true });
  writeFileSync(path.join(upstream, "was-dir"), "now a file");
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
    // Legacy clone remains external; collection-v1 storage is still anchored.
    skillRepositoriesRoot: path.join(dataDir, "SkillRepositories"),
  });
  return {
    server,
    clonePath,
    copiedSkill,
    upstream,
    dataDir,
    close: async () => {
      await server.close();
      delete process.env.AGENT_DECK_PI_ENV;
    },
  };
}

async function establishTwoSkillBaseline(
  fixture: LegacyFixture,
): Promise<{ alpha: string; beta: string }> {
  rmSync(path.join(fixture.upstream, "SKILL.md"));
  rmSync(path.join(fixture.upstream, "was-file"), { recursive: true });
  rmSync(path.join(fixture.upstream, "was-dir"));
  for (const name of ["alpha", "beta"]) {
    const dir = path.join(fixture.upstream, name);
    mkdirSync(dir);
    writeFileSync(path.join(dir, "SKILL.md"), skill(name, `${name} baseline.`));
  }
  git(fixture.upstream, ["add", "-A"]);
  git(fixture.upstream, ["commit", "-m", "establish two skills"]);
  const response = await fetch(
    `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
    { method: "POST" },
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ conflicts: [] });
  const catalog = path.dirname(path.dirname(fixture.copiedSkill));
  return {
    alpha: path.join(catalog, "alpha", "SKILL.md"),
    beta: path.join(catalog, "beta", "SKILL.md"),
  };
}

function persistedLegacyRecord(fixture: LegacyFixture): {
  lastSyncedCommit: string;
  skillNames: string[];
  skillHashes: Record<string, string>;
} {
  const persisted = JSON.parse(
    readFileSync(path.join(fixture.dataDir, "app-settings.json"), "utf8"),
  ) as {
    importedSkillRepositories: Array<{
      lastSyncedCommit: string;
      skillNames: string[];
      skillHashes: Record<string, string>;
    }>;
  };
  return persisted.importedSkillRepositories[0]!;
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
      const copiedRoot = path.dirname(fixture.copiedSkill);
      expect(readFileSync(path.join(copiedRoot, "was-file", "new"), "utf8")).toBe(
        "new nested file",
      );
      expect(readFileSync(path.join(copiedRoot, "was-dir"), "utf8")).toBe("now a file");
    } finally {
      await fixture.close();
    }
  });

  it("migrates a canonical legacy hash when checkout line endings differ", async () => {
    const fixture = await legacyFixture();
    try {
      git(fixture.clonePath, ["config", "core.autocrlf", "true"]);
      rmSync(path.join(fixture.clonePath, "SKILL.md"));
      git(fixture.clonePath, ["checkout", "HEAD", "--", "SKILL.md"]);
      const checkoutBytes = readFileSync(path.join(fixture.clonePath, "SKILL.md"));
      expect(checkoutBytes.includes(Buffer.from("\r\n"))).toBe(true);
      expect(git(fixture.clonePath, ["status", "--porcelain"])).toBe("");

      const response = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ updated: true, conflicts: [] });
      expect(readFileSync(fixture.copiedSkill, "utf8")).toContain("Upstream body.");
      expect(persistedLegacyRecord(fixture).skillHashes["legacy-skill"]).toMatch(
        /^tree-v1:[0-9a-f]{64}$/,
      );
    } finally {
      await fixture.close();
    }
  });

  it.each(["modify", "add", "delete", "reserved-git"] as const)(
    "holds an asset %s as a whole-skill conflict",
    async (change) => {
      const fixture = await legacyFixture();
      try {
        const copiedRoot = path.dirname(fixture.copiedSkill);
        const asset = path.join(copiedRoot, "was-file");
        if (change === "modify") writeFileSync(asset, "local asset edit");
        if (change === "add") writeFileSync(path.join(copiedRoot, "local-asset"), "local addition");
        if (change === "delete") rmSync(asset);
        if (change === "reserved-git") {
          mkdirSync(path.join(copiedRoot, ".git"));
          writeFileSync(path.join(copiedRoot, ".git", "config"), "local repository metadata");
        }

        const update = await fetch(
          `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
          { method: "POST" },
        );
        expect(update.status).toBe(200);
        expect(await update.json()).toMatchObject({ conflicts: ["legacy-skill"] });
        if (change === "modify") expect(readFileSync(asset, "utf8")).toBe("local asset edit");
        if (change === "add") {
          expect(readFileSync(path.join(copiedRoot, "local-asset"), "utf8")).toBe("local addition");
        }
        if (change === "delete") expect(existsSync(asset)).toBe(false);
        if (change === "reserved-git") {
          expect(readFileSync(path.join(copiedRoot, ".git", "config"), "utf8")).toBe(
            "local repository metadata",
          );
        }
        expect(persistedLegacyRecord(fixture).skillHashes["legacy-skill"]).toMatch(
          /^tree-v1:[0-9a-f]{64}$/,
        );
        if (change === "modify") {
          const sameCommit = await fetch(
            `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
            { method: "POST" },
          );
          expect(await sameCommit.json()).toMatchObject({
            updated: false,
            conflicts: ["legacy-skill"],
          });
        }
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(["rename", "type-transition", "whole-skill-delete"] as const)(
    "holds a local %s as a whole-skill conflict",
    async (change) => {
      const fixture = await legacyFixture();
      try {
        const copiedRoot = path.dirname(fixture.copiedSkill);
        if (change === "rename") {
          renameSync(path.join(copiedRoot, "was-file"), path.join(copiedRoot, "WAS-FILE"));
        } else if (change === "type-transition") {
          rmSync(path.join(copiedRoot, "was-file"));
          mkdirSync(path.join(copiedRoot, "was-file"));
        } else {
          rmSync(copiedRoot, { recursive: true });
        }
        const update = await fetch(
          `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
          { method: "POST" },
        );
        expect(await update.json()).toMatchObject({ conflicts: ["legacy-skill"] });
        if (change === "rename") expect(existsSync(path.join(copiedRoot, "WAS-FILE"))).toBe(true);
        if (change === "type-transition") {
          expect(existsSync(path.join(copiedRoot, "was-file"))).toBe(true);
        }
        if (change === "whole-skill-delete") expect(existsSync(copiedRoot)).toBe(false);
      } finally {
        await fixture.close();
      }
    },
  );

  it("fails closed when a legacy baseline cannot be proven from a clean tied clone", async () => {
    const fixture = await legacyFixture();
    try {
      writeFileSync(path.join(fixture.clonePath, "ambiguous-untracked"), "dirty clone");
      const update = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(await update.json()).toMatchObject({ conflicts: ["legacy-skill"] });
      expect(readFileSync(fixture.copiedSkill, "utf8")).toContain("Original body");
      expect(persistedLegacyRecord(fixture).skillHashes["legacy-skill"]).toBe(
        sha256(skill("legacy-skill", "Original body.")),
      );
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

  it("Keep Mine re-baselines the complete tree and same-commit retry stays clear", async () => {
    const fixture = await legacyFixture();
    try {
      const localAsset = path.join(path.dirname(fixture.copiedSkill), "local-only");
      writeFileSync(localAsset, "mine");
      const update = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(await update.json()).toMatchObject({ conflicts: ["legacy-skill"] });

      const resolve = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "legacy-skill", resolution: "mine" }),
        },
      );
      expect(resolve.status).toBe(200);
      expect(persistedLegacyRecord(fixture).skillHashes["legacy-skill"]).toMatch(
        /^tree-v1:[0-9a-f]{64}$/,
      );
      const retry = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(await retry.json()).toMatchObject({ updated: false, conflicts: [] });
      expect(readFileSync(localAsset, "utf8")).toBe("mine");
    } finally {
      await fixture.close();
    }
  });

  it("holds a new upstream name when an unmanaged catalog folder already exists", async () => {
    const fixture = await legacyFixture();
    try {
      await establishTwoSkillBaseline(fixture);
      const catalog = path.dirname(path.dirname(fixture.copiedSkill));
      const local = path.join(catalog, "gamma");
      mkdirSync(local);
      writeFileSync(path.join(local, "SKILL.md"), skill("gamma", "unrelated local skill"));
      const upstream = path.join(fixture.upstream, "gamma");
      mkdirSync(upstream);
      writeFileSync(path.join(upstream, "SKILL.md"), skill("gamma", "upstream skill"));
      git(fixture.upstream, ["add", "-A"]);
      git(fixture.upstream, ["commit", "-m", "add colliding gamma"]);

      const update = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(await update.json()).toMatchObject({ conflicts: ["gamma"] });
      expect(readFileSync(path.join(local, "SKILL.md"), "utf8")).toContain("unrelated local skill");
    } finally {
      await fixture.close();
    }
  });

  it("Take Remote applies a whole-skill upstream deletion and stores missing state", async () => {
    const fixture = await legacyFixture({ localEdit: true });
    try {
      rmSync(path.join(fixture.upstream, "SKILL.md"));
      rmSync(path.join(fixture.upstream, "was-file"), { recursive: true });
      rmSync(path.join(fixture.upstream, "was-dir"), { force: true });
      git(fixture.upstream, ["add", "-A"]);
      git(fixture.upstream, ["commit", "-m", "remove remote skill"]);
      const update = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(await update.json()).toMatchObject({ conflicts: ["legacy-skill"] });
      const resolve = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "legacy-skill", resolution: "remote" }),
        },
      );
      expect(resolve.status).toBe(200);
      expect(existsSync(path.dirname(fixture.copiedSkill))).toBe(false);
      expect(persistedLegacyRecord(fixture).skillHashes["legacy-skill"]).toBe("tree-v1:missing");
    } finally {
      await fixture.close();
    }
  });

  it("Take Remote replaces the complete skill tree", async () => {
    const fixture = await legacyFixture();
    try {
      const copiedRoot = path.dirname(fixture.copiedSkill);
      writeFileSync(path.join(copiedRoot, "local-only"), "remove me");
      const update = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(await update.json()).toMatchObject({ conflicts: ["legacy-skill"] });
      const resolve = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "legacy-skill", resolution: "remote" }),
        },
      );
      expect(resolve.status).toBe(200);
      expect(existsSync(path.join(copiedRoot, "local-only"))).toBe(false);
      expect(readFileSync(fixture.copiedSkill, "utf8")).toContain("Upstream body");
    } finally {
      await fixture.close();
    }
  });

  const unixIt = process.platform === "win32" ? it.skip : it;

  unixIt.each(["replace", "delete"] as const)(
    "holds a payload changed after initial scan immediately before upstream %s",
    async (operation) => {
      const fixture = await legacyFixture();
      try {
        if (operation === "delete") {
          rmSync(path.join(fixture.upstream, "SKILL.md"));
          rmSync(path.join(fixture.upstream, "was-file"), { recursive: true });
          rmSync(path.join(fixture.upstream, "was-dir"), { force: true });
          git(fixture.upstream, ["add", "-A"]);
          git(fixture.upstream, ["commit", "-m", "delete skill for race"]);
        }
        const localAsset = path.join(path.dirname(fixture.copiedSkill), "was-file");
        const gitPath = "/usr/bin/git";
        const wrapper = path.join(fixture.dataDir, `mutate-before-${operation}.mjs`);
        writeFileSync(
          wrapper,
          `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nconst result = spawnSync(${JSON.stringify(gitPath)}, process.argv.slice(2), { stdio: "inherit" });\nif (result.status === 0 && process.argv[2] === "reset") writeFileSync(${JSON.stringify(localAsset)}, "late local bytes");\nprocess.exit(result.status ?? 1);\n`,
        );
        chmodSync(wrapper, 0o755);
        process.env.AGENT_DECK_GIT_BIN = wrapper;

        const update = await fetch(
          `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
          { method: "POST" },
        );
        expect(update.status).toBe(200);
        expect(await update.json()).toMatchObject({ conflicts: ["legacy-skill"] });
        expect(readFileSync(localAsset, "utf8")).toBe("late local bytes");
        const retry = await fetch(
          `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
          { method: "POST" },
        );
        expect(await retry.json()).toMatchObject({
          updated: false,
          conflicts: ["legacy-skill"],
        });
      } finally {
        delete process.env.AGENT_DECK_GIT_BIN;
        await fixture.close();
      }
    },
  );

  unixIt("persists a proven legacy migration before fetch", async () => {
    const fixture = await legacyFixture();
    try {
      const gitPath = "/usr/bin/git";
      const wrapper = path.join(fixture.dataDir, "fail-fetch-git.mjs");
      writeFileSync(
        wrapper,
        `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nif (process.argv[2] === "fetch") process.exit(1);\nconst result = spawnSync(${JSON.stringify(gitPath)}, process.argv.slice(2), { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
      );
      chmodSync(wrapper, 0o755);
      process.env.AGENT_DECK_GIT_BIN = wrapper;
      const update = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(update.status).toBe(500);
      expect(persistedLegacyRecord(fixture).skillHashes["legacy-skill"]).toMatch(
        /^tree-v1:[0-9a-f]{64}$/,
      );
    } finally {
      delete process.env.AGENT_DECK_GIT_BIN;
      await fixture.close();
    }
  });

  unixIt(
    "persists partial update progress so a retry converges without a false conflict",
    async () => {
      const fixture = await legacyFixture();
      try {
        const copied = await establishTwoSkillBaseline(fixture);
        const baselineCommit = persistedLegacyRecord(fixture).lastSyncedCommit;
        const alphaUpdate = skill("alpha", "alpha upstream update.");
        writeFileSync(path.join(fixture.upstream, "alpha", "SKILL.md"), alphaUpdate);
        writeFileSync(
          path.join(fixture.upstream, "beta", "SKILL.md"),
          skill("beta", "beta upstream update."),
        );
        const outside = path.join(path.dirname(fixture.upstream), "unsafe-source");
        writeFileSync(outside, "outside");
        symlinkSync(outside, path.join(fixture.upstream, "beta", "unsafe-link"));
        git(fixture.upstream, ["add", "-A"]);
        git(fixture.upstream, ["commit", "-m", "update with unsafe second skill"]);

        const interrupted = await fetch(
          `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
          { method: "POST" },
        );
        expect(interrupted.status).toBe(409);
        expect(await interrupted.json()).toMatchObject({
          error: expect.stringContaining("interrupted"),
        });
        expect(readFileSync(copied.alpha, "utf8")).toBe(alphaUpdate);
        expect(readFileSync(copied.beta, "utf8")).toContain("beta baseline");
        const partial = persistedLegacyRecord(fixture);
        expect(partial.lastSyncedCommit).toBe(baselineCommit);
        expect(partial.skillHashes.alpha).toMatch(/^tree-v1:[0-9a-f]{64}$/);

        rmSync(path.join(fixture.upstream, "beta", "unsafe-link"));
        writeFileSync(path.join(fixture.upstream, "beta", "safe-asset"), "safe");
        git(fixture.upstream, ["add", "-A"]);
        git(fixture.upstream, ["commit", "-m", "make second skill safe"]);
        const retry = await fetch(
          `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
          { method: "POST" },
        );
        expect(retry.status).toBe(200);
        expect(await retry.json()).toMatchObject({ updated: true, conflicts: [] });
        expect(readFileSync(copied.alpha, "utf8")).toBe(alphaUpdate);
        expect(readFileSync(copied.beta, "utf8")).toContain("beta upstream update");
        expect(persistedLegacyRecord(fixture).lastSyncedCommit).toBe(
          git(fixture.upstream, ["rev-parse", "HEAD"]),
        );
      } finally {
        await fixture.close();
      }
    },
  );

  unixIt("serializes concurrent legacy updates for one repository", async () => {
    const fixture = await legacyFixture();
    try {
      const gitPath = "/usr/bin/git";
      expect(existsSync(gitPath)).toBe(true);
      const wrapper = path.join(fixture.dataDir, "delayed-git.mjs");
      writeFileSync(
        wrapper,
        `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nif (process.argv[2] === "fetch") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);\nconst result = spawnSync(${JSON.stringify(gitPath)}, process.argv.slice(2), { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
      );
      chmodSync(wrapper, 0o755);
      process.env.AGENT_DECK_GIT_BIN = wrapper;

      const responses = await Promise.all([
        fetch(`http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`, {
          method: "POST",
        }),
        fetch(`http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`, {
          method: "POST",
        }),
      ]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
      const persisted = persistedLegacyRecord(fixture);
      expect(persisted.skillNames).toEqual(["legacy-skill"]);
      expect(persisted.lastSyncedCommit).toBe(git(fixture.upstream, ["rev-parse", "HEAD"]));
    } finally {
      delete process.env.AGENT_DECK_GIT_BIN;
      await fixture.close();
    }
  });

  unixIt("prevents forget from racing an in-flight legacy update", async () => {
    const fixture = await legacyFixture();
    try {
      const gitPath = "/usr/bin/git";
      expect(existsSync(gitPath)).toBe(true);
      const marker = path.join(fixture.dataDir, "update-fetch-started");
      const wrapper = path.join(fixture.dataDir, "delayed-forget-git.mjs");
      writeFileSync(
        wrapper,
        `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nimport { writeFileSync } from "node:fs";\nif (process.argv[2] === "fetch") { writeFileSync(${JSON.stringify(marker)}, "started"); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500); }\nconst result = spawnSync(${JSON.stringify(gitPath)}, process.argv.slice(2), { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
      );
      chmodSync(wrapper, 0o755);
      process.env.AGENT_DECK_GIT_BIN = wrapper;

      const updatePromise = fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      await vi.waitFor(() => expect(existsSync(marker)).toBe(true));
      const forget = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id`,
        { method: "DELETE" },
      );
      expect(forget.status).toBe(409);
      expect(await forget.json()).toMatchObject({ error: expect.stringContaining("already") });

      const update = await updatePromise;
      expect(update.status).toBe(200);
      expect(await update.json()).toMatchObject({ updated: true });
      expect(existsSync(fixture.clonePath)).toBe(true);
      expect(persistedLegacyRecord(fixture).lastSyncedCommit).toBe(
        git(fixture.upstream, ["rev-parse", "HEAD"]),
      );

      const retry = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id`,
        { method: "DELETE" },
      );
      expect(retry.status).toBe(200);
      expect(existsSync(fixture.clonePath)).toBe(false);
      const persisted = JSON.parse(
        readFileSync(path.join(fixture.dataDir, "app-settings.json"), "utf8"),
      ) as { importedSkillRepositories: unknown[] };
      expect(persisted.importedSkillRepositories).toEqual([]);
    } finally {
      delete process.env.AGENT_DECK_GIT_BIN;
      await fixture.close();
    }
  });

  unixIt("prevents a conflict resolution from racing an in-flight update", async () => {
    const fixture = await legacyFixture({ localEdit: true });
    try {
      const gitPath = "/usr/bin/git";
      expect(existsSync(gitPath)).toBe(true);
      const wrapper = path.join(fixture.dataDir, "delayed-resolve-git.mjs");
      writeFileSync(
        wrapper,
        `#!/usr/bin/env node\nimport { spawnSync } from "node:child_process";\nif (process.argv[2] === "fetch") Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);\nconst result = spawnSync(${JSON.stringify(gitPath)}, process.argv.slice(2), { stdio: "inherit" });\nprocess.exit(result.status ?? 1);\n`,
      );
      chmodSync(wrapper, 0o755);
      process.env.AGENT_DECK_GIT_BIN = wrapper;

      const updatePromise = fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      const resolvePromise = fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "legacy-skill", resolution: "mine" }),
        },
      );
      const [update, resolve] = await Promise.all([updatePromise, resolvePromise]);
      expect(update.status).toBe(200);
      expect(await update.json()).toMatchObject({ conflicts: ["legacy-skill"] });
      expect(resolve.status).toBe(409);
      expect(await resolve.json()).toMatchObject({ error: expect.stringContaining("already") });
      expect(readFileSync(fixture.copiedSkill, "utf8")).toContain("Local edit");
      expect(persistedLegacyRecord(fixture).skillHashes["legacy-skill"]).not.toBe(
        sha256(readFileSync(fixture.copiedSkill, "utf8")),
      );
    } finally {
      delete process.env.AGENT_DECK_GIT_BIN;
      await fixture.close();
    }
  });

  it("holds an unsafe catalog target as a conflict without following it", async () => {
    const fixture = await legacyFixture();
    try {
      const list = async (): Promise<{ repos: Array<{ lastSyncedCommit: string }> }> =>
        (await (
          await fetch(`http://127.0.0.1:${fixture.server.port}/resources/skill-repos`)
        ).json()) as { repos: Array<{ lastSyncedCommit: string }> };
      const before = await list();
      rmSync(path.join(fixture.upstream, "SKILL.md"));
      rmSync(path.join(fixture.upstream, "was-file"), { recursive: true });
      rmSync(path.join(fixture.upstream, "was-dir"), { force: true });
      git(fixture.upstream, ["add", "-A"]);
      git(fixture.upstream, ["commit", "-m", "delete skill"]);
      const copiedRoot = path.dirname(fixture.copiedSkill);
      rmSync(copiedRoot, { recursive: true });
      const victim = path.join(path.dirname(copiedRoot), "outside-victim");
      mkdirSync(victim);
      writeFileSync(path.join(victim, "sentinel"), "outside-safe");
      symlinkSync(victim, copiedRoot, "dir");

      const response = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ conflicts: ["legacy-skill"] });
      expect((await list()).repos[0]?.lastSyncedCommit).not.toBe(before.repos[0]?.lastSyncedCommit);
      expect(readFileSync(path.join(victim, "sentinel"), "utf8")).toBe("outside-safe");
    } finally {
      await fixture.close();
    }
  });

  it("maps unsafe Take Remote deletion and retains the unresolved repository metadata", async () => {
    const fixture = await legacyFixture({ localEdit: true });
    try {
      rmSync(path.join(fixture.upstream, "SKILL.md"));
      rmSync(path.join(fixture.upstream, "was-file"), { recursive: true });
      rmSync(path.join(fixture.upstream, "was-dir"), { force: true });
      git(fixture.upstream, ["add", "-A"]);
      git(fixture.upstream, ["commit", "-m", "delete conflicted skill"]);
      const update = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/update`,
        { method: "POST" },
      );
      expect(update.status).toBe(200);
      expect(await update.json()).toMatchObject({ conflicts: ["legacy-skill"] });
      const copiedRoot = path.dirname(fixture.copiedSkill);
      rmSync(copiedRoot, { recursive: true });
      const victim = path.join(path.dirname(copiedRoot), "resolve-victim");
      mkdirSync(victim);
      writeFileSync(path.join(victim, "sentinel"), "outside-safe");
      symlinkSync(victim, copiedRoot, "dir");

      const resolve = await fetch(
        `http://127.0.0.1:${fixture.server.port}/resources/skill-repos/legacy-id/resolve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name: "legacy-skill", resolution: "remote" }),
        },
      );
      expect(resolve.status).toBe(409);
      expect(await resolve.json()).toMatchObject({ error: expect.stringContaining("unsafe") });
      const listed = (await (
        await fetch(`http://127.0.0.1:${fixture.server.port}/resources/skill-repos`)
      ).json()) as { repos: Array<{ skillNames: string[] }> };
      expect(listed.repos[0]?.skillNames).toContain("legacy-skill");
      expect(readFileSync(path.join(victim, "sentinel"), "utf8")).toBe("outside-safe");
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
