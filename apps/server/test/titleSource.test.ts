import { describe, expect, it } from "vitest";
import { lockTitleSource } from "../src/services/sessionManager.ts";

describe("lockTitleSource", () => {
  it("lets the first accepted prompt own the title, including an omitted source", () => {
    const first = lockTitleSource(false, undefined, undefined);
    expect(first).toEqual({ locked: true, source: undefined });
    expect(lockTitleSource(first.locked, first.source, "queued later")).toEqual({
      locked: true,
      source: undefined,
    });
  });

  it("keeps an explicit first-turn source and ignores later overrides", () => {
    const first = lockTitleSource(false, undefined, "  check this  ");
    expect(first).toEqual({ locked: true, source: "check this" });
    expect(lockTitleSource(first.locked, first.source, "queued later")).toEqual({
      locked: true,
      source: "check this",
    });
  });
});
