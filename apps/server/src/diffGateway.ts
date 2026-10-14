import type { DiffBase, DiffScope, SessionMeta } from "@agent-deck/contracts";
import { Effect } from "effect";
import { runPromiseUnwrapped } from "./effectRun.ts";
import { gitFullyQualifiedBranchRef, gitMergeBase } from "./git.ts";
import type { ServerRuntime } from "./runtime.ts";
import {
  SessionDiff,
  type DiffFileSet,
  type DiffRefreshResult,
  type FileDiffResult,
} from "./services/diff.ts";

/**
 * The promise facade over the `SessionDiff` Effect service (Slice 9), for the
 * non-Effect consumers (rpcHandler.ts ops, server.ts's turn-boundary hook) —
 * the exact role terminalGateway.ts plays over TerminalHost. No scopes here:
 * diff computations are one-shot effects, so the facade is a thin
 * runPromise/runSync bridge onto the runtime's service.
 */

export interface DiffGateway {
  /** The session's changed-file set (cached; computes on first call). */
  readonly listFiles: (sessionId: string, cwd: string, base?: string) => Promise<DiffFileSet>;
  /** Recompute now (turn boundary / on demand); reports whether the set changed. */
  readonly refresh: (sessionId: string, cwd: string, base?: string) => Promise<DiffRefreshResult>;
  /** One file's bounded unified diff (empty for unknown paths / binary files). */
  readonly fileDiff: (
    sessionId: string,
    cwd: string,
    path: string,
    base?: string,
    scope?: DiffScope,
  ) => Promise<FileDiffResult>;
  /** Drop the session's cache entry (session ended/destroyed). */
  readonly drop: (sessionId: string) => void;
}

/** Select a diff base exclusively from durable server-owned metadata: a Loop
 * review always compares with its source branch; a worktree session does so
 * only when the client asks for the `branch` base (ROAD-S20). */
export async function sessionDiffBase(
  meta: SessionMeta,
  requested: DiffBase = "head",
): Promise<string | undefined> {
  if (!meta.loopReviewRunId) {
    if (requested === "head") return undefined;
    if (
      !meta.worktreePath ||
      meta.cwd !== meta.worktreePath ||
      !meta.worktreeBranch ||
      !meta.worktreeSourceBranch
    ) {
      throw new Error("branch diff is only available for worktree sessions");
    }
    // sourceBranch...HEAD: the merge base, so source-branch commits made after
    // the worktree forked never show up as reverted worktree changes.
    const sourceRef = await gitFullyQualifiedBranchRef(meta.cwd, meta.worktreeSourceBranch);
    return gitMergeBase(meta.cwd, sourceRef, "HEAD");
  }
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      meta.loopReviewRunId,
    ) ||
    !meta.worktreePath ||
    meta.cwd !== meta.worktreePath ||
    !meta.worktreeBranch ||
    !meta.worktreeSourceBranch
  ) {
    throw new Error("Loop review metadata is unavailable");
  }
  return gitFullyQualifiedBranchRef(meta.cwd, meta.worktreeSourceBranch);
}

export function createDiffGateway(runtime: ServerRuntime): DiffGateway {
  return {
    listFiles: (sessionId, cwd, base) =>
      runPromiseUnwrapped(
        runtime,
        Effect.flatMap(SessionDiff, (diff) => diff.listFiles(sessionId, cwd, base)),
      ),
    refresh: (sessionId, cwd, base) =>
      runPromiseUnwrapped(
        runtime,
        Effect.flatMap(SessionDiff, (diff) => diff.refresh(sessionId, cwd, base)),
      ),
    fileDiff: (sessionId, cwd, path, base, scope) =>
      runPromiseUnwrapped(
        runtime,
        Effect.flatMap(SessionDiff, (diff) => diff.fileDiff(sessionId, cwd, path, base, scope)),
      ),
    drop: (sessionId) =>
      runtime.runSync(Effect.flatMap(SessionDiff, (diff) => diff.drop(sessionId))),
  };
}
