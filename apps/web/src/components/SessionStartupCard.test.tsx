// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { useAppStore } from "../state/store.ts";
import { SessionStartupCard } from "./SessionStartupCard.tsx";

afterEach(cleanup);

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
