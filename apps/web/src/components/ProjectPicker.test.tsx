// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addProject } from "@/state/wsBridge";
import { useAppStore } from "../state/store.ts";
import { ProjectPicker } from "./ProjectPicker.tsx";

vi.mock("@/state/wsBridge", () => ({
  addProject: vi.fn(async () => undefined),
  switchToProject: vi.fn(async () => undefined),
}));
vi.mock("./ProjectImage.tsx", () => ({ ProjectImage: () => null }));

/** A /fs/dirs server rooted at AGENT_DECK_PROJECT_ROOT=/srv/streetcoding with two clones. */
function stubServerFolders(): ReturnType<typeof vi.fn> {
  const root = "/srv/streetcoding";
  const tree: Record<string, string[]> = {
    [root]: ["agent-deck", "syncr"],
    [`${root}/agent-deck`]: ["apps", "packages"],
    [`${root}/syncr`]: [],
  };
  const fetchMock = vi.fn(async (input: string) => {
    const url = new URL(input, "http://deck.test");
    if (url.pathname !== "/fs/dirs") return new Response("not found", { status: 404 });
    const path = url.searchParams.get("path") ?? root;
    const dirs = tree[path];
    if (!dirs) return new Response(JSON.stringify({ error: "nope" }), { status: 404 });
    return new Response(
      JSON.stringify({
        root,
        path,
        parent: path === root ? null : root,
        dirs: dirs.map((name) => ({ name, path: `${path}/${name}` })),
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ProjectPicker with no projects", () => {
  it("offers Add project and browses the SERVER root in a plain browser", async () => {
    vi.stubGlobal("window", Object.assign(window, { agentDeck: undefined }));
    stubServerFolders();
    useAppStore.setState({ projects: [], currentProjectId: null });
    render(<ProjectPicker />);

    fireEvent.click(screen.getByTestId("project-picker"));
    fireEvent.click(screen.getByTestId("add-project"));

    // The browser opens at the server's root and lists its immediate children.
    await screen.findByTestId("server-folder-agent-deck");
    expect(screen.getByTestId("server-folder-syncr")).toBeTruthy();
    expect(screen.queryByTestId("server-folder-up")).toBeNull();
    expect((screen.getByTestId("add-project-path") as HTMLInputElement).value).toBe(
      "/srv/streetcoding",
    );

    // Picking a child folder selects it; confirming adds that server path.
    fireEvent.click(screen.getByTestId("server-folder-agent-deck"));
    await screen.findByTestId("server-folder-apps");
    expect(screen.getByTestId("server-folder-up")).toBeTruthy();
    expect((screen.getByTestId("add-project-path") as HTMLInputElement).value).toBe(
      "/srv/streetcoding/agent-deck",
    );
    fireEvent.click(screen.getByTestId("add-project-confirm"));
    await waitFor(() =>
      expect(vi.mocked(addProject)).toHaveBeenCalledWith("/srv/streetcoding/agent-deck"),
    );
  });
});

describe("ProjectPicker on the shared server (SRV-12a)", () => {
  afterEach(() => useAppStore.setState({ me: null }));

  const openAdd = () => {
    vi.stubGlobal("window", Object.assign(window, { agentDeck: undefined }));
    useAppStore.setState({ projects: [], currentProjectId: null });
    render(<ProjectPicker />);
    fireEvent.click(screen.getByTestId("project-picker"));
    fireEvent.click(screen.getByTestId("add-project"));
  };

  it("defaults to Repository, hints at connecting GitHub, and sends { repo, ref }", async () => {
    const fetchMock = stubServerFolders();
    fetchMock.mockImplementation(async (input: string) =>
      input === "/runtime/github"
        ? Response.json({ available: true, configured: true, connection: null })
        : new Response("not found", { status: 404 }),
    );
    useAppStore.setState({ me: { id: "ale@example.test", email: "ale@example.test" } });
    vi.mocked(addProject).mockResolvedValueOnce({
      id: "p1",
      path: "/srv/streetcoding/app",
      name: "app",
      createdAt: "2026-10-15T00:00:00Z",
    });
    openAdd();

    expect(screen.queryByTestId("server-folder-browser")).toBeNull();
    await screen.findByTestId("add-project-github-hint");
    fireEvent.change(screen.getByTestId("add-project-repo"), { target: { value: "acme/app" } });
    fireEvent.change(screen.getByTestId("add-project-repo-ref"), { target: { value: "dev" } });
    fireEvent.click(screen.getByTestId("add-project-repo-confirm"));
    await waitFor(() =>
      expect(vi.mocked(addProject)).toHaveBeenCalledWith(
        { repo: "acme/app", ref: "dev" },
        { rethrow: true },
      ),
    );
    await waitFor(() => expect(screen.queryByTestId("project-menu")).toBeNull());
  });

  it("shows the server's refusal inline and keeps the folder browser one tab away", async () => {
    stubServerFolders();
    useAppStore.setState({ me: { id: "ale@example.test", email: "ale@example.test" } });
    vi.mocked(addProject).mockRejectedValueOnce(new Error("connect GitHub first"));
    openAdd();

    fireEvent.change(screen.getByTestId("add-project-repo"), { target: { value: "acme/private" } });
    fireEvent.click(screen.getByTestId("add-project-repo-confirm"));
    expect((await screen.findByTestId("add-project-error")).textContent).toBe(
      "connect GitHub first",
    );
    fireEvent.click(screen.getByTestId("add-project-source-folder"));
    await screen.findByTestId("server-folder-agent-deck");
  });

  it("shows no Connect GitHub hint when the server has no GitHub app", async () => {
    const fetchMock = stubServerFolders();
    let asked = false;
    fetchMock.mockImplementation(async (input: string) => {
      asked = asked || input === "/runtime/github";
      return Response.json({ available: true, configured: false, connection: null });
    });
    useAppStore.setState({ me: { id: "ale@example.test", email: "ale@example.test" } });
    openAdd();
    await waitFor(() => expect(asked).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByTestId("add-project-github-hint")).toBeNull();
  });

  it("offers only the folder flow off the shared server", async () => {
    stubServerFolders();
    openAdd();
    await screen.findByTestId("server-folder-browser");
    expect(screen.queryByTestId("add-project-source-repo")).toBeNull();
    expect(screen.queryByTestId("add-project-repo")).toBeNull();
  });
});
