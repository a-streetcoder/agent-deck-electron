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
