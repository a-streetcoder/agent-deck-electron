import { describe, expect, it } from "vitest";
import { resolveProfile } from "../src/profile.ts";

const SHARED = {
  AGENT_DECK_TRUSTED_PROXY: "cloudflare",
  AGENT_DECK_CF_ACCESS_TEAM_DOMAIN: "team.cloudflareaccess.com",
  AGENT_DECK_CF_ACCESS_AUD: "aud",
};

describe("deployment profile (ADR 0008)", () => {
  it("is the desktop without a trusted proxy", () => {
    expect(resolveProfile({})).toEqual({ profile: "desktop", trustedProxy: null, side: "local" });
  });

  it("is the shared server behind a trusted proxy, with server-side records", () => {
    const resolved = resolveProfile(SHARED);
    expect(resolved.profile).toBe("shared-server");
    expect(resolved.side).toBe("server");
    expect(resolved.trustedProxy).not.toBeNull();
  });
});
