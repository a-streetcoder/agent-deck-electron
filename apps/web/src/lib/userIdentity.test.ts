import { describe, expect, it } from "vitest";
import { credentialsOwnerLabel, userDisplayName, userInitials } from "./userIdentity.ts";

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
  it("SRV-14: names the owner whose credentials a shared session runs on", () => {
    const me = { id: "andrea@example.com" };
    expect(credentialsOwnerLabel(me, { id: "ale@example.com", name: "Ale" })).toBe(
      "runs on Ale credentials",
    );
    expect(credentialsOwnerLabel(me, { id: "ale@example.com" })).toBe("runs on ale credentials");
    expect(credentialsOwnerLabel(me, { id: "andrea@example.com", name: "Andrea" })).toBeNull();
    expect(credentialsOwnerLabel(me, undefined)).toBeNull();
    expect(credentialsOwnerLabel(null, { id: "ale@example.com" })).toBeNull();
  });
});
