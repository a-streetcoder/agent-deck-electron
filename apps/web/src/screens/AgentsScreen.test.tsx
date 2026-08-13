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
    const card = screen.getByTestId("agent-default-outcome");
    expect(card.textContent).toContain("Default Outcome");
    expect(card.textContent).toContain("Write/update project file");
    const progress = screen.getByTestId("agent-default-progress");
    expect(progress.textContent).toContain("Default Progress");
    expect(progress.textContent).toContain("Yes");
  });

  it.each([
    ["absent", undefined],
    ["explicit false", false],
  ] as const)("displays No when progress metadata is %s", (_label, defaultProgress) => {
    useAppStore.setState({ projects: [], currentProjectId: null });
    render(
      <AgentDetail
        agent={{ ...agent, defaultProgress }}
        canCreateReplacement={false}
        onCreateReplacement={vi.fn()}
        onEdit={vi.fn()}
      />,
    );
    const progress = screen.getByTestId("agent-default-progress");
    expect(progress.textContent).toContain("Default Progress");
    expect(progress.textContent).toContain("No");
  });
});
