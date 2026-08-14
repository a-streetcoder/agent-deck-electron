import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { ProjectMeta } from "../src/index.ts";

describe("ProjectMeta assignedAgentNames", () => {
  const base = {
    id: "project",
    path: "/tmp/project",
    name: "Project",
    createdAt: "2026-01-01T00:00:00.000Z",
  };

  it("accepts legacy absence and preserves an explicitly empty assignment", () => {
    expect(Either.isRight(Schema.decodeUnknownEither(ProjectMeta)(base))).toBe(true);
    const decoded = Schema.decodeUnknownSync(ProjectMeta)({ ...base, assignedAgentNames: [] });
    expect(decoded.assignedAgentNames).toEqual([]);
  });
});
