// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudflaredProgress,
  CloudflaredStatus,
  TeamServerBridge,
  TeamServerState,
} from "@/lib/native";
import { cloudflaredFoundText, TeamServerScreen, teamServerStatus } from "./TeamServerScreen.tsx";

const empty: TeamServerState = {
  serverUrl: null,
  overridden: false,
  origin: null,
  restartRequired: false,
};

function mountBridge(state: TeamServerState, set = vi.fn()) {
  window.agentDeck = { isElectron: true, teamServer: { get: async () => state, set } };
  render(<TeamServerScreen />);
  return set;
}

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
  delete window.agentDeck;
});

describe("TeamServerScreen", () => {
  it("names the three states", () => {
    expect(teamServerStatus(empty)).toBe("Not configured");
    expect(
      teamServerStatus({ ...empty, serverUrl: "https://a.example", origin: "https://a.example" }),
    ).toBe("Configured, sign-in pending");
    expect(teamServerStatus({ ...empty, overridden: true, origin: "https://env.example" })).toBe(
      "Set by AGENT_DECK_SHARED_SERVER_URL (dev override)",
    );
  });

  it("saves the URL and shows the new status and the restart note", async () => {
    const set = mountBridge(
      empty,
      vi.fn(async () => ({
        ok: true,
        serverUrl: "https://deck.example.com",
        overridden: false,
        origin: "https://deck.example.com",
        restartRequired: true,
      })),
    );
    expect((await screen.findByTestId("team-server-status")).textContent).toBe("Not configured");

    fireEvent.change(screen.getByLabelText(/Server address/), {
      target: { value: " https://deck.example.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Configured, sign-in pending")).toBeTruthy();
    expect(set).toHaveBeenCalledWith({ serverUrl: "https://deck.example.com" });
    expect(screen.getByText(/Restart Agent Deck/)).toBeTruthy();
  });

  it("shows main's validation message and keeps the draft", async () => {
    mountBridge(
      empty,
      vi.fn(async () => ({
        ok: false,
        error: "The team server address must start with https://.",
      })),
    );
    const field = (await screen.findByLabelText(/Server address/)) as HTMLInputElement;
    fireEvent.change(field, { target: { value: "http://deck.example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect((await screen.findByRole("alert")).textContent).toContain("must start with https://");
    expect(field.value).toBe("http://deck.example.com");
    expect(screen.getByTestId("team-server-status").textContent).toBe("Not configured");
  });

  it("clears the setting with an empty field", async () => {
    const stored = { ...empty, serverUrl: "https://a.example", origin: "https://a.example" };
    const set = mountBridge(
      stored,
      vi.fn(async () => ({ ok: true, ...empty })),
    );
    fireEvent.change(await screen.findByLabelText(/Server address/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Not configured")).toBeTruthy();
    expect(set).toHaveBeenCalledWith({ serverUrl: null });
  });

  it("shows the dev override", async () => {
    mountBridge({ ...empty, overridden: true, origin: "https://env.example" });
    expect((await screen.findByTestId("team-server-status")).textContent).toBe(
      "Set by AGENT_DECK_SHARED_SERVER_URL (dev override)",
    );
  });

  it("explains that the setting needs the desktop app", () => {
    render(<TeamServerScreen />);
    expect(screen.getByText(/available in the desktop app/)).toBeTruthy();
  });
});

describe("TeamServerScreen cloudflared section", () => {
  const found: CloudflaredStatus = {
    path: "C:\\Tools\\cloudflared.exe",
    source: "path",
    version: "2026.10.0",
    warning: null,
  };

  function mountCloudflared(extra: Partial<TeamServerBridge>) {
    window.agentDeck = {
      isElectron: true,
      teamServer: { get: async () => empty, set: vi.fn(), ...extra },
    };
    render(<TeamServerScreen />);
  }

  it("shows where cloudflared was found", async () => {
    mountCloudflared({
      cloudflared: async () => found,
      cloudflaredInfo: async () => ({ downloadVersion: "2026.10.0", warning: null }),
    });
    expect((await screen.findByTestId("cloudflared-found")).textContent).toBe(
      "Found at C:\\Tools\\cloudflared.exe (PATH, 2026.10.0)",
    );
    expect(screen.queryByRole("button", { name: /Download cloudflared/ })).toBeNull();
    expect(cloudflaredFoundText({ ...found, source: "setting", version: null })).toBe(
      "Found at C:\\Tools\\cloudflared.exe (downloaded or set in Settings)",
    );
  });

  it("downloads when missing, shows progress, then the found path", async () => {
    let report: ((progress: CloudflaredProgress) => void) | undefined;
    let finish: (() => void) | undefined;
    const cloudflared = vi.fn(async (): Promise<CloudflaredStatus | null> => null);
    mountCloudflared({
      cloudflared,
      cloudflaredInfo: async () => ({ downloadVersion: "2026.10.0", warning: null }),
      onCloudflaredProgress: (handler) => {
        report = handler;
        return () => (report = undefined);
      },
      downloadCloudflared: () =>
        new Promise((resolve) => {
          finish = () => resolve({ ok: true, path: found.path, version: "2026.10.0" });
        }),
    });
    fireEvent.click(
      await screen.findByRole("button", { name: "Download cloudflared (2026.10.0)" }),
    );
    act(() => report?.({ received: 1_048_576, total: 4_194_304 }));
    expect(screen.getByText("Downloading… 25% (1.0 of 4.0 MB)")).toBeTruthy();

    cloudflared.mockResolvedValue({ ...found, source: "setting" });
    await act(async () => finish?.());
    expect((await screen.findByTestId("cloudflared-found")).textContent).toContain(
      "downloaded or set in Settings",
    );
    expect(report).toBeUndefined();
  });

  it("shows a failed download and keeps the button", async () => {
    mountCloudflared({
      cloudflared: async () => null,
      cloudflaredInfo: async () => ({ downloadVersion: "2026.10.0", warning: null }),
      downloadCloudflared: async () => ({
        ok: false,
        error: "The downloaded cloudflared failed its checksum check and was deleted.",
      }),
    });
    fireEvent.click(await screen.findByRole("button", { name: /Download cloudflared/ }));
    expect((await screen.findByRole("alert")).textContent).toContain("checksum check");
    expect(screen.getByRole("button", { name: /Download cloudflared/ })).toBeTruthy();
  });

  it("explains when no download exists for this computer", async () => {
    mountCloudflared({
      cloudflared: async () => null,
      cloudflaredInfo: async () => ({ downloadVersion: null, warning: null }),
    });
    expect(await screen.findByText(/No download is available/)).toBeTruthy();
  });

  it("warns when the dev override points at a missing file", async () => {
    mountCloudflared({
      cloudflared: async () => ({
        ...found,
        warning: "AGENT_DECK_CLOUDFLARED points at a missing file",
      }),
      cloudflaredInfo: async () => ({
        downloadVersion: "2026.10.0",
        warning: "AGENT_DECK_CLOUDFLARED points at a missing file",
      }),
    });
    expect((await screen.findByRole("alert")).textContent).toBe(
      "AGENT_DECK_CLOUDFLARED points at a missing file",
    );
    expect(screen.getByTestId("cloudflared-found")).toBeTruthy();
  });
});
