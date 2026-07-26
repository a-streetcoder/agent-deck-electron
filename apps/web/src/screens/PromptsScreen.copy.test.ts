// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "./PromptsScreen.tsx";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("prompt invocation clipboard fallback", () => {
  it.each(["absent", "rejected"] as const)(
    "uses and cleans up the textarea fallback when clipboard is %s",
    async (clipboardState) => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value:
          clipboardState === "rejected"
            ? { writeText: vi.fn().mockRejectedValue(new Error("denied")) }
            : undefined,
      });
      const execCommand = vi.fn().mockReturnValue(true);
      Object.defineProperty(document, "execCommand", {
        configurable: true,
        value: execCommand,
      });

      await expect(copyText("/review")).resolves.toBe(true);
      expect(execCommand).toHaveBeenCalledWith("copy");
      expect(document.querySelector("textarea")).toBeNull();
    },
  );
});
