import type { SessionMeta } from "@agent-deck/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const transportHarness = vi.hoisted(() => ({
  host: null as null | { onServerMessage: (message: unknown) => void },
}));

vi.mock("./clientTransport.ts", () => ({
  RpcClientTransport: class {
    constructor(host: { onServerMessage: (message: unknown) => void }) {
      transportHarness.host = host;
    }
    connect(): void {}
    disconnect(): void {}
    send(): void {}
  },
}));

import { mergeWorktreeSession, MergeWorktreeError, switchToSession } from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

const session = {
  id: "merge-session",
  cwd: "/tmp/worktree",
  createdAt: "2026-01-01T00:00:00.000Z",
} as SessionMeta;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function selectSession(): Promise<void> {
  const fetchMock = vi.mocked(fetch);
  fetchMock
    .mockResolvedValueOnce(jsonResponse({ session }))
    .mockResolvedValueOnce(jsonResponse({ sessions: [session] }));
  await switchToSession(session);
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.getState().resetDiffState();
  useAppStore.getState().setError(null);
});

describe("mergeWorktreeSession HTTP validation", () => {
  it.each([
    ["merge_conflict", "conflict"],
    ["merge_ahead_failed", "failed"],
  ] as const)("retains typed %s and clears a committed worktree diff", async (code, outcome) => {
    await selectSession();
    useAppStore.getState().setDiffState({
      repo: true,
      files: [
        {
          path: "changed.txt",
          status: "?",
          insertions: null,
          deletions: null,
          binary: false,
        },
      ],
      truncated: false,
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          code,
          outcome,
          error: "server detail",
          worktreeCommitted: true,
        },
        code === "merge_ahead_failed" ? 500 : 409,
      ),
    );

    const error = await mergeWorktreeSession(session.id).catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MergeWorktreeError);
    expect(error).toMatchObject({ code, outcome, worktreeCommitted: true });
    expect(useAppStore.getState().diffFiles).toEqual([]);
  });

  it.each([
    [{ error: "legacy" }, 409],
    [
      {
        code: "future_code",
        outcome: "future_outcome",
        error: "untrusted",
        worktreeCommitted: true,
      },
      409,
    ],
    [null, 500],
  ])("maps malformed non-OK JSON to a safe generic failure", async (body, status) => {
    vi.mocked(fetch).mockResolvedValueOnce(jsonResponse(body, status));
    const error = await mergeWorktreeSession("other-session").catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "merge_failed",
      outcome: "failed",
      worktreeCommitted: false,
    });
    expect((error as Error).message).toContain(`Merge failed (${status})`);
  });

  it("rejects malformed success JSON instead of clearing or returning it", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        code: "merge_succeeded",
        outcome: "merged",
        branch: "session",
        sourceBranch: "main",
        commits: "1",
        worktreeCommitted: true,
        cleanup: { status: "retained", runtimeStopped: false },
      }),
    );
    const error = await mergeWorktreeSession("other-session").catch((value: unknown) => value);
    expect(error).toMatchObject({
      code: "merge_failed",
      outcome: "failed",
      worktreeCommitted: false,
    });
  });

  it("accepts only the complete success discriminants", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        code: "merge_succeeded",
        outcome: "merged",
        branch: "session",
        sourceBranch: "main",
        commits: 1,
        worktreeCommitted: true,
        cleanup: { status: "removed", runtimeStopped: false },
      }),
    );
    await expect(mergeWorktreeSession("other-session")).resolves.toMatchObject({
      code: "merge_succeeded",
      outcome: "merged",
      commits: 1,
      cleanup: { status: "removed", runtimeStopped: false },
    });
  });

  it("accepts an actionable cleanup failure without changing merge success", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        code: "merge_succeeded",
        outcome: "merged",
        branch: "session",
        sourceBranch: "main",
        commits: 1,
        worktreeCommitted: true,
        cleanup: {
          status: "failed",
          runtimeStopped: true,
          code: "worktree_remove_failed",
          error: "The merge succeeded, but cleanup is locked.",
        },
      }),
    );
    await expect(mergeWorktreeSession("other-session")).resolves.toMatchObject({
      cleanup: { status: "failed", code: "worktree_remove_failed" },
    });
  });

  it.each([
    ["merge_runtime_busy", "Wait for the current Pi turn to finish before merging."],
    [
      "merge_runtime_state_unavailable",
      "Pi runtime state could not be verified. Stop or reopen the session before merging.",
    ],
  ] as const)("preserves Pi-specific recovery text for %s", async (code, serverMessage) => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse(
        {
          code,
          outcome: "busy",
          error: serverMessage,
          worktreeCommitted: false,
        },
        409,
      ),
    );

    const error = await mergeWorktreeSession("other-session").catch((value: unknown) => value);
    expect(error).toBeInstanceOf(MergeWorktreeError);
    expect(error).toMatchObject({ code, outcome: "busy" });
    expect((error as Error).message).toBe(serverMessage);
    expect((error as Error).message).not.toContain("Git operation");
  });

  it.each([
    [false, "pi exited (code 0)"],
    [true, null],
  ] as const)(
    "uses runtimeStopped=%s to classify a response-before-exit cleanup",
    async (runtimeStopped, expectedError) => {
      await selectSession();
      vi.mocked(fetch).mockResolvedValueOnce(
        jsonResponse({
          ok: true,
          code: "merge_succeeded",
          outcome: "merged",
          branch: "session",
          sourceBranch: "main",
          commits: 1,
          worktreeCommitted: true,
          cleanup: { status: "removed", runtimeStopped },
        }),
      );

      await mergeWorktreeSession(session.id);
      transportHarness.host!.onServerMessage({
        type: "session_exit",
        sessionId: session.id,
        code: 0,
        signal: null,
      });
      expect(useAppStore.getState().error).toBe(expectedError);
    },
  );

  it("rejects a cleanup result without explicit runtime ownership truth", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        code: "merge_succeeded",
        outcome: "merged",
        branch: "session",
        sourceBranch: "main",
        commits: 1,
        worktreeCommitted: true,
        cleanup: { status: "removed" },
      }),
    );

    await expect(mergeWorktreeSession("other-session")).rejects.toMatchObject({
      code: "merge_failed",
    });
  });

  it("does not clear an unrelated global error after successful cleanup", async () => {
    useAppStore.getState().setError("unrelated provider error");
    vi.mocked(fetch).mockResolvedValueOnce(
      jsonResponse({
        ok: true,
        code: "merge_succeeded",
        outcome: "merged",
        branch: "session",
        sourceBranch: "main",
        commits: 1,
        worktreeCommitted: true,
        cleanup: { status: "removed", runtimeStopped: false },
      }),
    );

    await mergeWorktreeSession("other-session");
    expect(useAppStore.getState().error).toBe("unrelated provider error");
  });

  it("preserves active-merge Git detail and completion-or-abort guidance", () => {
    const error = new MergeWorktreeError(
      "merge_active_failure",
      "failed",
      true,
      "hook rejected. Fix the reported issue and complete the merge commit, or abort the merge.",
    );
    expect(error.message).toContain("hook rejected");
    expect(error.message).toContain("complete the merge commit, or abort");
  });
});
