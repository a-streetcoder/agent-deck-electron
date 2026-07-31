// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { SkillsScreen } from "./SkillsScreen.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  useAppStore.setState({
    resourcesVersion: 0,
    error: null,
    toasts: [],
    projects: [],
    projectsLoaded: true,
    currentProjectId: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("skill repository per-file conflict review", () => {
  it("submits mixed choices and refreshes a stale review with choices reset to Keep Mine", async () => {
    const resolveBodies: unknown[] = [];
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/skills") return Promise.resolve(jsonResponse({ skills: [] }));
      if (url === "/resources/skill-recoveries") {
        return Promise.resolve(jsonResponse({ recoveries: [] }));
      }
      if (url === "/resources/skill-repos") {
        return Promise.resolve(
          jsonResponse({
            repos: [
              {
                id: "repo-1",
                remoteUrl: "file:///fixture.git",
                storageMode: "collection-v1",
                skillNames: ["mixed-choice"],
                lastSyncedCommit: "base",
                importedAt: "2026-07-28T00:00:00.000Z",
                available: true,
              },
            ],
          }),
        );
      }
      if (url === "/resources/skill-repos/repo-1/check") {
        return Promise.resolve(jsonResponse({ updateAvailable: true, deltas: [] }));
      }
      if (url === "/resources/skill-repos/repo-1/update") {
        return Promise.resolve(
          jsonResponse({
            updated: true,
            conflicts: ["mixed-choice"],
            mergeConflicts: [
              {
                name: "mixed-choice",
                mergeId: "merge-1",
                paths: [
                  { path: "keep.txt", local: "file", remote: "file" },
                  { path: "take.txt", local: "file", remote: "file" },
                ],
              },
            ],
            recoveries: [],
          }),
        );
      }
      if (url === "/resources/skill-repos/repo-1/resolve") {
        resolveBodies.push(JSON.parse(String(init?.body)));
        return Promise.resolve(
          resolveBodies.length === 1
            ? jsonResponse(
                {
                  code: "LEGACY_MERGE_STALE",
                  error: "The conflict changed since it was loaded.",
                },
                409,
              )
            : jsonResponse({ ok: true, recoveries: [] }),
        );
      }
      if (url === "/resources/skill-repos/repo-1/refresh-merge") {
        return Promise.resolve(
          jsonResponse({
            mergeConflict: {
              name: "mixed-choice",
              mergeId: "merge-2",
              paths: [
                { path: "keep.txt", local: "file", remote: "file" },
                { path: "take.txt", local: "file", remote: "file" },
              ],
            },
          }),
        );
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SkillsScreen />);
    const update = await screen.findByTestId("skill-repo-update-repo-1");
    await waitFor(() => expect(update.hasAttribute("disabled")).toBe(false));
    fireEvent.click(update);

    const takeRemote = await screen.findByLabelText("Take Remote for take.txt");
    fireEvent.click(takeRemote);
    fireEvent.click(screen.getByTestId("skill-conflict-apply-repo-1-mixed-choice"));

    await waitFor(() => expect(resolveBodies).toHaveLength(1));
    expect(resolveBodies[0]).toEqual({
      name: "mixed-choice",
      mergeId: "merge-1",
      choices: [
        { path: "keep.txt", resolution: "mine" },
        { path: "take.txt", resolution: "remote" },
      ],
    });

    fireEvent.click(await screen.findByTestId("skill-conflict-refresh-repo-1-mixed-choice"));
    await waitFor(() =>
      expect((screen.getByLabelText("Keep Mine for take.txt") as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    expect((screen.getByLabelText("Take Remote for take.txt") as HTMLInputElement).checked).toBe(
      false,
    );
    expect(
      screen.getByText("Review refreshed for mixed-choice. Choices reset to Keep Mine."),
    ).toBeTruthy();

    fireEvent.click(screen.getByTestId("skill-conflict-apply-repo-1-mixed-choice"));
    await waitFor(() => expect(resolveBodies).toHaveLength(2));
    expect(resolveBodies[1]).toEqual({
      name: "mixed-choice",
      mergeId: "merge-2",
      choices: [
        { path: "keep.txt", resolution: "mine" },
        { path: "take.txt", resolution: "mine" },
      ],
    });

    const refreshCall = fetchMock.mock.calls.find(
      ([url]) => String(url) === "/resources/skill-repos/repo-1/refresh-merge",
    );
    expect(JSON.parse(String(refreshCall?.[1]?.body))).toEqual({ name: "mixed-choice" });
  });
});
