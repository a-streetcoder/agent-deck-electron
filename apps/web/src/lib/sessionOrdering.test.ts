import { describe, expect, it } from "vitest";
import type { SessionMeta } from "@agent-deck/contracts";
import { sortSessionsByActivity, sortSessionsWithPins } from "./sessionOrdering.ts";

function session(
  id: string,
  updatedAt: string,
  pinnedAt?: string,
  projectId = "project",
): SessionMeta {
  return { id, cwd: "/tmp", createdAt: updatedAt, updatedAt, pinnedAt, projectId };
}

describe("session ordering", () => {
  it("puts newest pins first without changing ordinary activity order", () => {
    const sessions = [
      session("newest", "2026-07-29T12:00:00.000Z"),
      session("older-pin", "2026-07-29T09:00:00.000Z", "2026-07-29T12:01:00.000Z"),
      session("newer-pin", "2026-07-29T08:00:00.000Z", "2026-07-29T12:02:00.000Z"),
      session("middle", "2026-07-29T11:00:00.000Z"),
    ];

    expect(sortSessionsWithPins(sessions).map((item) => item.id)).toEqual([
      "newer-pin",
      "older-pin",
      "newest",
      "middle",
    ]);
    expect(sortSessionsByActivity(sessions).map((item) => item.id)).toEqual([
      "newest",
      "middle",
      "older-pin",
      "newer-pin",
    ]);
  });
});
