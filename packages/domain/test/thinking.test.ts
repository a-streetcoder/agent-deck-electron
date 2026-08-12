import { describe, expect, it } from "vitest";
import { THINKING_LEVELS, thinkingLevelsForModel } from "../src/thinking.ts";

describe("thinkingLevelsForModel", () => {
  it("offers the full ladder for a reasoning-capable model", () => {
    expect(thinkingLevelsForModel(true)).toEqual([...THINKING_LEVELS]);
  });

  it("preserves an exact reported subset, including max only when present", () => {
    expect(thinkingLevelsForModel(true, ["off", "low", "high", "max"])).toEqual([
      "off",
      "low",
      "high",
      "max",
    ]);
  });

  it("restricts a non-reasoning model to off even if inconsistent metadata is supplied", () => {
    expect(thinkingLevelsForModel(false, ["off", "max"])).toEqual(["off"]);
    expect(thinkingLevelsForModel(false, [])).toEqual(["off"]);
  });

  it("preserves an empty reasoning-model result instead of inventing levels", () => {
    expect(thinkingLevelsForModel(true, [])).toEqual([]);
  });

  it("uses the legacy ladder without guessing max when metadata is missing", () => {
    expect(thinkingLevelsForModel(undefined)).toEqual([...THINKING_LEVELS]);
    expect(thinkingLevelsForModel(undefined)).not.toContain("max");
  });
});
