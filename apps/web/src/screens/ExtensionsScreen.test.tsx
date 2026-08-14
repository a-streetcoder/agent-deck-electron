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
    if (url === "/resources/commands") return Promise.resolve(jsonResponse({ commands: [] }));
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

describe("injected command catalog", () => {
  it("shows loading and reports a command-catalog error without inventing rows", async () => {
    let rejectCommands!: (error: Error) => void;
    const mock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/resources/commands") {
        return new Promise<Response>((_resolve, reject) => {
          rejectCommands = reject;
        });
      }
      if (url.startsWith("/resources/extensions"))
        return Promise.resolve(jsonResponse({ extensions: [] }));
      if (url === "/settings")
        return Promise.resolve(
          jsonResponse({ settings: { extensionLoadingMode: "useMyExtensions" } }),
        );
      if (url === "/runtime/bridges") return Promise.resolve(jsonResponse({ bridges: [] }));
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", mock);

    render(<ExtensionsScreen />);
    expect(screen.getByRole("status").textContent).toContain("Loading commands");
    rejectCommands(new Error("command catalog unavailable"));
    await waitFor(() =>
      expect(useAppStore.getState().error).toContain("command catalog unavailable"),
    );
    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain("Commands are unavailable");
    expect(screen.queryByText("No imported commands.")).toBeNull();
  });

  it("ignores an older resourcesVersion response and aborts its catalog request", async () => {
    let resolveInitial!: (response: Response) => void;
    let commandLoads = 0;
    const signals: AbortSignal[] = [];
    const fresh = {
      id: "built-in:create-agent-deck-command",
      slashName: "/create-agent-deck-command",
      title: "Create command",
      description: "Fresh",
      source: "built-in",
      status: "enabled",
    };
    const mock = vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/commands") {
        commandLoads += 1;
        if (init?.signal) signals.push(init.signal);
        if (commandLoads === 1)
          return new Promise<Response>((resolve) => {
            resolveInitial = resolve;
          });
        return Promise.resolve(jsonResponse({ commands: [fresh] }));
      }
      if (url.startsWith("/resources/extensions"))
        return Promise.resolve(jsonResponse({ extensions: [] }));
      if (url === "/settings")
        return Promise.resolve(
          jsonResponse({ settings: { extensionLoadingMode: "useMyExtensions" } }),
        );
      if (url === "/runtime/bridges") return Promise.resolve(jsonResponse({ bridges: [] }));
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", mock);

    render(<ExtensionsScreen />);
    useAppStore.setState({ resourcesVersion: 1 });
    expect(await screen.findByText("/create-agent-deck-command")).toBeTruthy();
    expect(signals[0]?.aborted).toBe(true);
    resolveInitial(jsonResponse({ commands: [] }));
    await waitFor(() => expect(screen.getByText("/create-agent-deck-command")).toBeTruthy());
  });

  it("groups bundled and imported commands without exposing imported paths", async () => {
    const commands = [
      {
        id: "built-in:optimize-agents-md",
        slashName: "/optimize-agents-md",
        title: "Optimize AGENTS.md",
        description: "Optimize the guide",
        source: "built-in",
        fileName: "optimize-agents-md.ts",
        path: "/private/app/data/bundled/optimize-agents-md.ts",
        status: "enabled",
      },
      {
        id: "library:0123456789abcdef0123456789abcdef",
        slashName: "/review-work",
        title: "review-work",
        description: "Review work",
        source: "library",
        fileName: "0123456789abcdef0123456789abcdef.ts",
        path: "/private/app/data/library/secret.ts",
        status: "disabled",
      },
    ];
    const mock = vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/resources/commands") return Promise.resolve(jsonResponse({ commands }));
      if (url.startsWith("/resources/extensions"))
        return Promise.resolve(jsonResponse({ extensions: [] }));
      if (url === "/settings")
        return Promise.resolve(
          jsonResponse({ settings: { extensionLoadingMode: "useMyExtensions" } }),
        );
      if (url === "/runtime/bridges") return Promise.resolve(jsonResponse({ bridges: [] }));
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", mock);

    render(<ExtensionsScreen />);
    expect(await screen.findByText("/optimize-agents-md")).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain(
      "execute as Pi extensions with extension-runtime capabilities",
    );
    expect(screen.getByText("/review-work")).toBeTruthy();
    expect(screen.getByTestId("command-group-built-in")).toBeTruthy();
    expect(screen.getByTestId("command-group-library")).toBeTruthy();
    expect(screen.queryByText(/private\/app\/data/)).toBeNull();
    expect(
      screen.getByTestId("command-library:0123456789abcdef0123456789abcdef").className,
    ).toContain("sm:flex-row");
  });

  it("imports browser file bytes and starts from an accessible empty library", async () => {
    let commands: unknown[] = [];
    let importedBody: { fileName: string; content: string } | undefined;
    const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/resources/commands" && !init?.method) return jsonResponse({ commands });
      if (url === "/resources/commands/import") {
        importedBody = JSON.parse(String(init?.body));
        commands = [
          {
            id: "library:0123456789abcdef0123456789abcdef",
            slashName: "/hello",
            title: "hello",
            description: "Hello",
            source: "library",
            fileName: "0123456789abcdef0123456789abcdef.ts",
            status: "disabled",
          },
        ];
        return jsonResponse({ command: commands[0] }, 201);
      }
      if (url.startsWith("/resources/extensions")) return jsonResponse({ extensions: [] });
      if (url === "/settings")
        return jsonResponse({ settings: { extensionLoadingMode: "useMyExtensions" } });
      if (url === "/runtime/bridges") return jsonResponse({ bridges: [] });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", mock);

    render(<ExtensionsScreen />);
    expect(await screen.findByText("No imported commands.")).toBeTruthy();
    const file = new File(["source bytes"], "hello.ts", { type: "text/javascript" });
    Object.defineProperty(file, "text", { value: async () => "source bytes" });
    fireEvent.change(screen.getByTestId("command-file-input"), { target: { files: [file] } });
    expect(await screen.findByText("/hello")).toBeTruthy();
    expect(importedBody).toEqual({ fileName: "hello.ts", content: "source bytes" });
  });
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
