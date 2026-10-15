// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginOriginChange,
  endOriginChange,
  holdTransfer,
  TRANSFER_HOLD_CEILING_MS,
  transferRunning,
  useTransferHold,
} from "./sharedTransfers.ts";

afterEach(() => {
  endOriginChange();
  vi.useRealTimers();
});

describe("sharedTransfers", () => {
  it("an open dialog holds Save off until it closes", () => {
    const { rerender, unmount } = renderHook(({ open }) => useTransferHold(open), {
      initialProps: { open: true },
    });
    expect(transferRunning()).toBe(true);
    expect(beginOriginChange()).toBe(false);
    rerender({ open: false });
    expect(transferRunning()).toBe(false);
    rerender({ open: true });
    unmount();
    expect(transferRunning()).toBe(false);
  });

  it("a hold expires after the ceiling, so a hung step cannot block Save until restart", () => {
    vi.useFakeTimers();
    const release = holdTransfer();
    expect(transferRunning()).toBe(true);
    vi.advanceTimersByTime(TRANSFER_HOLD_CEILING_MS - 1);
    expect(transferRunning()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(transferRunning()).toBe(false);
    expect(beginOriginChange()).toBe(true);
    release();
  });
});
