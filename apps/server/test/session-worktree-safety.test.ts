import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionWorktreeStore } from "@agent-deck/resources";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalWorktreePath, gitWorktreeRegistrationAtPath } from "../src/git.ts";
import { startServer, type AgentDeckServer } from "../src/index.ts";

process.env.AGENT_DECK_TEST = "1";

let server: AgentDeckServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("session worktree startup boundary", () => {
  it("starts with a completely nonexistent explicit data directory", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "session-worktree-startup-"));
    const dataDir = path.join(parent, "missing", "app-data");

    server = await startServer({ dataDir });

    const physicalDataDir = realpathSync(dataDir);
    expect(realpathSync(path.join(dataDir, "session-worktrees"))).toBe(
      path.join(physicalDataDir, "session-worktrees"),
    );
  });

  it("refuses a linked explicit data directory without touching its target", async () => {
    const parent = mkdtempSync(path.join(tmpdir(), "session-worktree-linked-data-"));
    const outside = mkdtempSync(path.join(tmpdir(), "session-worktree-linked-target-"));
    const dataDir = path.join(parent, "app-data");
    const sentinel = path.join(outside, "sentinel");
    writeFileSync(sentinel, "safe");
    symlinkSync(outside, dataDir, process.platform === "win32" ? "junction" : "dir");

    await expect(startServer({ dataDir })).rejects.toThrow(/trusted data directory/i);
    expect(readFileSync(sentinel, "utf8")).toBe("safe");
    expect(readdirSync(outside)).toEqual(["sentinel"]);
  });
});

