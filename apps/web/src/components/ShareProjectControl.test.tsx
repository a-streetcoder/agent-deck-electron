// @vitest-environment jsdom

import type { ProjectMeta } from "@agent-deck/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SharedServerResponse } from "@/lib/native";
import {
  beginOriginChange,
  endOriginChange,
  ORIGIN_CHANGING_ERROR,
  transferRunning,
} from "@/lib/sharedTransfers";
import { updateProject } from "../state/wsBridge.ts";
import {
  ShareProjectControl,
  useSharedServerProjects,
  type ServerProject,
} from "./ShareProjectControl.tsx";

vi.mock("../state/wsBridge.ts", () => ({ updateProject: vi.fn(async () => true) }));

const SERVER = "https://deck.example.test";
const project: ProjectMeta = { id: "p1", path: "C:\\dev\\app", name: "app", createdAt: "now" };

let originAnswer: {
  hasOrigin: boolean;
  github: { owner: string; name: string } | null;
  topLevel: boolean;
};
const request = vi.fn<(...args: unknown[]) => Promise<SharedServerResponse>>();
const signIn = vi.fn(async () => ({ ok: true }));
const cancelSignIn = vi.fn(async () => true);
/** Fixed server list; the origin lookup goes straight to the (stubbed) local route. */
const shared = (projects: ServerProject[] | null = null) => ({
  projects,
  lookupOrigin: async () => originAnswer,
});
const openExternal = vi.fn(async () => true);

beforeEach(() => {
  originAnswer = { hasOrigin: true, github: { owner: "acme", name: "app" }, topLevel: true };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) =>
      input === "/projects/p1/origin"
        ? Response.json(originAnswer)
        : Response.json({ error: "unexpected" }, { status: 404 }),
    ),
  );
  window.agentDeck = {
    isElectron: true,
    openExternal,
    sharedServer: { origin: SERVER, request, signIn, cancelSignIn },
  };
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  delete window.agentDeck;
});

const makeShared = () => fireEvent.click(screen.getByRole("button", { name: "Make shared" }));

