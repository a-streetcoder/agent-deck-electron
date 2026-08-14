// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { InstructionsScreen } from "./InstructionsScreen.tsx";

/** INS-01: the SYSTEM.md base-prompt candidate joins the instructions editor. */

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  useAppStore.setState({
    error: null,
    toasts: [],
    projects: [],
    projectsLoaded: true,
    currentProjectId: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/runtime/instructions") {
        return Promise.resolve(
          jsonResponse({ content: "global context", path: "/home/.pi/agent/AGENTS.md" }),
        );
      }
      if (url === "/runtime/system-prompt") {
        if (init?.method === "PUT") return Promise.resolve(jsonResponse({ ok: true }));
        if (init?.method === "DELETE") return Promise.resolve(jsonResponse({ ok: true }));
        return Promise.resolve(
          jsonResponse({ content: "", path: "/home/.pi/agent/SYSTEM.md", exists: false }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SYSTEM.md base-prompt candidate (INS-01)", () => {
  it("the file toggle reveals the SYSTEM.md candidate; saving PUTs the override", async () => {
    render(<InstructionsScreen />);
    await screen.findByTestId("instructions-editor");

    // the base-prompt candidate is cataloged even though the file does not exist
    fireEvent.click(screen.getByTestId("instructions-file-system"));
    await waitFor(() => {
      expect(screen.getAllByText(/SYSTEM\.md/).length).toBeGreaterThan(0);
    });
    await screen.findByTestId("instructions-editor");
    // the candidate is cataloged with its create-semantics note (native's info text)
    expect(screen.getByTestId("instructions-system-note").textContent).toContain("overrides");

    fireEvent.change(screen.getByTestId("instructions-editor"), {
      target: { value: "You are a pirate." },
    });
    fireEvent.click(screen.getByTestId("instructions-save"));
    await waitFor(() => {
      const put = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url, init]) =>
            String(url) === "/runtime/system-prompt" &&
            (init as RequestInit | undefined)?.method === "PUT",
        );
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
        content: "You are a pirate.",
      });
    });
  });

  it("an EXISTING override offers Remove override, which DELETEs the file", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/runtime/instructions") {
        return Promise.resolve(jsonResponse({ content: "", path: "/home/.pi/agent/AGENTS.md" }));
      }
      if (url === "/runtime/system-prompt") {
        if (init?.method === "DELETE") return Promise.resolve(jsonResponse({ ok: true }));
        return Promise.resolve(
          jsonResponse({ content: "override", path: "/home/.pi/agent/SYSTEM.md", exists: true }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<InstructionsScreen />);
    await screen.findByTestId("instructions-editor");
    fireEvent.click(screen.getByTestId("instructions-file-system"));

    fireEvent.click(await screen.findByTestId("instructions-remove-override"));
    await waitFor(() => {
      const del = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url, init]) =>
            String(url) === "/runtime/system-prompt" &&
            (init as RequestInit | undefined)?.method === "DELETE",
        );
      expect(del).toBeTruthy();
    });
  });

  it("the Append toggle catalogs APPEND_SYSTEM.md with its own note and save target (INS-02)", async () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/runtime/instructions") {
        return Promise.resolve(jsonResponse({ content: "", path: "/home/.pi/agent/AGENTS.md" }));
      }
      if (url === "/runtime/append-prompt") {
        if (init?.method === "PUT") return Promise.resolve(jsonResponse({ ok: true }));
        return Promise.resolve(
          jsonResponse({ content: "", path: "/home/.pi/agent/APPEND_SYSTEM.md", exists: false }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<InstructionsScreen />);
    await screen.findByTestId("instructions-editor");

    fireEvent.click(screen.getByTestId("instructions-file-append"));
    await screen.findByTestId("instructions-append-note");

    fireEvent.change(await screen.findByTestId("instructions-editor"), {
      target: { value: "House rules." },
    });
    fireEvent.click(screen.getByTestId("instructions-save"));
    await waitFor(() => {
      const put = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url, init]) =>
            String(url) === "/runtime/append-prompt" &&
            (init as RequestInit | undefined)?.method === "PUT",
        );
      expect(JSON.parse(String((put![1] as RequestInit).body))).toEqual({
        content: "House rules.",
      });
    });
  });

  it("the PROJECT context view lists inherited ancestor candidates (INS-03)", async () => {
    useAppStore.setState({
      projects: [{ id: "p1", name: "repo", path: "C:/work/team/repo" } as never],
      currentProjectId: "p1",
    });
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/projects/p1/instructions") {
        return Promise.resolve(
          jsonResponse({ content: "project ctx", path: "C:/work/team/repo/AGENTS.md" }),
        );
      }
      if (url === "/projects/p1/instruction-ancestors") {
        return Promise.resolve(
          jsonResponse({
            items: [
              { dir: "C:/work", name: "CLAUDE.md", path: "C:/work/CLAUDE.md" },
              { dir: "C:/work/team", name: "AGENTS.md", path: "C:/work/team/AGENTS.md" },
            ],
          }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<InstructionsScreen />);
    await screen.findByTestId("instructions-editor");

    const list = await screen.findByTestId("instructions-ancestors");
    expect(list.textContent).toContain("C:/work/CLAUDE.md");
    expect(list.textContent).toContain("C:/work/team/AGENTS.md");
  });

  it("the GLOBAL context view fetches no ancestors and shows no list", async () => {
    render(<InstructionsScreen />);
    await screen.findByTestId("instructions-editor");
    expect(screen.queryByTestId("instructions-ancestors")).toBeNull();
    expect(
      vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes("instruction-ancestors")),
    ).toBe(false);
  });

  it("the context file view offers no Remove override", async () => {
    render(<InstructionsScreen />);
    await screen.findByTestId("instructions-editor");
    expect(screen.queryByTestId("instructions-remove-override")).toBeNull();
  });

  it("a save finishing AFTER a target switch never mutates the new target (review, Codex)", async () => {
    let resolvePut: ((r: Response) => void) | undefined;
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/runtime/instructions") {
        if (init?.method === "PUT") {
          return new Promise<Response>((resolve) => {
            resolvePut = resolve;
          });
        }
        return Promise.resolve(jsonResponse({ content: "", path: "/home/.pi/agent/AGENTS.md" }));
      }
      if (url === "/runtime/system-prompt") {
        return Promise.resolve(
          jsonResponse({ content: "", path: "/home/.pi/agent/SYSTEM.md", exists: false }),
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<InstructionsScreen />);
    await screen.findByTestId("instructions-editor");

    // start a context save, then switch to the SYSTEM.md view while it is in flight
    fireEvent.change(screen.getByTestId("instructions-editor"), {
      target: { value: "context edit" },
    });
    fireEvent.click(screen.getByTestId("instructions-save"));
    fireEvent.click(screen.getByTestId("instructions-file-system"));
    await screen.findByTestId("instructions-system-note");
    resolvePut!(jsonResponse({ ok: true }));

    // the SYSTEM view must not inherit the context save's completion: still
    // non-existent (no Remove override) and its editor still empty
    await waitFor(() => {
      expect(screen.queryByTestId("instructions-remove-override")).toBeNull();
    });
    expect((screen.getByTestId("instructions-editor") as HTMLTextAreaElement).value).toBe("");
  });
});
