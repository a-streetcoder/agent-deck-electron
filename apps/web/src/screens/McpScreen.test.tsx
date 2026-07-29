// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { McpScreen } from "./McpScreen.tsx";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
  useAppStore.setState({ resourcesVersion: 0, error: null, toasts: [] });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MCP configuration reload", () => {
  it("explicitly reloads disk configuration and replaces the visible catalog", async () => {
    let reloaded = false;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/mcp/reload" && init?.method === "POST") {
        reloaded = true;
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (String(input) === "/mcp") {
        return Promise.resolve(
          jsonResponse({
            servers: [
              {
                id: reloaded ? "after-edit" : "before-edit",
                transport: "stdio",
                connected: false,
                toolNames: [],
              },
            ],
          }),
        );
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });

    render(<McpScreen />);
    expect(await screen.findByTestId("mcp-before-edit")).toBeTruthy();
    fireEvent.click(screen.getByTestId("mcp-reload"));

    await waitFor(() => expect(screen.queryByTestId("mcp-before-edit")).toBeNull());
    expect(screen.getByTestId("mcp-after-edit")).toBeTruthy();
  });

  it("shows an actionable malformed-config error and clears it after a repaired reload", async () => {
    let attempts = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/mcp/reload" && init?.method === "POST") {
        attempts += 1;
        return Promise.resolve(
          attempts === 1
            ? jsonResponse(
                {
                  error: "MCP configuration is not valid JSON; current connections were preserved.",
                },
                422,
              )
            : jsonResponse({ ok: true }),
        );
      }
      if (String(input) === "/mcp") {
        return Promise.resolve(jsonResponse({ servers: [] }));
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });

    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");

    fireEvent.click(screen.getByTestId("mcp-reload"));
    await waitFor(() =>
      expect(useAppStore.getState().error).toBe(
        "MCP configuration is not valid JSON; current connections were preserved.",
      ),
    );

    fireEvent.click(screen.getByTestId("mcp-reload"));
    await waitFor(() => expect(useAppStore.getState().error).toBeNull());
  });

  it("does not report reload success when the refreshed catalog cannot be loaded", async () => {
    let catalogLoads = 0;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/mcp/reload" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (String(input) === "/mcp") {
        catalogLoads += 1;
        return Promise.resolve(
          catalogLoads === 1
            ? jsonResponse({ servers: [] })
            : new Response("catalog unavailable", { status: 503 }),
        );
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });

    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");
    fireEvent.click(screen.getByTestId("mcp-reload"));

    await waitFor(() => expect(useAppStore.getState().error).toContain("catalog unavailable"));
    expect(useAppStore.getState().toasts).toEqual([]);
  });

  it("waits for a broadcast-superseding catalog load before reporting success", async () => {
    let catalogLoads = 0;
    let resolveExplicit!: (response: Response) => void;
    vi.mocked(fetch).mockImplementation((input, init) => {
      if (String(input) === "/mcp/reload" && init?.method === "POST") {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      if (String(input) === "/mcp") {
        catalogLoads += 1;
        if (catalogLoads === 2) {
          return new Promise<Response>((resolve) => {
            resolveExplicit = resolve;
          });
        }
        return Promise.resolve(jsonResponse({ servers: [] }));
      }
      throw new Error(`unexpected request: ${String(input)}`);
    });

    render(<McpScreen />);
    await screen.findByTestId("mcp-empty");
    fireEvent.click(screen.getByTestId("mcp-reload"));
    await waitFor(() => expect(catalogLoads).toBe(2));

    // Simulate the resources_changed broadcast launching a newer catalog load
    // while the button's explicit load is still pending.
    useAppStore.setState({ resourcesVersion: 1 });
    await waitFor(() => expect(catalogLoads).toBe(3));
    expect(useAppStore.getState().toasts).toEqual([]);
    resolveExplicit(jsonResponse({ servers: [] }));

    await waitFor(() =>
      expect(useAppStore.getState().toasts.at(-1)?.message).toBe("Reloaded MCP configuration"),
    );
  });
});
