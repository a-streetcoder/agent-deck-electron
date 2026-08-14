// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { PromptInfo } from "@agent-deck/domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { filterPrompts, PromptsScreen } from "./PromptsScreen.tsx";

const prompts: PromptInfo[] = [
  {
    name: "NameNeedle",
    invocation: "/name-command",
    description: "First catalog entry",
    scope: "global",
    filePath: "/prompts/first.md",
    body: "First body",
  },
  {
    name: "second",
    invocation: "/InvocationNeedle",
    description: "Second catalog entry",
    scope: "library",
    filePath: "/prompts/second.md",
    body: "Second body",
  },
  {
    name: "third",
    invocation: "/third",
    description: "Contains DescNeedle here",
    scope: "builtin",
    filePath: "/prompts/third.md",
    body: "Third body",
  },
  {
    name: "fourth",
    invocation: "/fourth",
    description: "Fourth catalog entry",
    scope: "project",
    filePath: "/prompts/fourth.md",
    body: "Fourth body",
  },
  {
    name: "fifth",
    invocation: "/fifth",
    description: "Fifth catalog entry",
    scope: "library",
    filePath: "/catalog/PathNeedle/fifth.md",
    body: "Fifth body",
  },
  {
    name: "sixth",
    invocation: "/sixth",
    description: "Sixth catalog entry",
    scope: "library",
    filePath: "/prompts/sixth.md",
    body: "Long private content with BodyNeedle near the end",
  },
];

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

async function renderCatalog(): Promise<HTMLInputElement> {
  render(<PromptsScreen />);
  await screen.findByText("/name-command");
  return screen.getByRole("textbox", {
    name: "Search prompt templates",
  }) as HTMLInputElement;
}

beforeEach(() => {
  useAppStore.setState({
    resourcesVersion: 0,
    error: null,
    toasts: [],
    projects: [],
    projectsLoaded: true,
    currentProjectId: null,
    resourceCommandRequest: null,
    selectedPromptFilePath: null,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/resources/prompts") return Promise.resolve(jsonResponse({ prompts }));
      if (url === "/settings") return Promise.resolve(jsonResponse({ settings: {} }));
      throw new Error(`Unexpected request: ${url}`);
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("builtin prompt source (PRM-02)", () => {
  it("builtin prompts are read-only; opening one drafts a GLOBAL copy to customize", async () => {
    await renderCatalog();
    // no rename/delete affordances on the builtin row — it is not the user's file
    expect(screen.queryByTestId("prompt-rename-third")).toBeNull();
    expect(screen.queryByTestId("prompt-delete-third")).toBeNull();
    // ordinary rows keep them
    expect(screen.getByTestId("prompt-rename-NameNeedle")).toBeTruthy();

    // opening a builtin drafts a copy that SAVES into the user's global prompts
    fireEvent.click(screen.getByText("/third"));
    await screen.findByTestId("prompt-editor");
    fireEvent.click(screen.getByTestId("prompt-save"));
    await waitFor(() => {
      const put = vi
        .mocked(fetch)
        .mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toMatchObject({
        scope: "global",
        name: "third",
      });
    });
  });

  it("opening a builtin that is ALREADY customized edits the user's copy, never overwrites it blind", async () => {
    const shadowed: PromptInfo[] = [
      {
        name: "third",
        invocation: "/third",
        description: "the user's customized copy",
        scope: "global",
        filePath: "/prompts/third-global.md",
        body: "customized body",
      },
      {
        name: "third",
        invocation: "/third",
        description: "the bundled original",
        scope: "builtin",
        filePath: "/builtin-prompts/third.md",
        body: "bundled body",
      },
    ];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/resources/prompts") {
        return Promise.resolve(jsonResponse({ prompts: shadowed }));
      }
      if (url === "/settings") return Promise.resolve(jsonResponse({ settings: {} }));
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<PromptsScreen />);
    const rows = await screen.findAllByText("/third");
    fireEvent.click(rows[1]!); // the BUILTIN row
    await screen.findByTestId("prompt-editor");
    // the draft targets the user's existing copy (its file), not a blind overwrite
    expect(screen.getByTestId("prompt-file-path").textContent).toContain("third-global.md");
  });
});

describe("builtin prompt disable (PRM-06)", () => {
  it("builtin rows toggle disable via PATCH; a disabled builtin is dimmed and re-enableable", async () => {
    const builtins: PromptInfo[] = [
      {
        name: "active-builtin",
        invocation: "/active-builtin",
        description: "on",
        scope: "builtin",
        filePath: "/builtin-prompts/active-builtin.md",
        body: "b",
      },
      {
        name: "silenced",
        invocation: "/silenced",
        description: "off",
        scope: "builtin",
        filePath: "/builtin-prompts/silenced.md",
        body: "b",
        disabled: true,
      },
    ];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/prompts") {
        return Promise.resolve(jsonResponse({ prompts: builtins }));
      }
      if (url === "/settings") {
        if (init?.method === "PATCH") return Promise.resolve(jsonResponse({ settings: {} }));
        return Promise.resolve(jsonResponse({ settings: {} }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<PromptsScreen />);
    await screen.findByText("/active-builtin");

    // the silenced builtin is visibly disabled and offers Enable
    expect(screen.getByTestId("prompt-disabled-badge-silenced")).toBeTruthy();
    fireEvent.click(screen.getByTestId("prompt-builtin-toggle-silenced"));
    await waitFor(() => {
      const patch = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url, init2]) =>
            String(url) === "/settings" &&
            (init2 as RequestInit | undefined)?.method === "PATCH" &&
            String((init2 as RequestInit).body).includes("setBuiltinPromptDisabled"),
        );
      expect(JSON.parse(String((patch![1] as RequestInit).body))).toEqual({
        setBuiltinPromptDisabled: { name: "silenced", disabled: false },
      });
    });

    // the active builtin offers Disable
    fireEvent.click(screen.getByTestId("prompt-builtin-toggle-active-builtin"));
    await waitFor(() => {
      const calls = vi
        .mocked(fetch)
        .mock.calls.filter(([, init2]) =>
          String((init2 as RequestInit | undefined)?.body ?? "").includes(
            "setBuiltinPromptDisabled",
          ),
        );
      expect(JSON.parse(String((calls[1]![1] as RequestInit).body))).toEqual({
        setBuiltinPromptDisabled: { name: "active-builtin", disabled: true },
      });
    });
  });
});

