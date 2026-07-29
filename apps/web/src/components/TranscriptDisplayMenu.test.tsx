// @vitest-environment jsdom

import { DEFAULT_TRANSCRIPT_VISIBILITY } from "@agent-deck/contracts";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { TranscriptDisplayMenu } from "./TranscriptDisplayMenu.tsx";

const fetchMock = vi.fn<typeof fetch>();

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function settingsResponse(overrides: Partial<typeof DEFAULT_TRANSCRIPT_VISIBILITY> = {}): Response {
  return new Response(
    JSON.stringify({
      settings: {
        piAgentTranscriptVisibility: {
          ...DEFAULT_TRANSCRIPT_VISIBILITY,
          ...overrides,
        },
      },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  useAppStore.setState({
    transcriptVisibility: { ...DEFAULT_TRANSCRIPT_VISIBILITY },
    transcriptVisibilityLoaded: true,
    transcriptVisibilityLoadError: null,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("TranscriptDisplayMenu", () => {
  it("persists one category, applies the response, and restores trigger focus on Escape", async () => {
    fetchMock.mockResolvedValueOnce(settingsResponse({ showThinking: false }));
    render(<TranscriptDisplayMenu />);

    const trigger = screen.getByRole("button", { name: "Transcript display" });
    fireEvent.click(trigger);
    const thinking = screen.getByRole("switch", { name: "Thinking" });
    await waitFor(() => expect(document.activeElement).toBe(thinking));
    fireEvent.click(thinking);

    await waitFor(() => expect(thinking.getAttribute("aria-checked")).toBe("false"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    expect(init?.method).toBe("PATCH");
    expect(JSON.parse(String(init?.body))).toEqual({
      piAgentTranscriptVisibility: { showThinking: false },
    });
    expect(useAppStore.getState().transcriptVisibility.showThinking).toBe(false);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog", { name: "Transcript display" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("rolls back a failed write, announces the error, and re-enables switches", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 500 }));
    render(<TranscriptDisplayMenu />);

    fireEvent.click(screen.getByRole("button", { name: "Transcript display" }));
    const images = screen.getByRole("switch", { name: "Images" });
    fireEvent.click(images);

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Settings update failed (500)"),
    );
    expect(images.getAttribute("aria-checked")).toBe("true");
    expect((images as HTMLButtonElement).disabled).toBe(false);
    expect(useAppStore.getState().transcriptVisibility.showImages).toBe(true);
  });

  it("prevents Retry from racing a write and clears a stale load error after success", async () => {
    const update = deferred<Response>();
    fetchMock.mockReturnValueOnce(update.promise);
    useAppStore.setState({
      transcriptVisibilityLoadError: "Transcript preferences could not be loaded.",
    });
    render(<TranscriptDisplayMenu />);

    fireEvent.click(screen.getByRole("button", { name: "Transcript display" }));
    const retry = screen.getByRole("button", { name: "Retry" });
    fireEvent.click(screen.getByRole("switch", { name: "Thinking" }));

    expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(retry);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    update.resolve(settingsResponse({ showThinking: false }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(useAppStore.getState().transcriptVisibility.showThinking).toBe(false);
  });
});
