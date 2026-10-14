// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { EditorView } from "@uiw/react-codemirror";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAppStore } from "../../state/store.ts";
import CodeMirrorView from "./CodeMirrorView.tsx";
import { FilePreview } from "./FilePreview.tsx";

vi.mock("../../state/wsBridge.ts", () => ({
  fetchFileRead: vi.fn(async () => ({
    contentKind: "text",
    content: "const x = 1;\n",
    byteLength: 13,
    truncated: false,
    version: "v1",
  })),
  fetchFileWrite: vi.fn(),
  fetchAvailableEditors: vi.fn(async () => []),
  openFileInEditor: vi.fn(),
}));

// jsdom lacks layout; CodeMirror's measure pass calls this on text ranges.
Range.prototype.getClientRects = () => [] as unknown as DOMRectList;

const KEY = "agentdeck:file-preview-soft-wrap";

function preview(path: string) {
  return (
    <FilePreview
      key={path}
      path={path}
      sessionId="s1"
      isVisible
      editors={{ available: [], preferred: null, onOpenInEditor: () => {} }}
    />
  );
}

/** Wrap state read from each editor's STATE (the lineWrapping content class). */
function editorsWrapped(): boolean[] {
  return [...document.querySelectorAll<HTMLElement>(".cm-editor")].map((dom) =>
    EditorView.findFromDOM(dom)!
      .state.facet(EditorView.contentAttributes)
      .some((attrs) => typeof attrs !== "function" && attrs.class === "cm-lineWrapping"),
  );
}

async function editorsReady(count: number) {
  await vi.waitFor(() => expect(document.querySelectorAll(".cm-editor")).toHaveLength(count));
}

beforeEach(() => {
  localStorage.clear();
  useAppStore.setState({ softWrap: false });
});
afterEach(cleanup);

it("defaults to no soft wrap", async () => {
  vi.resetModules();
  const { useAppStore: fresh } = await import("../../state/store.ts");
  expect(fresh.getState().softWrap).toBe(false);

  render(preview("src/a.ts"));
  await editorsReady(1);
  expect(screen.getByTestId("file-preview-soft-wrap").getAttribute("aria-pressed")).toBe("false");
  expect(editorsWrapped()).toEqual([false]);
});

it("toggles wrapping on and off in the live editor and persists it", async () => {
  render(preview("src/a.ts"));
  await editorsReady(1);
  const editor = document.querySelector(".cm-editor");
  const button = screen.getByTestId("file-preview-soft-wrap");

  fireEvent.click(button);
  await vi.waitFor(() => expect(editorsWrapped()).toEqual([true]));
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(localStorage.getItem(KEY)).toBe("true");
  // Reconfigured through the compartment, not recreated.
  expect(document.querySelector(".cm-editor")).toBe(editor);

  fireEvent.click(button);
  await vi.waitFor(() => expect(editorsWrapped()).toEqual([false]));
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(localStorage.getItem(KEY)).toBe("false");
});

it("restores a persisted soft wrap when the store loads", async () => {
  localStorage.setItem(KEY, "true");
  vi.resetModules();
  const { useAppStore: fresh } = await import("../../state/store.ts");
  expect(fresh.getState().softWrap).toBe(true);
});

it("keeps every open file tab in sync", async () => {
  render(
    <>
      {preview("src/a.ts")}
      {preview("src/b.ts")}
    </>,
  );
  await editorsReady(2);
  fireEvent.click(screen.getAllByTestId("file-preview-soft-wrap")[0]!);
  await vi.waitFor(() => expect(editorsWrapped()).toEqual([true, true]));
  for (const button of screen.getAllByTestId("file-preview-soft-wrap")) {
    expect(button.getAttribute("aria-pressed")).toBe("true");
  }
});

it("keeps wrapping on across a full extensions reconfigure", async () => {
  const { rerender } = render(<CodeMirrorView value="x" filename="a.txt" lineWrapping={false} />);
  await editorsReady(1);
  rerender(<CodeMirrorView value="x" filename="a.txt" lineWrapping />);
  await vi.waitFor(() => expect(editorsWrapped()).toEqual([true]));
  // readOnly is a memoized-extensions dependency: this rebuilds the whole config.
  rerender(<CodeMirrorView value="x" filename="a.txt" lineWrapping readOnly={false} />);
  await vi.waitFor(() =>
    expect(document.querySelector(".cm-content")!.getAttribute("contenteditable")).toBe("true"),
  );
  expect(editorsWrapped()).toEqual([true]);
});
