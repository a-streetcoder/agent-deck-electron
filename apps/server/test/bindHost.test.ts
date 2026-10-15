import { describe, expect, it } from "vitest";
import { resolveBindHost } from "../src/bindHost.ts";

describe("resolveBindHost", () => {
  it("defaults to loopback and normalizes every loopback value to IPv4 127.0.0.1", () => {
    expect(resolveBindHost({})).toEqual({ host: undefined });
    // The Pi bridge and the HEALTHCHECK call 127.0.0.1; ::1/localhost may bind IPv6 only.
    for (const value of [" 127.0.0.1 ", "::1", "localhost"]) {
      expect(resolveBindHost({ AGENT_DECK_HOST: value }).host).toBe("127.0.0.1");
    }
  });

  it("refuses a wildcard without the trusted proxy or the opt-out", () => {
    expect(() => resolveBindHost({ AGENT_DECK_HOST: "0.0.0.0" })).toThrow(/unauthenticated/);
    expect(() => resolveBindHost({ AGENT_DECK_HOST: "::", AGENT_DECK_TRUSTED_PROXY: "" })).toThrow(
      /unauthenticated/,
    );
    expect(() =>
      resolveBindHost({
        AGENT_DECK_HOST: "0.0.0.0",
        AGENT_DECK_ALLOW_UNAUTHENTICATED_HOST: "true",
      }),
    ).toThrow(/unauthenticated/);
  });

  it("allows a wildcard behind the trusted proxy or with the explicit opt-out", () => {
    expect(
      resolveBindHost({ AGENT_DECK_HOST: "0.0.0.0", AGENT_DECK_TRUSTED_PROXY: "cloudflare" }).host,
    ).toBe("0.0.0.0");
    expect(
      resolveBindHost({ AGENT_DECK_HOST: "::", AGENT_DECK_ALLOW_UNAUTHENTICATED_HOST: "1" }).host,
    ).toBe("::");
  });

  it("refuses a specific non-loopback address even behind the proxy", () => {
    expect(() =>
      resolveBindHost({ AGENT_DECK_HOST: "10.0.0.5", AGENT_DECK_TRUSTED_PROXY: "cloudflare" }),
    ).toThrow(/not supported/);
  });

  it("refuses a trusted proxy value that is set but is not exactly cloudflare", () => {
    // A typo would silently turn authentication off.
    for (const value of ["cloudfare", "Cloudflare", " cloudflare"]) {
      expect(() => resolveBindHost({ AGENT_DECK_TRUSTED_PROXY: value })).toThrow(
        /refusing to start/,
      );
    }
    expect(resolveBindHost({ AGENT_DECK_TRUSTED_PROXY: "cloudflare" })).toEqual({
      host: undefined,
    });
    expect(resolveBindHost({ AGENT_DECK_TRUSTED_PROXY: "" })).toEqual({ host: undefined });
  });
});
