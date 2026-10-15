// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { addProject, updateSessionDraft } from "../state/wsBridge.ts";
import { useAppStore } from "../state/store.ts";
import { SessionStartupCard } from "./SessionStartupCard.tsx";

vi.mock("../state/wsBridge.ts", () => ({
  addProject: vi.fn(async () => ({
    id: "p-syncr",
    name: "syncr",
    path: "/srv/streetcoding/syncr",
    createdAt: "now",
  })),
  updateSessionDraft: vi.fn(async () => true),
}));

const root = "/srv/streetcoding";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("SessionStartupCard draft with no projects (remote server)", () => {
  it("adds a project through the server folder browser and selects it", async () => {
    vi.stubGlobal(
      "window",
      Object.assign(window, { agentDeck: { isElectron: true, remote: true } }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string) => {
        const url = new URL(input, "http://deck.test");
        const path = url.searchParams.get("path") ?? root;
        return new Response(
          JSON.stringify({
            root,
            path,
            parent: path === root ? null : root,
            dirs:
              path === root
                ? ["agent-deck", "syncr"].map((name) => ({ name, path: `${root}/${name}` }))
                : [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }),
    );
    useAppStore.setState({
      currentProjectId: null,
      currentAgentName: null,
      projects: [],
      session: { id: "draft", cwd: "/tmp", createdAt: "now", lifecycle: "draft" },
    });
    render(<SessionStartupCard />);

    // The select has only "No project"; the add entry sits right next to it.
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByTestId("startup-add-project"));
    fireEvent.click(await screen.findByTestId("server-folder-syncr"));
    await waitFor(() =>
      expect((screen.getByTestId("startup-add-project-path") as HTMLInputElement).value).toBe(
        `${root}/syncr`,
      ),
    );
    fireEvent.click(screen.getByTestId("startup-add-project-confirm"));
    await waitFor(() => expect(vi.mocked(addProject)).toHaveBeenCalledWith(`${root}/syncr`));
    await waitFor(() =>
      expect(vi.mocked(updateSessionDraft)).toHaveBeenCalledWith({
        projectId: "p-syncr",
        agentName: null,
      }),
    );
  });
});

describe("SessionStartupCard on the shared server (SRV-12a)", () => {
  afterEach(() => useAppStore.setState({ me: null }));

  it("does not move another draft to the project when the clone finishes after a switch", async () => {
    vi.stubGlobal("window", Object.assign(window, { agentDeck: undefined }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("not found", { status: 404 })),
    );
    let finish!: (project: { id: string; name: string; path: string; createdAt: string }) => void;
    vi.mocked(addProject).mockImplementationOnce(
      () => new Promise((resolve) => (finish = resolve)),
    );
    useAppStore.setState({
      me: { id: "ale@example.test", email: "ale@example.test" },
      projects: [],
      session: { id: "draft-a", cwd: "/tmp", createdAt: "now", lifecycle: "draft" },
    });
    render(<SessionStartupCard />);
    fireEvent.click(screen.getByTestId("startup-add-project"));
    fireEvent.change(await screen.findByTestId("startup-add-project-repo"), {
      target: { value: "acme/app" },
    });
    fireEvent.click(screen.getByTestId("startup-add-project-repo-confirm"));
    await waitFor(() => expect(vi.mocked(addProject)).toHaveBeenCalled());

    // The user opens another draft while the clone runs.
    useAppStore.setState({
      session: { id: "draft-b", cwd: "/tmp", createdAt: "now", lifecycle: "draft" },
    });
    finish({ id: "p-app", name: "app", path: "/srv/streetcoding/app", createdAt: "now" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vi.mocked(updateSessionDraft)).not.toHaveBeenCalled();
  });
});
