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
    const { result } = renderHook(() => useSuggestions("session-1"));

    act(() => result.current.update("look @read", 10));
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(119));
    expect(fetchMock).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(fetchMock).toHaveBeenCalledWith("/sessions/session-1/files?q=read", {
      signal: expect.any(AbortSignal),
    });

    act(() => result.current.update("/help", 5));
    expect(fetchMock).toHaveBeenLastCalledWith("/sessions/session-1/commands", {
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
    const { result, rerender, unmount } = renderHook(({ sessionId }) => useSuggestions(sessionId), {
      initialProps: { sessionId: "session-1" as string | null },
    });

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
    const { result } = renderHook(() => useSuggestions("session-1"));

    act(() => result.current.update("@old", 4));
    await act(async () => vi.advanceTimersByTimeAsync(120));
    expect(result.current.mode).toBe("file");
    expect(result.current.items).toEqual([{ id: "old-result.ts", label: "old-result.ts" }]);

    act(() => result.current.update("@new", 4));
    expect(result.current.mode).toBeNull();
    expect(result.current.items).toEqual([]);
  });

  it("does not request a bare @ query and cancels a pending file timer on close", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { result } = renderHook(() => useSuggestions("session-1"));

    act(() => result.current.update("@", 1));
    act(() => vi.advanceTimersByTime(120));
    expect(fetchMock).not.toHaveBeenCalled();

    act(() => result.current.update("@pending", 8));
    act(() => result.current.close());
    act(() => vi.advanceTimersByTime(120));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
