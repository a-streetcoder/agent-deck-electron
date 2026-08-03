// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { IssuesScreen } from "./IssuesScreen.tsx";

const project = {
  id: "issues-project",
  name: "Issues project",
  path: "/tmp/issues-project",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function issue(number: number) {
  return {
    number,
    title: `Issue ${number}`,
    state: "OPEN",
    url: `https://example.test/issues/${number}`,
    labels: [],
    assignees: [],
    author: null,
    updatedAt: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  useAppStore.setState({ currentProjectId: project.id, projects: [project], error: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("issues incomplete-results notice", () => {
  it("shows an accessible notice only for an incomplete successful result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          issues: Array.from({ length: 50 }, (_, index) => issue(index + 1)),
          incompleteResults: true,
        }),
      ),
    );

    render(<IssuesScreen />);

    const notice = await screen.findByTestId("issues-incomplete-results");
    expect(notice.getAttribute("role")).toBe("status");
    expect(notice.getAttribute("aria-live")).toBe("polite");
    expect(notice.textContent).toContain("first 50 issues returned by GitHub");
    expect(notice.textContent).toContain(
      "Search and label, assignee, and author filters apply only to these results",
    );
    expect(screen.getAllByTestId(/^issue-\d+$/)).toHaveLength(50);
  });

  it.each([
    ["exactly 50", Array.from({ length: 50 }, (_, index) => issue(index + 1))],
    ["empty", []],
  ])("does not show the notice for a complete %s result", async (_name, issues) => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ issues, incompleteResults: false })),
    );

    render(<IssuesScreen />);
    if (issues.length) await screen.findByTestId("issue-1");
    else await screen.findByTestId("issues-empty");
    expect(screen.queryByTestId("issues-incomplete-results")).toBeNull();
  });

  it("clears the old notice immediately during refresh and keeps it clear on failure", async () => {
    let rejectRefresh!: (reason: Error) => void;
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ issues: [issue(1)], incompleteResults: true }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectRefresh = reject;
          }),
      );
    vi.stubGlobal("fetch", fetchMock);

    render(<IssuesScreen />);
    await screen.findByTestId("issues-incomplete-results");
    fireEvent.click(screen.getByTestId("issues-refresh"));

    expect(screen.queryByTestId("issues-incomplete-results")).toBeNull();
    expect(screen.getByTestId("issues-refresh").hasAttribute("disabled")).toBe(true);
    rejectRefresh(new Error("offline"));
    await screen.findByTestId("issues-error");
    expect(screen.queryByTestId("issues-incomplete-results")).toBeNull();
  });

  it("ignores a stale incomplete response after a newer state result", async () => {
    let resolveClosed!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("state=open")) {
        return Promise.resolve(jsonResponse({ issues: [issue(1)], incompleteResults: true }));
      }
      if (url.endsWith("state=closed")) {
        return new Promise<Response>((resolve) => {
          resolveClosed = resolve;
        });
      }
      if (url.endsWith("state=all")) {
        return Promise.resolve(jsonResponse({ issues: [], incompleteResults: false }));
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<IssuesScreen />);
    await screen.findByTestId("issues-incomplete-results");
    fireEvent.click(screen.getByTestId("issues-state-closed"));
    expect(screen.queryByTestId("issues-incomplete-results")).toBeNull();
    fireEvent.click(screen.getByTestId("issues-state-all"));
    await screen.findByTestId("issues-empty");

    resolveClosed(jsonResponse({ issues: [issue(2)], incompleteResults: true }));
    await waitFor(() => expect(screen.queryByTestId("issue-2")).toBeNull());
    expect(screen.queryByTestId("issues-incomplete-results")).toBeNull();
  });

  it("rejects an old incomplete response resolved during a state-change commit", async () => {
    let resolveOpen!: (response: Response) => void;
    let resolveClosed!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("state=open")) {
        return new Promise<Response>((resolve) => {
          resolveOpen = resolve;
        });
      }
      if (url.endsWith("state=closed")) {
        return new Promise<Response>((resolve) => {
          resolveClosed = resolve;
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<IssuesScreen />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      screen
        .getByTestId("issues-state-closed")
        .dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(fetchMock).toHaveBeenCalledTimes(1); // the closed-state effect has not started
      resolveOpen(jsonResponse({ issues: [issue(1)], incompleteResults: true }));
      await Promise.resolve();
    });

    expect(screen.queryByTestId("issue-1")).toBeNull();
    expect(screen.queryByTestId("issues-incomplete-results")).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveClosed(jsonResponse({ issues: [], incompleteResults: false }));
    await screen.findByTestId("issues-empty");
  });

  it("rejects an old incomplete response resolved during a project switch", async () => {
    const nextProject = { ...project, id: "next-project", name: "Next project" };
    useAppStore.setState({ projects: [project, nextProject] });
    let resolveOld!: (response: Response) => void;
    let resolveNext!: (response: Response) => void;
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`/projects/${project.id}/`)) {
        return new Promise<Response>((resolve) => {
          resolveOld = resolve;
        });
      }
      if (url.includes(`/projects/${nextProject.id}/`)) {
        return new Promise<Response>((resolve) => {
          resolveNext = resolve;
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<IssuesScreen />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      useAppStore.getState().setCurrentProject(nextProject.id);
      expect(fetchMock).toHaveBeenCalledTimes(1); // the next-project effect has not started
      resolveOld(jsonResponse({ issues: [issue(1)], incompleteResults: true }));
      await Promise.resolve();
    });

    expect(screen.queryByTestId("issue-1")).toBeNull();
    expect(screen.queryByTestId("issues-incomplete-results")).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveNext(jsonResponse({ issues: [], incompleteResults: false }));
    await screen.findByTestId("issues-empty");
  });

  it("keeps search keyboard input usable while the notice is visible", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse({ issues: [issue(1)], incompleteResults: true })),
    );

    render(<IssuesScreen />);
    await screen.findByTestId("issues-incomplete-results");
    const search = screen.getByTestId("issues-search") as HTMLInputElement;
    search.focus();
    fireEvent.change(search, { target: { value: "no match" } });
    expect(search.value).toBe("no match");
    expect(document.activeElement).toBe(search);
    expect(screen.getByTestId("issues-incomplete-results")).toBeTruthy();
    expect(screen.getByTestId("issues-empty").textContent).toContain("No issues match");
  });
});
