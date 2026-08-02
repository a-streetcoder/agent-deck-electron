import { Either, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SessionMeta } from "../src/index.ts";

describe("SessionMeta fork provenance compatibility", () => {
  it("keeps a future or malformed optional payload decodable for guarded consumers", () => {
    const decode = Schema.decodeUnknownEither(SessionMeta);
    const result = decode({
      id: "session",
      cwd: "/tmp",
      createdAt: "now",
      forkProvenance: { version: 99, sourceTitle: 42, futureField: true },
    });
    expect(Either.isRight(result)).toBe(true);
  });
});
