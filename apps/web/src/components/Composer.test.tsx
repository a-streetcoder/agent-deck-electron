// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { Composer } from "./Composer.tsx";

beforeEach(() => {
  Object.defineProperty(window, "agentDeck", { configurable: true, value: undefined });
  useAppStore.setState((state) => ({
    connection: "open",
    session: { id: "drop-session", cwd: "/tmp", createdAt: "now" },
    currentAgentName: null,
    composerDrafts: {},
    transcript: { ...state.transcript, agentStatus: "idle" },
  }));
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      return new Response(
        JSON.stringify(
          url.includes("/resources/agents")
            ? { agents: [] }
            : url.endsWith("/models")
              ? { models: [] }
              : url.endsWith("/state")
                ? { state: { thinkingLevel: "off" } }
                : { files: [] },
        ),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAppStore.setState({ session: null, composerDrafts: {} });
  Reflect.deleteProperty(window, "agentDeck");
});

function transfer(files: File[]) {
  return {
    types: ["Files"],
    files,
    items: files.map((file) => ({ kind: "file", type: file.type })),
    dropEffect: "none",
  } as unknown as DataTransfer;
}

function imageFile(name = "shot.png"): File {
  const file = new File([new Uint8Array([1, 2, 3])], name, { type: "image/png" });
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => new Uint8Array([1, 2, 3]).buffer,
  });
  return file;
}

