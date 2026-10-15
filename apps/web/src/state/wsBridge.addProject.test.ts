// @vitest-environment jsdom
vi.mock("./remoteComposerDrafts.ts", () => ({
  forgetComposerDraft: vi.fn(),
  restoreComposerDraft: vi.fn(async () => {}),
  flushComposerDraft: vi.fn(async () => {}),
}));
vi.mock("./clientTransport.ts", () => ({
  RpcClientTransport: class {
    connect(): void {}
    disconnect(): void {}
    send(): void {}
  },
}));
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { addProject } from "./wsBridge.ts";
import { useAppStore } from "./store.ts";

const existing = { id: "p1", path: "/srv/streetcoding/app", name: "app", createdAt: "now" };

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({ projects: [] });
});
afterEach(() => vi.unstubAllGlobals());

it("SRV-12a: a repository add that outlives the proxy says the clone is still running", async () => {
  vi.mocked(fetch).mockResolvedValue(
    new Response("<html>A timeout occurred</html>", { status: 524 }),
  );
  await expect(addProject({ repo: "acme/app" }, { rethrow: true })).rejects.toThrow(
    "The server is still cloning; reload in a minute and the project will be there.",
  );
  vi.mocked(fetch).mockResolvedValue(new Response("<html>Bad gateway</html>", { status: 502 }));
  await expect(addProject({ repo: "acme/app" }, { rethrow: true })).rejects.toThrow(
    "still cloning",
  );
  // The server's own JSON 502 (a failed clone) is shown as it is.
  vi.mocked(fetch).mockResolvedValue(
    Response.json({ error: "The clone failed: fatal: nope" }, { status: 502 }),
  );
  await expect(addProject({ repo: "acme/app" }, { rethrow: true })).rejects.toThrow(
    "The clone failed: fatal: nope",
  );
});

it("SRV-12a: a 409 naming a project reloads the list so that project shows", async () => {
  vi.mocked(fetch).mockImplementation(async (_input, init) =>
    init?.method === "POST"
      ? Response.json({ error: "already the project", projectId: "p1" }, { status: 409 })
      : Response.json({ projects: [existing] }),
  );
  await expect(addProject({ repo: "acme/app" }, { rethrow: true })).rejects.toThrow(
    "already the project",
  );
  expect(useAppStore.getState().projects).toEqual([existing]);
});
