// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { ExtensionsScreen } from "./ExtensionsScreen.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function extension(name: string) {
  return {
    path: `/tmp/${name}`,
    name,
    exists: true,
    disabled: false,
    scope: "global",
    source: "discovered",
    bridgeConflict: null,
  };
}

function installFetch(
  loadExtensions: () => Promise<Response> | Response,
): ReturnType<typeof vi.fn> {
  const mock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.startsWith("/resources/extensions")) return Promise.resolve(loadExtensions());
    if (url === "/settings") {
      return Promise.resolve(
        jsonResponse({ settings: { extensionLoadingMode: "useMyExtensions" } }),
      );
    }
    if (url === "/runtime/bridges") return Promise.resolve(jsonResponse({ bridges: [] }));
    throw new Error(`unexpected request: ${url}`);
  });
  vi.stubGlobal("fetch", mock);
  return mock;
}

beforeEach(() => {
  useAppStore.setState({ resourcesVersion: 0, error: null, toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("extension catalog refresh", () => {
  it("refreshes external catalog changes in place and reports success", async () => {
    let refreshed = false;
    installFetch(() =>
      jsonResponse({
        extensions: [extension(refreshed ? "after-edit.ts" : "before-edit.ts")],
      }),
    );

    render(<ExtensionsScreen />);
    expect(await screen.findByText("before-edit.ts")).toBeTruthy();
    refreshed = true;
    fireEvent.click(screen.getByTestId("extension-refresh"));

    expect(await screen.findByText("after-edit.ts")).toBeTruthy();
    expect(screen.queryByText("before-edit.ts")).toBeNull();
    expect(useAppStore.getState().toasts.at(-1)?.message).toBe("Refreshed extensions");
  });

  it("disables the button while loading and preserves the current list on failure", async () => {
    let loads = 0;
    let rejectRefresh!: (error: Error) => void;
    installFetch(() => {
      loads += 1;
      if (loads === 1) return jsonResponse({ extensions: [extension("retained.ts")] });
      return new Promise<Response>((_resolve, reject) => {
        rejectRefresh = reject;
      });
    });

    render(<ExtensionsScreen />);
    expect(await screen.findByText("retained.ts")).toBeTruthy();
    fireEvent.click(screen.getByTestId("extension-refresh"));
    await waitFor(() =>
      expect(screen.getByTestId("extension-refresh").hasAttribute("disabled")).toBe(true),
    );

    rejectRefresh(new Error("catalog unavailable"));
    await waitFor(() => expect(useAppStore.getState().error).toContain("catalog unavailable"));
    expect(screen.getByText("retained.ts")).toBeTruthy();
    expect(screen.getByTestId("extension-refresh").hasAttribute("disabled")).toBe(false);
    expect(useAppStore.getState().toasts).toEqual([]);
  });

  it("ignores a stale earlier response that resolves after explicit refresh", async () => {
    let resolveInitial!: (response: Response) => void;
    let loads = 0;
    installFetch(() => {
      loads += 1;
      if (loads === 1) {
        return new Promise<Response>((resolve) => {
          resolveInitial = resolve;
        });
      }
      return jsonResponse({ extensions: [extension("fresh.ts")] });
    });

    render(<ExtensionsScreen />);
    fireEvent.click(screen.getByTestId("extension-refresh"));
    expect(await screen.findByText("fresh.ts")).toBeTruthy();
    resolveInitial(jsonResponse({ extensions: [extension("stale.ts")] }));

    await waitFor(() => expect(screen.queryByText("stale.ts")).toBeNull());
    expect(screen.getByText("fresh.ts")).toBeTruthy();
  });

  it("waits for a superseding resource load before reporting refresh success", async () => {
    let loads = 0;
    let resolveRefresh!: (response: Response) => void;
    installFetch(() => {
      loads += 1;
      if (loads === 2) {
        return new Promise<Response>((resolve) => {
          resolveRefresh = resolve;
        });
      }
      return jsonResponse({ extensions: [] });
    });

    render(<ExtensionsScreen />);
    await screen.findByText(/No extensions added/);
    fireEvent.click(screen.getByTestId("extension-refresh"));
    await waitFor(() => expect(loads).toBe(2));

    useAppStore.setState({ resourcesVersion: 1 });
    await waitFor(() => expect(loads).toBe(3));
    expect(useAppStore.getState().toasts).toEqual([]);
    resolveRefresh(jsonResponse({ extensions: [] }));

    await waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)?.message).toBe("Refreshed extensions"),
    );
  });
});
