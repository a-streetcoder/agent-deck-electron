// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TeamServerState } from "@/lib/native";
import { TeamServerScreen, teamServerStatus } from "./TeamServerScreen.tsx";

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
