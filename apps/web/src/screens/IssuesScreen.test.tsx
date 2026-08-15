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

describe("issue type facet (ISS-08)", () => {
  it("filters the loaded board by issue type", async () => {
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/issues")) {
        return Promise.resolve(
          jsonResponse({
            issues: [
              { ...issue(1), title: "A bug", type: "Bug" },
              { ...issue(2), title: "A task", type: "Task" },
            ],
            incompleteResults: false,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<IssuesScreen />);

    await screen.findByText("A bug");
    fireEvent.click(screen.getByTestId("issues-type-Bug"));
    await waitFor(() => {
      expect(screen.queryByText("A task")).toBeNull();
      expect(screen.getByText("A bug")).toBeTruthy();
    });
    // toggling off restores the board
    fireEvent.click(screen.getByTestId("issues-type-Bug"));
    await screen.findByText("A task");
  });
});

describe("aggregate all-projects search (ISS-10)", () => {
  it("toggles to the aggregate board, prefixes repos, and opens cross-project details", async () => {
    const projectB = {
      id: "project-b",
      name: "B",
      path: "/tmp/b",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    useAppStore.setState({
      currentProjectId: project.id,
      projects: [project, projectB],
      error: null,
    });
    const fetchMock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.startsWith("/issues/search")) {
        return Promise.resolve(
          jsonResponse({
            issues: [
              { ...issue(5), repository: "acme/one", projectId: project.id },
              { ...issue(9), repository: "acme/two", projectId: "project-b" },
            ],
            incompleteResults: false,
          }),
        );
      }
      if (url.includes("/projects/project-b/issues/9")) {
        return Promise.resolve(
          jsonResponse({
            issue: {
              number: 9,
              title: "Issue 9",
              body: "Cross-project body",
              state: "OPEN",
              url: "https://example.test/issues/9",
              labels: [],
              assignees: [],
              author: null,
              comments: [],
            },
          }),
        );
      }
      if (url.includes("/issues")) {
        return Promise.resolve(jsonResponse({ issues: [issue(5)], incompleteResults: false }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<IssuesScreen />);

    fireEvent.click(await screen.findByTestId("issues-scope-all"));
    // the aggregate route serves the board, rows carry their repo prefix
    await screen.findByText("acme/two#9");
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).startsWith("/issues/search?state=open")),
    ).toBe(true);

    // opening a row from ANOTHER project fetches THAT project's detail
    fireEvent.click(screen.getByText("Issue 9"));
    await screen.findByText("Cross-project body");
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes("/projects/project-b/issues/9")),
    ).toBe(true);
  });
});

describe("issue reply (ISS-01)", () => {
  it("posts the drafted comment and re-fetches the detail", async () => {
    let detailComments: Array<{ author: string | null; body: string; createdAt: string | null }> =
      [];
    let postedBody: unknown = null;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/issues/7/comment") && init?.method === "POST") {
        postedBody = JSON.parse(String(init.body));
        detailComments = [{ author: "ale", body: "Looks good.", createdAt: null }];
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url.includes("/issues/7")) {
        return Promise.resolve(
          jsonResponse({
            issue: {
              number: 7,
              title: "Issue 7",
              body: "The body",
              state: "OPEN",
              url: "https://example.test/issues/7",
              labels: [],
              assignees: [],
              author: null,
              comments: detailComments,
            },
          }),
        );
      }
      if (url.includes("/issues")) {
        return Promise.resolve(jsonResponse({ issues: [issue(7)], incompleteResults: false }));
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<IssuesScreen />);

    fireEvent.click(await screen.findByText("Issue 7"));
    const box = await screen.findByTestId("issue-reply-body");
    // the button is disabled until a non-empty draft exists
    expect((screen.getByTestId("issue-reply-post") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: "Looks good." } });
    fireEvent.click(screen.getByTestId("issue-reply-post"));

    // the route received the trimmed draft, and the re-fetched detail shows it
    await screen.findByText("Looks good.", { selector: "p" });
    expect(postedBody).toEqual({ body: "Looks good." });
    // the draft box cleared after a successful post AND the controls re-enabled
    // (the success path bumps the selection token — busy must still clear)
    expect((screen.getByTestId("issue-reply-body") as HTMLTextAreaElement).value).toBe("");
    expect((screen.getByTestId("issue-reply-body") as HTMLTextAreaElement).disabled).toBe(false);
  });
});

describe("issue reopen (ISS-02)", () => {
  it("shows Reopen only for a closed issue and flips local state on success", async () => {
    let reopened = false;
    const fetchMock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/issues/9/reopen") && init?.method === "POST") {
        reopened = true;
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url.includes("/issues/9")) {
        return Promise.resolve(
          jsonResponse({
            issue: {
              number: 9,
              title: "Issue 9",
              body: "Closed body",
              state: "CLOSED",
              stateReason: "NOT_PLANNED",
              type: "Bug",
              url: "https://example.test/issues/9",
              createdAt: "2026-01-01T00:00:00Z",
              updatedAt: "2026-02-01T00:00:00Z",
              closedAt: "2026-03-01T00:00:00Z",
              labels: [],
              assignees: [],
              author: null,
              comments: [
                {
                  id: "IC_9",
                  url: "https://example.test/issues/9#issuecomment-1",
                  author: "marty",
                  body: "Old note.",
                  createdAt: "2026-01-10T00:00:00Z",
                  updatedAt: "2026-01-12T00:00:00Z",
                },
              ],
            },
          }),
        );
      }
      if (url.includes("/issues")) {
        return Promise.resolve(
          jsonResponse({
            issues: [{ ...issue(9), state: "CLOSED" }],
            incompleteResults: false,
          }),
        );
      }
      return Promise.resolve(jsonResponse({}, 404));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<IssuesScreen />);

    fireEvent.click(await screen.findByText("Issue 9"));
    // a closed issue offers Reopen, not the close split-buttons
    const reopen = await screen.findByTestId("issue-reopen");
    expect(screen.queryByTestId("issue-close-completed")).toBeNull();
    // ISS-05: native-equivalent triage metadata is visible
    expect(screen.getByTestId("issue-detail-state-reason").textContent).toBe("not planned");
    expect(screen.getByTestId("issue-detail-type").textContent).toBe("Bug");
    // ISS-06: native's Created/Updated/Closed rows + comment permalink & edited stamp
    const stamps = screen.getByTestId("issue-detail-timestamps");
    expect(stamps.textContent).toContain("Created");
    expect(stamps.textContent).toContain("Updated");
    expect(stamps.textContent).toContain("Closed");
    const link = screen.getByTestId("issue-comment-link") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("https://example.test/issues/9#issuecomment-1");
    expect(screen.getByTestId("issue-comment-edited").textContent).toContain("edited");
    fireEvent.click(reopen);
    await waitFor(() => {
      expect(reopened).toBe(true);
      // local state flips to OPEN: the close buttons return, Reopen goes
      expect(screen.queryByTestId("issue-reopen")).toBeNull();
      expect(screen.getByTestId("issue-close-completed")).toBeTruthy();
    });
  });
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
