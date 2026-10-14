// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProvidersScreen } from "./ProvidersScreen.tsx";
import { useAppStore } from "../state/store.ts";

interface Provider {
  id: string;
  name: string;
  configured: boolean;
  signedIn: boolean;
  supportsAPIKey: boolean;
  supportsOAuth: boolean;
}

const connected: Provider = {
  id: "provider-a",
  name: "Provider A",
  configured: true,
  signedIn: true,
  supportsAPIKey: false,
  supportsOAuth: true,
};

const disconnected: Provider = {
  ...connected,
  configured: false,
  signedIn: false,
};

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe(): void {}
      unobserve(): void {}
      disconnect(): void {}
    },
  );
  useAppStore.setState({ resourcesVersion: 0, error: null });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  useAppStore.setState({ me: null });
});

describe("SRV-11 shared server", () => {
  it("keeps Connect and Sign out enabled and says the sign-ins are per user", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ providers: [connected] }));
    useAppStore.setState({ me: { id: "ale@example.com", email: "ale@example.com" } });
    render(<ProvidersScreen />);
    const signOut = await screen.findByRole("button", { name: "Sign out of Provider A" });
    expect(signOut).toHaveProperty("disabled", false);
    const connect = document.querySelector<HTMLButtonElement>('[data-provider-id="provider-a"]');
    expect(connect?.disabled).toBe(false);
    expect(screen.getByTestId("providers-shared-notice").textContent).toBe(
      "These sign-ins are yours only and apply to the sessions you create on this server.",
    );
  });

  it("keeps the controls enabled without a signed-in user", async () => {
    vi.mocked(fetch).mockResolvedValue(jsonResponse({ providers: [connected] }));
    useAppStore.setState({ me: null });
    render(<ProvidersScreen />);
    const signOut = await screen.findByRole("button", { name: "Sign out of Provider A" });
    expect(signOut).toHaveProperty("disabled", false);
    const connect = document.querySelector<HTMLButtonElement>('[data-provider-id="provider-a"]');
    expect(connect?.disabled).toBe(false);
    expect(screen.queryByTestId("providers-shared-notice")).toBeNull();
  });
});

describe("provider catalog refresh ordering", () => {
  it("does not let a pre-logout response restore a removed credential", async () => {
    let resolveStale!: (response: Response) => void;
    const staleResponse = new Promise<Response>((resolve) => {
      resolveStale = resolve;
    });
    let getCount = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      expect(String(input)).toMatch(/^\/runtime\/providers/);
      if (init?.method === "POST") return Promise.resolve(jsonResponse({ ok: true }));
      getCount += 1;
      if (getCount === 1) return Promise.resolve(jsonResponse({ providers: [connected] }));
      if (getCount === 2) return staleResponse;
      return Promise.resolve(jsonResponse({ providers: [disconnected] }));
    });

    render(<ProvidersScreen />);
    const signOut = await screen.findByRole("button", { name: "Sign out of Provider A" });

    act(() => useAppStore.getState().bumpResourcesVersion());
    await waitFor(() => expect(getCount).toBe(2));
    fireEvent.click(signOut);

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Sign out of Provider A" })).toBeNull(),
    );
    await act(async () => {
      resolveStale(jsonResponse({ providers: [connected] }));
      await staleResponse;
    });

    expect(screen.queryByRole("button", { name: "Sign out of Provider A" })).toBeNull();
  });
});

describe("PRV-01 Anthropic is API key only", () => {
  it("offers only the API key and says an old sign-in is not used", async () => {
    // The server sends supportsOAuth false for anthropic even with a stored sign-in.
    const anthropic = {
      id: "anthropic",
      name: "Anthropic",
      configured: true,
      signedIn: true,
      supportsAPIKey: true,
      supportsOAuth: false,
      credentialType: "oauth",
    };
    vi.mocked(fetch).mockImplementation(async (input) =>
      String(input) === "/runtime/providers"
        ? jsonResponse({ providers: [anthropic] })
        : jsonResponse({ loginId: "l1", events: [], status: "running" }),
    );
    render(<ProvidersScreen />);
    expect((await screen.findByTestId("provider-oauth-unused-anthropic")).textContent).toContain(
      "Your Anthropic sign-in is not used",
    );
    expect(screen.queryByText("Subscriptions")).toBeNull();
    expect(screen.getByText("API key")).toBeTruthy();
    fireEvent.click(document.querySelector<HTMLButtonElement>('[data-provider-id="anthropic"]')!);
    expect(screen.queryByText("Use a subscription")).toBeNull();
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith(
        "/runtime/providers/anthropic/login",
        expect.objectContaining({ body: JSON.stringify({ authType: "api_key" }) }),
      ),
    );
  });

  it("shows no note for an API key credential", async () => {
    vi.mocked(fetch).mockResolvedValue(
      jsonResponse({
        providers: [
          {
            id: "anthropic",
            name: "Anthropic",
            configured: true,
            signedIn: true,
            supportsAPIKey: true,
            supportsOAuth: false,
            credentialType: "api_key",
          },
        ],
      }),
    );
    render(<ProvidersScreen />);
    await screen.findByText("Anthropic");
    expect(screen.queryByTestId("provider-oauth-unused-anthropic")).toBeNull();
  });
});
