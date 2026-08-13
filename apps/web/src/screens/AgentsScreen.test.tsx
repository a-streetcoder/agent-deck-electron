// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import type { AgentInfo } from "@agent-deck/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { AgentDetail } from "./AgentsScreen.tsx";

vi.mock("../state/wsBridge.ts", () => ({
  deleteAgent: vi.fn(),
  renameAgent: vi.fn(),
  setAgentDisabled: vi.fn(),
  updateProject: vi.fn(),
}));

const agent: AgentInfo = {
  name: "writer",
  description: "Writes when separately approved",
  systemPromptMode: "replace",
  defaultExpectedOutcome: "writeProjectFile",
  defaultProgress: true,
  interactive: true,
  output: "Concise review summary",
  scope: "global",
  filePath: "/tmp/writer.md",
  body: "Write carefully.",
  shadowed: false,
  replacesBuiltin: false,
};

afterEach(cleanup);

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
    const card = screen.getByTestId("agent-default-outcome");
    expect(card.textContent).toContain("Default Outcome");
    expect(card.textContent).toContain("Write/update project file");
    const progress = screen.getByTestId("agent-default-progress");
    expect(progress.textContent).toContain("Default Progress");
    expect(progress.textContent).toContain("Yes");
    const interactive = screen.getByTestId("agent-interactive");
    expect(interactive.textContent).toContain("Interactive");
    expect(interactive.textContent).toContain("Yes");
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
