// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSuggestions } from "./useSuggestions.ts";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("useSuggestions request scheduling", () => {
  it("debounces file searches by 120ms while fetching slash commands immediately", () => {
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSuggestions("session-1", "project-1"));

    act(() => result.current.update("look @read", 10));
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(119));
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(fetchMock).toHaveBeenCalledWith("/sessions/session-1/files?q=read", {
      signal: expect.any(AbortSignal),
    });

    act(() => result.current.update("/help", 5));
    expect(fetchMock).toHaveBeenLastCalledWith("/sessions/session-1/slash-universe", {
      signal: expect.any(AbortSignal),
    });
  });

  it("aborts superseded queries, close, session changes, and unmount", () => {
    const signals: AbortSignal[] = [];
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      signals.push(init!.signal as AbortSignal);
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal("fetch", fetchMock);
    const { result, rerender, unmount } = renderHook(
      ({ sessionId }) => useSuggestions(sessionId, "project-1"),
      {
        initialProps: { sessionId: "session-1" as string | null },
      },
    );

    act(() => {
      result.current.update("@first", 6);
      vi.advanceTimersByTime(120);
    });
    expect(signals[0]?.aborted).toBe(false);

    act(() => result.current.update("@second", 7));
    expect(signals[0]?.aborted).toBe(true);
    act(() => vi.advanceTimersByTime(120));
    expect(signals[1]?.aborted).toBe(false);

    act(() => result.current.close());
    expect(signals[1]?.aborted).toBe(true);

    act(() => result.current.update("/help", 5));
    expect(signals[2]?.aborted).toBe(false);
    rerender({ sessionId: "session-2" });
    expect(signals[2]?.aborted).toBe(true);

    act(() => result.current.update("/again", 6));
    expect(signals[3]?.aborted).toBe(false);
    unmount();
    expect(signals[3]?.aborted).toBe(true);
  });

  it("clears old file results immediately while a replacement is debounced", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ files: ["old-result.ts"] }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSuggestions("session-1", "project-1"));

    act(() => result.current.update("@old", 4));
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(result.current.mode).toBe("file");
    expect(result.current.items).toEqual([{ id: "old-result.ts", label: "old-result.ts" }]);

    act(() => result.current.update("@new", 4));
    expect(result.current.mode).toBeNull();
    expect(result.current.items).toEqual([]);
  });

  it("fetches the slash universe once and filters later keystrokes in memory", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        commands: [
          {
            kind: "command",
            id: "command:built-in:help",
            displayName: "Help",
            isActive: true,
            slashName: "/help",
          },
        ],
        prompts: [],
        skills: [],
        loops: [],
      }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSuggestions("session-1", "project-1"));

    await act(async () => {
      result.current.update("/", 1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith("/sessions/session-1/slash-universe", {
      signal: expect.any(AbortSignal),
    });
    expect(result.current.mode).toBe("slash");
    expect(result.current.slashRows.map((row) => row.id)).toEqual(["cat:command"]);

    await act(async () => {
      result.current.update("/he", 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.current.slashRows.some((row) => row.type === "item")).toBe(true);
  });

  it("hides an empty no-project universe and retries on the next slash", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ commands: [], prompts: [], skills: [], loops: [] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          commands: [
            {
              kind: "command",
              id: "command:built-in:help",
              displayName: "Help",
              isActive: true,
              slashName: "/help",
            },
          ],
          prompts: [],
          skills: [],
          loops: [],
        }),
      } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSuggestions("session-1", "project-1"));

    await act(async () => {
      result.current.update("/", 1);
    });
    expect(result.current.mode).toBeNull();
    expect(result.current.slashRows).toEqual([]);

    await act(async () => {
      result.current.update("", 0);
      result.current.update("/", 1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.current.mode).toBe("slash");
  });

  it("drills into a category and Escape returns to the picker", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        commands: [
          {
            kind: "command",
            id: "command:built-in:help",
            displayName: "Help",
            isActive: true,
            slashName: "/help",
          },
        ],
        prompts: [],
        skills: [],
        loops: [],
      }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSuggestions("session-1", "project-1"));
    await act(async () => {
      result.current.update("/", 1);
    });
    const category = result.current.slashRows[0];
    expect(category?.type).toBe("category");
    act(() => {
      if (category) result.current.acceptSlashRow(category);
    });
    expect(result.current.slashScreen).toEqual({ type: "category", category: "command" });
    expect(result.current.slashRows.some((row) => row.type === "item")).toBe(true);

    act(() => {
      const event = {
        key: "Escape",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent;
      expect(result.current.handleKeyDown(event)).toBe(true);
    });
    expect(result.current.mode).toBe("slash");
    expect(result.current.slashScreen).toEqual({ type: "picker" });
  });

  it("returns from a filtered category to the picker on Escape", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        commands: [
          {
            kind: "command",
            id: "command:built-in:help",
            displayName: "Help",
            isActive: true,
            slashName: "/help",
          },
        ],
        prompts: [],
        skills: [],
        loops: [],
      }),
    } as Response);
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSuggestions("session-1", "project-1"));
    await act(async () => {
      result.current.update("/", 1);
    });
    const category = result.current.slashRows[0];
    act(() => {
      if (category) result.current.acceptSlashRow(category);
    });
    await act(async () => {
      result.current.update("/xyz", 4);
    });
    act(() => {
      const event = {
        key: "Escape",
        preventDefault: vi.fn(),
      } as unknown as React.KeyboardEvent;
      expect(result.current.handleKeyDown(event)).toBe(true);
    });
    expect(result.current.mode).toBe("slash");
    expect(result.current.slashScreen).toEqual({ type: "picker" });
  });

  it("does not open slash suggestions without a project", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSuggestions("session-1", null));
    act(() => result.current.update("/", 1));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.mode).toBeNull();
  });

  it("does not request a bare @ query and cancels a pending file timer on close", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSuggestions("session-1", "project-1"));

    act(() => result.current.update("@", 1));
    act(() => vi.advanceTimersByTime(120));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => result.current.update("@pending", 8));
    act(() => result.current.close());
    act(() => vi.advanceTimersByTime(120));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
