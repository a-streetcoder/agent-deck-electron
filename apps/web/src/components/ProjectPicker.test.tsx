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
  for (const [label, bridge] of [
    ["the desktop shell attached to a remote server", { isElectron: true, remote: true }],
    ["a plain browser (no Electron bridge)", undefined],
  ] as const) {
    it(`offers Add project and browses the SERVER root in ${label}`, async () => {
      vi.stubGlobal("window", Object.assign(window, { agentDeck: bridge }));
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
  }

  it("never opens the local native picker when attached remotely", async () => {
    const chooseDirectory = vi.fn(async () => ["C:\\Users\\pc\\wrong-machine"]);
    vi.stubGlobal(
      "window",
      Object.assign(window, { agentDeck: { isElectron: true, remote: true, chooseDirectory } }),
    );
    stubServerFolders();
    useAppStore.setState({ projects: [], currentProjectId: null });
    render(<ProjectPicker />);
    fireEvent.click(screen.getByTestId("project-picker"));
    fireEvent.click(screen.getByTestId("add-project"));
    await screen.findByTestId("server-folder-browser");
    expect(chooseDirectory).not.toHaveBeenCalled();
    expect(vi.mocked(addProject)).not.toHaveBeenCalled();
  });
});
