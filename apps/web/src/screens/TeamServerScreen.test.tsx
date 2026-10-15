// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CloudflaredProgress,
  CloudflaredStatus,
  TeamServerBridge,
  TeamServerState,
  TeamServerStatus,
} from "@/lib/native";
import { endOriginChange, ORIGIN_CHANGING_ERROR, trackTransfer } from "@/lib/sharedTransfers";
import { TeamServerIndicator } from "../components/TeamServerIndicator.tsx";
import {
  CLOUDFLARED_MISSING,
  cloudflaredFoundText,
  TeamServerScreen,
  TRANSFER_RUNNING_ERROR,
  teamServerStatus,
} from "./TeamServerScreen.tsx";

const empty: TeamServerState = {
  serverUrl: null,
  overridden: false,
  origin: null,
  restartRequired: false,
};
const configured: TeamServerState = {
  ...empty,
  serverUrl: "https://deck.example.com",
  origin: "https://deck.example.com",
};
const signedIn: TeamServerStatus = {
  state: "signedIn",
  user: { name: "Ann", email: "ann@x.test" },
  team: "acme.cloudflareaccess.com",
};

/** A bridge whose pushed status the test drives through `push`. */
function fakeBridge(
  state: TeamServerState,
  status: TeamServerStatus = { state: "off" },
  overrides: Partial<TeamServerBridge> = {},
) {
  let handler: ((next: TeamServerStatus) => void) | null = null;
  const bridge: TeamServerBridge = {
    get: async () => state,
    set: vi.fn(),
    status: async () => status,
    onStatus: (next) => {
      handler = next;
      return () => {
        handler = null;
      };
    },
    signIn: vi.fn(async () => ({ ok: true })),
    signOut: vi.fn(async () => ({ ok: true })),
    acceptTeam: vi.fn(async () => ({ ok: true })),
    cancelSignIn: vi.fn(async () => ({ ok: true })),
    forgetToken: vi.fn(async () => ({ ok: true, removed: 1 })),
    check: vi.fn(async () => ({ ok: true })),
    cloudflared: async () => ({ path: "C:/cf.exe", source: "path", version: null, warning: null }),
    ...overrides,
  };
  window.agentDeck = { isElectron: true, teamServer: bridge };
  const push = (next: TeamServerStatus) => act(() => handler?.(next));
  return { bridge, push };
}

function mountBridge(state: TeamServerState, set = vi.fn()) {
  fakeBridge(state, { state: state.origin ? "needsSignIn" : "off" }, { set });
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
  // The Save barrier is module state that only a window reload would clear.
  endOriginChange();
  cleanup();
  vi.unstubAllGlobals();
  delete window.agentDeck;
});

