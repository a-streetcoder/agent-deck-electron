// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyAppearance, installSystemTheme } from "./systemTheme.ts";

describe("system theme appearance", () => {
  let systemDark = false;
  let systemChange: (() => void) | undefined;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    systemDark = false;
    systemChange = undefined;
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => ({
        get matches() {
          return systemDark;
        },
        media: "(prefers-color-scheme: dark)",
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => {
          systemChange = listener;
        },
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("follows system changes in auto mode", () => {
    applyAppearance("auto");
    const uninstall = installSystemTheme();
    expect(document.documentElement.dataset.theme).toBe("light");

    systemDark = true;
    systemChange?.();
    expect(document.documentElement.dataset.theme).toBe("dark");
    uninstall();
  });

  it("keeps an explicit override when the system changes", () => {
    applyAppearance("auto");
    const uninstall = installSystemTheme();

    applyAppearance("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    systemDark = false;
    systemChange?.();
    expect(document.documentElement.dataset.theme).toBe("dark");

    applyAppearance("light");
    systemDark = true;
    systemChange?.();
    expect(document.documentElement.dataset.theme).toBe("light");
    uninstall();
  });
});
