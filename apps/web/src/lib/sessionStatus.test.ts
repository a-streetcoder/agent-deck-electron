import { describe, expect, it } from "vitest";
import { selectedSessionStatus } from "./sessionStatus.ts";

describe("selectedSessionStatus", () => {
  it("prioritizes connection, then running, then durable failure, then idle", () => {
    expect(selectedSessionStatus("connecting", "running", "failed")).toBe("connecting");
    expect(selectedSessionStatus("closed", "idle", "failed")).toBe("closed");
    expect(selectedSessionStatus("open", "running", "failed")).toBe("responding");
    expect(selectedSessionStatus("open", "idle", "failed")).toBe("failed");
    expect(selectedSessionStatus("open", "idle", undefined)).toBe("idle");
  });
});
