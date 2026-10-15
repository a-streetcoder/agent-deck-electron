// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchBranchDiffFiles, mergeWorktreeSession } from "../../state/wsBridge.ts";
import { useAppStore } from "../../state/store.ts";
import { DiffPanel } from "./DiffPanel.tsx";

vi.mock("../../state/wsBridge.ts", () => ({
  fetchBranchDiffFiles: vi.fn(),
  fetchFileDiff: vi.fn(async () => ({ diff: "", truncated: false, binary: false })),
  fetchAvailableEditors: vi.fn(async () => []),
  mergeWorktreeSession: vi.fn(),
  openFileInEditor: vi.fn(),
}));

const entry = (path: string) => ({
  path,
  status: "M" as const,
  insertions: 1,
  deletions: 0,
  binary: false,
});

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ settings: { gitAutomation: false } })),
  );
  vi.mocked(fetchBranchDiffFiles).mockResolvedValue({
    repo: true,
    files: [entry("a.txt"), entry("committed.txt")],
    truncated: false,
  });
  useAppStore.setState({
    session: {
      id: "s1",
      worktreeBranch: "agent-deck/session-s1",
      worktreeSourceBranch: "main",
    } as NonNullable<ReturnType<typeof useAppStore.getState>["session"]>,
    diffRepo: true,
    diffFiles: [entry("a.txt")],
    diffTruncated: false,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("a worktree session toggles between uncommitted and since-source-branch changes", async () => {
  render(<DiffPanel />);
  expect(screen.getByTestId("diff-file-count").textContent).toBe("1");
  expect(fetchBranchDiffFiles).not.toHaveBeenCalled();

  fireEvent.change(screen.getByLabelText("Compare with"), { target: { value: "branch" } });
  await waitFor(() => expect(screen.getByTestId("diff-file-count").textContent).toBe("2"));
  expect(screen.getByText("committed.txt")).toBeTruthy();

  fireEvent.change(screen.getByLabelText("Compare with"), { target: { value: "head" } });
  expect(screen.getByTestId("diff-file-count").textContent).toBe("1");
});

it("branch mode refetches when a turn ends with the HEAD set unchanged", async () => {
  const setAgentStatus = (agentStatus: "running" | "idle") =>
    useAppStore.setState((state) => ({ transcript: { ...state.transcript, agentStatus } }));
  setAgentStatus("idle");
  render(<DiffPanel />);
  fireEvent.change(screen.getByLabelText("Compare with"), { target: { value: "branch" } });
  await waitFor(() => expect(screen.getByTestId("diff-file-count").textContent).toBe("2"));

  // The agent edits and commits in one turn: no diff_push, the branch set grows.
  act(() => setAgentStatus("running"));
  vi.mocked(fetchBranchDiffFiles).mockResolvedValue({
    repo: true,
    files: [entry("a.txt"), entry("committed.txt"), entry("new-commit.txt")],
    truncated: false,
  });
  act(() => setAgentStatus("idle"));
  await waitFor(() => expect(screen.getByTestId("diff-file-count").textContent).toBe("3"));
  expect(screen.getByText("new-commit.txt")).toBeTruthy();
});

it("an ordinary session has no base toggle", () => {
  useAppStore.setState({
    session: { id: "s2" } as NonNullable<ReturnType<typeof useAppStore.getState>["session"]>,
  });
  render(<DiffPanel />);
  expect(screen.queryByLabelText("Compare with")).toBeNull();
});

describe("SRV-12c3: merge on a shared server", () => {
  const withSession = (extra: Record<string, unknown>, shared: boolean) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ settings: { gitAutomation: true } })),
    );
    useAppStore.setState({
      me: shared ? { id: "andrea@example.com", email: "andrea@example.com" } : null,
      toasts: [],
      session: {
        id: "s1",
        worktreeBranch: "agent-deck/session-s1",
        worktreeSourceBranch: "main",
        ...extra,
      } as NonNullable<ReturnType<typeof useAppStore.getState>["session"]>,
    });
  };
  afterEach(() => useAppStore.setState({ me: null }));

  it("reads Push and open PR, and says which PR it opened", async () => {
    withSession({}, true);
    vi.mocked(mergeWorktreeSession).mockResolvedValueOnce({
      ok: true,
      code: "merge_pr_opened",
      outcome: "pr",
      pr: { url: "https://github.com/acme/app/pull/7", number: 7 },
      branch: "agent-deck/session-s1",
      base: "main",
      commits: 1,
      worktreeCommitted: true,
    });
    render(<DiffPanel />);
    const button = await screen.findByTestId("diff-merge");
    expect(button.textContent).toBe("Push and open PR");
    fireEvent.click(button);
    await waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
        "Pushed agent-deck/session-s1 and opened pull request #7",
      ),
    );
  });

  it("shows the open PR and pushes to it again", async () => {
    withSession(
      { mergePr: { url: "https://github.com/acme/app/pull/7", number: 7, openedAt: "now" } },
      true,
    );
    vi.mocked(mergeWorktreeSession).mockResolvedValueOnce({
      ok: true,
      code: "merge_pr_updated",
      outcome: "pr",
      pr: { url: "https://github.com/acme/app/pull/7", number: 7 },
      branch: "agent-deck/session-s1",
      base: "main",
      commits: 2,
      worktreeCommitted: true,
    });
    render(<DiffPanel />);
    const button = await screen.findByTestId("diff-merge");
    expect(button.textContent).toBe("Push to PR");
    expect(screen.getByTestId("merge-pr-link").getAttribute("href")).toBe(
      "https://github.com/acme/app/pull/7",
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)?.message).toBe(
        "Pushed agent-deck/session-s1 and updated pull request #7",
      ),
    );
  });

  it("warns before a local merge of work that already has a PR on the server", async () => {
    withSession(
      {
        returnedFrom: {
          serverOrigin: "https://deck.example.test",
          serverSessionId: "srv",
          returnedAt: "now",
          mergePr: { url: "https://github.com/acme/app/pull/9", number: 9 },
        },
      },
      false,
    );
    render(<DiffPanel />);
    expect((await screen.findByTestId("diff-merge")).textContent).toBe("Merge to main");
    expect(screen.getByTestId("merge-returned-pr").textContent).toContain("PR #9");
  });

  it("keeps the local merge on the desktop", async () => {
    withSession({}, false);
    render(<DiffPanel />);
    expect((await screen.findByTestId("diff-merge")).textContent).toBe("Merge to main");
    expect(screen.queryByTestId("merge-pr-link")).toBeNull();
  });
});
