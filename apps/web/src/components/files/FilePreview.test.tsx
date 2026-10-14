// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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

function renderPreview() {
  return render(
    <FilePreview
      path="src/a.ts"
      sessionId="s1"
      isVisible
      editors={{ available: [], preferred: null, onOpenInEditor: () => {} }}
    />,
  );
}

async function wrapState() {
  const button = await screen.findByTestId("file-preview-soft-wrap");
  // CodeMirror is lazy-loaded; wait for its content element.
  await vi.waitFor(() => expect(document.querySelector(".cm-content")).not.toBeNull());
  return {
    button,
    pressed: button.getAttribute("aria-pressed"),
    wrapped: document.querySelector(".cm-content")!.classList.contains("cm-lineWrapping"),
  };
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

it("defaults to no soft wrap", async () => {
  renderPreview();
  const { pressed, wrapped } = await wrapState();
  expect(pressed).toBe("false");
  expect(wrapped).toBe(false);
});

it("toggles wrapping on and off in the live editor and persists it", async () => {
  renderPreview();
  const { button } = await wrapState();
  const editor = document.querySelector(".cm-editor");

  fireEvent.click(button);
  await vi.waitFor(() =>
    expect(document.querySelector(".cm-content")!.classList.contains("cm-lineWrapping")).toBe(true),
  );
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(localStorage.getItem(KEY)).toBe("true");
  // Reconfigured through the compartment, not recreated.
  expect(document.querySelector(".cm-editor")).toBe(editor);

  fireEvent.click(button);
  await vi.waitFor(() =>
    expect(document.querySelector(".cm-content")!.classList.contains("cm-lineWrapping")).toBe(
      false,
    ),
  );
  expect(button.getAttribute("aria-pressed")).toBe("false");
  expect(localStorage.getItem(KEY)).toBe("false");
});

it("restores a persisted soft wrap on the next mount", async () => {
  localStorage.setItem(KEY, "true");
  renderPreview();
  const { pressed, wrapped } = await wrapState();
  expect(pressed).toBe("true");
  expect(wrapped).toBe(true);
});
