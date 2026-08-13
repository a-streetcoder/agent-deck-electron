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
  scope: "global",
  filePath: "/tmp/writer.md",
  body: "Write carefully.",
  shadowed: false,
  replacesBuiltin: false,
};

afterEach(cleanup);

describe("AgentDetail default outcome", () => {
  it("displays the native typed label", () => {
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
  });
});
