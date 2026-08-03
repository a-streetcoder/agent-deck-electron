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
