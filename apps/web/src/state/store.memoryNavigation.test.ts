// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "./store.ts";

beforeEach(() => {
  useAppStore.setState({
    view: "chat",
    panelExpanded: true,
    currentProjectId: null,
    selectedAgentFilePath: "agent.md",
    selectedPromptFilePath: "prompt.md",
    memoryNavigationRequest: null,
  });
});

describe("memory transcript navigation request", () => {
  it("atomically switches project and view and keeps only the latest exact request", () => {
    const store = useAppStore.getState();
    store.requestMemoryNavigation({
      projectId: "project-a",
      memoryId: "memory-a",
      titleSnapshot: "Old title",
    });
    const first = useAppStore.getState().memoryNavigationRequest!;

    useAppStore.getState().requestMemoryNavigation({
      projectId: "project-b",
      memoryId: "memory-b",
      titleSnapshot: "Snapshot title",
    });
    const state = useAppStore.getState();
    expect(state).toMatchObject({
      view: "memory",
      panelExpanded: false,
      currentProjectId: "project-b",
      selectedAgentFilePath: null,
      selectedPromptFilePath: null,
      memoryNavigationRequest: {
        projectId: "project-b",
        memoryId: "memory-b",
        titleSnapshot: "Snapshot title",
      },
    });
    expect(state.memoryNavigationRequest!.requestId).toBeGreaterThan(first.requestId);

    useAppStore.getState().clearMemoryNavigationRequest(first.requestId);
    expect(useAppStore.getState().memoryNavigationRequest).toEqual(state.memoryNavigationRequest);
    useAppStore.getState().clearMemoryNavigationRequest(state.memoryNavigationRequest!.requestId);
    expect(useAppStore.getState().memoryNavigationRequest).toBeNull();
  });
});
