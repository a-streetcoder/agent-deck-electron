// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
