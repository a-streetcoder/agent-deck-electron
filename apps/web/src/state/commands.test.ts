import { DEFAULT_KEYBINDINGS } from "@agent-deck/contracts";
import { beforeEach, describe, expect, it } from "vitest";
import { COMMAND_DEFINITIONS, runCommand } from "./commands.ts";
import { useAppStore } from "./store.ts";

const RESOURCE_COMMANDS = [
  "agent.new",
  "agent.openFile",
  "agent.reveal",
  "agent.toggleDisabled",
  "skills.import",
  "prompt.new",
  "prompt.copyInvocation",
  "prompt.openFile",
  "prompt.reveal",
] as const;

describe("resource command catalog", () => {
  beforeEach(() => {
    useAppStore.setState({
      view: "chat",
      currentProjectId: null,
      selectedAgentFilePath: null,
      selectedPromptFilePath: null,
      resourceCommandRequest: null,
    });
  });

  it("contains all nine rebindable workflows exactly once and ships no defaults", () => {
    for (const command of RESOURCE_COMMANDS) {
      expect(
        COMMAND_DEFINITIONS.filter((definition) => definition.command === command),
      ).toHaveLength(1);
      expect(DEFAULT_KEYBINDINGS.some((binding) => binding.command === command)).toBe(false);
    }
  });

  it("captures the project and exact selected path before navigating", () => {
    useAppStore.setState({
      currentProjectId: "project-1",
      selectedAgentFilePath: "/exact/agent.md",
    });

    runCommand("agent.toggleDisabled");

    expect(useAppStore.getState()).toMatchObject({
      view: "agents",
      resourceCommandRequest: {
        action: "agent.toggleDisabled",
        projectId: "project-1",
        filePath: "/exact/agent.md",
      },
    });
  });

  it("enqueues null rather than inferring an unselected destructive target", () => {
    runCommand("agent.toggleDisabled");

    expect(useAppStore.getState().resourceCommandRequest).toMatchObject({
      action: "agent.toggleDisabled",
      projectId: null,
      filePath: null,
    });
  });
});