describe("composer drop target", () => {
  it("keeps the accent overlay stable across nested drag enter/leave", () => {
    render(<Composer />);
    const target = screen.getByTestId("composer-drop-target");
    const dataTransfer = transfer([imageFile()]);

    fireEvent.dragEnter(target, { dataTransfer });
    fireEvent.dragEnter(screen.getByTestId("composer-input"), { dataTransfer });
    expect(target.getAttribute("data-drop-active")).toBe("true");
    expect(screen.getByRole("status", { name: "" }).textContent).toContain("Drop images");

    fireEvent.dragLeave(screen.getByTestId("composer-input"), { dataTransfer });
    expect(target.getAttribute("data-drop-active")).toBe("true");
    fireEvent.dragLeave(target, { dataTransfer });
    expect(target.getAttribute("data-drop-active")).toBe("false");
  });

  it("attaches a dropped image as image bytes and restores editor focus", async () => {
    render(<Composer />);
    const target = screen.getByTestId("composer-drop-target");
    const file = imageFile();

    fireEvent.drop(target, { dataTransfer: transfer([file]) });

    await waitFor(() =>
      expect(useAppStore.getState().composerDrafts["drop-session"]?.images[0]).toMatchObject({
        name: "shot.png",
        mimeType: "image/png",
        data: "AQID",
      }),
    );
    expect(useAppStore.getState().composerDrafts["drop-session"]?.files).toEqual([]);
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("composer-input")));
    expect(
      screen.getByRole("button", { name: "Preview image shot.png" }).getAttribute("title"),
    ).toBe("shot.png");
    expect(
      screen.getByRole("button", { name: "Remove shot.png image attachment" }).className,
    ).toContain("h-6 w-6");
  });

  it("classifies a mixed desktop drop without duplicating the image as a file pill", async () => {
    const resolveDroppedItems = vi.fn().mockResolvedValue([
      { index: 0, path: "/tmp/shot.png", kind: "file" },
      { index: 1, path: "/tmp/notes.txt", kind: "file" },
      { index: 2, path: "/tmp/project", kind: "folder" },
    ]);
    Object.defineProperty(window, "agentDeck", {
      configurable: true,
      value: { isElectron: true, resolveDroppedItems },
    });
    render(<Composer />);
    const image = imageFile();
    const text = new File(["notes"], "notes.txt", { type: "text/plain" });
    const folder = new File([], "project", { type: "" });

    fireEvent.drop(screen.getByTestId("composer-drop-target"), {
      dataTransfer: transfer([image, text, folder]),
    });

    await waitFor(() => {
      const draft = useAppStore.getState().composerDrafts["drop-session"];
      expect(draft?.images).toHaveLength(1);
      expect(draft?.files.map((file) => file.path)).toEqual(["/tmp/notes.txt"]);
      expect(draft?.folders.map((item) => item.path)).toEqual(["/tmp/project"]);
    });
    expect(resolveDroppedItems).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle("/tmp/shot.png")).toBeNull();
  });

  it("falls back to valid image bytes when Electron cannot resolve a native path", async () => {
    Object.defineProperty(window, "agentDeck", {
      configurable: true,
      value: { isElectron: true, resolveDroppedItems: vi.fn().mockResolvedValue([]) },
    });
    render(<Composer />);

    fireEvent.drop(screen.getByTestId("composer-drop-target"), {
      dataTransfer: transfer([imageFile("memory.png")]),
    });

    await waitFor(() =>
      expect(useAppStore.getState().composerDrafts["drop-session"]?.images[0]?.name).toBe(
        "memory.png",
      ),
    );
    expect(screen.queryByTestId(/file-attachment-/)).toBeNull();
  });

  it("never treats a natively classified image-named folder as image bytes", async () => {
    Object.defineProperty(window, "agentDeck", {
      configurable: true,
      value: {
        isElectron: true,
        resolveDroppedItems: vi.fn().mockResolvedValue([
          { index: 0, path: "/tmp/assets.png", kind: "folder" },
          { index: 99, path: "/tmp/out-of-range.png", kind: "file" },
        ]),
      },
    });
    render(<Composer />);
    const folder = imageFile("assets.png");

    fireEvent.drop(screen.getByTestId("composer-drop-target"), {
      dataTransfer: transfer([folder]),
    });

    await waitFor(() =>
      expect(useAppStore.getState().composerDrafts["drop-session"]?.folders[0]?.path).toBe(
        "/tmp/assets.png",
      ),
    );
    expect(useAppStore.getState().composerDrafts["drop-session"]?.images).toEqual([]);
  });

  it("discards native path resolution that settles after a session switch", async () => {
    let settle: ((items: Array<{ index: number; path: string; kind: "file" }>) => void) | undefined;
    const pending = new Promise<Array<{ index: number; path: string; kind: "file" }>>((resolve) => {
      settle = resolve;
    });
    Object.defineProperty(window, "agentDeck", {
      configurable: true,
      value: { isElectron: true, resolveDroppedItems: vi.fn(() => pending) },
    });
    render(<Composer />);
    fireEvent.drop(screen.getByTestId("composer-drop-target"), {
      dataTransfer: transfer([new File(["x"], "late.txt", { type: "text/plain" })]),
    });

    useAppStore.setState({ session: { id: "other-session", cwd: "/tmp", createdAt: "now" } });
    settle?.([{ index: 0, path: "/tmp/late.txt", kind: "file" }]);

    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("composer-input")));
    expect(useAppStore.getState().composerDrafts["other-session"]?.files ?? []).toEqual([]);
    expect(useAppStore.getState().composerDrafts["drop-session"]?.files ?? []).toEqual([]);
  });

  it("reports a path dropped after the current file cap without stale render counts", async () => {
    useAppStore.getState().updateComposerDraft("drop-session", (current) => ({
      ...current,
      files: Array.from({ length: 16 }, (_, index) => ({
        id: `existing-${index}`,
        name: `existing-${index}.txt`,
        path: `/tmp/existing-${index}.txt`,
      })),
    }));
    Object.defineProperty(window, "agentDeck", {
      configurable: true,
      value: {
        isElectron: true,
        resolveDroppedItems: vi
          .fn()
          .mockResolvedValue([{ index: 0, path: "/tmp/overflow.txt", kind: "file" }]),
      },
    });
    render(<Composer />);

    fireEvent.drop(screen.getByTestId("composer-drop-target"), {
      dataTransfer: transfer([new File(["x"], "overflow.txt", { type: "text/plain" })]),
    });

    await waitFor(() =>
      expect(screen.getByTestId("composer-submit-status").textContent).toContain(
        "over the attachment limit",
      ),
    );
    expect(useAppStore.getState().composerDrafts["drop-session"]?.files).toHaveLength(16);
  });

  it("keeps the idle-only image status while attaching paths from a running mixed drop", async () => {
    useAppStore.setState((state) => ({
      transcript: { ...state.transcript, agentStatus: "running" },
    }));
    Object.defineProperty(window, "agentDeck", {
      configurable: true,
      value: {
        isElectron: true,
        resolveDroppedItems: vi.fn().mockResolvedValue([
          { index: 0, path: "/tmp/shot.png", kind: "file" },
          { index: 1, path: "/tmp/notes.txt", kind: "file" },
        ]),
      },
    });
    render(<Composer />);

    fireEvent.drop(screen.getByTestId("composer-drop-target"), {
      dataTransfer: transfer([
        imageFile(),
        new File(["notes"], "notes.txt", { type: "text/plain" }),
      ]),
    });

    await waitFor(() =>
      expect(useAppStore.getState().composerDrafts["drop-session"]?.files[0]?.path).toBe(
        "/tmp/notes.txt",
      ),
    );
    expect(useAppStore.getState().composerDrafts["drop-session"]?.images).toEqual([]);
    expect(screen.getByTestId("composer-submit-status").textContent).toBe(
      "Images can only be added while Pi is idle.",
    );
  });
});
