// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { parseEventLine, splitJsonl } from "@agent-deck/domain";
import { useAppStore } from "../state/store.ts";
import { LoopsScreen } from "./LoopsScreen.tsx";
// The A1b recorded log of one makerChecker loop run, completed in iteration 1.
import loopLog from "../../../../packages/domain/test/fixtures/events/loop-makerChecker.jsonl?raw";

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

it("reads the active run's status and iteration from the event-log tree when it is newer", async () => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  const events = splitJsonl(loopLog).lines.map((line) => parseEventLine(line)!);
  const finished = events.at(-1)!.payload as { run: { id: string; loopName: string } };
  // The last poll is older than the log: it still says running in iteration 0.
  const stored = {
    ...finished.run,
    status: "running",
    currentIteration: 0,
    updatedAt: "2025-01-01T00:00:00.000Z",
    iterations: [],
  };
  useAppStore.setState({
    currentProjectId: null,
    session: null,
    sessions: [],
    loopCommandRequest: null,
    projects: [],
    projectLog: { projectId: null, logId: "log", lastSeq: 50, events },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/resources/agents")) return Response.json({ agents: [] });
      if (url === "/loops") return Response.json({ loops: [] });
      if (url === "/loops/runs") return Response.json({ runs: [stored] });
      if (url.startsWith("/loops/runs/")) return Response.json({ run: stored });
      return Response.json({});
    }),
  );
  render(<LoopsScreen />);
  const status = await screen.findByTestId("loop-run-status");
  expect(status.getAttribute("data-status")).toBe("completed");
  expect(screen.getByTestId("loop-run-live-status").textContent).toMatch(
    /^Completed · Iteration 1/,
  );
  // Without log events for the run the store view stays.
  act(() => useAppStore.setState({ projectLog: null }));
  expect(screen.getByTestId("loop-run-status").getAttribute("data-status")).toBe("running");
});
