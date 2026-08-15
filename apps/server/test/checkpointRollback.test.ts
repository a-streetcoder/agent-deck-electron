import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { SessionMeta } from "@agent-deck/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeCheckpointRollback } from "../src/checkpointRollback.ts";
import { ReceiptBus } from "../src/receipts.ts";
import type { ManagedSession, SessionManager } from "../src/SessionManager.ts";
import { makeCheckpointService } from "../src/services/checkpoints.ts";

/**
 * Rollback orchestrator tests (Slice 18b) — the workspace + conversation restore
 * against a REAL scratch git repo, with the SessionManager (stop/reopen) faked
 * so no pi subprocess is needed. This proves the git restore (the donor's
 * restore-clean-reset, which never moves the branch pointer), the wholesale
 * session-file copy-back, the safety-checkpoint model, and the receipt — the
 * conversation-truncation invariant is guarded end-to-end by the e2e (real pi).
 */

vi.setConfig({ testTimeout: 20_000 });

const tempDirs: string[] = [];
function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function makeRepo(): string {
  const repo = makeTempDir("agent-deck-rb-repo-");
  git(repo, ["init", "-b", "main"]);
  git(repo, ["config", "user.email", "t@example.com"]);
  git(repo, ["config", "user.name", "Test"]);
  writeFileSync(path.join(repo, "README.md"), "# scratch\n");
  git(repo, ["add", "-A"]);
  git(repo, ["commit", "-m", "init"]);
  return repo;
}

