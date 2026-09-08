// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useAppStore } from "./store.ts";
import { useAgentsCatalog } from "./useAgents.ts";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("keeps explicit local scope independent and discards late prior-project responses", async () => {
  useAppStore.setState({ currentProjectId: "global-selection", resourcesVersion: 0 });
  const pending = new Map<string, (value: Response) => void>();
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => new Promise<Response>((resolve) => pending.set(url, resolve))),
  );
  const { result, rerender, unmount } = renderHook(
    ({ projectId }: { projectId: string | null }) => useAgentsCatalog({ projectId }),
    { initialProps: { projectId: "one" as string | null } },
  );
  rerender({ projectId: "two" });
  expect(result.current).toEqual({ agents: [], loaded: false, projectId: "two" });
  await act(async () =>
    pending.get("/resources/agents?projectId=two")!(Response.json({ agents: [{ name: "Two" }] })),
  );
  await waitFor(() => expect(result.current.agents).toEqual([{ name: "Two" }]));
  await act(async () =>
    pending.get("/resources/agents?projectId=one")!(Response.json({ agents: [{ name: "One" }] })),
  );
  expect(result.current.agents).toEqual([{ name: "Two" }]);
  rerender({ projectId: null });
  expect(pending.has("/resources/agents")).toBe(true);
  expect(useAppStore.getState().currentProjectId).toBe("global-selection");
  unmount();
  await act(async () => pending.get("/resources/agents")!(Response.json({ agents: [] })));
});
