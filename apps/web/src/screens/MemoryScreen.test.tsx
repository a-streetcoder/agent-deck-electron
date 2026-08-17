// @vitest-environment jsdom

import type { SemanticRecallStatus } from "@agent-deck/contracts";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../state/store.ts";
import { MemoryScreen } from "./MemoryScreen.tsx";

beforeEach(() => {
  useAppStore.setState({
    currentProjectId: null,
    projects: [],
    projectsLoaded: false,
    memoryNavigationRequest: null,
    error: null,
  });
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

const jsonResponse = (data: unknown, ok = true, statusCode = ok ? 200 : 500) => ({
  ok,
  status: statusCode,
  json: async () => data,
});

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

const project = (id: string) => ({
  id,
  path: `/tmp/${id}`,
  name: id,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const memory = (
  id: string,
  title: string,
): {
  id: string;
  type: "decision";
  status: "active";
  title: string;
  summary: string;
  body: string;
  tags: string[];
  updatedAt: string;
} => ({
  id,
  type: "decision",
  status: "active",
  title,
  summary: `${title} summary`,
  body: `${title} body`,
  tags: [],
  updatedAt: "2026-01-01T00:00:00.000Z",
});

function memoryNavigationFetch(
  direct: (url: string, init?: RequestInit) => Promise<ReturnType<typeof jsonResponse>>,
) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === "/settings") {
      return jsonResponse({ settings: { semanticMemoryEnabled: false } });
    }
    if (url === "/memory/semantic-status") {
      return jsonResponse({ recall: status("not_requested", "lexical") });
    }
    if (url.startsWith("/memory?projectId=")) return jsonResponse({ memories: [] });
    if (url.startsWith("/memory/")) return direct(url, init);
    throw new Error(`unexpected request: ${url}`);
  });
}

