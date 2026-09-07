import { SessionMutationClaims } from "../src/sessionMutationClaims.ts";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { SessionWorktreeStore } from "@agent-deck/loop-catalog-native";
import type { SessionMeta } from "@agent-deck/domain";
import { describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../src/context.ts";
import { registerSessionRoutes } from "../src/routes/sessions.ts";
import { SubagentRunStore } from "../src/subagentRunStore.ts";

// HTTP routes + actual durable child store + native ownership + real Git. No Pi
// or user checkout is needed to reproduce the missing parent-cwd failure.
async function fixture(keep = false) {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "deck-merge-children-")));
  const repo = path.join(root, "repo");
  const data = path.join(root, "data");
  mkdirSync(repo);
  mkdirSync(data);

  const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(repo, "init", "-b", "main");
  git(repo, "config", "user.name", "Fixture");
  git(repo, "config", "user.email", "fixture@example.invalid");
  writeFileSync(path.join(repo, "base"), "base");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const worktrees = new SessionWorktreeStore(data);
  const parent = path.join(data, "session-worktrees", "a1b2c3d4");
  const identity = worktrees.reserveWorktree(parent);
  const branch = "agent-deck/session-a1b2c3d4";
  git(repo, "worktree", "add", "-b", branch, parent);
  let store = new SubagentRunStore(data, vi.fn());
  const id = randomUUID();
  const rows = new Map<string, SessionMeta>();
  rows.set(id, {
    id,
    cwd: parent,
    projectId: "project",
    worktreePath: parent,
    worktreeIdentity: identity,
    worktreeBranch: branch,
    worktreeSourceBranch: "main",
  } as SessionMeta);
  const children: { id: string; cwd: string }[] = [];
  for (let i = 0; i < 2; i++) {
    const childId = randomUUID();
    const now = new Date().toISOString();
    store.create({
      id: childId,
      parentSessionId: id,
      task: "fixture",
      source: "parallel",
      status: "completed",
      createdAt: now,
      updatedAt: now,
      completedAt: now,
    });
    children.push({ id: childId, cwd: await store.prepareWorktree(childId, parent) });
  }
  writeFileSync(path.join(parent, "merged"), "session work");
  git(parent, "add", ".");
  git(parent, "commit", "-m", "session change");
  const fastify = Fastify();
  let live: { meta: SessionMeta } | undefined;
  const ctx = {
    fastify,
    sessions: {
      mutationClaims: new SessionMutationClaims(),
      get: () => live,
      list: () => (live ? [live.meta] : []),
      resume: vi.fn(async (meta: SessionMeta) => ({ meta })),
      destroy: vi.fn(async () => {}),
      removeSubagentWorktreesForMerge: (sessionId: string) =>
        store.removeWorktreesForMerge(sessionId),
      removeSubagentRuns: (sessionId: string) => store.removeParent(sessionId),
      removeLoopSessionSnapshot: vi.fn(),
    },
    index: {
      list: () => [...rows.values()],
      find: (f: (m: SessionMeta) => boolean) => [...rows.values()].find(f),
      upsert: (m: SessionMeta) => rows.set(m.id, m),
      remove: (sessionId: string) => rows.delete(sessionId),
    },
    projects: { find: () => ({ id: "project", path: repo }) },
    settings: { get: () => ({ keepWorktreeAfterMerge: keep }) },
    sessionWorktreeStore: worktrees,
    worktreesRoot: path.dirname(parent),
    bridgeTokens: new Map(),
    askUser: { cancelSession: vi.fn() },
    broadcast: vi.fn(),
    dropDiffCache: vi.fn(),
  } as unknown as ServerContext;
  registerSessionRoutes(ctx);
  return {
    parent,
    children,
    rows,
    id,
    git,
    repo,
    sessions: ctx.sessions,
    setLive: () => {
      live = { meta: rows.get(id)! };
    },
    resume: () => fastify.inject({ method: "POST", url: `/sessions/${id}/resume` }),
    store: () => store,
    restart: () => {
      store.close();
      store = new SubagentRunStore(data, vi.fn());
    },
    merge: () => fastify.inject({ method: "POST", url: `/sessions/${id}/merge` }),
    delete: () => fastify.inject({ method: "DELETE", url: `/sessions/${id}` }),
    close: async () => {
      await fastify.close();
      store.close();
      worktrees.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("merge cleanup with children rooted at a linked session checkout", () => {
  it("reaps children before their parent, retains history across restart, then deletes successfully", async () => {
    const f = await fixture();
    try {
      const result = await f.merge();
      expect(result.statusCode, result.body).toBe(200);
      expect(result.json()).toMatchObject({ cleanup: { status: "removed" } });
      expect(existsSync(f.parent)).toBe(false);
      for (const child of f.children) {
        expect(existsSync(child.cwd)).toBe(false);
        expect(f.store().get(child.id)).not.toHaveProperty("worktreePath");
      }
      expect(f.git(f.repo, "worktree", "list", "--porcelain")).not.toContain("detached");
      f.restart();
      expect(f.store().list(f.id)).toHaveLength(2);
      expect((await f.delete()).statusCode).toBe(200);
      expect(f.rows.has(f.id)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("preserves single-child artifacts and allows fresh allocation after merge cleanup", async () => {
    const f = await fixture();
    try {
      const now = new Date().toISOString();
      const run = {
        id: randomUUID(),
        parentSessionId: f.id,
        task: "history",
        source: "single" as const,
        status: "completed" as const,
        createdAt: now,
        updatedAt: now,
        completedAt: now,
      };
      const allocation = f.store().prepareTurn(run, "fixture prompt");
      f.store().create({
        ...run,
        artifactRootId: allocation.artifactRootId,
        artifactRootToken: allocation.identityToken,
        currentTurnId: allocation.turnId,
      });
      const sessionFile = path.join(allocation.sessionsDirectory, "history.jsonl");
      writeFileSync(sessionFile, "{}\n");
      f.store().markOwnedSession(run.id, sessionFile);
      expect((await f.merge()).json()).toMatchObject({ cleanup: { status: "removed" } });
      expect(f.store().get(run.id)?.sessionFile).toBe(sessionFile);
      expect(existsSync(sessionFile)).toBe(true);
      f.store().validateOwnedSession(run.id, sessionFile);
      const next = { ...run, id: randomUUID() };
      f.store().prepareTurn(next, "new turn");
      f.store().create(next);
      expect((await f.delete()).statusCode).toBe(200);
      expect(existsSync(sessionFile)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it("retains retry markers after partial physical cleanup and recovers after restart", async () => {
    const f = await fixture();
    const original = SessionWorktreeStore.prototype.deleteWorktree;
    const spy = vi
      .spyOn(SessionWorktreeStore.prototype, "deleteWorktree")
      .mockImplementation(function (this: SessionWorktreeStore, target, identity) {
        if (target === f.children[1]!.cwd) throw new Error("fixture lock");
        return original.call(this, target, identity);
      });
    try {
      expect((await f.merge()).json()).toMatchObject({ cleanup: { status: "failed" } });
      expect(existsSync(f.parent)).toBe(true);
      expect(f.store().get(f.children[0]!.id)?.worktreeCleanup).toBe("physical_removed");
      expect(existsSync(f.children[1]!.cwd)).toBe(true);
      spy.mockRestore();
      f.restart();
      await f.store().removeWorktreesForMerge(f.id);
      expect((await f.delete()).statusCode).toBe(200);
    } finally {
      spy.mockRestore();
      await f.close();
    }
  });

  it.each(["during reap", "after reap"])(
    "blocks resume/new-child spawn %s until parent cleanup commits",
    async (window) => {
      const f = await fixture();
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalDelete = SessionWorktreeStore.prototype.deleteWorktree;
      const deletionSpy = vi
        .spyOn(SessionWorktreeStore.prototype, "deleteWorktree")
        .mockImplementation(async function (this: SessionWorktreeStore, target, identity) {
          if (window === "during reap" && target === f.children[0]!.cwd) {
            enter();
            await gate;
          }
          return originalDelete.call(this, target, identity);
        });
      const originalReap = f.sessions.removeSubagentWorktreesForMerge;
      const reapSpy = vi
        .spyOn(f.sessions, "removeSubagentWorktreesForMerge")
        .mockImplementation(async (id) => {
          await originalReap(id);
          if (window === "after reap") {
            enter();
            await gate;
          }
        });
      const spawn = vi.spyOn(f.sessions, "resume").mockImplementation(async (meta) => {
        const now = new Date().toISOString();
        const childId = randomUUID();
        f.store().create({
          id: childId,
          parentSessionId: f.id,
          task: "concurrent spawn",
          source: "parallel",
          status: "starting",
          createdAt: now,
          updatedAt: now,
        });
        await f.store().prepareWorktree(childId, meta.cwd!);
        throw new Error("Resume must not reach child allocation while merging");
      });
      const merge = f.merge();
      try {
        await entered;
        const resume = await f.resume();
        expect(resume.statusCode, resume.body).toBe(409);
        expect(resume.json()).toMatchObject({ code: "session_mutation_busy" });
        expect(spawn).not.toHaveBeenCalled();
        expect(existsSync(f.parent)).toBe(true);
        release();
        expect((await merge).json()).toMatchObject({ cleanup: { status: "removed" } });
        expect(f.sessions.mutationClaims.owner(f.id)).toBeUndefined();
        expect(f.store().list(f.id)).toHaveLength(2);
        expect((await f.delete()).statusCode).toBe(200);
      } finally {
        release();
        await merge;
        deletionSpy.mockRestore();
        reapSpy.mockRestore();
        await f.close();
      }
    },
  );

  it("retains the parent if an internal runtime appears after child reaping", async () => {
    const f = await fixture();
    const original = f.sessions.removeSubagentWorktreesForMerge;
    vi.spyOn(f.sessions, "removeSubagentWorktreesForMerge").mockImplementation(async (id) => {
      await original(id);
      f.setLive();
    });
    try {
      expect((await f.merge()).json()).toMatchObject({
        cleanup: { status: "failed", code: "runtime_shutdown_failed" },
      });
      expect(existsSync(f.parent)).toBe(true);
      expect(f.rows.get(f.id)?.worktreePath).toBe(f.parent);
    } finally {
      await f.close();
    }
  });

  it.each(["starting", "running"] as const)(
    "refuses a clean %s child before removing any sibling",
    async (status) => {
      const f = await fixture();
      try {
        f.store().update(f.children[1]!.id, { status, completedAt: undefined });
        expect((await f.merge()).json()).toMatchObject({ cleanup: { status: "failed" } });
        expect(existsSync(f.parent)).toBe(true);
        for (const child of f.children) expect(existsSync(child.cwd)).toBe(true);
      } finally {
        await f.close();
      }
    },
  );

  it("rechecks live child status in phase two, not the preflight snapshot", async () => {
    const f = await fixture();
    const originalDelete = SessionWorktreeStore.prototype.deleteWorktree;
    const spy = vi
      .spyOn(SessionWorktreeStore.prototype, "deleteWorktree")
      .mockImplementation(async function (this: SessionWorktreeStore, target, identity) {
        await originalDelete.call(this, target, identity);
        if (target === f.children[0]!.cwd)
          f.store().update(f.children[1]!.id, { status: "running", completedAt: undefined });
      });
    try {
      expect((await f.merge()).json()).toMatchObject({ cleanup: { status: "failed" } });
      expect(existsSync(f.parent)).toBe(true);
      expect(existsSync(f.children[1]!.cwd)).toBe(true);
    } finally {
      spy.mockRestore();
      await f.close();
    }
  });

  it("keep-worktree retains parent and children for review and later deletion", async () => {
    const f = await fixture(true);
    try {
      expect((await f.merge()).json()).toMatchObject({ cleanup: { status: "retained" } });
      expect(existsSync(f.parent)).toBe(true);
      for (const child of f.children) expect(existsSync(child.cwd)).toBe(true);
      f.restart();
      expect((await f.delete()).statusCode).toBe(200);
      for (const child of f.children) expect(existsSync(child.cwd)).toBe(false);
    } finally {
      await f.close();
    }
  });

  it.each(["replaced", "dirty", "ignored", "unmerged commit"])(
    "refuses %s child without losing parent or siblings; repair permits retry",
    async (unsafe) => {
      const f = await fixture();
      const child = f.children[1]!;
      try {
        if (unsafe === "replaced") {
          renameSync(child.cwd, child.cwd + "-held");
          writeFileSync(child.cwd, "unowned replacement");
        } else {
          if (unsafe === "ignored")
            f.git(
              f.repo,
              "config",
              "core.excludesFile",
              path.join(f.repo, ".git", "fixture-ignore"),
            );
          if (unsafe === "ignored")
            writeFileSync(path.join(f.repo, ".git", "fixture-ignore"), "local\n");
          writeFileSync(path.join(child.cwd, "local"), "user work");
          if (unsafe === "unmerged commit") {
            f.git(child.cwd, "add", ".");
            f.git(child.cwd, "commit", "-m", "child-only");
          }
        }
        const result = await f.merge();
        expect(result.statusCode, result.body).toBe(200);
        expect(result.json()).toMatchObject({
          outcome: "merged",
          cleanup: { status: "failed", code: "worktree_remove_failed" },
        });
        expect(existsSync(f.parent)).toBe(true);
        expect(existsSync(f.children[0]!.cwd)).toBe(true);
        expect(f.rows.get(f.id)?.cwd).toBe(f.parent);
        if (unsafe === "replaced") {
          rmSync(child.cwd);
          renameSync(child.cwd + "-held", child.cwd);
        } else if (unsafe === "unmerged commit")
          f.git(f.parent, "merge", "--no-edit", f.git(child.cwd, "rev-parse", "HEAD"));
        else rmSync(path.join(child.cwd, "local"));
        // Same-process merge cleanup retry must not inherit #19's delete claim.
        await f.store().removeWorktreesForMerge(f.id);
        expect(f.store().list(f.id)).toHaveLength(2);
        expect((await f.delete()).statusCode).toBe(200);
      } finally {
        await f.close();
      }
    },
  );

  it("merge conflict never starts child cleanup", async () => {
    const f = await fixture();
    try {
      writeFileSync(path.join(f.repo, "merged"), "conflicting source change");
      f.git(f.repo, "add", ".");
      f.git(f.repo, "commit", "-m", "conflict");
      expect((await f.merge()).json()).toMatchObject({ code: "merge_conflict" });
      expect(existsSync(f.parent)).toBe(true);
      for (const child of f.children) expect(existsSync(child.cwd)).toBe(true);
    } finally {
      await f.close();
    }
  });
});
