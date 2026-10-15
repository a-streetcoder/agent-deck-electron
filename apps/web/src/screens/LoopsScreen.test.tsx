// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { LoopsScreen } from "./LoopsScreen.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("selects a Loop target locally, reloads its agents, and rejects a removed target", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  useAppStore.setState({
    currentProjectId: null,
    session: null,
    sessions: [],
    loopCommandRequest: null,
    projects: [
      { id: "one", name: "One", path: "/one", createdAt: "2026-01-01T00:00:00Z" },
      { id: "two", name: "Two", path: "/two", createdAt: "2026-01-01T00:00:00Z" },
    ],
  });
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/resources/agents")) return Response.json({ agents: [] });
    if (url === "/loops") return Response.json({ loops: [] });
    if (url === "/loops/runs") return Response.json({ runs: [] });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<LoopsScreen />);
  const picker = screen.getByRole("combobox", { name: "Run in project" }) as HTMLSelectElement;
  expect(picker.value).toBe("");
  fireEvent.change(picker, { target: { value: "one" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/resources/agents?projectId=one"));
  expect(useAppStore.getState().currentProjectId).toBeNull();
  expect(useAppStore.getState().session).toBeNull();
  fireEvent.change(picker, { target: { value: "two" } });
  await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/resources/agents?projectId=two"));
  act(() => useAppStore.setState({ projects: [] }));
  expect(picker.value).toBe("");
  await waitFor(() => expect(fetchMock).toHaveBeenLastCalledWith("/resources/agents"));
});

it("edits a graph-only loop's description without touching its graph (A9)", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  useAppStore.setState({
    currentProjectId: null,
    session: null,
    sessions: [],
    loopCommandRequest: null,
    projects: [],
  });
  const graph = {
    nodes: [
      { id: "plan", kind: "stage", agentName: "Planner" },
      { id: "build", kind: "stage", agentName: "Builder" },
      { id: "review", kind: "checker", agentName: "Reviewer" },
      { id: "judge", kind: "evaluator" },
    ],
    edges: [
      { from: "plan", to: "build" },
      { from: "build", to: "review" },
      { from: "review", to: "judge" },
      { from: "judge", to: "plan", when: "CONTINUE", budgeted: true },
    ],
  };
  const loop = {
    id: "graph-id",
    name: "graph-loop",
    description: "",
    goal: "Ship it.",
    structure: "agentPipeline",
    checkerRubric: "Evidence.",
    graph,
    launchContextScope: "firstIterationOnly",
    maxIterations: 2,
    validationCommand: "",
    successCondition: "Ship it.",
    successConditionSource: "goal",
    writeTarget: "artifactMarkdown",
    source: "user",
    availability: "allProjects",
    projectPaths: [],
    filePath: "graph-loop.loop.md",
  };
  const puts: Record<string, unknown>[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/resources/agents"))
      return Response.json({
        agents: ["Planner", "Builder", "Reviewer"].map((name) => ({ name, source: "user" })),
      });
    if (url === "/loops" && init?.method === "PUT") {
      puts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return Response.json({ ok: true });
    }
    if (url === "/loops") return Response.json({ loops: [loop] });
    if (url === "/loops/runs") return Response.json({ runs: [] });
    return Response.json({});
  });
  vi.stubGlobal("fetch", fetchMock);
  render(<LoopsScreen />);
  fireEvent.click(await screen.findByTestId("loop-open-graph-loop"));
  expect(screen.getByTestId("loop-custom-graph").textContent).toBe(
    "Custom graph: edit nodes/edges in the file.",
  );
  expect(screen.queryByTestId("loop-structure")).toBeNull();
  expect(within(screen.getByTestId("loop-editor")).getByTestId("loop-graph")).toBeTruthy();
  fireEvent.change(screen.getByLabelText("Description"), { target: { value: "edited" } });
  const save = screen.getByTestId("loop-save") as HTMLButtonElement;
  await waitFor(() => expect(save.disabled).toBe(false));
  fireEvent.click(save);
  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toMatchObject({
    id: "graph-id",
    description: "edited",
    structure: "agentPipeline",
  });
  // The graph supersedes the flat fields: none is sent, so the file keeps them and its nodes/edges.
  for (const key of ["pipelineStages", "checkerRubric", "agentName", "makerName", "checkerName"]) {
    expect(puts[0]).not.toHaveProperty(key);
  }
  await waitFor(() => expect(screen.queryByTestId("loop-editor")).toBeNull());
});