describe("ShareProjectControl", () => {
  it("renders nothing without a configured shared server or in remote mode", () => {
    window.agentDeck = { isElectron: true };
    const { container, rerender } = render(
      <ShareProjectControl project={project} shared={shared()} />,
    );
    expect(container.innerHTML).toBe("");
    window.agentDeck = {
      isElectron: true,
      remote: true,
      sharedServer: { origin: SERVER, request, signIn, cancelSignIn },
    };
    rerender(<ShareProjectControl project={{ ...project }} shared={shared()} />);
    expect(container.innerHTML).toBe("");
  });

  it("refuses a project without an origin or with a non-GitHub origin", async () => {
    originAnswer = { hasOrigin: false, github: null, topLevel: false };
    const { unmount } = render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    expect(await screen.findByText("This project has no git remote.")).toBeTruthy();
    unmount();

    originAnswer = { hasOrigin: true, github: null, topLevel: true };
    const second = render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    expect(await screen.findByText("Only GitHub repositories can be shared.")).toBeTruthy();
    second.unmount();

    originAnswer = { hasOrigin: true, github: { owner: "acme", name: "app" }, topLevel: false };
    render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    expect(
      await screen.findByText(
        "This folder is inside a larger repository; share the repository root instead.",
      ),
    ).toBeTruthy();
    expect(request).not.toHaveBeenCalled();
  });

  it("creates the server project, stores the link, and the badge opens it on the server", async () => {
    request.mockResolvedValue({ status: 201, body: { project: { id: "srv-9", repoId: 42 } } });
    const { rerender } = render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    await waitFor(() => expect(updateProject).toHaveBeenCalled());
    expect(request).toHaveBeenCalledWith("POST", "/projects", { repo: "acme/app" });
    expect(updateProject).toHaveBeenCalledWith("p1", {
      sharedTo: { serverOrigin: SERVER, projectId: "srv-9", repoId: 42 },
    });

    rerender(
      <ShareProjectControl
        project={{
          ...project,
          sharedTo: { serverOrigin: SERVER, projectId: "srv-9", sharedAt: "now" },
        }}
        shared={shared()}
      />,
    );
    expect(screen.getByTestId("project-shared-badge").textContent).toBe(
      "shared on deck.example.test",
    );
    fireEvent.click(screen.getByRole("button", { name: "Open on server" }));
    expect(openExternal).toHaveBeenCalledWith(`${SERVER}/?project=srv-9`);
  });

  it("links an already shared repository (409 with its id and repoId)", async () => {
    request.mockResolvedValue({
      status: 409,
      body: { error: "exists", projectId: "srv-1", repoId: 42 },
    });
    render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith("p1", {
        sharedTo: { serverOrigin: SERVER, projectId: "srv-1", repoId: 42 },
      }),
    );
  });

  it("never links the project of another repository holding the folder", async () => {
    request.mockResolvedValue({
      status: 409,
      body: {
        error: "The folder app is held by another repository's project app.",
        holderProjectId: "srv-other",
      },
    });
    render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    expect(await screen.findByRole("status")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("held by another repository");
    // An old server answering projectId without repoId is not trusted either.
    request.mockResolvedValue({ status: 409, body: { error: "held", projectId: "srv-other" } });
    makeShared();
    await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Make shared" })).toBeTruthy());
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("shows the server's refusal with a hint to connect GitHub there", async () => {
    request.mockResolvedValue({ status: 409, body: { error: "connect GitHub first" } });
    const { unmount } = render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    // Already about GitHub: shown alone, no doubled hint.
    expect((await screen.findByRole("status")).textContent).toBe("connect GitHub first");
    unmount();
    request.mockResolvedValue({
      status: 409,
      body: { error: "A folder named app already exists." },
    });
    render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    expect((await screen.findByRole("status")).textContent).toBe(
      "A folder named app already exists. If the repository is private, connect GitHub in Settings on deck.example.test.",
    );
    expect(updateProject).not.toHaveBeenCalled();
  });

  it("asks to sign in on a 401 and retries once after the sign-in", async () => {
    request
      .mockResolvedValueOnce({ status: 401, signInRequired: true })
      .mockResolvedValueOnce({ status: 200, body: { project: { id: "srv-2" } } });
    render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    expect(
      await screen.findByText("Sign in to deck.example.test to share this project."),
    ).toBeTruthy();
    expect(updateProject).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Sign in to deck.example.test" }));
    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith("p1", {
        sharedTo: { serverOrigin: SERVER, projectId: "srv-2" },
      }),
    );
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("marks a local project whose repository is already a server project and offers Link", async () => {
    render(
      <ShareProjectControl
        project={project}
        shared={shared([{ id: "srv-3", repoKey: "acme/app", repoId: 7 }])}
      />,
    );
    expect((await screen.findByTestId("project-shared-badge")).textContent).toBe(
      "shared on deck.example.test",
    );
    fireEvent.click(screen.getByRole("button", { name: "Link" }));
    expect(updateProject).toHaveBeenCalledWith("p1", {
      sharedTo: { serverOrigin: SERVER, projectId: "srv-3", repoId: 7 },
    });
  });

  it("unlinks, and flags a link whose server project is gone with Make shared again", async () => {
    const linked = {
      ...project,
      sharedTo: { serverOrigin: SERVER, projectId: "srv-9", sharedAt: "now" },
    };
    const { rerender } = render(
      <ShareProjectControl project={linked} shared={shared([{ id: "srv-9", repoKey: null }])} />,
    );
    expect(screen.getByTestId("project-shared-badge")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Make shared" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(updateProject).toHaveBeenCalledWith("p1", { sharedTo: null });

    rerender(
      <ShareProjectControl project={linked} shared={shared([{ id: "other", repoKey: null }])} />,
    );
    expect(screen.getByTestId("project-shared-gone").textContent).toBe(
      "not on deck.example.test any more",
    );
    expect(screen.queryByTestId("project-shared-badge")).toBeNull();
    expect(screen.getByRole("button", { name: "Unlink" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Make shared" })).toBeTruthy();
  });

  it("offers Cancel while the browser sign-in runs", async () => {
    request.mockResolvedValue({ status: 401, signInRequired: true });
    let finish!: (value: { ok: boolean; error?: string }) => void;
    signIn.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    fireEvent.click(await screen.findByRole("button", { name: "Sign in to deck.example.test" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(cancelSignIn).toHaveBeenCalledTimes(1);
    finish({ ok: false, error: "Sign-in cancelled." });
    expect((await screen.findByRole("status")).textContent).toBe("Sign-in cancelled.");
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
  });

  it("Make shared counts as a transfer and does not start while a Save is pending", async () => {
    let answer: (value: SharedServerResponse) => void = () => {};
    request.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    const { unmount } = render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    await waitFor(() => expect(request).toHaveBeenCalled());
    expect(transferRunning()).toBe(true);
    expect(beginOriginChange()).toBe(false);
    answer({ status: 201, body: { project: { id: "s1", repoId: 1 } } });
    await waitFor(() => expect(transferRunning()).toBe(false));
    unmount();

    request.mockClear();
    expect(beginOriginChange()).toBe(true);
    try {
      render(<ShareProjectControl project={project} shared={shared()} />);
      makeShared();
      expect(await screen.findByText(ORIGIN_CHANGING_ERROR)).toBeTruthy();
      expect(request).not.toHaveBeenCalled();
    } finally {
      endOriginChange();
    }
  });

  it("re-reads the origin on every click", async () => {
    originAnswer = { hasOrigin: false, github: null, topLevel: false };
    request.mockResolvedValue({ status: 201, body: { project: { id: "srv-5", repoId: 5 } } });
    render(<ShareProjectControl project={project} shared={shared()} />);
    makeShared();
    await screen.findByText("This project has no git remote.");
    originAnswer = { hasOrigin: true, github: { owner: "acme", name: "app" }, topLevel: true };
    makeShared();
    await waitFor(() =>
      expect(updateProject).toHaveBeenCalledWith("p1", {
        sharedTo: { serverOrigin: SERVER, projectId: "srv-5", repoId: 5 },
      }),
    );
    expect(
      vi.mocked(fetch).mock.calls.filter(([url]) => url === "/projects/p1/origin"),
    ).toHaveLength(2);
  });
});

describe("useSharedServerProjects", () => {
  let hook: ReturnType<typeof useSharedServerProjects> | undefined;
  function Probe() {
    hook = useSharedServerProjects();
    return <output>{JSON.stringify(hook.projects)}</output>;
  }

  it("reads the server's projects once and keys them by GitHub repository", async () => {
    request.mockResolvedValue({
      status: 200,
      body: {
        projects: [
          { id: "a", origin: "https://github.com/Acme/App.git", repoId: 1 },
          { id: "b" },
          { id: "c", origin: "https://gitlab.com/x/y.git" },
        ],
      },
    });
    render(<Probe />);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        JSON.stringify([
          { id: "a", repoKey: "acme/app", repoId: 1 },
          { id: "b", repoKey: null },
          { id: "c", repoKey: null },
        ]),
      ),
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("looks up each project's origin once, at most four at a time", async () => {
    request.mockResolvedValue({ status: 200, body: { projects: [] } });
    const pending: Array<() => void> = [];
    let inFlight = 0;
    let peak = 0;
    vi.mocked(fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          pending.push(() => {
            inFlight -= 1;
            resolve(Response.json(originAnswer));
          });
        }),
    );
    render(<Probe />);
    const ids = ["1", "2", "3", "4", "5", "6"];
    const all = Promise.all([...ids, "1", "2"].map((id) => hook!.lookupOrigin(id)));
    while (pending.length || inFlight) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      pending.shift()?.();
    }
    expect((await all).every((info) => info?.hasOrigin === true)).toBe(true);
    expect(peak).toBe(4);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(ids.length);
  });
});
