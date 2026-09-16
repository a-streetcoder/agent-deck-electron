// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { SessionStartupCard } from "./SessionStartupCard.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("previews the session project without a global project selection", () => {
  useAppStore.setState({
    currentProjectId: null,
    currentAgentName: null,
    projects: [
      {
        id: "project",
        name: "Project",
        path: "/project",
        createdAt: "now",
        assignedSkills: ["tidy-commits"],
      },
    ],
    session: { id: "session", projectId: "project", cwd: "/project", createdAt: "now" },
  });
  render(<SessionStartupCard />);
  expect(screen.getByTestId("startup-skills").textContent).toContain("tidy-commits");
  expect(screen.getByTestId("startup-cwd").textContent).toBe("/project");
  expect(screen.getByText("Project", { selector: "div" })).toBeTruthy();
});

it("does not borrow a different project's assignments for a no-project session", () => {
  useAppStore.setState({
    currentProjectId: "project",
    currentAgentName: null,
    projects: [
      {
        id: "project",
        name: "Project",
        path: "/project",
        createdAt: "now",
        assignedSkills: ["tidy-commits"],
      },
    ],
    session: { id: "session", cwd: "/tmp", createdAt: "now" },
  });
  render(<SessionStartupCard />);
  expect(screen.getByTestId("startup-skills").textContent).toBe("None assigned");
  expect(screen.getByText("All Projects")).toBeTruthy();
});

it("edits draft project and isolation without changing its session identity", async () => {
  const draft = {
    id: "draft",
    cwd: "/tmp",
    createdAt: "now",
    lifecycle: "draft" as const,
    draftWorktreeIsolation: true,
  };
  useAppStore.setState({
    session: draft,
    currentAgentName: null,
    projects: [{ id: "project", name: "Project", path: "/project", createdAt: "now" }],
  });
  const request = vi.fn(async (_input: unknown, init?: RequestInit) => {
    const patch = JSON.parse(String(init?.body)) as {
      projectId?: string;
      worktreeIsolation?: boolean;
    };
    return new Response(
      JSON.stringify({
        session: {
          ...useAppStore.getState().session,
          ...(patch.projectId ? { projectId: patch.projectId, cwd: "/project" } : {}),
          ...(patch.worktreeIsolation !== undefined
            ? { draftWorktreeIsolation: patch.worktreeIsolation }
            : {}),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", request);
  render(<SessionStartupCard />);
  expect((screen.getByLabelText("Isolate draft in a worktree") as HTMLInputElement).checked).toBe(
    true,
  );
  fireEvent.change(screen.getByLabelText("Draft project"), { target: { value: "project" } });
  await waitFor(() => expect(useAppStore.getState().session?.projectId).toBe("project"));
  fireEvent.click(screen.getByLabelText("Isolate draft in a worktree"));
  await waitFor(() => expect(useAppStore.getState().session?.draftWorktreeIsolation).toBe(false));
  expect(useAppStore.getState().session?.id).toBe("draft");
  expect(request).toHaveBeenCalledTimes(2);
});
