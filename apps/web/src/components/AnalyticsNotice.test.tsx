// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyticsNotice } from "./AnalyticsNotice.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const TEXT = /sends anonymous usage counts/;

describe("AnalyticsNotice (app shell)", () => {
  it("shows once until Got it, which saves analyticsNoticeSeen and hides it", () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    render(
      <AnalyticsNotice
        data={{ settings: { analyticsNoticeSeen: false }, capabilities: { analytics: true } }}
      />,
    );
    expect(screen.getByText(TEXT)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText(TEXT)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/settings");
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ analyticsNoticeSeen: true });
  });

  it("does not render where analytics is unavailable, already seen, or not loaded", () => {
    const { rerender } = render(
      <AnalyticsNotice
        data={{ settings: { analyticsNoticeSeen: false }, capabilities: { analytics: false } }}
      />,
    );
    expect(screen.queryByText(TEXT)).toBeNull();
    rerender(
      <AnalyticsNotice
        data={{ settings: { analyticsNoticeSeen: true }, capabilities: { analytics: true } }}
      />,
    );
    expect(screen.queryByText(TEXT)).toBeNull();
    rerender(<AnalyticsNotice data={null} />);
    expect(screen.queryByText(TEXT)).toBeNull();
  });
});
