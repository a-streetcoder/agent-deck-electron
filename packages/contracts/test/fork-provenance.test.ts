import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SessionMeta } from "../src/index.ts";

describe("SessionMeta provenance and location compatibility (ADR 0006)", () => {
  it("keeps a future or malformed provenance and location decodable for guarded consumers", () => {
    const decode = Schema.decodeUnknownEither(SessionMeta);
    const result = decode({
      id: "session",
      cwd: "/tmp",
      createdAt: "now",
      schemaVersion: 2,
      provenance: { kind: "scheduled", by: 42, futureField: true },
      location: { kind: "elsewhere", live: { futureField: true } },
    });
    expect(Either.isRight(result)).toBe(true);
  });

  it("keeps a later schema version decodable", () => {
    const decode = Schema.decodeUnknownEither(SessionMeta);
    expect(
      Either.isRight(decode({ id: "session", cwd: "/tmp", createdAt: "now", schemaVersion: 3 })),
    ).toBe(true);
  });
});
