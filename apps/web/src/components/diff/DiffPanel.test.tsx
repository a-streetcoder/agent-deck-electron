// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fetchBranchDiffFiles } from "../../state/wsBridge.ts";
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

it("an ordinary session has no base toggle", () => {
  useAppStore.setState({
    session: { id: "s2" } as NonNullable<ReturnType<typeof useAppStore.getState>["session"]>,
  });
  render(<DiffPanel />);
  expect(screen.queryByLabelText("Compare with")).toBeNull();
});