describe("MemoryScreen transcript navigation", () => {
  it("GETs the exact project/id and opens the renamed live record, never the title snapshot", async () => {
    const fetchMock = memoryNavigationFetch(async () =>
      jsonResponse({ memory: memory("memory-a", "Renamed live title") }),
    );
    vi.stubGlobal("fetch", fetchMock);
    useAppStore.setState({ projects: [project("project-a")], projectsLoaded: true });
    useAppStore.getState().requestMemoryNavigation({
      projectId: "project-a",
      memoryId: "memory-a",
      titleSnapshot: "Historical title",
    });

    render(<MemoryScreen />);

    expect(await screen.findByTestId("memory-editor")).toBeTruthy();
    expect((screen.getByTestId("memory-title") as HTMLInputElement).value).toBe(
      "Renamed live title",
    );
    expect((screen.getByTestId("memory-body") as HTMLTextAreaElement).value).toBe(
      "Renamed live title body",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/memory/memory-a?projectId=project-a",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(document.body.textContent).not.toContain("Historical title");
    await waitFor(() => expect(useAppStore.getState().memoryNavigationRequest).toBeNull());
  });

  it("shows an accessible snapshot-specific alert for a deleted exact ID", async () => {
    const fetchMock = memoryNavigationFetch(async () => jsonResponse({}, false, 404));
    vi.stubGlobal("fetch", fetchMock);
    useAppStore.setState({ projects: [project("project-a")], projectsLoaded: true });
    useAppStore.getState().requestMemoryNavigation({
      projectId: "project-a",
      memoryId: "deleted-memory",
      titleSnapshot: "Deleted title",
    });

    render(<MemoryScreen />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Memory “Deleted title” no longer exists",
    );
    expect(screen.queryByTestId("memory-editor")).toBeNull();
  });

  it("does not fetch or open another item when the historical project is unavailable", async () => {
    const fetchMock = memoryNavigationFetch(async () => {
      throw new Error("exact memory fetch must not run");
    });
    vi.stubGlobal("fetch", fetchMock);
    useAppStore.setState({ projects: [project("other-project")], projectsLoaded: true });
    useAppStore.getState().requestMemoryNavigation({
      projectId: "removed-project",
      memoryId: "memory-a",
      titleSnapshot: "Historical title",
    });

    render(<MemoryScreen />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Memory “Historical title” no longer exists",
    );
    expect(screen.queryByTestId("memory-editor")).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input]) =>
        String(input).startsWith("/memory/memory-a?projectId=removed-project"),
      ),
    ).toBe(false);
  });

  it("clears an existing same-project draft as soon as exact navigation is admitted", async () => {
    const pending = new Promise<ReturnType<typeof jsonResponse>>(() => undefined);
    const fetchMock = memoryNavigationFetch(async () => pending);
    vi.stubGlobal("fetch", fetchMock);
    useAppStore.setState({
      currentProjectId: "project-a",
      projects: [project("project-a")],
      projectsLoaded: true,
    });
    render(<MemoryScreen />);
    fireEvent.click(screen.getByRole("button", { name: "New memory" }));
    expect(screen.getByTestId("memory-editor")).toBeTruthy();

    act(() => {
      useAppStore.getState().requestMemoryNavigation({
        projectId: "project-a",
        memoryId: "memory-a",
        titleSnapshot: "Historical title",
      });
    });

    expect(screen.queryByTestId("memory-editor")).toBeNull();
    expect(screen.queryByDisplayValue("Historical title")).toBeNull();
  });

  it.each([
    { name: "an unavailable request", response: () => jsonResponse({}, false, 400) },
    { name: "a server failure", response: () => jsonResponse({}, false, 503) },
    {
      name: "a network failure",
      response: () => Promise.reject(new Error("private network detail")),
    },
  ])("shows an honest alert for $name without fallback", async ({ name, response }) => {
    const fetchMock = memoryNavigationFetch(async () => response());
    vi.stubGlobal("fetch", fetchMock);
    useAppStore.setState({ projects: [project("project-a")], projectsLoaded: true });
    useAppStore.getState().requestMemoryNavigation({
      projectId: "project-a",
      memoryId: "exact-memory",
      titleSnapshot: "Snapshot title",
    });

    render(<MemoryScreen />);

    expect((await screen.findByRole("alert")).textContent).toBe(
      name === "an unavailable request"
        ? "Memory “Snapshot title” no longer exists"
        : "Couldn’t open memory. Try again.",
    );
    expect(screen.queryByTestId("memory-editor")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock).toHaveBeenCalledWith(
      "/memory/exact-memory?projectId=project-a",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("lets the latest repeated click win when an older exact GET resolves last", async () => {
    let resolveFirst!: (response: ReturnType<typeof jsonResponse>) => void;
    const first = new Promise<ReturnType<typeof jsonResponse>>(
      (resolve) => (resolveFirst = resolve),
    );
    const fetchMock = memoryNavigationFetch(async (url) => {
      if (url.startsWith("/memory/memory-a?")) return first;
      if (url.startsWith("/memory/memory-b?")) {
        return jsonResponse({ memory: memory("memory-b", "Latest live title") });
      }
      throw new Error(`unexpected direct request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    useAppStore.setState({ projects: [project("project-a")], projectsLoaded: true });
    useAppStore.getState().requestMemoryNavigation({
      projectId: "project-a",
      memoryId: "memory-a",
      titleSnapshot: "First snapshot",
    });
    render(<MemoryScreen />);
    await waitFor(() =>
      expect(
        fetchMock.mock.calls.some(([input]) => String(input).startsWith("/memory/memory-a?")),
      ).toBe(true),
    );

    act(() => {
      useAppStore.getState().requestMemoryNavigation({
        projectId: "project-a",
        memoryId: "memory-b",
        titleSnapshot: "Second snapshot",
      });
    });
    expect(await screen.findByDisplayValue("Latest live title")).toBeTruthy();

    resolveFirst(jsonResponse({ memory: memory("memory-a", "Late stale title") }));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect((screen.getByTestId("memory-title") as HTMLInputElement).value).toBe(
      "Latest live title",
    );
  });
});

describe("MemoryScreen project memory preference", () => {
  it("shows On/Paused, fences a busy save, and rolls back an error", async () => {
    let patchResolve: ((value: ReturnType<typeof jsonResponse>) => void) | undefined;
    const patch = new Promise<ReturnType<typeof jsonResponse>>((resolve) => {
      patchResolve = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/settings" && init?.method === "PATCH") return await patch;
      if (url === "/settings") {
        return jsonResponse({
          settings: { agentMemoryEnabled: true, semanticMemoryEnabled: false },
        });
      }
      if (url === "/memory/semantic-status") {
        return jsonResponse({ recall: status("not_requested", "lexical") });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    const toggle = await screen.findByRole("switch", { name: "Memory automation" });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("agent-memory-state").textContent).toBe("On");
    expect((screen.getByTestId("agent-memory-budget") as HTMLInputElement).value).toBe("6000");
    const childToggle = screen.getByRole("switch", { name: "Delegated agent memory context" });
    expect(childToggle.getAttribute("aria-checked")).toBe("true");
    expect(childToggle).toHaveProperty("disabled", false);
    expect(document.body.textContent).toContain(
      "Across all projects, pausing stops automatic recall and agent memory tools. Stored memories remain available.",
    );

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(toggle).toHaveProperty("disabled", true);
    expect(screen.getByTestId("agent-memory-state").textContent).toBe("Paused");
    expect(childToggle).toHaveProperty("disabled", true);
    expect(screen.getByTestId("agent-memory-subagents-state").textContent).toContain(
      "Inactive while memory automation is paused",
    );
    patchResolve!(jsonResponse({}, false));

    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
    expect(screen.getByTestId("agent-memory-save-status").getAttribute("role")).toBe("alert");
  });

  it.each(["", "999", "20001", "1000.5"])(
    "restores the saved budget and reports invalid blur value %j",
    async (invalid) => {
      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url === "/settings" && init?.method === "PATCH") {
          throw new Error("invalid values must not be sent");
        }
        if (url === "/settings") {
          return jsonResponse({
            settings: {
              agentMemoryEnabled: true,
              agentMemoryInjectionCharacterBudget: 6000,
              agentMemorySubagentsEnabled: false,
              semanticMemoryEnabled: false,
            },
            capabilities: { agentMemory: true },
          });
        }
        if (url === "/memory/semantic-status") {
          return jsonResponse({ recall: status("not_requested", "lexical") });
        }
        throw new Error(`unexpected request: ${url}`);
      });
      vi.stubGlobal("fetch", fetchMock);
      render(<MemoryScreen />);
      const input = (await screen.findByTestId("agent-memory-budget")) as HTMLInputElement;
      fireEvent.change(input, { target: { value: invalid } });
      fireEvent.blur(input);
      expect(input.value).toBe("6000");
      expect(screen.getByTestId("agent-memory-save-status").getAttribute("role")).toBe("alert");
      expect(screen.getByTestId("agent-memory-save-status").textContent).toContain(
        "1,000 to 20,000",
      );
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
    },
  );

  it("resyncs external changes without letting its own broadcast strand an in-flight save", async () => {
    let serverEnabled = true;
    let resolvePatch!: () => void;
    const patchPending = new Promise<void>((resolve) => {
      resolvePatch = resolve;
    });
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/settings" && init?.method === "PATCH") {
        await patchPending;
        return jsonResponse({
          settings: { agentMemoryEnabled: serverEnabled, semanticMemoryEnabled: false },
          capabilities: { agentMemory: true },
        });
      }
      if (url === "/settings") {
        return jsonResponse({
          settings: { agentMemoryEnabled: serverEnabled, semanticMemoryEnabled: false },
          capabilities: { agentMemory: true },
        });
      }
      if (url === "/memory/semantic-status") {
        return jsonResponse({ recall: status("not_requested", "lexical") });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    const toggle = await screen.findByRole("switch", { name: "Memory automation" });
    fireEvent.click(toggle);
    expect(toggle).toHaveProperty("disabled", true);
    serverEnabled = false;
    act(() => {
      useAppStore.setState((state) => ({ resourcesVersion: state.resourcesVersion + 1 }));
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("false"));
    expect(toggle).toHaveProperty("disabled", true);

    resolvePatch();
    await waitFor(() => expect(toggle).toHaveProperty("disabled", false));
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    serverEnabled = true;
    act(() => {
      useAppStore.setState((state) => ({ resourcesVersion: state.resourcesVersion + 1 }));
    });
    await waitFor(() => expect(toggle.getAttribute("aria-checked")).toBe("true"));
  });

  it("shows an unavailable disabled switch without claiming the stored library is available", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url === "/settings") {
        return jsonResponse({
          settings: { agentMemoryEnabled: true, semanticMemoryEnabled: false },
          capabilities: { agentMemory: false },
        });
      }
      if (url === "/memory/semantic-status") {
        return jsonResponse({ recall: status("not_requested", "lexical") });
      }
      throw new Error(`unexpected request: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<MemoryScreen />);

    const toggle = await screen.findByRole("switch", { name: "Memory automation" });
    expect(toggle).toHaveProperty("disabled", true);
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(screen.getByTestId("agent-memory-state").textContent).toBe("Unavailable");
    const childToggle = screen.getByRole("switch", { name: "Delegated agent memory context" });
    expect(childToggle).toHaveProperty("disabled", true);
    expect(screen.getByTestId("agent-memory-subagents-state").textContent).toContain(
      "Inactive: memory capability unavailable",
    );
    expect(document.body.textContent).toContain(
      "Memory automation is unavailable because it is disabled by this server’s configuration.",
    );
    expect(document.body.textContent).not.toContain("Stored memories remain available.");
    fireEvent.click(toggle);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);
  });
});

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

describe("tag editing (MEM-12)", () => {
  const editorFetch = (patches: unknown[]) =>
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "PATCH") {
        patches.push(JSON.parse(String(init.body)));
        return jsonResponse({ memory: {} });
      }
      if (url === "/settings") {
        return jsonResponse({ settings: { semanticMemoryEnabled: false } });
      }
      if (url === "/memory/semantic-status") {
        return jsonResponse({ recall: status("not_requested", "lexical") });
      }
      if (url.startsWith("/memory?projectId=")) {
        return jsonResponse({
          memories: [{ ...memory("mem-tagged", "Tagged memory"), tags: ["ci", "tests"] }],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

  it("edits tags as native does: comma-separated, trimmed, empties dropped", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", editorFetch(patches));
    useAppStore.setState({
      currentProjectId: "project-a",
      projects: [project("project-a")],
      projectsLoaded: true,
    });
    render(<MemoryScreen />);

    fireEvent.click(await screen.findByText("Tagged memory"));
    // Native seeds its "Comma-separated tags" field from the record
    // (AgentMemoryViews.swift:437) so an edit starts from what is stored.
    const tags = screen.getByTestId("memory-tags") as HTMLInputElement;
    expect(tags.value).toBe("ci, tests");

    fireEvent.change(tags, { target: { value: " ci ,, release ,  " } });
    fireEvent.click(screen.getByTestId("memory-save"));

    await waitFor(() => expect(patches.length).toBe(1));
    // Native's parse: split on comma, trim, drop empties (:579-582).
    expect((patches[0] as { edit: { tags: string[] } }).edit.tags).toEqual(["ci", "release"]);
  });

  it("leaves tags alone when the field was never touched", async () => {
    const patches: unknown[] = [];
    vi.stubGlobal("fetch", editorFetch(patches));
    useAppStore.setState({
      currentProjectId: "project-a",
      projects: [project("project-a")],
      projectsLoaded: true,
    });
    render(<MemoryScreen />);

    fireEvent.click(await screen.findByText("Tagged memory"));
    fireEvent.change(screen.getByTestId("memory-body"), { target: { value: "revised body" } });
    fireEvent.click(screen.getByTestId("memory-save"));

    // A body-only edit must not carry tags: the field is a flat comma-joined
    // view, so re-sending it would re-split a tag containing a comma and would
    // overwrite anything an agent tagged while the editor sat open. Omitting
    // the key makes the store keep what is on disk.
    await waitFor(() => expect(patches.length).toBe(1));
    expect(patches[0] as { edit: Record<string, unknown> }).not.toHaveProperty("edit.tags");
  });
});

describe("memory provenance display (MEM-11)", () => {
  it("shows which delegated agent authored a memory, and nothing when unattributed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/settings") {
          return jsonResponse({ settings: { semanticMemoryEnabled: false } });
        }
        if (url === "/memory/semantic-status") {
          return jsonResponse({ recall: status("not_requested", "lexical") });
        }
        if (url.startsWith("/memory?projectId=")) {
          return jsonResponse({
            memories: [
              { ...memory("mem-child", "Written by a child"), sourceAgentName: "reviewer" },
              memory("mem-parent", "Written by the parent"),
            ],
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    useAppStore.setState({
      currentProjectId: "project-a",
      projects: [project("project-a")],
      projectsLoaded: true,
    });
    render(<MemoryScreen />);

    // Native shows a "Source" row for an attributed memory
    // (AgentMemoryViews.swift:467) and omits it otherwise, so stored provenance
    // is visible rather than buried in the file.
    const source = await screen.findByTestId("memory-source-mem-child");
    expect(source.textContent).toContain("reviewer");
    expect(screen.queryByTestId("memory-source-mem-parent")).toBeNull();
  });
});

describe("bulk stale delete (MEM-14)", () => {
  const staleAndActive = (sweeps: string[][]) =>
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "/memory/delete-stale") {
        const body = JSON.parse(String(init?.body)) as { ids: string[] };
        sweeps.push(body.ids);
        return jsonResponse({ deleted: body.ids.length, skipped: 0 });
      }
      if (url === "/settings") {
        return jsonResponse({ settings: { semanticMemoryEnabled: false } });
      }
      if (url === "/memory/semantic-status") {
        return jsonResponse({ recall: status("not_requested", "lexical") });
      }
      if (url.startsWith("/memory?projectId=")) {
        return jsonResponse({
          memories: [
            { ...memory("mem-active", "Keep me"), status: "active" },
            { ...memory("mem-stale-1", "Retired one"), status: "stale" },
            { ...memory("mem-stale-2", "Retired two"), status: "stale" },
          ],
        });
      }
      throw new Error(`unexpected request: ${url}`);
    });

  const openProject = async (sweeps: string[][]) => {
    vi.stubGlobal("fetch", staleAndActive(sweeps));
    useAppStore.setState({
      currentProjectId: "project-a",
      projects: [project("project-a")],
      projectsLoaded: true,
    });
    render(<MemoryScreen />);
    await waitFor(() => expect(screen.getByTestId("memory-delete-mem-stale-1")).toBeTruthy());
  };

  it("sweeps exactly the visible stale ids in ONE request, leaving the others alone", async () => {
    const sweeps: string[][] = [];
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    await openProject(sweeps);

    fireEvent.click(screen.getByTestId("memory-delete-stale"));
    await waitFor(() => expect(sweeps.length).toBe(1));
    // One request, and the active memory is not in it. The SERVER re-proves
    // staleness per id (memory-routes.test.ts pins that half), so a memory an
    // agent reactivated mid-sweep survives.
    expect(sweeps[0]).toEqual(["mem-stale-1", "mem-stale-2"]);
    // Native's confirm names the count so a bulk destructive action is never a
    // surprise ("Delete N stale memories?").
    expect(
      String((confirm as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0]),
    ).toContain("2");
  });

  it("says so when the server skipped ids that stopped being stale", async () => {
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/memory/delete-stale") return jsonResponse({ deleted: 1, skipped: 1 });
        if (url === "/settings") {
          return jsonResponse({ settings: { semanticMemoryEnabled: false } });
        }
        if (url === "/memory/semantic-status") {
          return jsonResponse({ recall: status("not_requested", "lexical") });
        }
        if (url.startsWith("/memory?projectId=")) {
          return jsonResponse({
            memories: [{ ...memory("mem-stale-1", "Retired one"), status: "stale" }],
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    useAppStore.setState({
      currentProjectId: "project-a",
      projects: [project("project-a")],
      projectsLoaded: true,
    });
    render(<MemoryScreen />);
    await waitFor(() => expect(screen.getByTestId("memory-delete-stale")).toBeTruthy());

    fireEvent.click(screen.getByTestId("memory-delete-stale"));
    // Reloading silently would hide a partial result from someone who just
    // confirmed deleting everything shown.
    const notice = await screen.findByTestId("memory-stale-sweep-notice");
    expect(notice.textContent).toContain("Skipped 1");
  });

  it("sweeps nothing when the confirm is declined", async () => {
    const sweeps: string[][] = [];
    vi.stubGlobal(
      "confirm",
      vi.fn(() => false),
    );
    await openProject(sweeps);

    fireEvent.click(screen.getByTestId("memory-delete-stale"));
    expect(sweeps).toEqual([]);
  });

  it("offers no bulk control when nothing visible is stale", async () => {
    vi.stubGlobal("fetch", initialFetch(false, status("not_requested", "lexical")));
    useAppStore.setState({ currentProjectId: null, projects: [], projectsLoaded: true });
    render(<MemoryScreen />);
    expect(screen.queryByTestId("memory-delete-stale")).toBeNull();
  });
});

describe("memory detail metadata (MEM-13)", () => {
  it("shows the metadata rows native's detail pane shows", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/settings") {
          return jsonResponse({ settings: { semanticMemoryEnabled: false } });
        }
        if (url === "/memory/semantic-status") {
          return jsonResponse({ recall: status("not_requested", "lexical") });
        }
        if (url.startsWith("/memory?projectId=")) {
          return jsonResponse({
            memories: [
              {
                ...memory("mem-detail", "Detailed memory"),
                createdAt: "2026-03-04T09:30:00.000Z",
                updatedAt: "2026-05-06T14:45:00.000Z",
                sourceAgentName: "reviewer",
                filePath: "/data/memory/proj/mem-detail.md",
              },
            ],
          });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    useAppStore.setState({
      currentProjectId: "project-a",
      projects: [project("project-a")],
      projectsLoaded: true,
    });
    render(<MemoryScreen />);

    fireEvent.click(await screen.findByText("Detailed memory"));
    // Native lists Type, Scope, Created, Updated, Source (when attributed) and
    // File (AgentMemoryViews.swift:461-471), so reviewing a memory does not
    // mean opening the file to find out when it was written or by what.
    const meta = screen.getByTestId("memory-meta");
    const labels = [...meta.querySelectorAll("dt")].map((node) => node.textContent);
    expect(labels).toEqual(["Type", "Scope", "Created", "Updated", "Source", "File"]);
    const values = [...meta.querySelectorAll("dd")].map((node) => node.textContent);
    expect(values[0]).toBe("decision");
    expect(values[1]).toBe("project");
    expect(values[2]).toContain("2026");
    expect(values[4]).toBe("reviewer");
    expect(values[5]).toBe("/data/memory/proj/mem-detail.md");
  });

  it("omits the Source row when nothing authored it, and the block entirely for a new memory", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url === "/settings") {
          return jsonResponse({ settings: { semanticMemoryEnabled: false } });
        }
        if (url === "/memory/semantic-status") {
          return jsonResponse({ recall: status("not_requested", "lexical") });
        }
        if (url.startsWith("/memory?projectId=")) {
          return jsonResponse({ memories: [memory("mem-plain", "Plain memory")] });
        }
        throw new Error(`unexpected request: ${url}`);
      }),
    );
    useAppStore.setState({
      currentProjectId: "project-a",
      projects: [project("project-a")],
      projectsLoaded: true,
    });
    render(<MemoryScreen />);

    fireEvent.click(await screen.findByText("Plain memory"));
    const labels = [...screen.getByTestId("memory-meta").querySelectorAll("dt")].map(
      (node) => node.textContent,
    );
    expect(labels).not.toContain("Source");

    // A memory being composed has no created/updated/file yet — native only
    // renders a detail pane for a record that exists.
    fireEvent.click(screen.getByTestId("memory-new"));
    expect(screen.queryByTestId("memory-meta")).toBeNull();
  });
});

