// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addProject } from "../state/wsBridge.ts";
import { useAppStore } from "../state/store.ts";
import { ProjectsScreen } from "./ProjectsScreen.tsx";

vi.mock("../state/wsBridge.ts", () => ({
  addProject: vi.fn(async () => undefined),
  refreshProjects: vi.fn(async () => undefined),
  updateProject: vi.fn(async () => undefined),
}));
vi.mock("../components/ProjectImage.tsx", () => ({ ProjectImage: () => null }));

const root = "/srv/streetcoding";
function stubServer(): void {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input, "http://deck.test");
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.pathname === "/projects/discovery") return json({ roots: [], discovered: [] });
      if (url.pathname === "/fs/dirs") {
        const path = url.searchParams.get("path") ?? root;
        if (path !== root) return json({ error: "nope" }, 404);
        return json({
          root,
          path: root,
          parent: null,
          dirs: ["agent-deck", "syncr"].map((name) => ({ name, path: `${root}/${name}` })),
        });
      }
      return json({ error: "unexpected" }, 404);
    }),
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("ProjectsScreen with no projects", () => {
  for (const [label, bridge] of [
    ["the desktop shell attached to a remote server", { isElectron: true, remote: true }],
    ["a plain browser (no Electron bridge)", undefined],
  ] as const) {
    it(`reaches the server folder browser from Add Projects in ${label}`, async () => {
      vi.stubGlobal("window", Object.assign(window, { agentDeck: bridge }));
      stubServer();
      useAppStore.setState({ projects: [], currentProjectId: null });
      render(<ProjectsScreen />);

      expect(screen.getByText("No projects yet")).toBeTruthy();
      fireEvent.click(screen.getByTestId("projects-add"));
      await screen.findByTestId("add-projects-dialog");

      // Immediate children of AGENT_DECK_PROJECT_ROOT are listed; picking one fills the path.
      fireEvent.click(await screen.findByTestId("server-folder-syncr"));
      await waitFor(() =>
        expect((screen.getByTestId("projects-add-path") as HTMLInputElement).value).toBe(
          `${root}/syncr`,
        ),
      );
      fireEvent.click(screen.getByTestId("projects-add-confirm"));
      await waitFor(() => expect(vi.mocked(addProject)).toHaveBeenCalledWith(`${root}/syncr`));
      expect(screen.queryByTestId("choose-project-folder")).toBeNull();
    });
  }
});