describe("package prompt source (PRM-03)", () => {
  it("package prompts are read-only like builtins, and resolution warnings surface", async () => {
    const packaged: PromptInfo[] = [
      {
        name: "from-pack",
        invocation: "/from-pack",
        description: "shipped by a package",
        scope: "package",
        filePath: "/node_modules/my-pack/prompts/from-pack.md",
        body: "packaged body",
      },
    ];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/resources/prompts") {
        return Promise.resolve(
          jsonResponse({
            prompts: packaged,
            packagePromptWarnings: [
              "Package ghost-pack declares prompt templates at tpl, but that path was not found.",
            ],
          }),
        );
      }
      if (url === "/settings") return Promise.resolve(jsonResponse({ settings: {} }));
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<PromptsScreen />);
    await screen.findByText("/from-pack");

    // read-only: no rename/delete for a package prompt
    expect(screen.queryByTestId("prompt-rename-from-pack")).toBeNull();
    expect(screen.queryByTestId("prompt-delete-from-pack")).toBeNull();
    // a configured-but-broken package is surfaced, not silent
    expect(screen.getByTestId("prompt-package-warnings").textContent).toContain("ghost-pack");

    // opening a package prompt drafts a GLOBAL copy (copy-to-customize)
    fireEvent.click(screen.getByText("/from-pack"));
    await screen.findByTestId("prompt-editor");
    fireEvent.click(screen.getByTestId("prompt-save"));
    await waitFor(() => {
      const put = vi
        .mocked(fetch)
        .mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toMatchObject({
        scope: "global",
        name: "from-pack",
      });
    });
  });
});

