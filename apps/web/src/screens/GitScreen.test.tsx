// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { GitScreen } from "./GitScreen.tsx";

vi.mock("../state/wsBridge.ts", () => ({ mergeWorktreeSession: vi.fn() }));
const projects = ["a", "b"].map((id) => ({ id, name: id, path: `/${id}`, createdAt: "now" }));
const dirty = {
  repo: true,
  branch: "main",
  clean: false,
  files: [{ status: "M", path: "file.txt" }],
};
const settings = {
  settings: { gitAutomation: true, worktreeIsolation: true, keepWorktreeAfterMerge: true },
};
const select = (id: string) =>
  fireEvent.change(screen.getByTestId("git-project-picker"), { target: { value: id } });
beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  useAppStore.setState({
    projects,
    session: null,
    currentProjectId: null,
    gitActionRequest: null,
    error: null,
    toasts: [],
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => Response.json(url === "/settings" ? settings : dirty)),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("selects locally without a session and commits/pushes the selected project", async () => {
  render(<GitScreen />);
  expect(screen.getByTestId("git-no-project")).toBeTruthy();
  select("b");
  await screen.findByTestId("git-commit-message");
  fireEvent.change(screen.getByTestId("git-commit-message"), { target: { value: "fix" } });
  fireEvent.click(screen.getByTestId("git-commit"));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith(
      "/projects/b/git/commit",
      expect.objectContaining({ body: JSON.stringify({ message: "fix", push: false }) }),
    ),
  );
  await waitFor(() =>
    expect((screen.getByTestId("git-push") as HTMLButtonElement).disabled).toBe(false),
  );
  fireEvent.click(screen.getByTestId("git-push"));
  await waitFor(() =>
    expect(fetch).toHaveBeenCalledWith("/projects/b/git/push", { method: "POST" }),
  );
  expect(useAppStore.getState().currentProjectId).toBeNull();
});

it("defaults to the active session project but keeps explicit selection and scopes merge", async () => {
  useAppStore.setState({
    session: {
      id: "session",
      projectId: "a",
      worktreeBranch: "work",
      worktreeSourceBranch: "main",
    } as NonNullable<ReturnType<typeof useAppStore.getState>["session"]>,
  });
  render(<GitScreen />);
  await screen.findByTestId("git-merge");
  expect((screen.getByTestId("git-project-picker") as HTMLSelectElement).value).toBe("a");
  select("b");
  await screen.findByTestId("git-commit-message");
  expect(screen.queryByTestId("git-merge")).toBeNull();
  act(() => useAppStore.setState({ currentProjectId: "a" }));
  expect((screen.getByTestId("git-project-picker") as HTMLSelectElement).value).toBe("b");
});

it("handles missing and removed projects without a status request", async () => {
  useAppStore.setState({ projects: [] });
  render(<GitScreen />);
  expect(screen.getByTestId("git-no-project")).toBeTruthy();
  expect(fetch).not.toHaveBeenCalledWith(expect.stringContaining("/git/status"));
  act(() => useAppStore.setState({ projects }));
  select("a");
  await screen.findByTestId("git-file-list");
  act(() => useAppStore.setState({ projects: [] }));
  expect(screen.getByTestId("git-no-project")).toBeTruthy();
});

it("ignores late status and generated-message responses across A -> B -> A", async () => {
  let resolveStatus!: (response: Response) => void;
  let resolveMessage!: (response: Response) => void;
  let aLoads = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      if (url === "/projects/a/git/status" && ++aLoads === 1)
        return new Promise<Response>((resolve) => {
          resolveStatus = resolve;
        });
      if (url.endsWith("generate-message"))
        return new Promise<Response>((resolve) => {
          resolveMessage = resolve;
        });
      return Promise.resolve(Response.json(url === "/settings" ? settings : dirty));
    }),
  );
  render(<GitScreen />);
  select("a");
  select("b");
  await screen.findByTestId("git-generate-message");
  fireEvent.click(screen.getByTestId("git-generate-message"));
  select("a");
  await screen.findByTestId("git-commit-message");
  await act(async () => {
    resolveStatus(Response.json({ ...dirty, branch: "stale" }));
    resolveMessage(Response.json({ message: "stale draft" }));
  });
  expect(screen.getByTestId("git-branch").textContent).toBe("main");
  expect((screen.getByTestId("git-commit-message") as HTMLTextAreaElement).value).toBe("");
  expect(useAppStore.getState().error).toBeNull();
});
