// @vitest-environment jsdom

import type { SemanticRecallStatus } from "@agent-deck/contracts";
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

const status = (
  readiness: SemanticRecallStatus["readiness"],
  mode: SemanticRecallStatus["mode"],
  reason: SemanticRecallStatus["reason"] = null,
): SemanticRecallStatus => ({ readiness, mode, reason, message: `Safe ${readiness} status.` });

const jsonResponse = (data: unknown, ok = true) => ({ ok, json: async () => data });

function initialFetch(enabled: boolean, recall: SemanticRecallStatus) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === "/settings") {
      return jsonResponse({ settings: { semanticMemoryEnabled: enabled } });
    }
    if (url === "/memory/semantic-status") return jsonResponse({ recall });
    throw new Error(`unexpected request: ${url}`);
  });
}

describe("MemoryScreen semantic readiness", () => {
  it("loads passive status and shows the not-requested lexical state", async () => {
    const fetchMock = initialFetch(false, status("not_requested", "lexical"));
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    const toggle = await screen.findByRole("switch", { name: "Semantic ranking" });
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("semantic-memory-mode").textContent).toBe("Not requested");
    expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe(
      "Not requested · Lexical",
    );
    expect(screen.getByTestId("semantic-memory-readiness").textContent).toContain(
      "Safe not_requested status.",
    );
    expect(fetchMock).toHaveBeenCalledWith("/memory/semantic-status", expect.anything());
  });

  it("checks readiness explicitly and exposes the ready semantic state", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/settings") return jsonResponse({ settings: { semanticMemoryEnabled: true } });
      if (url === "/memory/semantic-status") {
        return jsonResponse({ recall: status("not_checked", "lexical") });
      }
      if (url === "/memory/semantic-status/check" && init?.method === "POST") {
        return jsonResponse({ recall: status("ready", "semantic") });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Check readiness" }));
    expect(screen.getByTestId("semantic-memory-mode").textContent).toBe("Requested");
    expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe("Checking");
    await waitFor(() =>
      expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe(
        "Ready · Semantic",
      ),
    );
  });

  it.each([
    {
      readiness: "unavailable" as const,
      reason: "optional_dependency_missing" as const,
      label: "Unavailable · Lexical fallback",
    },
    {
      readiness: "error" as const,
      reason: "initialization_failed" as const,
      label: "Error · Lexical fallback",
    },
  ])("offers an accessible retry for $reason", async ({ readiness, reason, label }) => {
    vi.stubGlobal("fetch", initialFetch(true, status(readiness, "lexical_fallback", reason)));
    render(<MemoryScreen />);

    expect((await screen.findByTestId("semantic-memory-mode")).textContent).toBe("Requested");
    expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe(label);
    expect(screen.getByTestId("semantic-memory-readiness").textContent).toContain(
      `Safe ${readiness} status.`,
    );
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("toggles optimistically, stays busy, and refreshes passive status after save", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    let enabled = false;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/settings" && init?.method === "PATCH") {
        await pending;
        enabled = true;
        return jsonResponse({ settings: { semanticMemoryEnabled: true } });
      }
      if (url === "/settings")
        return jsonResponse({ settings: { semanticMemoryEnabled: enabled } });
      if (url === "/memory/semantic-status") {
        return jsonResponse({
          recall: enabled ? status("not_checked", "lexical") : status("not_requested", "lexical"),
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    const toggle = await screen.findByRole("switch", { name: "Semantic ranking" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect((toggle as HTMLButtonElement).disabled).toBe(true);
    release();
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByTestId("semantic-memory-mode").textContent).toBe("Requested");
    expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe(
      "Not checked · Lexical",
    );
  });

  it("rolls back the visible preference and reports a save error", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/settings" && init?.method === "PATCH") return jsonResponse({}, false);
      if (url === "/settings") return jsonResponse({ settings: { semanticMemoryEnabled: false } });
      if (url === "/memory/semantic-status") {
        return jsonResponse({ recall: status("not_requested", "lexical") });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    const toggle = await screen.findByRole("switch", { name: "Semantic ranking" });
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(screen.getByRole("alert").textContent).toContain("couldn’t save");
  });

  it.each(["embedding_failed", "invalid_embedding"] as const)(
    "shows automatic recall retry instead of a check action for %s",
    async (reason) => {
      useAppStore.setState({ currentProjectId: "project-1" });
      const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/settings") {
          return jsonResponse({ settings: { semanticMemoryEnabled: true } });
        }
        if (url === "/memory/semantic-status") {
          return jsonResponse({ recall: status("ready", "semantic") });
        }
        if (url === "/memory?projectId=project-1") return jsonResponse({ memories: [] });
        if (url.startsWith("/memory/search?")) {
          return jsonResponse({
            memories: [],
            recall: status("error", "lexical_fallback", reason),
          });
        }
        throw new Error(`unexpected request: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<MemoryScreen />);

      await screen.findByRole("switch", { name: "Semantic ranking" });
      fireEvent.change(screen.getByTestId("memory-search"), { target: { value: "oauth" } });
      await waitFor(() =>
        expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe(
          "Error · Lexical fallback",
        ),
      );
      expect(screen.getByTestId("semantic-memory-mode").textContent).toBe("Requested");
      expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
      expect(screen.getByTestId("semantic-memory-runtime-retry").textContent).toContain(
        "next memory search or agent recall",
      );
    },
  );

  it.each([
    { name: "HTTP failure", response: jsonResponse({}, false) },
    { name: "missing recall metadata", response: jsonResponse({ memories: [] }) },
  ])("preserves readiness when search has $name", async ({ response }) => {
    useAppStore.setState({ currentProjectId: "project-1" });
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/settings") return jsonResponse({ settings: { semanticMemoryEnabled: true } });
      if (url === "/memory/semantic-status") {
        return jsonResponse({ recall: status("ready", "semantic") });
      }
      if (url === "/memory?projectId=project-1") return jsonResponse({ memories: [] });
      if (url.startsWith("/memory/search?")) return response;
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    await screen.findByRole("switch", { name: "Semantic ranking" });
    fireEvent.change(screen.getByTestId("memory-search"), { target: { value: "oauth" } });
    await screen.findByTestId("memory-search-empty");
    expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe(
      "Ready · Semantic",
    );
  });

  it("does not let a late readiness check overwrite a later toggle", async () => {
    let enabled = true;
    let releaseCheck!: (response: ReturnType<typeof jsonResponse>) => void;
    const pendingCheck = new Promise<ReturnType<typeof jsonResponse>>(
      (resolve) => (releaseCheck = resolve),
    );
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/settings" && init?.method === "PATCH") {
        enabled = false;
        return jsonResponse({ settings: { semanticMemoryEnabled: false } });
      }
      if (url === "/settings") {
        return jsonResponse({ settings: { semanticMemoryEnabled: enabled } });
      }
      if (url === "/memory/semantic-status/check") return pendingCheck;
      if (url === "/memory/semantic-status") {
        return jsonResponse({
          recall: enabled
            ? status("unavailable", "lexical_fallback", "optional_dependency_missing")
            : status("not_requested", "lexical"),
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    fireEvent.click(screen.getByRole("switch", { name: "Semantic ranking" }));
    await waitFor(() =>
      expect(screen.getByTestId("semantic-memory-mode").textContent).toBe("Not requested"),
    );
    expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe(
      "Not requested · Lexical",
    );

    releaseCheck(jsonResponse({ recall: status("ready", "semantic") }));
    await Promise.resolve();
    expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe(
      "Not requested · Lexical",
    );
  });

  it("recovers server readiness when a toggle fails during an in-flight check", async () => {
    let releaseCheck!: (response: ReturnType<typeof jsonResponse>) => void;
    const pendingCheck = new Promise<ReturnType<typeof jsonResponse>>(
      (resolve) => (releaseCheck = resolve),
    );
    const serverRecall = status("unavailable", "lexical_fallback", "optional_dependency_missing");
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/settings" && init?.method === "PATCH") return jsonResponse({}, false);
      if (url === "/settings") {
        return jsonResponse({ settings: { semanticMemoryEnabled: true } });
      }
      if (url === "/memory/semantic-status/check") return pendingCheck;
      if (url === "/memory/semantic-status") return jsonResponse({ recall: serverRecall });
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));
    expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe("Checking");
    fireEvent.click(screen.getByRole("switch", { name: "Semantic ranking" }));

    await waitFor(() =>
      expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe(
        "Unavailable · Lexical fallback",
      ),
    );
    expect(screen.getByTestId("semantic-memory-mode").textContent).toBe("Requested");
    expect(screen.getByRole("alert").textContent).toContain("couldn’t save");

    releaseCheck(jsonResponse({ recall: status("ready", "semantic") }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByTestId("semantic-memory-readiness-mode").textContent).toBe(
      "Unavailable · Lexical fallback",
    );
  });

  it("admits only one toggle mutation while a save is in flight", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => (release = resolve));
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/settings" && init?.method === "PATCH") {
        await pending;
        return jsonResponse({ settings: { semanticMemoryEnabled: true } });
      }
      if (url === "/settings") {
        return jsonResponse({ settings: { semanticMemoryEnabled: false } });
      }
      if (url === "/memory/semantic-status") {
        return jsonResponse({ recall: status("not_requested", "lexical") });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    const toggle = await screen.findByRole("switch", { name: "Semantic ranking" });
    fireEvent.click(toggle);
    fireEvent.click(toggle);
    expect(
      fetchMock.mock.calls.filter(
        ([, init]) => (init as RequestInit | undefined)?.method === "PATCH",
      ),
    ).toHaveLength(1);
    release();
    await waitFor(() => expect((toggle as HTMLButtonElement).disabled).toBe(false));
  });

  it("shows a combined load error and retries both passive reads", async () => {
    let attempt = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (attempt === 0) {
        if (url === "/memory/semantic-status") attempt = 1;
        return jsonResponse({}, false);
      }
      if (url === "/settings") return jsonResponse({ settings: { semanticMemoryEnabled: true } });
      return jsonResponse({ recall: status("not_checked", "lexical") });
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    expect((await screen.findByTestId("semantic-memory-load-error")).textContent).toContain(
      "couldn’t load",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("switch", { name: "Semantic ranking" })).toBeTruthy();
  });
});
