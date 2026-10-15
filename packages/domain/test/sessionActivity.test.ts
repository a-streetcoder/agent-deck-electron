import { describe, expect, it } from "vitest";
import { sessionActivity } from "../src/sessionActivity.ts";

describe("sessionActivity (SRV-15b)", () => {
  it("is running only for a live runtime that is not idle", () => {
    expect(sessionActivity({}, { idle: false })).toBe("running");
    expect(sessionActivity({}, { idle: true })).toBe("idle");
  });

  it("is idle without a live runtime, whatever the log says (a turn left open by a restart)", () => {
    // The log is not an input: no live runtime means no running turn.
    expect(sessionActivity({})).toBe("idle");
  });

  it("reports parked for a parked session, never running", () => {
    expect(sessionActivity({ parkedAt: "2026-10-15T10:00:00.000Z" })).toBe("parked");
  });

  it("is needsInput while an open human node waits, even mid-turn", () => {
    expect(sessionActivity({}, { idle: false }, true)).toBe("needsInput");
    expect(sessionActivity({ status: "failed" }, undefined, true)).toBe("needsInput");
  });

  it("reports a durable failure, then attention, from meta", () => {
    expect(sessionActivity({ status: "failed", needsAttention: true })).toBe("failed");
    expect(sessionActivity({ needsAttention: true, parkedAt: "x" })).toBe("attention");
    expect(sessionActivity({ status: "failed" }, { idle: false })).toBe("running");
  });
});