describe("persisted session worktree deletion boundary", () => {
  it("refuses an external persisted target, leaves it untouched, and retains metadata", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "session-worktree-safety-data-"));
    const project = mkdtempSync(path.join(tmpdir(), "session-worktree-safety-project-"));
    const external = mkdtempSync(path.join(tmpdir(), "session-worktree-safety-external-"));
    const sentinel = path.join(external, "sentinel.txt");
    writeFileSync(sentinel, "must survive");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      path.join(dataDir, "projects.json"),
      JSON.stringify([{ id: "project", name: "project", path: project }]),
    );
    writeFileSync(
      path.join(dataDir, "sessions.json"),
      JSON.stringify([
        {
          id: "persisted-session",
          cwd: external,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          projectId: "project",
          worktreePath: external,
          worktreeBranch: "agent-deck/session-deadbeef",
          worktreeSourceBranch: "main",
        },
      ]),
    );

    server = await startServer({ dataDir });
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions/persisted-session`, {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    expect((await response.json()) as { code: string }).toMatchObject({
      code: "session_worktree_cleanup_failed",
    });
    expect(readFileSync(sentinel, "utf8")).toBe("must survive");
    const listed = await fetch(`http://127.0.0.1:${server.port}/sessions`);
    expect(
      ((await listed.json()) as { sessions: Array<{ id: string }> }).sessions.map(({ id }) => id),
    ).toContain("persisted-session");
  });

  it("refuses a missing target whose stale Git registration belongs to another branch", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "session-worktree-stale-data-"));
    const project = mkdtempSync(path.join(tmpdir(), "session-worktree-stale-project-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: project, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
    writeFileSync(path.join(project, "README.md"), "test\n");
    execFileSync("git", ["add", "README.md"], { cwd: project });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: project, stdio: "ignore" });
    execFileSync("git", ["branch", "other-owner", "main"], { cwd: project });
    const worktreeStore = new SessionWorktreeStore(dataDir);
    if (process.platform === "win32") {
      expect(worktreeStore.rootPath.startsWith("\\\\?\\")).toBe(false);
    }
    const target = path.join(worktreeStore.rootPath, "deadbeef");
    execFileSync("git", ["worktree", "add", target, "other-owner"], {
      cwd: project,
      stdio: "ignore",
    });
    const worktreeIdentity = worktreeStore.captureWorktreeIdentity(target);
    rmSync(target, { recursive: true });
    writeFileSync(
      path.join(dataDir, "projects.json"),
      JSON.stringify([{ id: "project", name: "project", path: project }]),
    );
    writeFileSync(
      path.join(dataDir, "sessions.json"),
      JSON.stringify([
        {
          id: "stale-mismatch",
          cwd: target,
          createdAt: "2025-01-01T00:00:00.000Z",
          updatedAt: "2025-01-01T00:00:00.000Z",
          projectId: "project",
          worktreePath: target,
          worktreeIdentity,
          worktreeBranch: "agent-deck/session-deadbeef",
          worktreeSourceBranch: "main",
        },
      ]),
    );

    server = await startServer({ dataDir });
    const response = await fetch(`http://127.0.0.1:${server.port}/sessions/stale-mismatch`, {
      method: "DELETE",
    });

    expect(response.status).toBe(409);
    const registration = await gitWorktreeRegistrationAtPath(project, target);
    expect(registration).toMatchObject({ branch: "other-owner" });
    expect(await canonicalWorktreePath(registration!.path)).toBe(
      await canonicalWorktreePath(target),
    );
    const listed = await fetch(`http://127.0.0.1:${server.port}/sessions`);
    expect(
      ((await listed.json()) as { sessions: Array<{ id: string }> }).sessions.map(({ id }) => id),
    ).toContain("stale-mismatch");
  });

  it.skipIf(process.platform === "win32")(
    "persists expected OID and finishes after restart with stale registration and absent branch",
    async () => {
      const dataDir = mkdtempSync(path.join(tmpdir(), "session-worktree-retry-data-"));
      const project = mkdtempSync(path.join(tmpdir(), "session-worktree-retry-project-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: project, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "test@example.invalid"], { cwd: project });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: project });
      writeFileSync(path.join(project, "README.md"), "test\n");
      execFileSync("git", ["add", "README.md"], { cwd: project });
      execFileSync("git", ["commit", "-m", "initial"], { cwd: project, stdio: "ignore" });
      execFileSync("git", ["branch", "agent-deck/session-facefeed", "main"], { cwd: project });
      const root = path.join(dataDir, "session-worktrees");
      mkdirSync(root, { recursive: true });
      const authoritativeRoot = realpathSync(root);
      const target = path.join(authoritativeRoot, "facefeed");
      execFileSync("git", ["worktree", "add", target, "agent-deck/session-facefeed"], {
        cwd: project,
        stdio: "ignore",
      });
      execFileSync("mkfifo", [path.join(target, "blocked")]);
      writeFileSync(
        path.join(dataDir, "projects.json"),
        JSON.stringify([{ id: "project", name: "project", path: project }]),
      );
      writeFileSync(
        path.join(dataDir, "sessions.json"),
        JSON.stringify([
          {
            id: "retry-session",
            cwd: target,
            createdAt: "2025-01-01T00:00:00.000Z",
            updatedAt: "2025-01-01T00:00:00.000Z",
            projectId: "project",
            worktreePath: target,
            worktreeBranch: "agent-deck/session-facefeed",
            worktreeSourceBranch: "main",
          },
        ]),
      );
      server = await startServer({ dataDir });
      const remove = () =>
        fetch(`http://127.0.0.1:${server!.port}/sessions/retry-session`, { method: "DELETE" });
      const listedIds = async () => {
        const response = await fetch(`http://127.0.0.1:${server!.port}/sessions`);
        return ((await response.json()) as { sessions: Array<{ id: string }> }).sessions.map(
          ({ id }) => id,
        );
      };

      expect((await remove()).status).toBe(409);
      const quarantine = readdirSync(root).find((entry) =>
        entry.startsWith(".agent-deck-session-delete-facefeed-"),
      );
      expect(quarantine).toBeDefined();
      expect(await listedIds()).toContain("retry-session");
      const adopted = JSON.parse(
        readFileSync(path.join(dataDir, "sessions.json"), "utf8"),
      ) as Array<{
        id: string;
        worktreeIdentity?: string;
        worktreeCleanupBranchHead?: string;
      }>;
      const persisted = adopted.find(({ id }) => id === "retry-session");
      expect(persisted?.worktreeIdentity).toMatch(/^v1:[0-9a-f]{16}:[0-9a-f]{16}$/);
      expect(persisted?.worktreeCleanupBranchHead).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);

      await server.close();
      server = undefined;
      server = await startServer({ dataDir });
      expect((await remove()).status).toBe(409);
      expect(existsSync(path.join(root, quarantine!))).toBe(true);
      expect(await listedIds()).toContain("retry-session");

      // Simulate a crash after physical removal + CAS ref deletion but before
      // prune: retain the exact stale registration and the same-row expected OID.
      rmSync(path.join(root, quarantine!), { recursive: true });
      execFileSync(
        "git",
        [
          "update-ref",
          "-d",
          "refs/heads/agent-deck/session-facefeed",
          persisted!.worktreeCleanupBranchHead!,
        ],
        { cwd: project },
      );
      await server.close();
      server = undefined;
      server = await startServer({ dataDir });

      expect((await remove()).status).toBe(200);
      expect(existsSync(path.join(root, quarantine!))).toBe(false);
      expect(await listedIds()).not.toContain("retry-session");
      expect(
        execFileSync("git", ["worktree", "list", "--porcelain"], {
          cwd: project,
          encoding: "utf8",
        }),
      ).not.toContain(`worktree ${target}`);
      expect(
        execFileSync("git", ["branch", "--list", "agent-deck/session-facefeed"], {
          cwd: project,
          encoding: "utf8",
        }).trim(),
      ).toBe("");
    },
  );
});