describe("makeCheckpointRollback", () => {
  it("restores both halves to a prior turn and relaunches, keeping a safety checkpoint", async () => {
    const repo = makeRepo();
    const sessionDir = makeTempDir("agent-deck-rb-sess-");
    const liveSessionFile = path.join(sessionDir, "session.jsonl");
    const dataDir = makeTempDir("agent-deck-rb-data-");
    const checkpoints = makeCheckpointService({ dataDir });
    const receipts = new ReceiptBus(true);
    const sessionId = "sess-rb";

    // Turn 1: pi writes fileA + appends turn 1 to its session file.
    writeFileSync(path.join(repo, "fileA.txt"), "A-turn1\n");
    writeFileSync(liveSessionFile, "conv-turn1\n");
    await checkpoints.capture({
      sessionId,
      cwd: repo,
      sessionFile: liveSessionFile,
      label: "write fileA",
    });

    // Turn 2: pi writes fileB + grows the session file.
    writeFileSync(path.join(repo, "fileB.txt"), "B-turn2\n");
    writeFileSync(liveSessionFile, "conv-turn1\nconv-turn2\n");
    await checkpoints.capture({
      sessionId,
      cwd: repo,
      sessionFile: liveSessionFile,
      label: "write fileB",
    });

    expect((await checkpoints.records(sessionId)).map((r) => r.turnIndex)).toEqual([0, 1]);

    // Fake the session manager: get() hands back the live meta, destroy() and
    // reopen() just record that they ran (no real pi).
    const meta: SessionMeta = {
      id: sessionId,
      cwd: repo,
      createdAt: new Date().toISOString(),
      piSessionFile: liveSessionFile,
      title: "rollback test",
    };
    const events: string[] = [];
    let reopenedWith: SessionMeta | null = null;
    const sessions = {
      get: (id: string) => (id === sessionId ? ({ meta } as ManagedSession) : undefined),
      destroy: async (id: string) => {
        events.push(`destroy:${id}`);
      },
    } as unknown as SessionManager;

    const rollback = makeCheckpointRollback({
      sessions,
      checkpoints,
      receipts,
      reopen: async (m) => {
        reopenedWith = m;
        events.push("reopen");
        return { meta: m } as ManagedSession;
      },
    });

    const result = await rollback.rollback({ sessionId, turnIndex: 0 });

    // Files: fileA restored (turn 1 content), fileB DISCARDED (post-checkpoint).
    // (git may check the worktree file out with CRLF under core.autocrlf on
    // Windows — normalize before comparing content.)
    const normalize = (s: string): string => s.replace(/\r\n/g, "\n");
    expect(result.filesRestored).toBe(true);
    expect(existsSync(path.join(repo, "fileA.txt"))).toBe(true);
    expect(normalize(readFileSync(path.join(repo, "fileA.txt"), "utf8"))).toBe("A-turn1\n");
    expect(existsSync(path.join(repo, "fileB.txt"))).toBe(false);
    // The branch pointer is untouched (restore never resets HEAD onto the
    // parentless checkpoint commit).
    expect(git(repo, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("main");

    // Conversation: the live session file is the turn-1 snapshot again.
    expect(readFileSync(liveSessionFile, "utf8")).toBe("conv-turn1\n");

    // Lifecycle: stopped THEN relaunched through reopen (with endedAt cleared).
    expect(events).toEqual([`destroy:${sessionId}`, "reopen"]);
    expect(reopenedWith).not.toBeNull();
    expect(reopenedWith!.id).toBe(sessionId);
    expect(reopenedWith!.endedAt).toBeUndefined();

    // Timeline: truncated to [turn 0] + the safety checkpoint (turnIndex 2),
    // whose snapshot is the pre-rollback conversation (the undo point).
    const records = await checkpoints.records(sessionId);
    expect(records.map((r) => r.turnIndex)).toEqual([0, 2]);
    const safety = records.find((r) => r.turnIndex === 2)!;
    expect(readFileSync(safety.sessionSnapshotPath, "utf8")).toBe("conv-turn1\nconv-turn2\n");

    // The receipt fired (UI/e2e synchronization point).
    await receipts.waitFor("checkpoint_rolled_back", sessionId, 1000);
  });

  it("reports the rolled-back turn's user prompt as nextPrompt (CHK-01 rerun-from-here)", async () => {
    const repo = makeRepo();
    const sessionDir = makeTempDir("agent-deck-rb-sessR-");
    const liveSessionFile = path.join(sessionDir, "session.jsonl");
    const dataDir = makeTempDir("agent-deck-rb-dataR-");
    const checkpoints = makeCheckpointService({ dataDir });
    const receipts = new ReceiptBus(false);
    const sessionId = "sess-rb-rerun";

    writeFileSync(path.join(repo, "fileA.txt"), "A-turn1\n");
    writeFileSync(liveSessionFile, "conv-turn1\n");
    await checkpoints.capture({ sessionId, cwd: repo, sessionFile: liveSessionFile, label: "t1" });
    writeFileSync(liveSessionFile, "conv-turn1\nconv-turn2\n");
    await checkpoints.capture({ sessionId, cwd: repo, sessionFile: liveSessionFile, label: "t2" });

    const meta: SessionMeta = {
      id: sessionId,
      cwd: repo,
      createdAt: new Date().toISOString(),
      piSessionFile: liveSessionFile,
      title: "rerun test",
    };
    // The LIVE session's transcript has two user turns; the restored session
    // (after reopen) has one — the rolled-back turn's prompt is the rerun.
    const userCell = (id: string, text: string) => ({ kind: "user", id, text });
    const liveState = { cells: [userCell("u1", "prompt one"), userCell("u2", "prompt two")] };
    const restoredState = { cells: [userCell("u1", "prompt one")] };
    const sessions = {
      get: (id: string) =>
        id === sessionId
          ? ({ meta, snapshot: () => ({ seq: 2, state: liveState }) } as unknown as ManagedSession)
          : undefined,
      destroy: async () => {},
    } as unknown as SessionManager;

    const rollback = makeCheckpointRollback({
      sessions,
      checkpoints,
      receipts,
      reopen: async (m) =>
        ({
          meta: m,
          snapshot: () => ({ seq: 1, state: restoredState }),
        }) as unknown as ManagedSession,
    });

    const result = await rollback.rollback({ sessionId, turnIndex: 0 });
    expect(result.nextPrompt).toBe("prompt two");
    expect(result.nextPromptHadAttachments).toBe(false);

    // A DIVERGENT restored transcript (not a text-prefix of the live one)
    // fails closed: no prompt is ever guessed (Codex).
    writeFileSync(liveSessionFile, "conv-turn1\nconv-turn2\n");
    await checkpoints.capture({ sessionId, cwd: repo, sessionFile: liveSessionFile, label: "tD" });
    const divergentRestored = { cells: [userCell("uX", "something else entirely")] };
    const rollbackDivergent = makeCheckpointRollback({
      sessions: {
        get: () =>
          ({ meta, snapshot: () => ({ seq: 2, state: liveState }) }) as unknown as ManagedSession,
        destroy: async () => {},
      } as unknown as SessionManager,
      checkpoints,
      receipts,
      reopen: async (m) =>
        ({
          meta: m,
          snapshot: () => ({ seq: 1, state: divergentRestored }),
        }) as unknown as ManagedSession,
    });
    const divergentRecords = await checkpoints.records(sessionId);
    const divergent = await rollbackDivergent.rollback({
      sessionId,
      turnIndex: divergentRecords[0]!.turnIndex,
    });
    expect(divergent.nextPrompt).toBeNull();

    // An attachments-ONLY dropped turn yields no text but sets the flag, so
    // the UI can say the turn wasn't rerunnable as text.
    writeFileSync(liveSessionFile, "conv-turn1\nconv-turn2\n");
    await checkpoints.capture({ sessionId, cwd: repo, sessionFile: liveSessionFile, label: "tA" });
    const liveWithAttachment = {
      cells: [
        userCell("u1", "prompt one"),
        { kind: "user", id: "u2", text: "", images: [{ ref: "img-1" }] },
      ],
    };
    const rollbackAttach = makeCheckpointRollback({
      sessions: {
        get: () =>
          ({
            meta,
            snapshot: () => ({ seq: 2, state: liveWithAttachment }),
          }) as unknown as ManagedSession,
        destroy: async () => {},
      } as unknown as SessionManager,
      checkpoints,
      receipts,
      reopen: async (m) =>
        ({
          meta: m,
          snapshot: () => ({ seq: 1, state: restoredState }),
        }) as unknown as ManagedSession,
    });
    const attachRecords = await checkpoints.records(sessionId);
    const attach = await rollbackAttach.rollback({
      sessionId,
      turnIndex: attachRecords[0]!.turnIndex,
    });
    expect(attach.nextPrompt).toBeNull(); // attachments-only: no text to resend
    expect(attach.nextPromptHadAttachments).toBe(true);

    // Rolling back to the LATEST checkpoint drops nothing → no rerun prompt.
    writeFileSync(liveSessionFile, "conv-turn1\nconv-turn2\n");
    await checkpoints.capture({ sessionId, cwd: repo, sessionFile: liveSessionFile, label: "t2b" });
    const sessionsSame = {
      get: () =>
        ({ meta, snapshot: () => ({ seq: 2, state: liveState }) }) as unknown as ManagedSession,
      destroy: async () => {},
    } as unknown as SessionManager;
    const rollbackSame = makeCheckpointRollback({
      sessions: sessionsSame,
      checkpoints,
      receipts,
      reopen: async (m) =>
        ({ meta: m, snapshot: () => ({ seq: 2, state: liveState }) }) as unknown as ManagedSession,
    });
    const records = await checkpoints.records(sessionId);
    const latest = records[records.length - 1]!;
    const same = await rollbackSame.rollback({ sessionId, turnIndex: latest.turnIndex });
    expect(same.nextPrompt).toBeNull();
  });

  it("aborts (conversation unchanged) when a checkpoint with a git ref fails to restore", async () => {
    const repo = makeRepo();
    const sessionDir = makeTempDir("agent-deck-rb-sessF-");
    const liveSessionFile = path.join(sessionDir, "session.jsonl");
    const dataDir = makeTempDir("agent-deck-rb-dataF-");
    const checkpoints = makeCheckpointService({ dataDir });
    const receipts = new ReceiptBus(false);
    const sessionId = "sess-rb-fail";

    // Two turns, each writing a file + growing the conversation.
    writeFileSync(path.join(repo, "fileA.txt"), "A-turn1\n");
    writeFileSync(liveSessionFile, "conv-turn1\n");
    await checkpoints.capture({ sessionId, cwd: repo, sessionFile: liveSessionFile, label: "A" });
    writeFileSync(path.join(repo, "fileB.txt"), "B-turn2\n");
    writeFileSync(liveSessionFile, "conv-turn1\nconv-turn2\n");
    await checkpoints.capture({ sessionId, cwd: repo, sessionFile: liveSessionFile, label: "B" });

    // Corrupt the target: delete turn 0's hidden checkpoint ref so its commit is
    // unresolvable at restore time — gitRestoreCheckpoint returns false, which
    // must ABORT rather than restore the conversation onto the un-restored tree.
    const target = (await checkpoints.records(sessionId)).find((r) => r.turnIndex === 0)!;
    expect(target.gitRef).not.toBeNull();
    git(repo, ["update-ref", "-d", target.gitRef!]);

    const meta: SessionMeta = {
      id: sessionId,
      cwd: repo,
      createdAt: new Date().toISOString(),
      piSessionFile: liveSessionFile,
      title: "abort test",
    };
    const events: string[] = [];
    let reopenedWith: SessionMeta | null = null;
    const sessions = {
      get: (id: string) => (id === sessionId ? ({ meta } as ManagedSession) : undefined),
      destroy: async (id: string) => {
        events.push(`destroy:${id}`);
      },
    } as unknown as SessionManager;
    const rollback = makeCheckpointRollback({
      sessions,
      checkpoints,
      receipts,
      reopen: async (m) => {
        reopenedWith = m;
        events.push("reopen");
        return { meta: m } as ManagedSession;
      },
    });

    await expect(rollback.rollback({ sessionId, turnIndex: 0 })).rejects.toThrow(
      /rollback aborted|snapshot is missing/,
    );

    // Conversation is UNCHANGED — the live session file still holds both turns
    // (never overwritten by the target snapshot).
    expect(readFileSync(liveSessionFile, "utf8")).toBe("conv-turn1\nconv-turn2\n");
    // The session was relaunched from the ORIGINAL meta (stoppable + re-openable,
    // not orphaned dead) with endedAt cleared.
    expect(events).toEqual([`destroy:${sessionId}`, "reopen"]);
    expect(reopenedWith).not.toBeNull();
    expect(reopenedWith!.id).toBe(sessionId);
    expect(reopenedWith!.endedAt).toBeUndefined();
    // A safety checkpoint of the pre-rollback state was still captured (recovery
    // point), and the timeline was truncated to [turn 0, safety].
    const records = await checkpoints.records(sessionId);
    expect(records.map((r) => r.turnIndex)).toEqual([0, 2]);
  });

  it("rejects an unknown session before mutating anything", async () => {
    const dataDir = makeTempDir("agent-deck-rb-data2-");
    const checkpoints = makeCheckpointService({ dataDir });
    const receipts = new ReceiptBus(false);
    const sessions = {
      get: () => undefined,
      destroy: async () => {},
    } as unknown as SessionManager;
    const rollback = makeCheckpointRollback({
      sessions,
      checkpoints,
      receipts,
      reopen: async (m) => ({ meta: m }) as ManagedSession,
    });
    await expect(rollback.rollback({ sessionId: "nope", turnIndex: 0 })).rejects.toThrow(
      /unknown session/,
    );
  });
});