describe("open editor follows the record (MEM-13)", () => {
  const listing = (memories: unknown[]) =>
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "DELETE") return jsonResponse({ deleted: true });
      if (url === "/settings") return jsonResponse({ settings: { semanticMemoryEnabled: false } });
      if (url === "/memory/semantic-status") {
        return jsonResponse({ recall: status("not_requested", "lexical") });
      }
      if (url.startsWith("/memory?projectId=")) return jsonResponse({ memories: memories.shift() });
      throw new Error(`unexpected request: ${url}`);
    });

  it("closes when the open memory is deleted from under it", async () => {
    const record = memory("mem-open", "Open memory");
    vi.stubGlobal(
      "confirm",
      vi.fn(() => true),
    );
    vi.stubGlobal("fetch", listing([[record], []]));
    useAppStore.setState({
      currentProjectId: "project-a",
      projects: [project("project-a")],
      projectsLoaded: true,
    });
    render(<MemoryScreen />);

    fireEvent.click(await screen.findByText("Open memory"));
    expect(screen.getByTestId("memory-editor")).toBeTruthy();

    // Native clears its selection when the selected record is deleted
    // (AgentMemoryViews.swift:298); an editor left open on a deleted memory
    // only fails at save time, and its File row points at nothing.
    fireEvent.click(screen.getByTestId("memory-delete-mem-open"));
    await waitFor(() => expect(screen.queryByTestId("memory-editor")).toBeNull());
  });

  it("refreshes the metadata rows when the record changes, without discarding typing", async () => {
    const before = { ...memory("mem-open", "Open memory"), updatedAt: "2026-01-01T00:00:00.000Z" };
    const after = {
      ...before,
      updatedAt: "2026-09-09T18:00:00.000Z",
      sourceAgentName: "reviewer",
    };
    vi.stubGlobal("fetch", listing([[before], [after]]));
    useAppStore.setState({
      currentProjectId: "project-a",
      projects: [project("project-a")],
      projectsLoaded: true,
      resourcesVersion: 0,
    });
    render(<MemoryScreen />);

    fireEvent.click(await screen.findByText("Open memory"));
    fireEvent.change(screen.getByTestId("memory-body"), { target: { value: "half-typed" } });

    // An agent rewriting the memory mid-edit is the ordinary case here, and
    // native's detail pane is bound to the record, so the read-only rows follow
    // it while the edit sheet keeps what the user typed.
    act(() => useAppStore.setState({ resourcesVersion: 1 }));
    await waitFor(() =>
      expect(
        [...screen.getByTestId("memory-meta").querySelectorAll("dt")].map((n) => n.textContent),
      ).toContain("Source"),
    );
    const values = [...screen.getByTestId("memory-meta").querySelectorAll("dd")].map(
      (n) => n.textContent,
    );
    expect(values[3]).toContain("2026");
    expect(values[3]).not.toBe("—");
    expect((screen.getByTestId("memory-body") as HTMLTextAreaElement).value).toBe("half-typed");
  });
});