describe("TeamServerScreen", () => {
  it("names the states", () => {
    expect(teamServerStatus(empty, null)).toBe("Not configured");
    expect(teamServerStatus(configured, null)).toBe("Checking the sign-in…");
    expect(teamServerStatus(configured, { state: "needsSignIn", checking: true })).toBe(
      "Checking the sign-in…",
    );
    expect(teamServerStatus(configured, signedIn)).toBe(
      "Signed in as Ann (acme.cloudflareaccess.com)",
    );
    expect(teamServerStatus(configured, { state: "needsSignIn" })).toBe("Not signed in");
    expect(teamServerStatus(configured, { state: "signingIn" })).toMatch(/browser/);
    expect(
      teamServerStatus(configured, {
        state: "unreachable",
        error: "The shared server could not be reached.",
      }),
    ).toBe("Unreachable: The shared server could not be reached.");
    expect(
      teamServerStatus(configured, {
        state: "forbidden",
        error: "Your account is not allowed on x.",
      }),
    ).toBe("Your account is not allowed on x.");
  });

  it("saves the URL and shows the reload note", async () => {
    const set = mountBridge(
      empty,
      vi.fn(async () => ({ ok: true, ...configured, restartRequired: true })),
    );
    expect((await screen.findByTestId("team-server-status")).textContent).toBe("Not configured");

    fireEvent.change(screen.getByLabelText(/Server address/), {
      target: { value: " https://deck.example.com " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText(/Agent Deck reloads/)).toBeTruthy();
    expect(set).toHaveBeenCalledWith({ serverUrl: "https://deck.example.com" });
  });

  it("refuses Save while a session move is running", async () => {
    const set = mountBridge(empty);
    fireEvent.change(await screen.findByLabelText(/Server address/), {
      target: { value: "https://deck.example.com" },
    });
    let finish = () => {};
    const move = trackTransfer(() => new Promise<void>((resolve) => (finish = resolve)));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe(TRANSFER_RUNNING_ERROR);
    expect(set).not.toHaveBeenCalled();
    finish();
    await move;
  });

  it("refuses a move from Save until the reload, and lifts the barrier when none follows", async () => {
    let answer: (value: { ok: true } & TeamServerState) => void = () => {};
    const set = mountBridge(
      empty,
      vi.fn(() => new Promise<{ ok: true } & TeamServerState>((resolve) => (answer = resolve))),
    );
    fireEvent.change(await screen.findByLabelText(/Server address/), {
      target: { value: "https://deck.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(set).toHaveBeenCalled();
    const move = vi.fn(async () => undefined);
    await expect(trackTransfer(move)).rejects.toThrow(ORIGIN_CHANGING_ERROR);
    // A reloading Save keeps the barrier: the reload replaces the page.
    await act(async () => answer({ ok: true, ...configured, restartRequired: true }));
    await expect(trackTransfer(move)).rejects.toThrow(ORIGIN_CHANGING_ERROR);
    expect(move).not.toHaveBeenCalled();

    // A Save that does not reload (same origin in effect) lifts it.
    endOriginChange();
    cleanup();
    mountBridge(
      empty,
      vi.fn(async () => ({ ok: true, ...configured, overridden: true, restartRequired: false })),
    );
    fireEvent.change(await screen.findByLabelText(/Server address/), {
      target: { value: "https://deck.example.com" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await screen.findByTestId("team-server-override");
    await trackTransfer(move);
    expect(move).toHaveBeenCalledTimes(1);
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
  });

  it("clears the setting with an empty field", async () => {
    const set = mountBridge(
      configured,
      vi.fn(async () => ({ ok: true, ...empty })),
    );
    fireEvent.change(await screen.findByLabelText(/Server address/), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    expect(await screen.findByText("Not configured")).toBeTruthy();
    expect(set).toHaveBeenCalledWith({ serverUrl: null });
  });

  it("signs in, follows the pushed status and signs out", async () => {
    const { bridge, push } = fakeBridge(configured, { state: "needsSignIn" });
    render(<TeamServerScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect(bridge.signIn).toHaveBeenCalled();
    push({ state: "signingIn" });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(bridge.cancelSignIn).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    push(signedIn);
    expect(screen.getByTestId("team-server-status").textContent).toBe(
      "Signed in as Ann (acme.cloudflareaccess.com)",
    );
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(bridge.signOut).toHaveBeenCalled();
  });

  it("keeps Sign in disabled while the cloudflared lookup is pending, then enables it", async () => {
    let resolveLookup: (found: CloudflaredStatus | null) => void = () => {};
    fakeBridge(
      configured,
      { state: "needsSignIn" },
      { cloudflared: () => new Promise((resolve) => (resolveLookup = resolve)) },
    );
    render(<TeamServerScreen />);
    const signIn = (await screen.findByRole("button", { name: "Sign in" })) as HTMLButtonElement;
    expect(signIn.disabled).toBe(true);
    expect(screen.getByText(CLOUDFLARED_MISSING)).toBeTruthy();
    await act(async () =>
      resolveLookup({ path: "C:/cf.exe", source: "path", version: null, warning: null }),
    );
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
    expect(screen.queryByText(CLOUDFLARED_MISSING)).toBeNull();
  });

  it("keeps Sign in disabled when the lookup fails or finds nothing, until a download lands", async () => {
    fakeBridge(
      configured,
      { state: "needsSignIn" },
      { cloudflared: () => Promise.reject(new Error("probe failed")) },
    );
    render(<TeamServerScreen />);
    expect(await screen.findByText("probe failed")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    cleanup();

    const cloudflared = vi.fn(async (): Promise<CloudflaredStatus | null> => null);
    fakeBridge(
      configured,
      { state: "needsSignIn" },
      {
        cloudflared,
        cloudflaredInfo: async () => ({ downloadVersion: "2026.10.0", warning: null }),
        downloadCloudflared: async () => ({ ok: true, path: "C:/cf.exe", version: "2026.10.0" }),
      },
    );
    render(<TeamServerScreen />);
    fireEvent.click(await screen.findByRole("button", { name: /Download cloudflared/ }));
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    cloudflared.mockResolvedValue({
      path: "C:/cf.exe",
      source: "setting",
      version: null,
      warning: null,
    });
    await screen.findByTestId("cloudflared-found");
    expect((screen.getByRole("button", { name: "Sign in" }) as HTMLButtonElement).disabled).toBe(
      false,
    );
  });

  it("re-checks the status on mount and offers Remove cached token when signed in or refused", async () => {
    const { bridge, push } = fakeBridge(configured, signedIn);
    render(<TeamServerScreen />);
    expect(bridge.check).toHaveBeenCalledTimes(1);
    fireEvent.click(await screen.findByRole("button", { name: "Remove cached token" }));
    expect(bridge.forgetToken).toHaveBeenCalled();
    await act(async () => {});
    push({ state: "forbidden", error: "Your account is not allowed on x." });
    expect(screen.getByRole("button", { name: "Remove cached token" })).toBeTruthy();
    push({ state: "needsSignIn" });
    expect(screen.queryByRole("button", { name: "Remove cached token" })).toBeNull();
  });

  it("shows a failed sign-in's text", async () => {
    fakeBridge(
      configured,
      { state: "needsSignIn" },
      {
        signIn: async () => ({ ok: false, error: "Sign-in cancelled." }),
      },
    );
    render(<TeamServerScreen />);
    fireEvent.click(await screen.findByRole("button", { name: "Sign in" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Sign-in cancelled.");
  });

  it("asks to confirm a sign-in from an unexpected Access team", async () => {
    const { bridge } = fakeBridge(configured, {
      state: "needsSignIn",
      team: "evil.cloudflareaccess.com",
      warning: "This server signed you in through the Access team evil.cloudflareaccess.com.",
    });
    render(<TeamServerScreen />);
    expect(await screen.findByText(/through the Access team evil/)).toBeTruthy();
    expect(screen.getByTestId("team-server-status").textContent).toBe(
      "Sign-in waiting for confirmation (evil.cloudflareaccess.com)",
    );
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(bridge.acceptTeam).toHaveBeenCalled();
  });

  it("shows the dev override", async () => {
    mountBridge({ ...configured, overridden: true });
    expect((await screen.findByTestId("team-server-override")).textContent).toBe(
      "Set by AGENT_DECK_SHARED_SERVER_URL (dev override)",
    );
  });

  it("explains that the setting needs the desktop app", () => {
    render(<TeamServerScreen />);
    expect(screen.getByText(/available in the desktop app/)).toBeTruthy();
  });
});

describe("TeamServerIndicator", () => {
  it("shows the state with a configured server only", async () => {
    const { push } = fakeBridge(configured, signedIn);
    render(<TeamServerIndicator />);
    expect((await screen.findByTestId("team-server-indicator")).textContent).toBe(
      "Team server: signed in",
    );
    push({ state: "unreachable", error: "The shared server could not be reached." });
    expect(screen.getByTestId("team-server-indicator").textContent).toBe(
      "Team server: unreachable",
    );
    push({ state: "off" });
    expect(screen.queryByTestId("team-server-indicator")).toBeNull();
  });

  it("renders nothing outside the desktop app", () => {
    render(<TeamServerIndicator />);
    expect(screen.queryByTestId("team-server-indicator")).toBeNull();
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