describe("external prompt references (PRM-05)", () => {
  it("external rows badge + Remove Reference (no rename/delete); a path can be referenced", async () => {
    const externalPrompt: PromptInfo[] = [
      {
        name: "kept-outside",
        invocation: "/kept-outside",
        description: "referenced in place",
        scope: "library",
        filePath: "C:/notes/kept-outside.md",
        body: "external body",
        external: true,
      },
    ];
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/prompts") {
        return Promise.resolve(jsonResponse({ prompts: externalPrompt }));
      }
      if (url === "/settings") return Promise.resolve(jsonResponse({ settings: {} }));
      if (url === "/resources/prompts/external-refs" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (url === "/resources/prompts/external-refs" && init?.method === "DELETE") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    render(<PromptsScreen />);
    await screen.findByText("/kept-outside");

    // the reference is visibly external and offers no rename/delete of the file
    expect(screen.getByTestId("prompt-external-kept-outside")).toBeTruthy();
    expect(screen.queryByTestId("prompt-rename-kept-outside")).toBeNull();
    expect(screen.queryByTestId("prompt-delete-kept-outside")).toBeNull();
    // an external prompt IS launchable, so its All Projects default toggle shows
    expect(screen.getByTestId("prompt-default-kept-outside")).toBeTruthy();

    // opening an external drafts a GLOBAL copy — never a library overwrite, even
    // though the reference itself carries library scope (review, Codex)
    fireEvent.click(screen.getByText("/kept-outside"));
    await screen.findByTestId("prompt-editor");
    fireEvent.click(screen.getByTestId("prompt-save"));
    await waitFor(() => {
      const put = vi
        .mocked(fetch)
        .mock.calls.find(([, init2]) => (init2 as RequestInit | undefined)?.method === "PUT");
      expect(put).toBeTruthy();
      expect(JSON.parse(String((put![1] as RequestInit).body))).toMatchObject({
        scope: "global",
        name: "kept-outside",
      });
    });

    // removing removes the REFERENCE via its own endpoint
    fireEvent.click(screen.getByTestId("prompt-remove-external-kept-outside"));
    await waitFor(() => {
      const del = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url, init2]) =>
            String(url) === "/resources/prompts/external-refs" &&
            (init2 as RequestInit | undefined)?.method === "DELETE",
        );
      expect(JSON.parse(String((del![1] as RequestInit).body))).toEqual({
        path: "C:/notes/kept-outside.md",
      });
    });

    // adding: the reference-path input posts to the same endpoint
    fireEvent.click(screen.getByTestId("prompt-add-external"));
    fireEvent.change(screen.getByTestId("prompt-external-path"), {
      target: { value: "C:/notes/another.md" },
    });
    fireEvent.click(screen.getByTestId("prompt-external-confirm"));
    await waitFor(() => {
      const post = vi
        .mocked(fetch)
        .mock.calls.find(
          ([url, init2]) =>
            String(url) === "/resources/prompts/external-refs" &&
            (init2 as RequestInit | undefined)?.method === "POST",
        );
      expect(JSON.parse(String((post![1] as RequestInit).body))).toEqual({
        path: "C:/notes/another.md",
      });
    });
  });
});

describe("prompt catalog search", () => {
  it("does not show the catalog-empty state while the initial prompt request is pending", () => {
    vi.mocked(fetch).mockImplementation((input: RequestInfo | URL) => {
      if (String(input) === "/settings") {
        return Promise.resolve(jsonResponse({ settings: {} }));
      }
      return new Promise<Response>(() => undefined);
    });

    render(<PromptsScreen />);

    expect(screen.queryByText(/No prompt templates yet/)).toBeNull();
  });

  it.each([
    ["name", "NameNeedle", "NameNeedle"],
    ["slash invocation", "InvocationNeedle", "second"],
    ["description", "DescNeedle", "third"],
    ["scope", "project", "fourth"],
    ["file path", "PathNeedle", "fifth"],
    ["body", "BodyNeedle", "sixth"],
  ])("matches the prompt %s field", async (_field, query, expectedName) => {
    const search = await renderCatalog();

    fireEvent.change(search, { target: { value: query } });

    const rows = within(screen.getByTestId("prompt-list")).getAllByRole("listitem");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.getAttribute("data-prompt-name")).toBe(expectedName);
  });

  it("trims and case-folds live queries, then clears back to the full catalog", async () => {
    const search = await renderCatalog();

    fireEvent.change(search, { target: { value: "  dEsCnEeDlE  " } });
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("/third")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Clear prompt search" }));

    expect(search.value).toBe("");
    expect(screen.getAllByRole("listitem")).toHaveLength(prompts.length);
    expect(document.activeElement).toBe(search);
  });

  it("shows a dedicated no-results state without claiming the catalog is empty", async () => {
    const search = await renderCatalog();

    fireEvent.change(search, { target: { value: "does-not-exist" } });

    expect(screen.getByRole("status").textContent).toContain(
      "No prompt templates match your search.",
    );
    expect(screen.queryByText(/No prompt templates yet/)).toBeNull();
  });

  it("opens an action with the original prompt object after filtering", async () => {
    const bodyMatch = prompts.at(-1)!;
    expect(filterPrompts(prompts, "BodyNeedle")[0]).toBe(bodyMatch);
    const search = await renderCatalog();
    fireEvent.change(search, { target: { value: "BodyNeedle" } });

    fireEvent.click(screen.getByText("/sixth"));

    await waitFor(() => expect(screen.getByTestId("prompt-editor")).toBeTruthy());
    expect((screen.getByTestId("prompt-name") as HTMLInputElement).value).toBe(bodyMatch.name);
    expect((screen.getByTestId("prompt-body") as HTMLTextAreaElement).value).toBe(bodyMatch.body);
    expect(screen.getByTestId("prompt-file-path").textContent).toContain(bodyMatch.filePath);
  });
});
