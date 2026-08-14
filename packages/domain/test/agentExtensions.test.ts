import {
  AGENT_EXTENSION_MAX_ITEMS,
  normalizeAgentExtensions,
  validateAgentExtensionsForAuthoring,
} from "../src/resources.ts";
import { describe, expect, it } from "vitest";

describe("agent extension policy", () => {
  it("preserves absence versus explicit empty and stably deduplicates", () => {
    expect(normalizeAgentExtensions(undefined)).toBeUndefined();
    expect(normalizeAgentExtensions([])).toEqual([]);
    expect(normalizeAgentExtensions([" /one.ts ", "/two.ts", "/one.ts", ""])).toEqual([
      "/one.ts",
      "/two.ts",
    ]);
  });

  it("rejects authoring overflow instead of silently truncating", () => {
    expect(() =>
      validateAgentExtensionsForAuthoring(
        Array.from({ length: AGENT_EXTENSION_MAX_ITEMS + 1 }, (_, index) => `/ext-${index}.ts`),
      ),
    ).toThrow(/cannot exceed/);
  });
});
