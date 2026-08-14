// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { MemoryScreen } from "./MemoryScreen.tsx";

beforeEach(() => {
  useAppStore.setState({ currentProjectId: null, error: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const settingsResponse = (semanticMemoryEnabled: boolean) => ({
  ok: true,
  json: async () => ({ settings: { semanticMemoryEnabled } }),
});

describe("MemoryScreen semantic preference", () => {
  it("loads the global mode and describes availability without claiming readiness", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(settingsResponse(false)));
    render(<MemoryScreen />);

    const toggle = await screen.findByRole("switch", { name: "Semantic ranking" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("semantic-memory-mode").textContent).toBe("Not requested");
    expect(screen.getByText(/when it is available/i)).toBeTruthy();
    expect(screen.queryByText(/fallback|unavailable|ready/i)).toBeNull();
  });

  it("toggles optimistically, stays busy, and accepts the authoritative response", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(settingsResponse(false))
      .mockImplementationOnce(async () => {
        await pending;
        return settingsResponse(true);
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    const toggle = await screen.findByRole("switch", { name: "Semantic ranking" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("semantic-memory-save-status").textContent).toContain("Saving");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      semanticMemoryEnabled: true,
    });

    release();
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId("semantic-memory-mode").textContent).toBe("Requested");
    expect(screen.getByTestId("semantic-memory-save-status").textContent).toContain("Saved");
  });

  it("rolls back the visible mode and reports a save error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(settingsResponse(false))
      .mockResolvedValueOnce({ ok: false });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    const toggle = await screen.findByRole("switch", { name: "Semantic ranking" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByTestId("semantic-memory-mode").textContent).toBe("Not requested");
    expect(screen.getByRole("alert").textContent).toContain("couldn’t save");
  });

  it("shows a load error and retries without allowing the failed response to set a mode", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce(settingsResponse(true));
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    expect((await screen.findByTestId("semantic-memory-load-error")).textContent).toContain(
      "couldn’t load",
    );
    expect(screen.queryByRole("switch", { name: "Semantic ranking" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(
      (await screen.findByRole("switch", { name: "Semantic ranking" })).getAttribute(
        "aria-checked",
      ),
    ).toBe("true");
  });

  it("admits only one toggle mutation while a save is in flight", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(settingsResponse(false))
      .mockImplementationOnce(async () => {
        await pending;
        return settingsResponse(true);
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    const toggle = await screen.findByRole("switch", { name: "Semantic ranking" });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    release();
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});
