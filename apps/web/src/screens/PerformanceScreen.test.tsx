// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PerformanceScreen } from "./PerformanceScreen.tsx";

beforeEach(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const defaults = {
  piAgentIdleParkingEnabled: true,
  piAgentIdleParkingTimeoutMinutes: 10,
  analyticsEnabled: true,
};

describe("PerformanceScreen", () => {
  it("shows an explicit load error and retries into the ready state", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ settings: defaults }) });
    vi.stubGlobal("fetch", fetchMock);
    render(<PerformanceScreen />);

    expect((await screen.findByTestId("performance-error")).textContent).toContain("couldn’t load");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByTestId("performance-ready")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("persists the toggle with busy and saved status", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ settings: defaults }) })
      .mockImplementationOnce(async () => {
        await pending;
        return {
          ok: true,
          json: async () => ({ settings: { ...defaults, piAgentIdleParkingEnabled: false } }),
        };
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<PerformanceScreen />);

    const toggle = await screen.findByRole("switch", { name: "Pause idle chats" });
    fireEvent.click(toggle);
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("performance-save-status").textContent).toContain("Saving");
    release();
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByTestId("performance-save-status").textContent).toContain("Saved");
  });

  it("persists the Privacy analytics switch through PATCH /settings", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ settings: defaults, capabilities: { analytics: true } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ settings: { ...defaults, analyticsEnabled: false } }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<PerformanceScreen />);

    const toggle = await screen.findByRole("switch", { name: "Send anonymous usage counts" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(fetchMock.mock.calls[1]?.[1]?.method).toBe("PATCH");
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      analyticsEnabled: false,
    });
  });

  it("hides the Privacy switch when this backend cannot send usage counts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ settings: defaults, capabilities: { analytics: false } }),
      }),
    );
    render(<PerformanceScreen />);
    await screen.findByTestId("performance-ready");
    expect(screen.queryByTestId("analytics-toggle")).toBeNull();
  });

  it("validates minutes locally and commits once on Enter", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ settings: defaults }) })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          settings: { ...defaults, piAgentIdleParkingTimeoutMinutes: 37 },
        }),
      });
    vi.stubGlobal("fetch", fetchMock);
    render(<PerformanceScreen />);
    const input = await screen.findByTestId("idle-parking-minutes");

    fireEvent.change(input, { target: { value: "121" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("alert").textContent).toContain("1 to 120");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.change(input, { target: { value: "37" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toEqual({
      piAgentIdleParkingTimeoutMinutes: 37,
    });
  });
});
