import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { emptyTranscript } from "@agent-deck/domain";
import { SessionWorktreeStore } from "@agent-deck/loop-catalog-native";
import { describe, expect, it, vi } from "vitest";
import { gitDetachedWorktreeAdd, gitWorktreeSource } from "../src/git.ts";
import { SubagentRunStore, type SubagentRunRecord } from "../src/subagentRunStore.ts";

const PARENT_A = randomUUID();
const PARENT_B = randomUUID();

const record = (overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord => {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    parentSessionId: PARENT_A,
    task: "inspect the implementation",
    status: "starting",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
};

describe("SubagentRunStore", () => {
  it("owns bounded per-turn artifacts and deletes only its proven root", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-artifacts-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ source: "single" });
    const allocation = store.prepareTurn(run, "system prompt");
    store.create({
      ...run,
      artifactRootId: allocation.artifactRootId,
      artifactRootToken: allocation.identityToken,
      currentTurnId: allocation.turnId,
    });
    store.writeOutput(run.id, "final output");
    const sessionFile = path.join(allocation.sessionsDirectory, "child.jsonl");
    writeFileSync(sessionFile, "{}\n");
    store.markOwnedSession(run.id, sessionFile);
    const expectedDirectory = realpathSync.native(path.join(dataDir, "Subagent Runs", run.id));
    expect(store.artifactDirectoryForReveal(run.id)).toBe(path.toNamespacedPath(expectedDirectory));
    expect(store.cells(PARENT_A)[0]?.artifactRootId).toBe(run.id);
    store.removeParent(PARENT_A);
    expect(existsSync(path.join(dataDir, "Subagent Runs", run.id))).toBe(false);
  });

  it("allocates distinct detached child worktrees, retains restart proof, and safely deletes them", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktrees-"));
    const repo = mkdtempSync(path.join(tmpdir(), "subagent-worktree-repo-space -"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "parent.txt"), "unchanged\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      { cwd: repo },
    );
    const store = new SubagentRunStore(dataDir, vi.fn());
    const first = record({ source: "parallel" });
    const second = record({ source: "parallel" });
    for (const run of [first, second]) {
      const allocation = store.prepareTurn(run, "system");
      store.create({
        ...run,
        artifactRootId: allocation.artifactRootId,
        artifactRootToken: allocation.identityToken,
        currentTurnId: allocation.turnId,
      });
    }
    const [firstPath, secondPath] = await Promise.all([
      store.prepareWorktree(first.id, repo),
      store.prepareWorktree(second.id, repo),
    ]);
    expect(firstPath).not.toBe(secondPath);
    expect(existsSync(path.join(repo, "child.txt"))).toBe(false);
    writeFileSync(path.join(firstPath, "child.txt"), "first");
    writeFileSync(path.join(secondPath, "child.txt"), "second");
    execFileSync("git", ["add", "child.txt"], { cwd: firstPath });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "child"],
      { cwd: firstPath },
    );
    expect(
      execFileSync("git", ["rev-parse", "HEAD"], { cwd: firstPath, encoding: "utf8" }).trim(),
    ).not.toBe(store.get(first.id)?.worktreeBaseCommit);

    const restarted = new SubagentRunStore(dataDir, vi.fn());
    expect(restarted.get(first.id)).toEqual(
      expect.objectContaining({
        worktreePath: firstPath,
        worktreeParentRepository: realpathSync(repo),
        worktreeBaseCommit: expect.stringMatching(/^[0-9a-f]{40}$/),
      }),
    );
    await restarted.removeParent(PARENT_A);
    expect(existsSync(firstPath)).toBe(false);
    expect(existsSync(secondPath)).toBe(false);
    expect(restarted.list(PARENT_A)).toEqual([]);
  });

  it("rolls back a reserved native leaf when ownership persistence fails", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktree-persist-fail-"));
    const repo = mkdtempSync(path.join(tmpdir(), "subagent-worktree-persist-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "base"), "base");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      { cwd: repo },
    );
    let rejectWrite = false;
    const store = new SubagentRunStore(dataDir, vi.fn(), {
      syncFile: () => {
        if (rejectWrite) throw new Error("injected metadata failure");
      },
      syncDirectory: () => {},
    });
    const run = record({ source: "parallel" });
    store.create(run);
    rejectWrite = true;

    await expect(store.prepareWorktree(run.id, repo)).rejects.toThrow("injected metadata failure");
    expect(readdirSync(path.join(dataDir, "session-worktrees"))).toEqual([]);
    expect(store.get(run.id)?.worktreePath).toBeUndefined();
  });

  it("retains retryable cleanup proof when metadata rename succeeded but directory fsync failed", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktree-post-rename-fail-"));
    const repo = mkdtempSync(path.join(tmpdir(), "subagent-worktree-post-rename-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "base"), "base");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      { cwd: repo },
    );
    let rejectDirectorySync = false;
    const store = new SubagentRunStore(dataDir, vi.fn(), {
      syncFile: () => {},
      syncDirectory: () => {
        if (rejectDirectorySync) throw new Error("injected directory fsync failure");
      },
    });
    const run = record({ source: "parallel" });
    store.create(run);
    rejectDirectorySync = true;

    await expect(store.prepareWorktree(run.id, repo)).rejects.toBeTruthy();
    expect(readdirSync(path.join(dataDir, "session-worktrees"))).toEqual([]);
    expect(store.get(run.id)).toEqual(
      expect.objectContaining({ worktreeState: "reserved", worktreeCleanup: "physical_removed" }),
    );
    rejectDirectorySync = false;
    await store.removeParent(PARENT_A);
    expect(store.get(run.id)).toBeUndefined();
  });

  it("retries idempotently from a durable physical-removal marker", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktree-cleanup-marker-"));
    const repo = mkdtempSync(path.join(tmpdir(), "subagent-worktree-marker-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "base"), "base");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      { cwd: repo },
    );
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ source: "parallel" });
    store.create(run);
    const worktree = await store.prepareWorktree(run.id, repo);
    const owned = store.get(run.id)!;
    await new SessionWorktreeStore(dataDir).deleteWorktree(worktree, owned.worktreeIdentity!);
    store.update(run.id, { worktreeCleanup: "physical_removed" });
    execFileSync("git", ["worktree", "prune", "--expire", "now"], { cwd: repo });

    const restarted = new SubagentRunStore(dataDir, vi.fn());
    await restarted.removeParent(PARENT_A);
    expect(restarted.get(run.id)).toBeUndefined();
  });

  it("recovers a crash after physical removal but before marker persistence", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktree-pre-marker-crash-"));
    const repo = mkdtempSync(path.join(tmpdir(), "subagent-worktree-pre-marker-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "base"), "base");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      { cwd: repo },
    );
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ source: "parallel" });
    store.create(run);
    const worktree = await store.prepareWorktree(run.id, repo);
    const owned = store.get(run.id)!;
    await new SessionWorktreeStore(dataDir).deleteWorktree(worktree, owned.worktreeIdentity!);
    expect(store.get(run.id)?.worktreeCleanup).toBeUndefined();

    const restarted = new SubagentRunStore(dataDir, vi.fn());
    await restarted.removeParent(PARENT_A);
    expect(restarted.get(run.id)).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "rejects parent repository path replacement before Pi spawn",
    async () => {
      const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktree-parent-replaced-"));
      const repo = mkdtempSync(path.join(tmpdir(), "subagent-worktree-parent-repo-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: repo });
      writeFileSync(path.join(repo, "base"), "base");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
        { cwd: repo },
      );
      const store = new SubagentRunStore(dataDir, vi.fn());
      const run = record({ source: "parallel" });
      store.create(run);
      await store.prepareWorktree(run.id, repo);

      const moved = `${repo}-moved`;
      const replacement = mkdtempSync(path.join(tmpdir(), "subagent-worktree-other-repo-"));
      execFileSync("git", ["init", "-b", "main"], { cwd: replacement });
      writeFileSync(path.join(replacement, "other"), "other");
      execFileSync("git", ["add", "."], { cwd: replacement });
      execFileSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "other"],
        { cwd: replacement },
      );
      renameSync(repo, moved);
      symlinkSync(replacement, repo, "dir");

      await expect(store.validateWorktreeForSpawn(run.id)).rejects.toThrow(
        "Git ownership changed before spawn",
      );
    },
  );

  it("recovers reserved state after Git add won the registered-state crash window", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktree-post-add-crash-"));
    const repo = mkdtempSync(path.join(tmpdir(), "subagent-worktree-post-add-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "base"), "base");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      { cwd: repo },
    );
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ source: "parallel" });
    store.create(run);
    const source = await gitWorktreeSource(repo);
    const native = new SessionWorktreeStore(dataDir);
    const target = path.join(native.rootPath, randomUUID().replaceAll("-", "").slice(0, 8));
    const identity = native.reserveWorktree(target);
    store.update(run.id, {
      worktreePath: target,
      worktreeIdentity: identity,
      worktreeParentRepository: source.repositoryRoot,
      worktreeRepositoryIdentity: source.repositoryIdentity,
      worktreeBaseCommit: source.baseCommit,
      worktreeState: "reserved",
    });
    await gitDetachedWorktreeAdd(source.repositoryRoot, target, source.baseCommit);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }),
    ).toContain(target);

    const restarted = new SubagentRunStore(dataDir, vi.fn());
    await restarted.removeParent(PARENT_A);
    expect(restarted.get(run.id)).toBeUndefined();
    expect(existsSync(target)).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }),
    ).not.toContain(target);
  });

  it("serializes parent deletion against a deferred in-flight allocation", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktree-delete-race-"));
    const repo = mkdtempSync(path.join(tmpdir(), "subagent-worktree-delete-race-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "base"), "base");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      { cwd: repo },
    );
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const store = new SubagentRunStore(dataDir, vi.fn(), undefined, {
      beforeGitWorktreeAdd: () => gate,
    });
    const run = record({ source: "parallel" });
    const artifact = store.prepareTurn(run, "system");
    store.create({
      ...run,
      artifactRootId: artifact.artifactRootId,
      artifactRootToken: artifact.identityToken,
      currentTurnId: artifact.turnId,
    });
    const allocation = store.prepareWorktree(run.id, repo);
    await vi.waitFor(() => expect(store.get(run.id)?.worktreeState).toBe("reserved"));
    const target = store.get(run.id)!.worktreePath!;
    let deletionSettled = false;
    const deletion = store.removeParent(PARENT_A).finally(() => {
      deletionSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(deletionSettled).toBe(false);
    release();

    await expect(allocation).rejects.toThrow("deleted during worktree allocation");
    await deletion;
    expect(store.get(run.id)).toBeUndefined();
    expect(existsSync(target)).toBe(false);
    expect(existsSync(path.join(dataDir, "Subagent Runs", run.id))).toBe(false);
    expect(
      execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: repo, encoding: "utf8" }),
    ).not.toContain(target);
  });

  it("retains an isolated worktree as review evidence after cancellation and restart", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktree-cancelled-"));
    const repo = mkdtempSync(path.join(tmpdir(), "subagent-worktree-cancel-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "base"), "base");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      { cwd: repo },
    );
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ source: "parallel" });
    const allocation = store.prepareTurn(run, "system");
    store.create({
      ...run,
      artifactRootId: allocation.artifactRootId,
      artifactRootToken: allocation.identityToken,
      currentTurnId: allocation.turnId,
    });
    const worktree = await store.prepareWorktree(run.id, repo);
    const stoppedAt = new Date().toISOString();
    store.update(run.id, {
      status: "stopped",
      updatedAt: stoppedAt,
      completedAt: stoppedAt,
      error: "Subagent run was stopped before completion.",
    });

    const restarted = new SubagentRunStore(dataDir, vi.fn());
    expect(restarted.get(run.id)).toEqual(
      expect.objectContaining({ status: "stopped", worktreePath: worktree }),
    );
    expect(existsSync(worktree)).toBe(true);
    await restarted.removeParent(PARENT_A);
  });

  it("fails closed outside Git before allocating a worktree or starting evidence", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktree-nongit-"));
    const nonGit = mkdtempSync(path.join(tmpdir(), "subagent-worktree-source-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ source: "parallel" });
    const allocation = store.prepareTurn(run, "system");
    store.create({
      ...run,
      artifactRootId: allocation.artifactRootId,
      artifactRootToken: allocation.identityToken,
      currentTurnId: allocation.turnId,
    });
    await expect(store.prepareWorktree(run.id, nonGit)).rejects.toBeTruthy();
    expect(store.get(run.id)?.worktreePath).toBeUndefined();
    expect(readdirSync(path.join(dataDir, "session-worktrees"))).toEqual([]);
  });

  it("preflights all siblings before a later unsafe child can remove an earlier worktree", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktree-sibling-preflight-"));
    const repo = mkdtempSync(path.join(tmpdir(), "subagent-worktree-sibling-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "base"), "base");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      { cwd: repo },
    );
    const store = new SubagentRunStore(dataDir, vi.fn());
    const first = record({ source: "parallel" });
    const second = record({ source: "parallel" });
    store.create(first);
    store.create(second);
    const firstPath = await store.prepareWorktree(first.id, repo);
    const secondPath = await store.prepareWorktree(second.id, repo);
    rmSync(secondPath, { recursive: true, force: true });
    mkdirSync(secondPath);

    await expect(store.removeParent(PARENT_A)).rejects.toBeTruthy();
    expect(existsSync(firstPath)).toBe(true);
    expect(store.get(first.id)?.worktreeCleanup).toBeUndefined();
    expect(store.get(second.id)?.worktreePath).toBe(secondPath);
  });

  it("retains records and artifacts when worktree identity no longer proves safe deletion", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-worktree-replaced-"));
    const repo = mkdtempSync(path.join(tmpdir(), "subagent-worktree-repo-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: repo });
    writeFileSync(path.join(repo, "base"), "base");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync(
      "git",
      ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "base"],
      { cwd: repo },
    );
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ source: "parallel" });
    const allocation = store.prepareTurn(run, "system");
    store.create({
      ...run,
      artifactRootId: allocation.artifactRootId,
      artifactRootToken: allocation.identityToken,
      currentTurnId: allocation.turnId,
    });
    const worktree = await store.prepareWorktree(run.id, repo);
    rmSync(worktree, { recursive: true, force: true });
    mkdirSync(worktree);
    writeFileSync(path.join(worktree, "foreign"), "retain");

    await expect(store.removeParent(PARENT_A)).rejects.toBeTruthy();
    expect(store.get(run.id)?.worktreePath).toBe(worktree);
    expect(existsSync(path.join(dataDir, "Subagent Runs", run.id))).toBe(true);
    expect(existsSync(path.join(worktree, "foreign"))).toBe(true);
  });

  it("retains a valid allocation when metadata commit never happened", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-commit-gap-"));
    const warnings = vi.fn();
    const first = new SubagentRunStore(dataDir, warnings);
    const run = record();
    first.prepareTurn(run, "system");
    const root = path.join(realpathSync(dataDir), "Subagent Runs", run.id);
    expect(existsSync(path.join(root, "manifest.json"))).toBe(true);

    new SubagentRunStore(dataDir, warnings);
    expect(existsSync(root)).toBe(true);
    expect(warnings).toHaveBeenCalledWith(
      expect.stringContaining(`retained unrecorded subagent artifact root ${run.id}`),
    );
  });

  it("marks a contained session owned when an active run is interrupted at restart", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-interrupted-owned-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record();
    const allocation = store.prepareTurn(run, "system");
    const sessionFile = path.join(allocation.sessionsDirectory, "interrupted.jsonl");
    writeFileSync(sessionFile, "{}\n");
    store.create({
      ...run,
      sessionFile,
      artifactRootId: allocation.artifactRootId,
      artifactRootToken: allocation.identityToken,
      currentTurnId: allocation.turnId,
    });

    const reloaded = new SubagentRunStore(dataDir, vi.fn());
    expect(reloaded.get(run.id)).toEqual(
      expect.objectContaining({ status: "interrupted", sessionOwnership: "owned" }),
    );
    expect(reloaded.cells(run.parentSessionId)[0]).toEqual(
      expect.objectContaining({ status: "interrupted", artifactRootId: run.id }),
    );
  });

  it("scopes live transcript projections to the owning parent and invalidates them on deletion", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-live-transcript-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ status: "running" });
    store.create(run);
    store.registerLiveTranscript(run.id);
    const transcript = {
      ...emptyTranscript(),
      cells: [
        { kind: "user" as const, id: "child-user", text: "ordered child input" },
        {
          kind: "subagent" as const,
          id: "nested-child",
          task: "legacy nested run",
          status: "done" as const,
          text: "nested",
          progress: [],
          artifactRootId: randomUUID(),
        },
        {
          kind: "tool" as const,
          id: "tool",
          toolCallId: "call",
          toolName: "test",
          args: { nested: { artifactRootToken: "secret", safe: "kept" } },
          status: "done" as const,
        },
      ],
    };
    store.updateLiveTranscript(run.id, transcript);

    expect(store.liveTranscript(PARENT_B, run.id)).toBeUndefined();
    const snapshot = store.liveTranscript(PARENT_A, run.id)!;
    expect(snapshot.source).toBe("live");
    expect(snapshot.cells[0]).toEqual(
      expect.objectContaining({ kind: "user", text: "ordered child input" }),
    );
    expect(snapshot.cells[1]).not.toHaveProperty("artifactRootId");
    expect(snapshot.cells[2]).toEqual(
      expect.objectContaining({ args: { nested: { safe: "kept" } } }),
    );
    expect(JSON.stringify(snapshot)).not.toMatch(
      /sessionFile|artifactRoot|identityToken|worktree|turnDirectory|sessionsDirectory/,
    );

    store.removeParent(PARENT_A);
    expect(store.liveTranscript(PARENT_A, run.id)).toBeUndefined();
    expect(() => store.updateLiveTranscript(run.id, transcript)).not.toThrow();
  });

  it.each([
    ["completed", "done"],
    ["failed", "error"],
    ["stopped", "stopped"],
    ["interrupted", "interrupted"],
  ] as const)(
    "maps terminal %s transcript metadata without changing identity",
    (status, expected) => {
      const dataDir = mkdtempSync(path.join(tmpdir(), `subagent-terminal-${status}-`));
      const store = new SubagentRunStore(dataDir, vi.fn());
      const completedAt = new Date().toISOString();
      const run = record({ status, completedAt, updatedAt: completedAt });
      store.create(run);
      expect(store.summaryTranscript(run)).toEqual(
        expect.objectContaining({ runId: run.id, status: expected, source: "summary_only" }),
      );
    },
  );

  it("labels legacy retained evidence as summary-only rather than canonical", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-summary-transcript-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const completedAt = new Date().toISOString();
    const run = record({
      status: "completed",
      completedAt,
      updatedAt: completedAt,
      summary: "retained result",
    });
    store.create(run);

    const snapshot = store.summaryTranscript(run);
    expect(snapshot.source).toBe("summary_only");
    expect(snapshot.notice).toMatch(/Full canonical child history is unavailable/);
    expect(snapshot.cells.map((cell) => cell.kind)).toEqual(["user", "assistant"]);
  });

  it("serializes parent deletion against allocation commit", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-delete-allocation-race-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record();
    store.prepareTurn(run, "system");
    store.removeParent(run.parentSessionId);
    expect(() => store.create(run)).toThrow(/deleted during subagent allocation/);
  });

  it("retries metadata removal after a proven root was already deleted", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-delete-retry-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record();
    const allocation = store.prepareTurn(run, "system");
    store.create({
      ...run,
      artifactRootId: allocation.artifactRootId,
      artifactRootToken: allocation.identityToken,
      currentTurnId: allocation.turnId,
    });
    rmSync(path.join(realpathSync(dataDir), "Subagent Runs", run.id), { recursive: true });
    store.removeParent(PARENT_A);
    expect(store.get(run.id)).toBeUndefined();
  });

  it("persists independent completed runs and hydrates stable transcript cards", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-runs-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const first = record();
    const second = record({ agent: "reviewer" });
    store.create(first);
    store.create(second);
    const completedAt = new Date().toISOString();
    store.update(first.id, {
      status: "completed",
      updatedAt: completedAt,
      completedAt,
      summary: "first result",
      model: "mock-model",
      inputTokens: 2,
      outputTokens: 3,
      durationMs: 12,
    });
    store.update(second.id, {
      status: "failed",
      updatedAt: completedAt,
      completedAt,
      error: "second failed",
    });

    const restored = new SubagentRunStore(dataDir, vi.fn());
    expect(restored.list(PARENT_A).map((run) => run.id)).toEqual([first.id, second.id]);
    expect(restored.cells(PARENT_A)).toEqual([
      expect.objectContaining({ id: first.id, status: "done", text: "first result" }),
      expect.objectContaining({
        id: second.id,
        status: "error",
        text: "",
        error: "second failed",
      }),
    ]);
  });

  it("round-trips additive continuation fields while accepting legacy v1 records", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-continuation-fields-"));
    const sessionFile = path.join(dataDir, "child.jsonl");
    writeFileSync(sessionFile, "{}\n");
    const store = new SubagentRunStore(dataDir, vi.fn());
    const current = record({ source: "single", sessionFile });
    store.create(current);
    expect(new SubagentRunStore(dataDir, vi.fn()).get(current.id)).toEqual(
      expect.objectContaining({ source: "single", sessionFile }),
    );

    for (const version of [1, 2] as const) {
      const legacyDir = mkdtempSync(path.join(tmpdir(), `subagent-legacy-v${version}-`));
      const completedAt = new Date().toISOString();
      const legacy = record({ status: "completed", updatedAt: completedAt, completedAt });
      const serialized = `${JSON.stringify({ version, runs: [legacy] })}\n`;
      const file = path.join(legacyDir, "subagent-runs.json");
      writeFileSync(file, serialized);
      const restoredLegacy = new SubagentRunStore(legacyDir, vi.fn()).get(legacy.id)!;
      expect(restoredLegacy.id).toBe(legacy.id);
      expect(restoredLegacy.source).toBeUndefined();
      expect(restoredLegacy.sessionFile).toBeUndefined();
      expect(readFileSync(file, "utf8")).toBe(serialized);
    }
  });

  it("atomically corrects active-at-restart records to interrupted", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-interrupt-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record({ status: "running" });
    store.create(run);

    const restored = new SubagentRunStore(dataDir, vi.fn());
    expect(restored.list(PARENT_A)[0]).toEqual(
      expect.objectContaining({ id: run.id, status: "interrupted" }),
    );
    expect(restored.cells(PARENT_A)[0]).toEqual(
      expect.objectContaining({
        id: run.id,
        status: "interrupted",
        error: "Subagent run was interrupted by an app or server restart.",
      }),
    );
    expect(readdirSync(dataDir).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("preserves stopped status and partial output separately from its reason", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-stopped-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    const run = record();
    store.create(run);
    const completedAt = new Date().toISOString();
    store.update(run.id, {
      status: "stopped",
      updatedAt: completedAt,
      completedAt,
      summary: "partial output",
      error: "Stopped by parent shutdown.",
    });

    expect(new SubagentRunStore(dataDir, vi.fn()).cells(PARENT_A)[0]).toEqual(
      expect.objectContaining({
        status: "stopped",
        text: "partial output",
        error: "Stopped by parent shutdown.",
      }),
    );
  });

  it("fsyncs the temporary file and containing directory for each committed rename", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-durable-"));
    const syncFile = vi.fn();
    const syncDirectory = vi.fn();
    const store = new SubagentRunStore(dataDir, vi.fn(), { syncFile, syncDirectory });
    store.create(record());

    expect(syncFile).toHaveBeenCalledOnce();
    expect(syncDirectory).toHaveBeenCalledOnce();
    expect(syncDirectory).toHaveBeenCalledWith(dataDir);
  });

  it("retains renamed state in memory when directory fsync fails before a later write", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-directory-sync-"));
    const syncDirectory = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error("directory fsync failed");
      })
      .mockImplementation(() => {});
    const store = new SubagentRunStore(dataDir, vi.fn(), {
      syncFile: vi.fn(),
      syncDirectory,
    });
    const first = record();
    const second = record();

    expect(() => store.create(first)).toThrow("directory fsync failed");
    // The rename succeeded before directory fsync failed. A subsequent commit
    // must build on that candidate rather than stale pre-rename memory.
    store.create(second);

    expect(new SubagentRunStore(dataDir, vi.fn()).list(PARENT_A).map((run) => run.id)).toEqual([
      first.id,
      second.id,
    ]);
  });

  it("removes only records owned by the deleted parent", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-remove-"));
    const store = new SubagentRunStore(dataDir, vi.fn());
    store.create(record({ parentSessionId: PARENT_A }));
    store.create(record({ parentSessionId: PARENT_B }));
    store.removeParent(PARENT_A);

    const restored = new SubagentRunStore(dataDir, vi.fn());
    expect(restored.list(PARENT_A)).toEqual([]);
    expect(restored.list(PARENT_B)).toHaveLength(1);
  });

  it("quarantines corrupt and tampered persistence without loading it", () => {
    for (const body of ["{broken", JSON.stringify({ version: 1, runs: [{ forged: true }] })]) {
      const dataDir = mkdtempSync(path.join(tmpdir(), "subagent-corrupt-"));
      const file = path.join(dataDir, "subagent-runs.json");
      writeFileSync(file, body);
      const warn = vi.fn();
      const store = new SubagentRunStore(dataDir, warn);

      expect(store.list(PARENT_A)).toEqual([]);
      expect(warn).toHaveBeenCalledOnce();
      expect(existsSync(file)).toBe(false);
      expect(readdirSync(dataDir).some((name) => name.includes(".corrupt-"))).toBe(true);
    }
  });
});
