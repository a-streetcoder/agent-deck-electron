// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentInfo } from "@agent-deck/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { AgentDetail } from "./AgentsScreen.tsx";
import { updateProject } from "../state/wsBridge.ts";

vi.mock("../state/wsBridge.ts", () => ({
  deleteAgent: vi.fn(),
  renameAgent: vi.fn(),
  setAgentDisabled: vi.fn(),
  updateProject: vi.fn(),
}));

const updateProjectMock = vi.mocked(updateProject);

const agent: AgentInfo = {
  name: "writer",
  description: "Writes when separately approved",
  systemPromptMode: "replace",
  defaultReads: ["AGENTS.md", "src/main.ts"],
  defaultExpectedOutcome: "writeProjectFile",
  defaultProgress: true,
  interactive: true,
  maxSubagentDepth: 0,
  output: "Concise review summary",
  scope: "global",
  filePath: "/tmp/writer.md",
  body: "Write carefully.",
  shadowed: false,
  replacesBuiltin: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("AgentDetail delegation metadata", () => {
  it("displays the native outcome and progress labels", () => {
    useAppStore.setState({ projects: [], currentProjectId: null });
    render(
      <AgentDetail
        agent={agent}
        canCreateReplacement={false}
        onCreateReplacement={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    const output = screen.getByTestId("agent-output");
    expect(output.textContent).toContain("Output Advisory");
    expect(output.textContent).toContain("Concise review summary");
    const reads = screen.getByTestId("agent-default-reads");
    expect(reads.textContent).toContain("Default Reads");
    expect(reads.textContent).toContain("AGENTS.md");
    expect(reads.textContent).toContain("src/main.ts");
    const card = screen.getByTestId("agent-default-outcome");
    expect(card.textContent).toContain("Default Outcome");
    expect(card.textContent).toContain("Write/update project file");
    const progress = screen.getByTestId("agent-default-progress");
    expect(progress.textContent).toContain("Default Progress");
    expect(progress.textContent).toContain("Yes");
    const interactive = screen.getByTestId("agent-interactive");
    expect(interactive.textContent).toContain("Interactive");
    expect(interactive.textContent).toContain("Yes");
    const depth = screen.getByTestId("agent-max-subagent-depth");
    expect(depth.textContent).toContain("Max Subagent Depth Metadata");
    expect(depth.textContent).toContain("0");
  });

  it("turns legacy-open availability into an explicit stable assignment set", () => {
    useAppStore.setState({
      projects: [
        {
          id: "project",
          path: "/tmp/project",
          name: "Project",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      currentProjectId: "project",
    });
    render(
      <AgentDetail
        agent={agent}
        canCreateReplacement={false}
        onCreateReplacement={vi.fn()}
        onEdit={vi.fn()}
        availableCustomAgentNames={["writer", "reviewer", "writer"]}
      />,
    );

    const assignment = screen.getByTestId("assigned-agent-writer");
    expect(assignment.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("default-agent-writer").textContent).toContain("session default");
    fireEvent.click(assignment);
    expect(updateProjectMock).toHaveBeenCalledWith("project", {
      assignedAgentNames: ["reviewer"],
    });
  });

  it("keeps builtin project access distinct from active-session default", () => {
    useAppStore.setState({
      projects: [
        {
          id: "project",
          path: "/tmp/project",
          name: "Project",
          createdAt: "2026-01-01T00:00:00.000Z",
          assignedAgentNames: [],
        },
      ],
      currentProjectId: "project",
    });
    render(
      <AgentDetail
        agent={{ ...agent, scope: "builtin" }}
        canCreateReplacement={false}
        onCreateReplacement={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByTestId("builtin-project-access").textContent).toContain("every project");
    expect(screen.queryByTestId("assigned-agent-writer")).toBeNull();
    expect(screen.getByTestId("default-agent-writer").hasAttribute("disabled")).toBe(false);
  });

  it("does not display effective output metadata on a builtin", () => {
    useAppStore.setState({ projects: [], currentProjectId: null });
    render(
      <AgentDetail
        agent={{ ...agent, scope: "builtin" }}
        canCreateReplacement={true}
        onCreateReplacement={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.queryByTestId("agent-output")).toBeNull();
  });

  it.each([
    ["absent", undefined],
    ["explicit false", false],
  ] as const)("displays No when boolean metadata is %s", (_label, value) => {
    useAppStore.setState({ projects: [], currentProjectId: null });
    render(
      <AgentDetail
        agent={{ ...agent, defaultProgress: value, interactive: value }}
        canCreateReplacement={false}
        onCreateReplacement={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    const progress = screen.getByTestId("agent-default-progress");
    expect(progress.textContent).toContain("Default Progress");
    expect(progress.textContent).toContain("No");
    const interactive = screen.getByTestId("agent-interactive");
    expect(interactive.textContent).toContain("Interactive");
    expect(interactive.textContent).toContain("No");
  });
});
