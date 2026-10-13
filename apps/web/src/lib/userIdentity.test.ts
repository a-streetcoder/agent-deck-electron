import { describe, expect, it } from "vitest";
import { userDisplayName, userInitials } from "./userIdentity.ts";

describe("userIdentity", () => {
  it("prefers the name, then the email local part", () => {
    expect(userDisplayName({ id: "ale@example.com", name: "Alessandro Moretti" })).toBe(
      "Alessandro Moretti",
    );
    expect(userDisplayName({ id: "andrea.rossi@example.com" })).toBe("andrea.rossi");
    expect(userDisplayName({ id: "opaque" })).toBe("opaque");
  });
  it("derives compact initials", () => {
    expect(userInitials({ id: "x", name: "Alessandro Moretti" })).toBe("AM");
    expect(userInitials({ id: "andrea.rossi@example.com" })).toBe("AR");
    expect(userInitials({ id: "ale@example.com" })).toBe("AL");
    expect(userInitials({ id: "" })).toBe("?");
  });
});
