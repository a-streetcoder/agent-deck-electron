// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { AgentInfo } from "@agent-deck/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { AgentDetail, AgentsScreen } from "./AgentsScreen.tsx";
import { updateProject } from "../state/wsBridge.ts";

const catalogMock = vi.hoisted(() => ({
  agents: [] as AgentInfo[],
  loaded: true,
  projectId: null as string | null,
}));

vi.mock("../state/useAgents.ts", () => ({
  useAgentsCatalog: () => catalogMock,
}));

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
  vi.unstubAllGlobals();
});

describe("AgentsScreen catalog navigation", () => {
  it("opens a full-width detail and restores the filtered catalog selection", async () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    catalogMock.agents = [
      agent,
      {
        ...agent,
        name: "reviewer",
        description: "Reviews changes",
        filePath: "/tmp/reviewer.md",
      },
    ];
    useAppStore.setState({
      projects: [],
      currentProjectId: null,
      selectedAgentFilePath: null,
    });

    render(<AgentsScreen />);
    fireEvent.change(screen.getByTestId("agent-search"), { target: { value: "review" } });
    const row = screen.getByTestId("agent-row");
    fireEvent.click(row);

    expect(screen.getByTestId("agents-catalog").className).toContain("hidden");
    expect(screen.getByTestId("agent-detail").textContent).toContain("reviewer");
    fireEvent.change(screen.getByTestId("agent-search"), { target: { value: "writer" } });
    expect(screen.getByTestId("agent-detail").textContent).toContain("reviewer");
    fireEvent.change(screen.getByTestId("agent-search"), { target: { value: "review" } });
    fireEvent.click(screen.getByTestId("agent-detail-back"));

    const restoredRow = screen.getByTestId("agent-row");
    await vi.waitFor(() => expect(document.activeElement).toBe(restoredRow));
    expect((screen.getByTestId("agent-search") as HTMLInputElement).value).toBe("review");
    expect(restoredRow.getAttribute("aria-selected")).toBe("true");
    expect(useAppStore.getState().selectedAgentFilePath).toBe("/tmp/reviewer.md");
  });

  it("keeps the single-choice filter accessible and fails safely if an open agent disappears", () => {
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
    catalogMock.agents = [agent];
    useAppStore.setState({ projects: [], currentProjectId: null, selectedAgentFilePath: null });
    const { rerender } = render(<AgentsScreen />);

    const filter = screen.getByTestId("agent-filter-control") as HTMLSelectElement;
    expect(filter.options).toHaveLength(9);
    fireEvent.change(filter, { target: { value: "global" } });
    expect(filter.value).toBe("global");
    fireEvent.click(screen.getByTestId("agent-row"));

    catalogMock.agents = [];
    rerender(<AgentsScreen />);
    expect(screen.getByText("This agent is no longer available.")).toBeTruthy();
    expect(screen.getByTestId("agent-detail-back")).toBeTruthy();
  });
});

describe("AgentDetail delegation metadata", () => {
  it("presents current-project warnings in a labelled accessible panel", () => {
    useAppStore.setState({
      projects: [
        {
          id: "project",
          path: "/tmp/project",
          name: "Current Project",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      ],
      currentProjectId: "project",
    });
    render(
      <AgentDetail
        agent={{
          ...agent,
          warnings: [
            {
              id: "skill-missing",
              category: "skill",
              message:
                "References missing skill “private-review”. Add it or remove the assignment.",
            },
          ],
        }}
        canCreateReplacement={false}
        onCreateReplacement={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    const panel = screen.getByTestId("agent-warning-panel");
    expect(panel.getAttribute("aria-labelledby")).toBe("agent-warning-heading");
    expect(panel.textContent).toContain("Current Project");
    expect(panel.textContent).toContain("private-review");
  });
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
    expect(screen.getByTestId("agent-extensions").textContent).toContain("Default catalog policy");
  });

  it.each([
    [[], "None (explicit)"],
    [["/one.ts", "/two.ts"], "2 selected"],
  ] as const)("labels explicit extension policy %# accurately", (extensions, label) => {
    useAppStore.setState({ projects: [], currentProjectId: null });
    render(
      <AgentDetail
        agent={{ ...agent, extensions: [...extensions] }}
        canCreateReplacement={false}
        onCreateReplacement={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByTestId("agent-extensions").textContent).toContain(label);
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

  it("offers accessible replace and remove actions for a managed avatar", async () => {
    useAppStore.setState({ projects: [], currentProjectId: null });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AgentDetail
        agent={{ ...agent, avatarUrl: "/agent-avatars/id?v=hash" }}
        canCreateReplacement={false}
        onCreateReplacement={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("Replace avatar for writer")).not.toBeNull();
    const remove = screen.getByRole("button", { name: "Remove avatar for writer" });
    fireEvent.click(remove);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith(
      "/resources/agents/avatar",
      expect.objectContaining({ method: "DELETE" }),
    );
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
